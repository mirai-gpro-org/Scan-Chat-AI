#!/usr/bin/env node
/**
 * batch-scan-to-elith.mjs
 *
 * サンプル検査画像を一括で「AIスキャン(Gemini) → Elith 連携仕様の JSON」へ変換し、
 * 元画像とあわせて S3 に書き出すバッチ。既存アプリの機能(スキャン+S3)を
 * コマンドラインから全件に適用するためのツール (方式A)。
 *
 * ■ 前提 (アプリと同じ資格情報が必要)
 *   - GEMINI_API_KEY               : 必須 (画像OCR。無いと1枚も処理できない)
 *   - AWS_REGION / AWS_S3_BUCKET   : --upload 時に必須
 *   - AWS_ACCESS_KEY_ID / _SECRET  : Elith バケットへの書込権限を持つもの
 *   → これらが揃った環境 (アプリのデプロイ環境 / 専用サーバ) で実行する。
 *
 * ■ スキャンのプロンプトは src/pages/api/scan.ts の ANALYZE_SYSTEM を
 *   実行時に読み取って再利用する (二重管理を避けるため)。
 *
 * ■ 出力 (Elith 仕様: docs/elith_s3_data_handoff_spec.md)
 *   パス   : {prefix}user/{client_id}/date/{YYYY_MM_DD}/
 *   JSON   : {format_id}_date_{YYYY_MM_DD}_user_{client_id}.json
 *   元画像 : {format_id}_date_{YYYY_MM_DD}_user_{client_id}.{元拡張子}   (同名・拡張子替え)
 *
 * ■ 使い方
 *   # まずローカル ドライラン (S3 に書かない。./batch-out に生成物を出す)
 *   GEMINI_API_KEY=xxx node scripts/batch-scan-to-elith.mjs --input ./samples
 *
 *   # 本番アップロード
 *   GEMINI_API_KEY=xxx AWS_REGION=ap-northeast-1 AWS_S3_BUCKET=wellfort-ai-input \
 *   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
 *   node scripts/batch-scan-to-elith.mjs --input ./samples --upload
 *
 * ■ 主なオプション
 *   --input <dir>        入力ルート。直下のサブフォルダ名から format_id を推定
 *   --upload             S3 へアップロード (省略時はローカル ドライラン)
 *   --out <dir>          ドライラン出力先 (既定 ./batch-out)
 *   --prefix <s3prefix>  バケット内共通プレフィックス (既定 空。例 "prod/")
 *   --client-id <mode>   uuid(既定) | fixed:<id> | filename
 *   --format <id>        全画像の format_id を明示指定 (サブフォルダ推定より優先)
 *   --today <YYYY-MM-DD> 検査日不明時に使う「本日」を上書き (既定 実行日 JST)
 *   --concurrency <n>    同時処理数 (既定 2)
 *   --limit <n>          先頭 n 件だけ処理 (試験用)
 *
 * Node >= 20 (global fetch / crypto.randomUUID を使用)。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ---------- 引数 ----------
function parseArgs(argv) {
  const a = { input: null, drive: null, upload: false, out: './batch-out', prefix: '',
    clientId: 'uuid', format: null, today: null, concurrency: 2, limit: 0 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--input') a.input = next();
    else if (k === '--drive') a.drive = next();      // Google Drive フォルダID (ローカルに落とさず直接処理)
    else if (k === '--upload') a.upload = true;
    else if (k === '--out') a.out = next();
    else if (k === '--prefix') a.prefix = next();
    else if (k === '--client-id') a.clientId = next();
    else if (k === '--format') a.format = next();
    else if (k === '--today') a.today = next();
    else if (k === '--concurrency') a.concurrency = Math.max(1, parseInt(next(), 10) || 2);
    else if (k === '--limit') a.limit = Math.max(0, parseInt(next(), 10) || 0);
    else if (k === '--help' || k === '-h') { printHelp(); process.exit(0); }
    else throw new Error(`Unknown option: ${k}`);
  }
  if (!a.input && !a.drive) { printHelp(); throw new Error('--drive <folderId> か --input <dir> のどちらかが必須です'); }
  if (a.input && a.drive) throw new Error('--input と --drive は同時指定できません');
  return a;
}
function printHelp() {
  console.log('Usage: node scripts/batch-scan-to-elith.mjs (--drive <folderId> | --input <dir>) [--upload]\n' +
    '       [--out <dir>] [--prefix <s3prefix>] [--client-id uuid|fixed:<id>|filename] [--format <id>]\n' +
    '       [--today YYYY-MM-DD] [--concurrency <n>] [--limit <n>]\n' +
    '  env(共通): GEMINI_API_KEY (必須)\n' +
    '  env(--upload時): AWS_REGION, AWS_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY\n' +
    '  env(--drive時): GOOGLE_ACCESS_TOKEN もしくは GOOGLE_SERVICE_ACCOUNT_KEY(_FILE)  (drive.readonly)');
}

// ---------- format_id 推定 (フォルダ名 → format_id) ----------
const FORMAT_RULES = [
  { re: /(がんリスク|cancer|尿)/i, id: 'CancerRiskAssessmentData' },
  { re: /(遺伝子|genetic|genome|ゲノム)/i, id: 'GeneticTestResultData' },
  { re: /(血液|blood)/i, id: 'BloodTestData' },
  { re: /(人間ドック|検診|健診|健康診断|ドック|checkup|dock)/i, id: 'HealthCheckupData' },
  { re: /(問診|生活習慣|lifestyle|questionnaire)/i, id: 'LifestyleQuestionnaireData' },
];
function inferFormatId(relDir, override) {
  if (override) return override;
  for (const r of FORMAT_RULES) if (r.re.test(relDir)) return r.id;
  return 'Other';
}

// ---------- 画像 MIME ----------
const IMAGE_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic', '.pdf': 'application/pdf',
};
function mimeFor(ext) { return IMAGE_EXT[ext.toLowerCase()] || null; }

// ---------- ANALYZE_SYSTEM を scan.ts から抽出 (二重管理回避) ----------
async function loadAnalyzePrompt() {
  const src = await fs.readFile(path.join(REPO_ROOT, 'src/pages/api/scan.ts'), 'utf-8');
  const marker = 'const ANALYZE_SYSTEM = `';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('scan.ts に ANALYZE_SYSTEM が見つかりません (パス/実装変更?)');
  let i = start + marker.length;
  let out = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { // エスケープ: 次の文字をそのまま採用 (\` → ` など)
      const n = src[i + 1];
      out += (n === '`' || n === '\\' || n === '$') ? n : '\\' + n;
      i++;
      continue;
    }
    if (c === '`') break; // テンプレートリテラル終端
    out += c;
  }
  if (!out.trim()) throw new Error('ANALYZE_SYSTEM の抽出に失敗しました');
  return out;
}

// ---------- Gemini 呼び出し (src/lib/gemini.ts と同等) ----------
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const EXAM_DATE_INSTRUCTION =
  '\nまた、紙面に検査日・採取日・受診日・報告日が読み取れる場合は、出力の先頭行に ' +
  '`<!-- exam_date: YYYY-MM-DD -->` を1行だけ加えてください (読み取れなければ加えない)。';

async function geminiScan(apiKey, systemPrompt, mime, base64) {
  const url = `${GEMINI_ENDPOINT}/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const req = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: mime, data: base64 } },
      { text: 'この紙面を Markdown に書き起こしてください。' + EXAM_DATE_INSTRUCTION },
    ] }],
    generationConfig: { temperature: 0.0, maxOutputTokens: 32768, thinkingConfig: { thinkingBudget: 2048 } },
  };
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const md = parts.map((p) => p.text ?? '').filter(Boolean).join('\n').trim();
  const finishReason = json.candidates?.[0]?.finishReason ?? null;
  return { markdown: md, finishReason };
}

// ---------- 検査日抽出 ----------
function extractExamDate(markdown, todayIso) {
  // 1) 明示コメント <!-- exam_date: YYYY-MM-DD -->
  const m = /<!--\s*exam_date:\s*(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/i.exec(markdown);
  if (m) return { date: iso(m[1], m[2], m[3]), source: 'exam_date' };
  // 2) 本文中の日付パターン (最初の妥当な日付)
  const re = /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/g;
  let g;
  while ((g = re.exec(markdown))) {
    const d = iso(g[1], g[2], g[3]);
    if (d) return { date: d, source: 'markdown' };
  }
  return { date: todayIso, source: 'today' };
}
function iso(y, mo, d) {
  const Y = +y, M = +mo, D = +d;
  if (M < 1 || M > 12 || D < 1 || D > 31) return null;
  return `${Y.toString().padStart(4, '0')}-${M.toString().padStart(2, '0')}-${D.toString().padStart(2, '0')}`;
}
function jstTodayIso() {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

// ---------- Markdown → 領域/計測値の構造化 ----------
function parseRegions(markdown) {
  const lines = markdown.split(/\r?\n/);
  const regions = [];
  let cur = null;
  const pushCur = () => { if (cur) regions.push(cur); };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) { pushCur(); cur = { label: h2[1], bbox: null, type: null, columns: null, rows: [], notes: [] }; continue; }
    if (!cur) { if (line.trim()) { cur = { label: '(no heading)', bbox: null, type: null, columns: null, rows: [], notes: [] }; } else continue; }
    const bb = /<!--\s*bbox:\s*([\d.,\s]+)-->/i.exec(line);
    if (bb) { cur.bbox = bb[1].split(',').map((s) => parseFloat(s.trim())).filter((n) => !Number.isNaN(n)); continue; }
    if (/<!--\s*exam_date:/i.test(line)) continue; // 検査日コメントは領域に含めない
    if (line.startsWith('|')) {
      const cells = splitRow(line);
      if (cells.every((c) => { const t = c.replace(/\s/g, ''); return t === '' || /^:?-+:?$/.test(t); })) continue; // 区切り行 (---, :--: 等)
      if (!cur.columns) { cur.columns = cells; cur.type = 'table'; }
      else cur.rows.push(cells);
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) { cur.notes.push(bullet[1]); if (!cur.type) cur.type = 'notes'; continue; }
  }
  pushCur();
  // 空領域 (見出しだけ/コメントだけ) は除外
  return regions.filter((r) => r.type || r.rows.length || r.notes.length);
}
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

// テーブル領域 → measurements[] (列名でマッピング)
function toMeasurements(regions) {
  const out = [];
  const pick = (cols, names) => { for (const n of names) { const i = cols.indexOf(n); if (i >= 0) return i; } return -1; };
  for (const r of regions) {
    if (r.type !== 'table' || !r.columns) continue;
    const c = r.columns;
    const idx = {
      no: pick(c, ['No', 'no']), name: pick(c, ['検査項目']), detail: pick(c, ['検査項目詳細']),
      value: pick(c, ['読み取った値', '結果', '値']), inferred: pick(c, ['推論値']),
      unit: pick(c, ['単位', '単位名称']), low: pick(c, ['下限値']), high: pick(c, ['上限値']),
      flag: pick(c, ['判定']), note: pick(c, ['備考']),
    };
    for (const row of r.rows) {
      const g = (i) => (i >= 0 && i < row.length ? row[i] : '') || '';
      const name = g(idx.name);
      if (!name && !g(idx.value)) continue;
      out.push({
        region: r.label, no: g(idx.no) || null, name, name_detail: g(idx.detail) || null,
        value: g(idx.value) || null, inferred: g(idx.inferred) || null, unit: g(idx.unit) || null,
        ref_low: g(idx.low) || null, ref_high: g(idx.high) || null, flag: g(idx.flag) || null,
        note: g(idx.note) || null,
      });
    }
  }
  return out;
}
function collectNotes(regions) {
  const out = [];
  for (const r of regions) if (r.notes?.length) out.push(...r.notes);
  return out;
}

// ---------- Elith エンベロープ生成 ----------
function buildElithJson({ formatId, clientId, diagnosticId, sourceImage, testDate, dateSource, markdown, finishReason }) {
  const regions = parseRegions(markdown);
  return {
    format_id: formatId,
    schema_version: 'elith-handoff-v0.1',
    kind: 'scan_sample',
    client_id: clientId,
    diagnostic_id: diagnosticId,
    source_image: sourceImage,
    test_date: testDate,
    date_source: dateSource, // 'exam_date' | 'markdown' | 'today'
    exported_at: new Date().toISOString(),
    subject: { sex: null, age: null }, // サンプルのため PII なし
    source: { origin: 'scan-chat-ai', app: 'scan-chat-ai', model: GEMINI_MODEL,
      note: 'サンプル一括生成 (AIスキャン)。命名/フォーマットは暫定。', lab_name: null, finish_reason: finishReason },
    data: { measurements: toMeasurements(regions), notes: collectNotes(regions), regions },
    raw_markdown: stripExamComment(markdown),
  };
}
function stripExamComment(md) { return md.replace(/^\s*<!--\s*exam_date:[^>]*-->\s*\n?/i, ''); }

// ---------- client_id 採番 ----------
function makeClientId(mode, imgBase) {
  if (mode.startsWith('fixed:')) return mode.slice('fixed:'.length) || 'test-samples';
  if (mode === 'filename') return imgBase.normalize('NFKC').replace(/[^0-9A-Za-z_-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || crypto.randomUUID();
  return crypto.randomUUID();
}

// ---------- 入力の列挙 (ローカル or Google Drive) ----------
// item: { name, relDir, ext, read: async () => Buffer }

async function listLocal(root) {
  const items = [];
  async function walk(dir) {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (mimeFor(path.extname(e.name))) {
        const rel = path.relative(root, p);
        items.push({ name: e.name, relDir: path.dirname(rel), ext: path.extname(e.name), read: () => fs.readFile(p) });
      }
    }
  }
  await walk(root);
  items.sort((a, b) => (a.relDir + '/' + a.name).localeCompare(b.relDir + '/' + b.name));
  return items;
}

// --- Google Drive 直読み (ローカルに保存しない) ---
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }

async function getDriveToken() {
  if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN;
  let key = null;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  else if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) key = JSON.parse(await fs.readFile(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, 'utf-8'));
  if (!key) throw new Error('Drive認証情報が必要です: GOOGLE_ACCESS_TOKEN か GOOGLE_SERVICE_ACCOUNT_KEY(_FILE) を設定してください');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = { iss: key.client_email, scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const signer = crypto.createSign('RSA-SHA256'); signer.update(unsigned); signer.end();
  const jwt = `${unsigned}.${b64url(signer.sign(key.private_key))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error('Driveトークン取得失敗: ' + JSON.stringify(j).slice(0, 300));
  return j.access_token;
}

async function listDrive(folderId) {
  const token = await getDriveToken();
  const auth = { authorization: `Bearer ${token}` };
  const items = [];
  async function walk(id, relDir) {
    let pageToken;
    do {
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.set('q', `'${id}' in parents and trashed=false`);
      url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType)');
      url.searchParams.set('pageSize', '1000');
      url.searchParams.set('supportsAllDrives', 'true');
      url.searchParams.set('includeItemsFromAllDrives', 'true');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const res = await fetch(url, { headers: auth });
      const j = await res.json();
      if (!res.ok) throw new Error('Drive一覧失敗: ' + JSON.stringify(j).slice(0, 300));
      for (const f of j.files || []) {
        if (f.mimeType === 'application/vnd.google-apps.folder') {
          await walk(f.id, relDir ? `${relDir}/${f.name}` : f.name);
        } else {
          const ext = path.extname(f.name);
          if (!mimeFor(ext)) continue;
          const fileId = f.id, fileName = f.name;
          items.push({ name: fileName, relDir: relDir || '.', ext, read: async () => {
            const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: auth });
            if (!r.ok) throw new Error(`Driveダウンロード失敗 ${fileName}: ${r.status}`);
            return Buffer.from(await r.arrayBuffer());
          } });
        }
      }
      pageToken = j.nextPageToken;
    } while (pageToken);
  }
  await walk(folderId, '');
  items.sort((a, b) => (a.relDir + '/' + a.name).localeCompare(b.relDir + '/' + b.name));
  return items;
}

async function listItems(args) {
  if (args.drive) return listDrive(args.drive);
  return listLocal(path.resolve(args.input));
}

// ---------- 書き出し (S3 or ローカル) ----------
async function makeWriter(args) {
  if (!args.upload) {
    const outRoot = path.resolve(args.out);
    return {
      label: `local:${outRoot}`,
      async put(key, body, _ct) {
        const dest = path.join(outRoot, key);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, body);
        return `file://${dest}`;
      },
    };
  }
  const region = process.env.AWS_REGION, bucket = process.env.AWS_S3_BUCKET;
  if (!region || !bucket) throw new Error('--upload には AWS_REGION と AWS_S3_BUCKET が必要です');
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const client = new S3Client({ region });
  return {
    label: `s3://${bucket}`,
    async put(key, body, ct) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: ct }));
      return `s3://${bucket}/${key}`;
    },
  };
}

// ---------- メイン ----------
// ---------- .env 自動読み込み (アプリと同じキーをそのまま使う) ----------
// リポジトリ直下 / 実行ディレクトリの .env(.local) を読み、未設定の環境変数だけ補う。
// (astro dev 用の .env に GEMINI_API_KEY / AWS_* があれば、手入力せずに使える)
async function loadDotEnv() {
  const files = [...new Set([
    path.join(REPO_ROOT, '.env.local'), path.join(REPO_ROOT, '.env'),
    path.join(process.cwd(), '.env.local'), path.join(process.cwd(), '.env'),
  ])];
  const loaded = [];
  for (const f of files) {
    let text;
    try { text = await fs.readFile(f, 'utf-8'); } catch { continue; }
    let n = 0;
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined || process.env[m[1]] === '') { process.env[m[1]] = v; n++; }
    }
    if (n) loaded.push(`${f} (${n})`);
  }
  if (loaded.length) console.log('[batch] .env 読込:', loaded.join(', '));
}

async function main() {
  const args = parseArgs(process.argv);
  await loadDotEnv();
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY が未設定です (画像OCRに必須)');

  const prompt = await loadAnalyzePrompt();
  const writer = await makeWriter(args);
  const todayIso = args.today || jstTodayIso();
  const prefix = args.prefix ? args.prefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';

  let images = await listItems(args);
  if (args.limit) images = images.slice(0, args.limit);
  if (!images.length) throw new Error(`画像が見つかりません: ${args.drive ? 'drive:' + args.drive : args.input}`);

  console.log(`[batch] source=${args.drive ? 'drive' : 'local'} / ${images.length} 枚 / 出力先=${writer.label} / prefix="${prefix}" / today=${todayIso} / client-id=${args.clientId}`);

  const results = [];
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= images.length) return;
      const item = images[i];
      const rel = (item.relDir && item.relDir !== '.' ? item.relDir + '/' : '') + item.name;
      const ext = item.ext;
      const base = item.name.slice(0, item.name.length - ext.length);
      const formatId = inferFormatId(item.relDir || '', args.format);
      const clientId = makeClientId(args.clientId, base);
      const rec = { source: rel, format_id: formatId, client_id: clientId, test_date: '', date_source: '', json_key: '', image_key: '', status: '', note: '' };
      try {
        const buf = await item.read();
        const mime = mimeFor(ext);
        const { markdown, finishReason } = await geminiScan(apiKey, prompt, mime, buf.toString('base64'));
        if (!markdown) throw new Error('Gemini 応答が空 (finishReason=' + finishReason + ')');
        const { date, source } = extractExamDate(markdown, todayIso);
        const dateFolder = date.replace(/-/g, '_'); // YYYY_MM_DD
        const diagnosticId = crypto.randomUUID();
        const json = buildElithJson({ formatId, clientId, diagnosticId, sourceImage: item.name, testDate: date, dateSource: source, markdown, finishReason });
        const folder = `${prefix}user/${clientId}/date/${dateFolder}/`;
        const stem = `${formatId}_date_${dateFolder}_user_${clientId}`;
        const jsonKey = `${folder}${stem}.json`;
        const imageKey = `${folder}${stem}${ext.toLowerCase()}`;
        const jsonUri = await writer.put(jsonKey, Buffer.from(JSON.stringify(json, null, 2), 'utf-8'), 'application/json; charset=utf-8');
        await writer.put(imageKey, buf, mime);
        Object.assign(rec, { test_date: date, date_source: source, json_key: jsonKey, image_key: imageKey, status: 'ok', note: `rows=${json.data.measurements.length}` });
        console.log(`  ✓ [${i + 1}/${images.length}] ${rel} → ${jsonUri} (${source}, rows=${json.data.measurements.length})`);
      } catch (err) {
        Object.assign(rec, { status: 'error', note: String(err?.message || err).slice(0, 200) });
        console.error(`  ✗ [${i + 1}/${images.length}] ${rel} : ${rec.note}`);
      }
      results.push(rec);
    }
  }
  await Promise.all(Array.from({ length: args.concurrency }, worker));

  // マッピング CSV (画像 ↔ client_id / date / keys)
  const header = 'source,format_id,client_id,test_date,date_source,json_key,image_key,status,note';
  const csv = [header, ...results.map((r) => [r.source, r.format_id, r.client_id, r.test_date, r.date_source, r.json_key, r.image_key, r.status, r.note].map(csvCell).join(','))].join('\n');
  let mapLoc;
  if (args.upload) {
    // ローカルに残さず S3 へ (「ローカルに置かない」方針)
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', 'T');
    const key = `${prefix}user/_batch/batch-mapping-${stamp}.csv`;
    mapLoc = await writer.put(key, Buffer.from(csv, 'utf-8'), 'text/csv; charset=utf-8');
  } else {
    mapLoc = path.join(path.resolve(args.out), 'batch-mapping.csv');
    await fs.mkdir(path.dirname(mapLoc), { recursive: true });
    await fs.writeFile(mapLoc, csv, 'utf-8');
  }

  const ok = results.filter((r) => r.status === 'ok').length;
  const ng = results.length - ok;
  console.log(`\n[batch] 完了: 成功 ${ok} / 失敗 ${ng} / 合計 ${results.length}`);
  console.log(`[batch] マッピング: ${mapLoc}`);
  if (ng) process.exitCode = 1;
}
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// 直接実行時のみ main() を走らせる (テストで import 可能にするため)
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => { console.error('[batch] 中断:', err?.message || err); process.exit(1); });
}

export { loadAnalyzePrompt, parseRegions, toMeasurements, collectNotes, extractExamDate,
  buildElithJson, inferFormatId, makeClientId, jstTodayIso };
