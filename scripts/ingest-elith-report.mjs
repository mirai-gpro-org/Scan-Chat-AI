#!/usr/bin/env node
/**
 * 受領した AI疾病予防報告書 (Elith) を **実データとして取り込む** 一度きりのスクリプト。
 *
 * 正本: docs/elith/AI疾病予防報告書_仕様書.md §4.5
 *
 * 【なぜ要るか】本番は「本番相当」の設定に切り替わっていて (`13a8a95`)、
 *   **受領サンプルは admin/デモ許可 uid にしか出ない**。実データが 1 件も無いと
 *   `/report` は仕様どおり「材料が無い章は出さない」で **ほぼ空の紙面**になる
 *   (2026-08-30 実測。`emptyVM` = 主軸の帯と主軸 A の 1 枚だけ)。
 *   → **サンプルのゲートを緩めるのではなく、材料を実データとして入れる**のが正しい解き方。
 *      本番と同じ経路 (`POST /api/admin/elith-report/upload`) を通るので、
 *      表示も本番と同じ「実データの紙面」になる (`サンプル表示` バッジも出ない)。
 *
 * 【送るもの】リポジトリ同梱の受領 2026-08-26 分。**中身は 1 バイトも加工しない。**
 *   src/data/elith/report_text_20260826.json      → report        (jsonb)
 *   src/data/elith/health_checkup_20260826.json   → checkup_values (jsonb)
 *   docs/elith/2026_08_26_Elith_健康アドバイスレポート.pdf → 原本保管 (任意・--no-pdf で外す)
 *
 * 【キーの扱い】`ADMIN_API_KEY` は **Vercel の環境変数が正**。
 *   このスクリプトはそれを引数か環境変数で受け取るだけで、**どこにも保存しない**。
 *
 * 使い方:
 *   node scripts/ingest-elith-report.mjs --uid <diagnostic_user_id> --key <ADMIN_API_KEY>
 *
 *   --uid   取り込み先。**`/dashboard` の「デバッグ (テストフェーズ確認用)」に出ている
 *           `diagnostic_user_id` をそのまま貼る。**
 *   --key   省略時は環境変数 ADMIN_API_KEY
 *   --base  既定 https://scan-chat-ai.vercel.app
 *   --no-pdf / --dry-run
 *
 * 【この API は世代管理をする】同じユーザーの既存行を `superseded` に落として新しい行を足す。
 *   何度流しても行が積み上がるだけで、表示は常に最新 1 件 (spec の「表示は常に最新版 1 件」)。
 */

import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const REPORT_TEXT = 'src/data/elith/report_text_20260826.json';
const HEALTH_CHECKUP = 'src/data/elith/health_checkup_20260826.json';
const PDF = 'docs/elith/2026_08_26_Elith_健康アドバイスレポート.pdf';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const uid = (arg('uid') ?? '').trim();
const key = (arg('key') ?? process.env.ADMIN_API_KEY ?? '').trim();
const base = (arg('base') ?? 'https://scan-chat-ai.vercel.app').replace(/\/+$/, '');
const withPdf = !has('no-pdf');
const dryRun = has('dry-run');

const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

if (!UUID_RE.test(uid)) {
  die('--uid に diagnostic_user_id (UUID) を渡してください。\n'
    + '  /dashboard の「デバッグ (テストフェーズ確認用)」に出ています。');
}
if (!dryRun && !key) die('--key か環境変数 ADMIN_API_KEY が要ります (値は Vercel の環境変数が正)。');

const form = new FormData();
form.set('diagnostic_user_id', uid);

for (const [field, rel] of [['report_text', REPORT_TEXT], ['health_checkup', HEALTH_CHECKUP]]) {
  const raw = await readFile(resolve(ROOT, rel), 'utf8');
  try { JSON.parse(raw); } catch { die(`${rel} が JSON として壊れています`); }
  form.set(field, raw);                       // 加工しない。受領したままを送る
  console.log(`  ${field.padEnd(15)} ${rel} (${raw.length.toLocaleString()} 字)`);
}

if (withPdf) {
  try {
    const bytes = await readFile(resolve(ROOT, PDF));
    form.set('file', new Blob([bytes], { type: 'application/pdf' }), basename(PDF));
    console.log(`  ${'file'.padEnd(15)} ${PDF} (${(bytes.length / 1024).toFixed(0)} KB)`);
  } catch {
    console.log(`  ${'file'.padEnd(15)} (見つからないので省略。PDF は任意)`);
  }
}

console.log(`\n宛先: POST ${base}/api/admin/elith-report/upload`);
console.log(`取込先 uid: ${uid}`);
if (dryRun) { console.log('\n--dry-run のため送信しませんでした。'); process.exit(0); }

const res = await fetch(`${base}/api/admin/elith-report/upload`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}` },
  body: form,
}).catch((e) => die(`送信できませんでした: ${e.message}`));

const text = await res.text();
let body; try { body = JSON.parse(text); } catch { body = text; }

if (!res.ok || body?.ok === false) {
  console.error(`\n✗ ${res.status}`);
  console.error(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  process.exit(1);
}
console.log(`\n✓ ${res.status} 取り込みました`);
console.log(JSON.stringify(body, null, 2));
console.log('\n→ /report を開くと、実データの紙面が出ます (「サンプル表示」バッジは出ません)。');
