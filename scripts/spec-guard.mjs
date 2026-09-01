#!/usr/bin/env node
/**
 * `spec-guard.mjs` — V1 Implementation Spec の**機械検査**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * このファイルは Claude Code `/impl` からの**恒久 Do Not Touch**。
 * ══════════════════════════════════════════════════════════════════════
 * validator を実装エージェント自身が書き換えられるなら、Scope guard も
 * Do Not Touch guard も metadata validation も**自分で無効化できる**ので、
 * security boundary にならない。変更は人間承認付き maintenance session のみ。
 *
 * 【方針】外部依存ゼロ (node: 組み込みのみ)。既存 scripts/verify-*.mjs と同じ流儀。
 * 汎用 YAML パーサは**作らない**。`_TEMPLATE.md` で構文を極めて限定し、
 * **曖昧な入力は解釈せず必ず FAIL** させる (fail-closed)。
 *
 * 【mode】**すべての mode で spec path 制約は同一**。
 *   validate <spec>                 … 実装前。spec 単体の静的検査
 *   scope    <spec>                 … 実装後。diff が Scope / Do Not Touch に収まるか
 *   snapshot <spec>                 … working tree の状態を stdout へ (Verification 前に取る)
 *   verify-clean <spec> <snapfile>  … snapshot と比較し、Verification が tree を汚していないか
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = process.cwd();

/** 全 spec 共通の恒久 Do Not Touch。**spec 側から緩められない**。 */
const PERMANENT_DO_NOT_TOUCH = [
  'CLAUDE.md',
  '.claude/**',
  '.github/workflows/**',
  'docs/specs/**',
  'scripts/spec-guard.mjs',
];

/** spec path はこの形以外を一切受け付けない (全 mode 共通)。 */
const SPEC_PATH_RE = /^docs\/specs\/WF-\d{4}\.md$/;

const REQUIRED_META = ['spec_id', 'status', 'repo', 'base_branch', 'baseline_sha', 'depends_on'];

/** §1〜§13 の見出し。**`_TEMPLATE.md` を正本として固定**。同義語を認めない。 */
const REQUIRED_SECTIONS = [
  '## 1. Objective',
  '## 2. Direct Confirmed Facts',
  '## 3. Derived Confirmed Facts',
  '## 4. Unknown / Assumptions',
  '## 5. External Evidence Required',
  '## 6. Scope',
  '## 7. Do Not Touch',
  '## 8. Design Decision',
  '## 9. Implementation Requirements',
  '## 10. Acceptance Criteria',
  '## 11. Verification Commands',
  '## 12. Stop Conditions',
  '## 13. Sources / Evidence',
];

const EE_REQUIRED = ['required_fact', 'source', 'status', 'collected_by', 'collected_at', 'max_age_hours', 'evidence'];
const EE_STATUS = ['resolved', 'unresolved'];
const EE_COLLECTED_BY = ['human', 'trusted-readonly-connector'];
const VERIFY_REQUIRED = ['kind', 'command', 'expected_baseline', 'expected_after'];
const VERIFY_KINDS = ['static', 'behavioral'];

/** ISO8601 UTC (Z 終端) のみ。Date.parse の広い許容に頼らない。 */
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const errors = [];
const notes = [];
const fail = (code, msg) => errors.push(`[${code}] ${msg}`);
const note = (msg) => notes.push(msg);

// ══════════════════════════════════════════════════════════════════════
// path 安全性 — **Do Not Touch 判定より前**に、path 自体の安全を保証する
// ══════════════════════════════════════════════════════════════════════
/**
 * repository root からの正規化済み POSIX 相対パスだけを認める。
 * 危険な形は**意味を解釈せず拒否**する。
 */
function pathSafetyError(p) {
  if (typeof p !== 'string' || p === '') return '空のパス';
  if (p.includes('\\')) return 'backslash を含む (Windows 形式は不可)';
  if (p.startsWith('/')) return '絶対パス';
  if (/^[A-Za-z]:/.test(p)) return 'ドライブレター付き絶対パス';
  if (p.startsWith('~')) return 'ホーム展開 (~) を含む';
  const segs = p.split('/');
  if (segs.some((s) => s === '..')) return '.. を含む';
  if (segs.some((s) => s === '.')) return './ を含む';
  if (segs.some((s) => s === '')) return '空のセグメントを含む (// または末尾 /)';
  if (p.includes('\0')) return 'NUL を含む';
  return null;
}

