/**
 * 回帰チェック: 取り込み専用キー `LAB_INTAKE_API_KEY` のスコープを固定する。
 *
 * 実行: npx tsx scripts/verify-intake-scope.ts   (npm run verify:intake-scope)
 * 正本: `docs/lab/demecal_unattended_spec.md §3.1`
 *
 * 【なぜ要るか】このキーは**専用PC に置きっぱなしになる**。通る口が増えても
 * 画面上は何も変わらないので、**静かに壊れる**。だから「増えたら落ちる」形で固定する。
 *
 * 見るのは 2 点だけ:
 *   ① 通ってよい 3 つの口が `isLabIntakeEndpointAuthorized` を使っていること
 *   ② **それ以外の admin/partner API が intake 認可に触れていないこと**
 *      (`isIntakeAuthorized` / `isLabIntakeEndpointAuthorized` / `x-intake-key` のいずれも)
 *
 * サーバを立てずにソースを読むだけで済ませる。実行の速さより
 * 「CI でも手元でも必ず動く」ことを優先した (鍵も DB も要らない)。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/** intake キーで通ってよい口。**ここを増やすときは spec §3.1 も直すこと。** */
const ALLOWED = [
  'src/pages/api/admin/demecal-state.ts',
  'src/pages/api/admin/elith-blood-csv.ts',
  'src/pages/api/admin/demecal-run.ts',
];

/**
 * **intake キーを「受け付ける」側**の語。1 つでも出たら「認可に使っている」とみなす。
 * ここが増えると鍵のスコープが黙って広がるので、ALLOWED 以外では 1 つも許さない。
 */
const AUTH_MARKERS = ['isIntakeAuthorized', 'isLabIntakeEndpointAuthorized', 'x-intake-key'];

/**
 * **鍵を「配る」側**の語 (env を読んで bat へ焼き込む)。受け付けるのとは別物。
 * 配布は 1 箇所だけであるべきなので、ここも列挙して固定する。
 */
const DIST_MARKER = 'LAB_INTAKE_API_KEY';
const DIST_ALLOWED = ['src/pages/api/ops/probe-bat.ts'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|astro)$/.test(name)) out.push(p);
  }
  return out;
}

const failures: string[] = [];
const notes: string[] = [];

// ── ① 通ってよい 3 つ ─────────────────────────────────────
for (const rel of ALLOWED) {
  const p = resolve(ROOT, rel);
  let src: string;
  try { src = readFileSync(p, 'utf8'); }
  catch { failures.push(`${rel}: ファイルが無い (口を消したなら ALLOWED からも外す)`); continue; }
  if (!src.includes('isLabIntakeEndpointAuthorized')) {
    failures.push(`${rel}: isLabIntakeEndpointAuthorized を使っていない (intake キーで通らない)`);
  } else {
    notes.push(`OK  ${rel}`);
  }
}

// ── ② それ以外は触れていないこと ──────────────────────────
const apiDir = resolve(ROOT, 'src/pages/api');
for (const p of walk(apiDir)) {
  const rel = relative(ROOT, p).split('\\').join('/');
  if (ALLOWED.includes(rel)) continue;
  const src = readFileSync(p, 'utf8');
  const hit = AUTH_MARKERS.filter((m) => src.includes(m));
  if (hit.length > 0) {
    failures.push(`${rel}: intake 認可を受け付けている (${hit.join(', ')})。この口は intake キーで通してはいけない`);
  }
  // 鍵の**配布**は許可した 1 箇所だけ。増えたら落とす。
  if (src.includes(DIST_MARKER) && !DIST_ALLOWED.includes(rel)) {
    failures.push(`${rel}: ${DIST_MARKER} を読んでいる。鍵を配ってよいのは ${DIST_ALLOWED.join(', ')} だけ`);
  }
}

// 配布口は**鍵を配るだけ**で、**認可には使っていない**こと。
for (const rel of DIST_ALLOWED) {
  const src = readFileSync(resolve(ROOT, rel), 'utf8');
  const hit = AUTH_MARKERS.filter((m) => src.includes(m));
  if (hit.length > 0) failures.push(`${rel}: 配布口が intake 認可も受け付けている (${hit.join(', ')})`);
  else notes.push(`OK  ${rel} (鍵の配布のみ)`);
}

// `api-auth.ts` 自身は実装なので対象外。ただし**関数が存在すること**は確かめる。
const auth = readFileSync(resolve(ROOT, 'src/lib/api-auth.ts'), 'utf8');
for (const fn of ['isIntakeAuthorized', 'isLabIntakeEndpointAuthorized', 'intakeApiKey']) {
  if (!auth.includes(`export function ${fn}`)) failures.push(`api-auth.ts: ${fn} が無い`);
}
// **未設定でも dev 素通しをしていないこと。** ここが緩むと PC 用の鍵に抜け道ができる。
const intakeBody = auth.slice(auth.indexOf('export function isIntakeAuthorized'));
if (/isDevServer\(\)/.test(intakeBody.slice(0, 500))) {
  failures.push('api-auth.ts: isIntakeAuthorized に dev 素通しがある (PC 用の鍵に抜け道を作らない)');
}

for (const n of notes) console.log(n);
if (failures.length > 0) {
  console.error('\n✗ intake スコープ検査 NG:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\n✓ intake スコープ検査 OK (通る口 ${ALLOWED.length} 件のみ)`);
