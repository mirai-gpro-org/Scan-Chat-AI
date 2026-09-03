/**
 * 回帰チェック: 配布口 `/api/ops/probe-bat` の `script` パラメータを fail-closed に保つ。
 *
 * 実行: node scripts/verify-probe-bat-gate.mjs   (npm run verify:probe-bat-gate)
 * 対象: `src/pages/api/ops/probe-bat.ts`
 *
 * 【なぜ要るか — 実障害 2026-09-02】Phase B が実行されなかった真因は
 * **案内メールの中でリンクが `...?k=<token>` までで切れ、`&script=verify` が
 * リンクの外へ落ちた**こと。旧実装は script 省略時に既定 `probe` を返したので、
 * 押した人には**正常にダウンロードできたように見えたまま**、意図と違う
 * 旧 `demecal-check v1.0` が配られた。**専用PC の実行を 1 回無駄にした。**
 *
 * この種は静かに壊れる — 200 が返り、bat も動くので、誰も異常に気づけない。
 * だから「既定値を足したら落ちる」形で機械に見張らせる。
 *
 * 【やりかた】サーバは立てず、**ルートの GET を実際に呼んで status を見る**。
 * ソースの目視 (正規表現) では「既定値が復活した」を確実には捕まえられない。
 *   ・`.ps1?raw` は Vite の記法で node が解決できないので、esbuild の
 *     resolve/load プラグインで**実ファイルをそのまま文字列として**渡す
 *     (スタブにしない = `$Version` も `buildProbeBat` も本物を通る)。
 *   ・env は本物を使わずこの場で与える。DB も鍵も要らない。
 */

import { build } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
if (!existsSync(resolve(ROOT, 'package.json'))) {
  console.error(`✗ リポジトリ直下で実行してください (cwd=${ROOT})`);
  process.exit(1);
}

const ROUTE = 'src/pages/api/ops/probe-bat.ts';
const OUT = resolve(ROOT, 'node_modules/.cache/verify-probe-bat-gate.mjs');

/** `import X from '....ps1?raw'` を実ファイルの中身へ解決する。 */
const ps1RawPlugin = {
  name: 'ps1-raw',
  setup(b) {
    b.onResolve({ filter: /\.ps1\?raw$/ }, (args) => ({
      path: resolve(args.resolveDir ?? dirname(args.importer), args.path.replace(/\?raw$/, '')),
      namespace: 'ps1-raw',
    }));
    b.onLoad({ filter: /.*/, namespace: 'ps1-raw' }, (args) => ({
      contents: `export default ${JSON.stringify(readFileSync(args.path, 'utf8'))};`,
      loader: 'js',
    }));
  },
};

await build({
  entryPoints: [resolve(ROOT, ROUTE)],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'error',
  // ルートは import.meta.env → process.env の順に読む。前者を潰して後者を使わせる。
  define: { 'import.meta.env': '{}' },
  plugins: [ps1RawPlugin],
});

// 本物の値は使わない。ここで与えた値だけで完結させる。
const TOKEN = 'verify-probe-bat-gate-token';
process.env.PROBE_UPLOAD_TOKEN = TOKEN;
process.env.DEMECAL_USER_ID = 'verify-user';
process.env.DEMECAL_PASSWORD = 'verify-pass';
process.env.LAB_INTAKE_API_KEY = 'verify-intake-key';

const { GET } = await import(`${pathToFileURL(OUT).href}?t=${Date.now()}`);

/** `?k=` は必ず付ける (認可は別の関心事)。query をそのまま繋いだ URL で呼ぶ。 */
async function call(query) {
  const url = new URL(`https://example.invalid/api/ops/probe-bat?k=${TOKEN}${query}`);
  return GET({ url });
}

/**
 * 期待する組み合わせ。**ここが仕様の正**。
 * 「script なし → 400」を消すと Phase B の事故が再発するので、必ず残す。
 */
const CASES = [
  { name: 'script なし',            query: '',                 status: 400, body: 'script is required (probe | recon | daily | verify)' },
  { name: 'script= (空)',           query: '&script=',         status: 400, body: 'script is required' },
  { name: 'script=   (空白のみ)',   query: '&script=%20%20',   status: 400, body: 'script is required' },
  { name: 'script=probe',           query: '&script=probe',    status: 200 },
  { name: 'script=verify',          query: '&script=verify',   status: 200 },
  { name: 'script=recon',           query: '&script=recon',    status: 200 },
  { name: 'script=daily (凍結)',    query: '&script=daily',    status: 409, body: '凍結中' },
  { name: 'script=unknown',         query: '&script=nope',     status: 400, body: 'unknown script' },
  { name: 'script=constructor',     query: '&script=constructor', status: 400, body: 'unknown script' },
];

const failures = [];
for (const c of CASES) {
  let res;
  try { res = await call(c.query); }
  catch (err) { failures.push(`${c.name}: 例外 ${err instanceof Error ? err.message : String(err)}`); continue; }
  const body = res.status === 200 ? '' : await res.text();
  const ok = res.status === c.status && (!c.body || body.includes(c.body));
  const shown = res.status === 200
    ? `200 ${res.headers.get('content-disposition') ?? ''}`.trim()
    : `${res.status} ${JSON.stringify(body.split('\n')[0])}`;
  console.log(`  ${ok ? '✓' : '✗'} ${c.name.padEnd(22)} → ${shown}`);
  if (!ok) failures.push(`${c.name}: 期待 ${c.status}${c.body ? ` / "${c.body}"` : ''} だが ${res.status} / ${JSON.stringify(body)}`);
}

// 認可は script より前に効くこと (script を付けても 401 のまま)。
const unauth = await GET({ url: new URL('https://example.invalid/api/ops/probe-bat?k=wrong&script=verify') });
const unauthOk = unauth.status === 401;
console.log(`  ${unauthOk ? '✓' : '✗'} 誤トークン + script=verify → ${unauth.status}`);
if (!unauthOk) failures.push(`誤トークン: 期待 401 だが ${unauth.status}`);

if (failures.length > 0) {
  console.error(`\n✗ verify-probe-bat-gate FAIL (${failures.length} 件)`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(`\n✓ verify-probe-bat-gate PASS (${CASES.length + 1} ケース)`);