/** 全 mode 共通の spec path 検査。**scope / snapshot / verify-clean も同じ制約**。 */
function assertSpecPath(specPath) {
  const unsafe = pathSafetyError(specPath);
  if (unsafe) { fail('PATH-003', `spec path が安全でない: ${specPath} — ${unsafe}`); return false; }
  if (!SPEC_PATH_RE.test(specPath)) { fail('PATH-001', `spec path は docs/specs/WF-NNNN.md のみ許可: ${specPath}`); return false; }
  if (!existsSync(specPath)) { fail('PATH-002', `spec が存在しない: ${specPath}`); return false; }
  return true;
}

// ── 極小 glob: `**` と `*` だけ ──────────────────────────────────────
function globToRe(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i += 1; } else { out += '[^/]*'; }
    } else if ('\\^$.|?+()[]{}'.includes(c)) { out += `\\${c}`; } else { out += c; }
  }
  return new RegExp(`${out}$`);
}
const matchesAny = (p, globs) => globs.some((g) => globToRe(g).test(p));

// ══════════════════════════════════════════════════════════════════════
// front matter (厳格)
// ══════════════════════════════════════════════════════════════════════
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') { fail('META-001', 'front matter が 1 行目の `---` で始まっていない'); return null; }
  const end = lines.indexOf('---', 1);
  if (end === -1) { fail('META-002', 'front matter の終端 `---` が無い'); return null; }
  const meta = {};
  for (let i = 1; i < end; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const m = /^([a-z_]+): (.*)$/.exec(line);
    if (!m) { fail('META-003', `metadata の構文が不正 (${i + 1} 行目): ${JSON.stringify(line)} — 許可形式は "key: value" のみ`); continue; }
    if (meta[m[1]] !== undefined) { fail('META-004', `metadata キーが重複: ${m[1]}`); continue; }
    meta[m[1]] = m[2];
  }
  return meta;
}

// ══════════════════════════════════════════════════════════════════════
// フェンスブロック parser (fail-closed)
// ══════════════════════════════════════════════════════════════════════
/**
 * すべての ``` フェンスを走査する。
 * - **閉じられていないフェンスは FAIL** (EOF まで読み進めて黙って受理しない)
 * - info string は `tag` と `id` に分解する
 */
function parseFenced(text) {
  const lines = text.split('\n');
  const blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^```/.test(line)) { if (open) open.body.push(line); continue; }
    if (open === null) {
      const info = line.slice(3).trim();
      const parts = info === '' ? [] : info.split(/\s+/);
      open = { tag: parts[0] ?? '', id: parts[1] ?? null, extra: parts.slice(2), body: [], startLine: i + 1 };
    } else {
      if (line.trim() !== '```') { fail('BLK-005', `フェンス終端に余分な文字がある (${i + 1} 行目): ${JSON.stringify(line)}`); }
      open.endLine = i + 1;
      blocks.push(open);
      open = null;
    }
  }
  if (open !== null) fail('BLK-001', `閉じられていないフェンスブロック (${open.startLine} 行目 \`\`\`${open.tag}) — EOF まで読み進めない`);
  return blocks;
}

/** 指定 tag のブロックだけを返す。**id 重複は FAIL**。 */
function blocksOfTag(blocks, tag, { requireId = true } = {}) {
  const out = blocks.filter((b) => b.tag === tag);
  const seen = new Set();
  for (const b of out) {
    if (b.extra.length > 0) fail('BLK-006', `${tag} ブロックの info string に余分な語がある (${b.startLine} 行目): ${b.extra.join(' ')}`);
    if (requireId) {
      if (!b.id) { fail('BLK-002', `${tag} ブロックに id が無い (${b.startLine} 行目)`); continue; }
      if (seen.has(b.id)) { fail('BLK-003', `${tag} ブロックの id が重複: ${b.id} (${b.startLine} 行目)`); continue; }
      seen.add(b.id);
    }
  }
  return out;
}

/**
 * `key: value` 行だけを受ける。**不正行を黙って無視しない。key 重複は後勝ちにしない**。
 */
