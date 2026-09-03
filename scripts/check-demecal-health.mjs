/**
 * デメカル無人取得の **監視口** (Phase C / C-6)。
 *
 * 実行:
 *   node scripts/check-demecal-health.mjs --fixture <path.json>        # 完全ローカル
 *   node scripts/check-demecal-health.mjs --url https://... --key ...  # 実運用
 *
 * 終了コード:
 *   0  … 異常なし
 *   1  … 異常あり (STALE / LAST_RUN_FAILED / NO_RUN_HISTORY / CERT_EXPIRING /
 *                  MONITOR_SOURCE_ERROR)
 *   2  … 使い方の誤り (引数不足など)
 *
 * 【なぜ「JSON が返ること」で終わりにしないか】無人運用の監視は
 * **人が見ていない**前提なので、`health` を画面に出すだけでは
 * 「誰も見ていない健康情報」が増えるだけで、止まっていることに気づけない。
 * **機械が 0 / 非 0 で答えられる口**を作って初めて見張りになる
 * (既存の確定事項どおり、通知基盤は作らず GitHub Actions の
 *  ワークフロー失敗を見張りに使う)。
 *
 * 【判定はここに書かない】判定は `src/lib/demecal-health.ts` の
 * `evaluateDemecalHealth` が単独で持つ。この CLI がやるのは
 * 取ってくる / 渡す / 出す / 終了コードを返す の 4 つだけ。
 * そうしておくと、判定は fixture だけで完全に検査できる。
 *
 * 【出すもの・出さないもの】出すのは判定結果 (`summary` と verdict) だけ。
 * **応答の生 JSON を出す口を用意しない** — `runs[].error` / `diag` は
 * API 側で長さを切ってあるが、監視の出力は CI のログやメールに載って
 * 行き先が広い。**鍵も絶対に出さない。**
 *
 * 【鍵】`x-intake-key` (`LAB_INTAKE_API_KEY`) を使う。
 * `ADMIN_API_KEY` はフル権限なので監視には渡さない
 * (`docs/lab/demecal_unattended_spec.md §3.1` と同じ理由)。
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(2);
}

/** `--k v` / `--k=v` / `--flag` を拾う。 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[a.slice(2)] = next; i++; }
    else out[a.slice(2)] = true;
  }
  return out;
}

/**
 * 判定モジュールを読み込む。`demecal-health.ts` は**依存ゼロ**なので
 * transpile だけで足りる (bundle 不要 = 監視の起動を軽くする)。
 * import が生えたらここで気づけるように先に見る。
 */
async function loadEvaluator() {
  const path = resolve(ROOT, 'src/lib/demecal-health.ts');
  let src;
  try { src = readFileSync(path, 'utf8'); }
  catch { die(`判定モジュールが読めません: ${path}`); }
  if (/^\s*import\s.+\sfrom\s/m.test(src)) {
    die('demecal-health.ts が他モジュールを import しています。transpile だけでは読めません (bundle へ切り替えてください)');
  }
  const { transform } = await import('esbuild');
  const { code } = await transform(src, { loader: 'ts', format: 'esm' });
  const dir = resolve(ROOT, 'node_modules/.cache');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, 'demecal-health.mjs');
  writeFileSync(file, code);
  return import(`${pathToFileURL(file).href}?t=${Date.now()}`);
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log([
    'node scripts/check-demecal-health.mjs --fixture <path.json>',
    'node scripts/check-demecal-health.mjs --url <base|full> [--key <LAB_INTAKE_API_KEY>]',
    '',
    '  --now <ISO>   判定に使わない基準時刻 (出力の evaluated_at を固定する)',
    '  --json        verdict を JSON で出す (生の応答は出さない)',
    '',
    '終了コード: 0 = 異常なし / 1 = 異常あり / 2 = 使い方の誤り',
  ].join('\n'));
  process.exit(0);
}

const { evaluateDemecalHealth, DEMECAL_RUN_PATH } = await loadEvaluator();

const now = args.now ? new Date(String(args.now)) : new Date();
if (Number.isNaN(now.getTime())) die(`--now が日時として読めません: ${args.now}`);

let payload = null;
let getError;

if (args.fixture) {
  // ローカル検査。**ここだけで全ケースを通せる**ようにしておく (実機も鍵も要らない)。
  try { payload = JSON.parse(readFileSync(resolve(String(args.fixture)), 'utf8')); }
  catch (e) { getError = `fixture が読めません: ${e instanceof Error ? e.message : String(e)}`; }
} else if (args.url) {
  const base = String(args.url).replace(/\/+$/, '');
  const url = base.includes(DEMECAL_RUN_PATH) ? String(args.url) : `${base}${DEMECAL_RUN_PATH}`;
  const key = args.key !== undefined && args.key !== true
    ? String(args.key)
    : (process.env.LAB_INTAKE_API_KEY || '');
  if (!key) die('鍵がありません (--key か環境変数 LAB_INTAKE_API_KEY)');
  try {
    // **鍵は URL に載せずヘッダで送る** (URL はログ・履歴に残る)。
    const res = await fetch(url, {
      headers: { 'x-intake-key': key, accept: 'application/json' },
    });
    if (!res.ok) {
      // 本文は出さない (何が入っているか保証できない)。状態だけ。
      getError = `HTTP ${res.status}`;
    } else {
      try { payload = await res.json(); }
      catch { getError = '応答を JSON として読めません'; }
    }
  } catch (e) {
    getError = `到達できません: ${e instanceof Error ? e.message : String(e)}`;
  }
} else {
  die('--fixture か --url のどちらかが要ります (--help)');
}

const verdict = evaluateDemecalHealth(payload, now, getError);

if (args.json) {
  console.log(JSON.stringify(verdict, null, 2));
} else {
  console.log(verdict.summary);
  for (const a of verdict.alerts) console.log(`  - ${a.code}: ${a.detail}`);
}

process.exit(verdict.ok ? 0 : 1);