function blockKV(block, tag) {
  const kv = {};
  for (let i = 0; i < block.body.length; i += 1) {
    const line = block.body[i];
    if (line.trim() === '') continue;
    const m = /^([a-z_]+): (.*)$/.exec(line);
    if (!m) {
      fail('BLK-004', `${tag} ${block.id ?? ''} の ${block.startLine + 1 + i} 行目が "key: value" でない: ${JSON.stringify(line)}`);
      continue;
    }
    if (kv[m[1]] !== undefined) {
      fail('BLK-007', `${tag} ${block.id ?? ''} で key が重複: ${m[1]} — 後勝ちを認めない`);
      continue;
    }
    kv[m[1]] = m[2];
  }
  return kv;
}

function requireKeys(kv, keys, code, label) {
  for (const k of keys) if (kv[k] === undefined) fail(code, `${label}: ${k} が無い`);
}

// ── git ───────────────────────────────────────────────────────────────
function git(args) {
  try { return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim(); }
  catch { return null; }
}
/**
 * trim しない git。**porcelain には必須**。
 * `git status --porcelain` の未ステージ変更は先頭が空白 (" M path") なので、
 * 出力全体を trim すると **1 行目だけ 1 文字ずれてパスが壊れる** (PoC-1 で実測)。
 */
function gitRaw(args) {
  try { return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }); }
  catch { return null; }
}
function gitOk(args) {
  try { execFileSync('git', args, { cwd: REPO_ROOT, stdio: 'ignore' }); return true; }
  catch { return false; }
}
/**
 * `-uall` が必須。既定 (-unormal) は**未追跡ディレクトリを畳む** ("?? src/newdir/") ため、
 * spec の scope が書くファイルパスと一致せず**誤って Scope violation になる** (PoC-1 で実測)。
 */
const porcelain = () => (gitRaw(['status', '--porcelain', '-uall']) ?? '')
  .split('\n').filter((l) => l.trim() !== '').map((l) => l.replace(/\r$/, ''));

// ══════════════════════════════════════════════════════════════════════
// scope / do_not_touch
// ══════════════════════════════════════════════════════════════════════
function parseScope(blocks) {
  const found = blocks.filter((b) => b.tag === 'scope');
  if (found.length === 0) { fail('SCOPE-001', '```scope ブロックが無い'); return null; }
  if (found.length > 1) { fail('SCOPE-002', '```scope ブロックが複数ある'); return null; }
  const scope = { modify: [], create: [], delete: [] };
  const seen = new Set();
  for (let i = 0; i < found[0].body.length; i += 1) {
    const line = found[0].body[i];
    if (line.trim() === '') continue;
    const m = /^(modify|create|delete) (\S+)$/.exec(line);
    if (!m) { fail('SCOPE-003', `scope 行の構文が不正: ${JSON.stringify(line)} — "<modify|create|delete> <path>" のみ`); continue; }
    const [, kind, p] = m;
    const unsafe = pathSafetyError(p);
    if (unsafe) { fail('SCOPE-005', `scope.${kind} のパスが安全でない: ${p} — ${unsafe}`); continue; }
    const key = `${kind} ${p}`;
    if (seen.has(key)) { fail('SCOPE-006', `scope に重複した宣言: ${key}`); continue; }
    seen.add(key);
    if (matchesAny(p, PERMANENT_DO_NOT_TOUCH)) {
      fail('SCOPE-004', `scope.${kind} が恒久 Do Not Touch を宣言している: ${p} — spec 側から緩められない`);
      continue;
    }
    scope[kind].push(p);
  }
  return scope;
}

function parseExtraDoNotTouch(blocks) {
  const out = [];
  for (const b of blocks.filter((x) => x.tag === 'do_not_touch')) {
    for (const line of b.body) {
      const t = line.trim();
      if (t === '') continue;
      const unsafe = pathSafetyError(t.replace(/\*+$/, 'x'));
      if (unsafe) { fail('DNT-002', `do_not_touch のパスが安全でない: ${t} — ${unsafe}`); continue; }
      out.push(t);
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// validate
// ══════════════════════════════════════════════════════════════════════
function modeValidate(specPath) {
  const text = readFileSync(specPath, 'utf8');
  const meta = parseFrontMatter(text);
  const blocks = parseFenced(text);

  // ── 必須 13 セクション: 存在 / 重複なし / 順序 1→13 ──
  const lines = text.split('\n');
  const seenAt = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const h = lines[i].replace(/\s+$/, '');
    if (!/^## /.test(h)) continue;
    if (!REQUIRED_SECTIONS.includes(h)) continue;
    if (seenAt.has(h)) { fail('SEC-002', `必須セクションが重複: ${h} (${i + 1} 行目)`); continue; }
    seenAt.set(h, i);
  }
  for (const h of REQUIRED_SECTIONS) if (!seenAt.has(h)) fail('SEC-001', `必須セクションが無い: ${h}`);
  const order = REQUIRED_SECTIONS.filter((h) => seenAt.has(h)).map((h) => seenAt.get(h));
  for (let i = 1; i < order.length; i += 1) {
    if (order[i] < order[i - 1]) { fail('SEC-003', '必須セクションの順序が 1→13 になっていない'); break; }
  }

  if (!meta) return;

  // ── metadata ──
  requireKeys(meta, REQUIRED_META, 'META-010', 'metadata');
  for (const k of Object.keys(meta)) if (!REQUIRED_META.includes(k)) fail('META-011', `未知の metadata キー: ${k}`);
  const fileId = specPath.replace(/^.*\//, '').replace(/\.md$/, '');
  if (meta.spec_id && meta.spec_id !== fileId) fail('META-012', `spec_id (${meta.spec_id}) がファイル名 (${fileId}) と一致しない`);
  if (meta.spec_id && !/^WF-\d{4}$/.test(meta.spec_id)) fail('META-013', `spec_id の形式が不正: ${meta.spec_id}`);
  if (meta.status !== undefined && meta.status !== 'approved') fail('META-020', `status が approved でない: ${meta.status} — 実装開始禁止`);
  if (meta.depends_on !== undefined && !/^\[\]$|^\[WF-\d{4}(, WF-\d{4})*\]$/.test(meta.depends_on)) {
    fail('META-014', `depends_on の形式が不正: ${meta.depends_on} — "[]" または "[WF-0001, WF-0002]"`);
  }
  if (/^repositories:/m.test(text)) fail('REPO-002', 'V1 は 1 spec = 1 repository。repositories[] は使用禁止');

  // ── repo 一致 (**fail-closed**: origin を解決できなければ FAIL。スキップしない) ──
  const remote = git(['remote', 'get-url', 'origin']);
  if (!remote) {
    fail('REPO-003', 'origin remote を取得できない — repo 一致検査をスキップして実装開始することは禁止');
  } else {
    const slug = (remote.replace(/\.git$/, '').match(/([^/:]+\/[^/]+)$/) ?? [])[1] ?? null;
    if (!slug) fail('REPO-004', `origin から owner/name を解決できない: ${remote}`);
    else if (meta.repo && meta.repo.toLowerCase() !== slug.toLowerCase()) {
      fail('REPO-001', `repo が一致しない: spec=${meta.repo} / origin=${slug}`);
    }
  }

  // ── base_branch / baseline_sha ──
  let baseRef = null;
  if (meta.base_branch) {
    for (const cand of [`origin/${meta.base_branch}`, meta.base_branch]) {
      if (git(['rev-parse', '--verify', `${cand}^{commit}`])) { baseRef = cand; break; }
    }
    if (!baseRef) fail('GIT-001', `base_branch が存在しない: ${meta.base_branch}`);
  }
  let shaOk = false;
  if (meta.baseline_sha) {
    shaOk = !!git(['rev-parse', '--verify', `${meta.baseline_sha}^{commit}`]);
    if (!shaOk) fail('GIT-002', `baseline_sha が repository に存在しない: ${meta.baseline_sha}`);
  }
  // baseline_sha が base_branch の履歴上にあること
  if (shaOk && baseRef) {
    if (!gitOk(['merge-base', '--is-ancestor', meta.baseline_sha, baseRef])) {
      fail('GIT-003', `baseline_sha (${meta.baseline_sha}) が base_branch (${meta.base_branch}) の ancestor でない`);
    }
  }

  // ── §13 Sources: baseline 以降に変更されていないか ──
  if (shaOk && baseRef) checkSources(text, meta.baseline_sha, baseRef);

  // ── External Evidence (厳格) ──
  for (const b of blocksOfTag(blocks, 'external_evidence')) {
    const id = b.id ?? '(id無し)';
    const kv = blockKV(b, 'external_evidence');
    requireKeys(kv, EE_REQUIRED, 'EE-010', id);
    if (kv.status !== undefined && !EE_STATUS.includes(kv.status)) fail('EE-011', `${id}: status が不正: ${kv.status} — ${EE_STATUS.join(' | ')}`);
    if (kv.status === 'unresolved') fail('EE-001', `${id}: status が unresolved — 実装開始禁止`);
    if (kv.collected_by !== undefined && !EE_COLLECTED_BY.includes(kv.collected_by)) fail('EE-012', `${id}: collected_by が不正: ${kv.collected_by} — ${EE_COLLECTED_BY.join(' | ')}`);
    if (kv.collected_at !== undefined && !ISO_UTC_RE.test(kv.collected_at)) fail('EE-004', `${id}: collected_at が ISO8601 UTC (Z 終端) でない: ${kv.collected_at}`);
    if (kv.max_age_hours !== undefined && kv.max_age_hours !== 'null') {
      if (!/^[1-9]\d*$/.test(kv.max_age_hours)) {
        fail('EE-003', `${id}: max_age_hours は null または 0 より大きい整数のみ: ${kv.max_age_hours}`);
      } else if (ISO_UTC_RE.test(kv.collected_at ?? '')) {
        const ageH = (Date.now() - Date.parse(kv.collected_at)) / 3_600_000;
        if (ageH > Number(kv.max_age_hours)) fail('EE-005', `${id}: 期限切れ (経過 ${ageH.toFixed(1)}h > ${kv.max_age_hours}h) — 実装開始禁止`);
      }
    }
  }

  // ── Direct Fact ──
  for (const b of blocksOfTag(blocks, 'direct_fact')) {
    const kv = blockKV(b, 'direct_fact');
    requireKeys(kv, ['claim', 'evidence'], 'DF-001', b.id ?? '(id無し)');
  }
  // ── Derived Fact ──
  for (const b of blocksOfTag(blocks, 'derived_fact')) {
    const kv = blockKV(b, 'derived_fact');
    requireKeys(kv, ['claim', 'evidence', 'reproduce', 'expected'], 'RF-001', b.id ?? '(id無し)');
  }

  // ── Verification ──
  const verifyIds = new Set();
  for (const b of blocksOfTag(blocks, 'verification')) {
    const id = b.id ?? '(id無し)';
    if (b.id) verifyIds.add(b.id);
    const kv = blockKV(b, 'verification');
    requireKeys(kv, VERIFY_REQUIRED, 'VER-010', id);
    if (kv.kind !== undefined && !VERIFY_KINDS.includes(kv.kind)) fail('VER-001', `${id}: kind が不正: ${kv.kind} — ${VERIFY_KINDS.join(' | ')}`);
  }
  // ── Acceptance ──
  for (const b of blocksOfTag(blocks, 'acceptance')) {
    const id = b.id ?? '(id無し)';
    const kv = blockKV(b, 'acceptance');
    requireKeys(kv, ['criterion', 'verified_by'], 'AC-010', id);
    if (kv.verified_by !== undefined && !verifyIds.has(kv.verified_by)) {
      fail('AC-011', `${id}: verified_by が実在しない Verification ID を指している: ${kv.verified_by}`);
    }
  }

  parseScope(blocks);
  parseExtraDoNotTouch(blocks);
}

/**
 * §13 Sources / Evidence の各項目のうち、**repository 相対パスとして機械認識できるものだけ**を
 * baseline..base の間で変更されていないか検査する。
 * **曖昧な文字列をパスだと推論しない** — 認識できなかった項目は note に出す (黙って無視しない)。
 */
function checkSources(text, baselineSha, baseRef) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.replace(/\s+$/, '') === '## 13. Sources / Evidence');
  if (start === -1) return;
  for (let i = start + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (/^## /.test(raw)) break;
    const m = /^\s*-\s+(.*)$/.exec(raw);
    if (!m) continue;
    const item = m[1].trim();
    if (item === '') continue;
    if (/^https?:\/\//i.test(item)) { note(`Sources: 外部 URL のため対象外 — ${item}`); continue; }
    // 拡張子つきの先頭トークンだけをパス候補とみなす (行番号 :12-34 は落とす)
    const cand = (/^([A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]+)(?::|\s|$)/.exec(item) ?? [])[1];
    if (!cand) { note(`Sources: パスとして機械認識できないため対象外 — ${item}`); continue; }
    if (pathSafetyError(cand)) { fail('SRC-003', `Sources のパスが安全でない: ${cand}`); continue; }
    if (!existsSync(cand)) { fail('SRC-001', `Sources が指すファイルが存在しない: ${cand}`); continue; }
    const changed = git(['log', '--oneline', `${baselineSha}..${baseRef}`, '--', cand]);
    if (changed) fail('SRC-002', `Sources が baseline 以降に変更されている: ${cand} (${changed.split('\n').length} commit)`);
  }
}

// ══════════════════════════════════════════════════════════════════════
// scope (実装後)
// ══════════════════════════════════════════════════════════════════════
function classify(line) {
  const x = line.slice(0, 2);
  const p = line.slice(3).trim().replace(/^"|"$/g, '');
  let kind;
  if (x.includes('D')) kind = 'delete';
  else if (x.includes('?') || x.includes('A')) kind = 'create';
  else kind = 'modify';
  return { kind, path: p };
}

function modeScope(specPath) {
  const text = readFileSync(specPath, 'utf8');
  const blocks = parseFenced(text);
  const scope = parseScope(blocks);
  if (scope === null) return;
  const dnt = [...PERMANENT_DO_NOT_TOUCH, ...parseExtraDoNotTouch(blocks)];

  const cur = new Set(porcelain());
  const baseFile = process.env.SPEC_GUARD_BASELINE;
  if (baseFile && existsSync(baseFile)) {
    for (const l of readFileSync(baseFile, 'utf8').split('\n')) if (l.trim() !== '') cur.delete(l.replace(/\r$/, ''));
    note(`SPEC_GUARD_BASELINE を適用 (${baseFile})`);
  }
  if (cur.size === 0) note('実装差分なし (working tree に変更が無い)');

  for (const line of cur) {
    const c = classify(line);
    // path 安全性を最初に見る (Do Not Touch 判定より前)
    const unsafe = pathSafetyError(c.path);
    if (unsafe) { fail('PATH-004', `変更されたパスが安全でない: ${c.path} — ${unsafe}`); continue; }
    if (matchesAny(c.path, dnt)) { fail('DNT-001', `Do Not Touch への変更: ${c.kind} ${c.path}`); continue; }
    if (!scope[c.kind].includes(c.path)) {
      fail('SCOPE-010', `Scope 外の ${c.kind}: ${c.path} (spec の scope.${c.kind} に無い)`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// snapshot / verify-clean — Verification 自身が tree を汚していないかを機械比較
// ══════════════════════════════════════════════════════════════════════
function modeSnapshot() {
  process.stdout.write(`${porcelain().join('\n')}\n`);
}

function modeVerifyClean(snapFile) {
  if (!snapFile) { fail('VC-000', 'snapshot ファイルが指定されていない'); return; }
  if (!existsSync(snapFile)) { fail('VC-001', `snapshot ファイルが存在しない: ${snapFile}`); return; }
  const before = readFileSync(snapFile, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => l.replace(/\r$/, ''));
  const after = porcelain();
  const b = new Set(before);
  const a = new Set(after);
  const added = after.filter((l) => !b.has(l));
  const removed = before.filter((l) => !a.has(l));
  if (added.length === 0 && removed.length === 0) { note('Verification は working tree を変更していない'); return; }
  for (const l of added) fail('VC-010', `Verification 後に増えた変更: ${l}`);
  for (const l of removed) fail('VC-011', `Verification 後に消えた変更: ${l}`);
}

// ── entry ─────────────────────────────────────────────────────────────
const [mode, specPath, extraArg] = process.argv.slice(2);
const MODES = ['validate', 'scope', 'snapshot', 'verify-clean'];
if (!mode || !specPath) {
  console.error('usage: node scripts/spec-guard.mjs <validate|scope|snapshot|verify-clean> <docs/specs/WF-NNNN.md> [snapshot-file]');
  process.exit(2);
}
if (!MODES.includes(mode)) { console.error(`unknown mode: ${mode}`); process.exit(2); }

// **全 mode 共通**の spec path 制約
if (assertSpecPath(specPath)) {
  if (mode === 'validate') modeValidate(specPath);
  else if (mode === 'scope') modeScope(specPath);
  else if (mode === 'snapshot') modeSnapshot();
  else if (mode === 'verify-clean') modeVerifyClean(extraArg);
}

const out = mode === 'snapshot' ? console.error : console.log;
out(`spec-guard ${mode} — ${specPath}`);
for (const n of notes) out(`  note: ${n}`);
if (errors.length === 0) { out('  ✓ PASS'); process.exit(0); }
for (const e of errors) out(`  ✗ ${e}`);
out(`  FAIL (${errors.length} 件)`);
process.exit(1);
