/**
 * 回帰チェック: デメカル無人取得の**監視判定**を固定する (Phase C / C-6)。
 *
 * 実行: node scripts/verify-demecal-health.mjs   (npm run verify:demecal-health)
 * 対象: `src/lib/demecal-health.ts` / `scripts/check-demecal-health.mjs`
 *
 * 【層は 4 つ】C-5 で学んだとおり、**ソース検査と実行検査は両方要る**。
 *   A. 判定モジュールのソース検査 (時計依存ゼロ / しきい値を作り直していない / PII を出さない)
 *   B. fixture を判定に通す        (状態の出し分け・境界)
 *   C. **CLI を実際に起動する**    (終了コード・ローカル HTTP サーバ相手の実通信)
 *   D. API 契約の固定             (fixture 生成器が `demecal-run.ts` と食い違っていない)
 *
 * D が要るのは、この検査の fixture が**サーバの health 計算を写して**作られているから。
 * 写しである以上、本物が変わったら fixture は黙って古くなる。
 * だから「`STALE_DAYS = 8`」「`stale = days === null || days > STALE_DAYS`」
 * 「`cert_days_left = runs[0]` から」の 3 点をソースで押さえ、
 * 変わったらここが落ちて**人が写しを直しに来る**ようにする。
 */

import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const ROOT = resolve(import.meta.dirname, '..');
const TMP = resolve(ROOT, 'node_modules/.cache/verify-demecal-health');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const fails = [];
let count = 0;
function check(name, cond, extra = '') {
  count++;
  if (!cond) fails.push(`${name}${extra ? ` — ${extra}` : ''}`);
}
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const HEALTH_TS = 'src/lib/demecal-health.ts';
const CLI = 'scripts/check-demecal-health.mjs';
const API = 'src/pages/api/admin/demecal-run.ts';

/* ══ D. API 契約の固定 (fixture 生成器の前提) ══════════════════════ */

const api = read(API);
check('D1 STALE_DAYS=8 が API 側の契約', /const\s+STALE_DAYS\s*=\s*8\b/.test(api),
  'demecal-run.ts のしきい値が変わった → 下の fixture 生成器を写し直す');
check('D2 stale は「一度も成功なし OR days > STALE_DAYS」',
  /stale:\s*days === null \|\| days > STALE_DAYS/.test(api));
check('D3 days_since_success は最後の ok の received_at から',
  /const lastOk = runs\.find\(\(r\) => r\.result === 'ok'\)/.test(api)
  && /Date\.parse\(lastOk\.received_at\)\)\s*\/\s*86_400_000/.test(api));
check('D4 cert_days_left は直近 run から', /cert_days_left:\s*runs\[0\]\?\.cert_days_left \?\? null/.test(api));
check('D5 health が返す 4 つのキーが揃っている',
  ['last_success_at', 'days_since_success', 'cert_days_left', 'stale'].every((k) => api.includes(`${k}:`)));
// C-6 は API を増築しない (`§9`)。GET に新しい集計を足していないことを見る。
check('D6 GET が返すのは ok / runs / health だけ',
  /return json\(\{\s*\n\s*ok: true,\s*\n\s*runs,\s*\n\s*health: \{/.test(api),
  'C-6 で server API を増築していないこと');

/* ══ A. 判定モジュールのソース検査 ════════════════════════════════ */

/**
 * **コメントを落としてから見る。** C-5 で同じ穴を踏んだ:
 * 解説文に `Date.now()` や `STALE_DAYS = 8` と書いてあるだけで検査が誤爆し、
 * 逆に誤爆を避けようと検査を緩めると本体を見なくなる。
 * (初回実行でこの 2 件がまさに誤検知した = この処理が無いと成立しない)
 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const src = stripComments(read(HEALTH_TS));

// **時計依存ゼロ。** 内部で現在時刻を読むと、境界の検査が実行時刻任せになる。
check('A1 Date.now() を呼んでいない', !/Date\.now\(\)/.test(src));
check('A2 引数なしの new Date() を作っていない', !/new Date\(\s*\)/.test(src));
// **しきい値を作り直していない。** 日数を数え直したらサーバと二重管理になる。
check('A3 日数を自前で計算していない', !/86_?400_?000|\/\s*86400|getTime\(\)\s*-/.test(src));
check('A4 STALE の判定は health.stale をそのまま使う', /if \(health\.stale\)/.test(src));
check('A5 stale の日数しきい値をコード定数にしていない', !/STALE_DAYS\s*=/.test(src));
// **PII を出さない。** run の error / diag は API 側で長さを切ってあるが、
// 監視の出力は CI のログや通知メールに載って行き先が広いので載せない。
{
  // 読んでよい `.error` は `payload.error` (API 自身が返すエラー文言) だけ。
  const all = (src.match(/\.error\b/g) || []).length;
  const allowed = (src.match(/payload\.error\b/g) || []).length;
  check('A6 error を読むのは payload.error だけ (runs[].error を読まない)',
    allowed > 0 && all === allowed, `.error=${all} / payload.error=${allowed}`);
}
check('A7 diag に触れていない', !/\bdiag\b/.test(src));
check('A8 rows / range / host を読んでいない', !/\brows\b|\brange\b|\bhost\b/.test(src));
check('A9 CERT_MIN_DAYS = 60', /export const CERT_MIN_DAYS = 60;/.test(src));
check('A10 5 つの状態コードが定義されている',
  ['MONITOR_SOURCE_ERROR', 'NO_RUN_HISTORY', 'LAST_RUN_FAILED', 'STALE', 'CERT_EXPIRING']
    .every((c) => src.includes(`'${c}'`)));
check('A11 監視が読む口が 1 か所に書かれている',
  /export const DEMECAL_RUN_PATH = '\/api\/admin\/demecal-run';/.test(src));

const cli = stripComments(read(CLI));
check('A12 CLI は鍵をヘッダで送る (URL に載せない)',
  /'x-intake-key': key/.test(cli) && !/[?&]key=\$\{/.test(cli));
check('A13 CLI は ADMIN_API_KEY を既定にしない', !/ADMIN_API_KEY/.test(cli));
check('A14 CLI は生の応答を出す口を持たない',
  !/console\.log\([^)]*payload/.test(cli) && !/--raw/.test(cli));
check('A15 CLI は判定を持たない (evaluateDemecalHealth に委ねる)',
  !/stale|cert_days_left\s*</.test(cli));
check('A16 CLI の終了コードは verdict.ok だけで決まる',
  /process\.exit\(verdict\.ok \? 0 : 1\)/.test(cli));
// **C-6 で自動取得側に触らない** (`§7`)。
for (const word of ['schtasks', 'Enable-ScheduledTask', 'demecal-production', 'demecal-state', 'Demecal接続']) {
  check(`A17 CLI が ${word} に触れていない`, !cli.includes(word));
}
check('A18 判定モジュールが自動取得側に触れていない',
  !/schtasks|Enable-ScheduledTask|demecal-state/.test(src));

/* ══ fixture 生成器 (`demecal-run.ts` GET の写し・D 層が守っている) ══ */

const NOW = new Date('2026-09-03T00:00:00.000Z');
const DAY = 86_400_000;
const iso = (daysAgo) => new Date(NOW.getTime() - daysAgo * DAY).toISOString();

function run(o = {}) {
  const at = iso(o.daysAgo ?? 0);
  return {
    started_at: at, finished_at: at,
    result: o.result ?? 'ok',
    stage: o.stage, rows: o.rows, range: o.range,
    error: o.error, diag: o.diag,
    host: 'PC-TEST', script_version: 'production-1.0',
    cert_days_left: o.certDays,
    received_at: at,
  };
}

/** `api/admin/demecal-run.ts` GET と同じ形・同じ計算で応答を組む。 */
function apiResponse(runs) {
  const lastOk = runs.find((r) => r.result === 'ok');
  const days = lastOk?.received_at
    ? Math.floor((NOW.getTime() - Date.parse(lastOk.received_at)) / DAY)
    : null;
  return {
    ok: true,
    runs,
    health: {
      last_success_at: lastOk?.received_at ?? null,
      days_since_success: days,
      cert_days_left: runs[0]?.cert_days_left ?? null,
      stale: days === null || days > 8,
    },
  };
}

/* ══ B. fixture を判定に通す ══════════════════════════════════════ */

const { transform } = await import('esbuild');
const { code } = await transform(read(HEALTH_TS), { loader: 'ts', format: 'esm' });
const mod = resolve(TMP, 'demecal-health.mjs');
writeFileSync(mod, code);
const { evaluateDemecalHealth } = await import(`${pathToFileURL(mod).href}?t=${Date.now()}`);

const ev = (payload, getError) => evaluateDemecalHealth(payload, NOW, getError);
const codes = (v) => v.alerts.map((a) => a.code);

// B1. 記録が 1 件も無い
{
  const v = ev(apiResponse([]));
  check('B1 記録ゼロ → 異常', v.ok === false);
  check('B2 記録ゼロ → NO_RUN_HISTORY', codes(v).includes('NO_RUN_HISTORY'));
  // API は runs=[] でも stale=true を返す (fail-closed)。**握り潰さない** =
  // こちら側でサーバの判定を書き換えない、という原則の帰結。
  check('B3 記録ゼロ → STALE も同時に立つ (API の fail-closed をそのまま映す)',
    codes(v).includes('STALE'));
  check('B4 記録ゼロ → NO_RUN_HISTORY が先に並ぶ', codes(v)[0] === 'NO_RUN_HISTORY');
  check('B5 記録ゼロ → last_run_result は null', v.last_run_result === null);
}

// B6. 正常 (直近 ok / 1 日前 / 証明書 500 日)
{
  const v = ev(apiResponse([run({ daysAgo: 1, result: 'ok', rows: 12, certDays: 500 })]));
  check('B6 直近 ok・1 日前・cert=500 → 正常', v.ok === true, JSON.stringify(codes(v)));
  check('B7 アラート 0 件', v.alerts.length === 0);
  check('B8 days_since_success=1', v.days_since_success === 1);
  check('B9 cert_state=ok', v.cert_state === 'ok');
  check('B10 summary が OK で始まる', v.summary.startsWith('OK demecal:'));
}

// B11. 直近 fail (最後の成功は 1 日前 = stale ではない)
{
  const v = ev(apiResponse([
    run({ daysAgo: 0, result: 'fail', stage: 'download', certDays: 500 }),
    run({ daysAgo: 1, result: 'ok', rows: 3, certDays: 501 }),
  ]));
  check('B11 直近 fail → 異常', v.ok === false);
  check('B12 直近 fail → LAST_RUN_FAILED', codes(v).includes('LAST_RUN_FAILED'));
  // **ここが §2 の眼目**: 「直近 run 失敗」と「長期間成功なし」を混同しない。
  check('B13 直近 fail でも STALE にはしない', !codes(v).includes('STALE'));
  check('B14 last_run_stage を拾う', v.last_run_stage === 'download');
  check('B15 stage がアラート文に出る', v.alerts[0].detail.includes('stage=download'));
}

// B16. 長期間 成功なし
{
  const v = ev(apiResponse([run({ daysAgo: 9, result: 'ok', rows: 1, certDays: 500 })]));
  check('B16 最後の成功が 9 日前 → 異常', v.ok === false);
  check('B17 → STALE', codes(v).includes('STALE'));
  check('B18 → 直近 run は ok なので LAST_RUN_FAILED は立たない',
    !codes(v).includes('LAST_RUN_FAILED'));
  check('B19 → 記録はあるので NO_RUN_HISTORY も立たない',
    !codes(v).includes('NO_RUN_HISTORY'));
  check('B20 日数がアラート文に出る', v.alerts[0].detail.includes('9 日'));
}

// B21. stale の境界 (8 日は正常 / 9 日は異常) — **固定した NOW で見る**
{
  const ok8 = ev(apiResponse([run({ daysAgo: 8, result: 'ok', certDays: 500 })]));
  const ng9 = ev(apiResponse([run({ daysAgo: 9, result: 'ok', certDays: 500 })]));
  check('B21 8 日前 → 正常 (API 契約 days > 8)', ok8.ok === true);
  check('B22 9 日前 → 異常', ng9.ok === false && codes(ng9).includes('STALE'));
}

// B23. 0 件成功は正常 (取り込む対象が無かった日 = 異常ではない)
{
  const v = ev(apiResponse([run({ daysAgo: 0, result: 'ok', rows: 0, certDays: 500 })]));
  check('B23 rows=0 の成功 → 正常', v.ok === true, JSON.stringify(codes(v)));
  check('B24 rows=0 でも days_since_success=0', v.days_since_success === 0);
}

// B25. 証明書
{
  const c59 = ev(apiResponse([run({ daysAgo: 0, result: 'ok', certDays: 59 })]));
  const c60 = ev(apiResponse([run({ daysAgo: 0, result: 'ok', certDays: 60 })]));
  const cNull = ev(apiResponse([run({ daysAgo: 0, result: 'ok' })]));
  check('B25 cert=59 → 異常', c59.ok === false);
  check('B26 cert=59 → CERT_EXPIRING', codes(c59).includes('CERT_EXPIRING'));
  check('B27 cert=59 → cert_state=expiring', c59.cert_state === 'expiring');
  check('B28 cert=60 → 証明書のアラート無し', !codes(c60).includes('CERT_EXPIRING'));
  check('B29 cert=60 → 正常', c60.ok === true);
  // **未知は鳴らさない**。古い run や証明書を見ない run で値が無いことがある。
  check('B30 cert=null → それだけでは異常にしない', cNull.ok === true, JSON.stringify(codes(cNull)));
  check('B31 cert=null → cert_state=unknown', cNull.cert_state === 'unknown');
  check('B32 cert=null → summary に cert=unknown', cNull.summary.includes('cert=unknown'));
}

// B33. 同時成立
{
  const v = ev(apiResponse([
    run({ daysAgo: 0, result: 'fail', stage: 'login', certDays: 30 }),
    run({ daysAgo: 20, result: 'ok', certDays: 50 }),
  ]));
  check('B33 3 つ同時に立つ', codes(v).length === 3, JSON.stringify(codes(v)));
  check('B34 並びは LAST_RUN_FAILED → STALE → CERT_EXPIRING',
    codes(v).join(',') === 'LAST_RUN_FAILED,STALE,CERT_EXPIRING');
  check('B35 summary に 3 つとも出る',
    ['LAST_RUN_FAILED', 'STALE', 'CERT_EXPIRING'].every((c) => v.summary.includes(c)));
}

// B36. 壊れた応答 / GET 失敗
{
  const cases = [
    ['null', null],
    ['配列', [1, 2]],
    ['文字列', 'ok'],
    ['ok:false', { ok: false, error: 'unauthorized' }],
    ['runs が無い', { ok: true, health: { stale: false, days_since_success: 0, cert_days_left: 1, last_success_at: null } }],
    ['health が無い', { ok: true, runs: [] }],
    ['stale が文字列', { ok: true, runs: [], health: { stale: 'false', days_since_success: 0, cert_days_left: null, last_success_at: null } }],
    ['days が文字列', { ok: true, runs: [], health: { stale: false, days_since_success: '0', cert_days_left: null, last_success_at: null } }],
    ['runs[0] が数値', { ok: true, runs: [1], health: { stale: false, days_since_success: 0, cert_days_left: null, last_success_at: null } }],
    ['result が未知の値', { ok: true, runs: [{ result: 'partial', received_at: iso(0) }], health: { stale: false, days_since_success: 0, cert_days_left: null, last_success_at: iso(0) } }],
  ];
  for (const [label, p] of cases) {
    const v = ev(p);
    check(`B36 壊れた応答 (${label}) → MONITOR_SOURCE_ERROR`,
      v.ok === false && codes(v).join(',') === 'MONITOR_SOURCE_ERROR', JSON.stringify(codes(v)));
  }
  const g = ev(null, 'HTTP 401');
  check('B37 GET 失敗 → MONITOR_SOURCE_ERROR', g.ok === false && codes(g)[0] === 'MONITOR_SOURCE_ERROR');
  check('B38 GET 失敗の理由が出る', g.alerts[0].detail === 'HTTP 401');
  // 応答が正しくても getError があれば source error が勝つ (取り違えない)。
  const g2 = ev(apiResponse([run({ daysAgo: 0, certDays: 500 })]), 'HTTP 500');
  check('B39 getError は応答より優先', codes(g2).join(',') === 'MONITOR_SOURCE_ERROR');
}

// B40. now は判定に使わない (別の now を渡しても結論が変わらない)
{
  const p = apiResponse([run({ daysAgo: 9, result: 'ok', certDays: 500 })]);
  const a = evaluateDemecalHealth(p, NOW);
  const b = evaluateDemecalHealth(p, new Date('2031-01-01T00:00:00.000Z'));
  check('B40 now を変えても判定は同じ', JSON.stringify(codes(a)) === JSON.stringify(codes(b)));
  check('B41 evaluated_at にだけ now が出る',
    a.evaluated_at === NOW.toISOString() && b.evaluated_at === '2031-01-01T00:00:00.000Z');
}

// B42. PII を判定結果に混ぜない
const PII_MARK = 'ZZ-PII-MARKER-9999';
{
  const v = ev(apiResponse([run({
    daysAgo: 0, result: 'fail', stage: 'download', certDays: 500,
    error: `失敗: ${PII_MARK}`, diag: [`row ${PII_MARK}`], range: { from: '2026-08-01', to: '2026-08-31' },
  })]));
  const dump = JSON.stringify(v);
  check('B42 verdict に error / diag の中身が出ない', !dump.includes(PII_MARK), dump.slice(0, 200));
  check('B43 verdict に range が出ない', !dump.includes('2026-08-01'));
  check('B44 verdict に host が出ない', !dump.includes('PC-TEST'));
}

/* ══ C. CLI を実際に起動する ══════════════════════════════════════ */

/**
 * CLI を子プロセスで走らせて **終了コードと出力**を取る。
 *
 * **`spawnSync` は使えない** (2026-09-03 実測): 下の C20 以降はこの同じプロセス内に
 * HTTP サーバを立てて `--url` 経路を通す。`spawnSync` は親の event loop を止めるので、
 * サーバが子の要求に**永久に応答できず**、子が固まって spawnSync の timeout まで
 * 待ち続ける = 検査全体がデッドロックする (最初に書いた版がこれで固まった)。
 */
function runCli(args, env) {
  return new Promise((done) => {
    const p = spawn(process.execPath, [resolve(ROOT, CLI), ...args], {
      cwd: ROOT, env: env ?? process.env,
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => done({ code, out }));
  });
}
function fixture(name, obj) {
  const p = resolve(TMP, `${name}.json`);
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return p;
}

const FX_OK = fixture('ok', apiResponse([run({ daysAgo: 1, result: 'ok', rows: 5, certDays: 500 })]));
const FX_EMPTY = fixture('empty', apiResponse([]));
const FX_FAIL = fixture('fail', apiResponse([
  run({ daysAgo: 0, result: 'fail', stage: 'download', certDays: 500, error: `失敗: ${PII_MARK}`, diag: [PII_MARK] }),
  run({ daysAgo: 1, result: 'ok', certDays: 500 }),
]));
const FX_STALE = fixture('stale', apiResponse([run({ daysAgo: 9, result: 'ok', certDays: 500 })]));
const FX_ZERO = fixture('zero', apiResponse([run({ daysAgo: 0, result: 'ok', rows: 0, certDays: 500 })]));
const FX_C59 = fixture('cert59', apiResponse([run({ daysAgo: 0, result: 'ok', certDays: 59 })]));
const FX_C60 = fixture('cert60', apiResponse([run({ daysAgo: 0, result: 'ok', certDays: 60 })]));
const FX_CNULL = fixture('certnull', apiResponse([run({ daysAgo: 0, result: 'ok' })]));
const FX_BAD = fixture('malformed', '{ this is not json');

const NOWARG = ['--now', NOW.toISOString()];

{
  const r = await runCli(['--fixture', FX_OK, ...NOWARG]);
  check('C1 正常 → exit 0', r.code === 0, `exit=${r.code} ${r.out}`);
  check('C2 正常 → OK 行が出る', /^OK demecal:/m.test(r.out));
}
{
  const r = await runCli(['--fixture', FX_EMPTY, ...NOWARG]);
  check('C3 記録ゼロ → exit 非 0', r.code !== 0 && r.code !== 2, `exit=${r.code}`);
  check('C4 記録ゼロ → NO_RUN_HISTORY が出る', r.out.includes('NO_RUN_HISTORY'));
}
{
  const r = await runCli(['--fixture', FX_FAIL, ...NOWARG]);
  check('C5 直近 fail → exit 非 0', r.code === 1, `exit=${r.code}`);
  check('C6 直近 fail → LAST_RUN_FAILED が出る', r.out.includes('LAST_RUN_FAILED'));
  check('C7 直近 fail → STALE は出ない', !r.out.includes('STALE'));
  // **標準出力に PII を出さない** (CI のログ・通知メールに載るため)。
  check('C8 CLI の出力に error / diag の中身が出ない', !r.out.includes(PII_MARK), r.out);
  const j = await runCli(['--fixture', FX_FAIL, ...NOWARG, '--json']);
  check('C9 --json でも PII が出ない', !j.out.includes(PII_MARK));
  check('C10 --json は verdict を返す', JSON.parse(j.out).alerts[0].code === 'LAST_RUN_FAILED');
}
{
  const r = await runCli(['--fixture', FX_STALE, ...NOWARG]);
  check('C11 9 日前 → exit 1 / STALE', r.code === 1 && r.out.includes('STALE'));
}
{
  const r = await runCli(['--fixture', FX_ZERO, ...NOWARG]);
  check('C12 0 件成功 → exit 0', r.code === 0, `exit=${r.code} ${r.out}`);
}
{
  const a = await runCli(['--fixture', FX_C59, ...NOWARG]);
  const b = await runCli(['--fixture', FX_C60, ...NOWARG]);
  const c = await runCli(['--fixture', FX_CNULL, ...NOWARG]);
  check('C13 cert=59 → exit 1 / CERT_EXPIRING', a.code === 1 && a.out.includes('CERT_EXPIRING'));
  check('C14 cert=60 → exit 0', b.code === 0, `exit=${b.code} ${b.out}`);
  check('C15 cert=null → exit 0', c.code === 0, `exit=${c.code} ${c.out}`);
  check('C16 cert=null → cert=unknown と出る', c.out.includes('cert=unknown'));
}
{
  const r = await runCli(['--fixture', FX_BAD, ...NOWARG]);
  check('C17 壊れた JSON → exit 1 / MONITOR_SOURCE_ERROR',
    r.code === 1 && r.out.includes('MONITOR_SOURCE_ERROR'), `exit=${r.code}`);
}
{
  const r = await runCli([...NOWARG]);
  check('C18 引数不足 → exit 2', r.code === 2, `exit=${r.code}`);
  const r2 = await runCli(['--fixture', FX_OK, '--now', 'not-a-date']);
  check('C19 --now が壊れている → exit 2', r2.code === 2, `exit=${r2.code}`);
}

/* ── 実通信 (ローカル HTTP サーバ)。`--url` 経路を本当に走らせる ──── */
{
  const KEY = 'verify-intake-key';
  let seen = null;
  let mode = 'ok';
  const server = createServer((req, res) => {
    seen = { url: req.url, key: req.headers['x-intake-key'], auth: req.headers.authorization };
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
    };
    if (mode === '401') return send(401, JSON.stringify({ ok: false, error: 'unauthorized' }));
    if (mode === '500') return send(500, 'boom');
    if (mode === 'garbage') return send(200, 'not json at all');
    return send(200, JSON.stringify(apiResponse([run({ daysAgo: 1, result: 'ok', rows: 5, certDays: 500 })])));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const good = await runCli(['--url', base, '--key', KEY, ...NOWARG]);
  check('C20 実通信 200 → exit 0', good.code === 0, `exit=${good.code} ${good.out}`);
  check('C21 監視が叩く口は /api/admin/demecal-run', seen?.url === '/api/admin/demecal-run', String(seen?.url));
  // **鍵はヘッダで送り URL に残さない** (URL はプロキシ・履歴・ログに残る)。
  check('C22 鍵は x-intake-key ヘッダで送られる', seen?.key === KEY);
  check('C23 鍵が URL に載っていない', !String(seen?.url).includes(KEY));
  check('C24 Authorization は送らない (admin キーの経路を作らない)', seen?.auth === undefined);

  mode = '401';
  const r401 = await runCli(['--url', base, '--key', KEY, ...NOWARG]);
  check('C25 401 → exit 1', r401.code === 1, `exit=${r401.code}`);
  check('C26 401 → MONITOR_SOURCE_ERROR / HTTP 401', r401.out.includes('MONITOR_SOURCE_ERROR') && r401.out.includes('HTTP 401'));

  mode = '500';
  const r500 = await runCli(['--url', base, '--key', KEY, ...NOWARG]);
  check('C27 500 → exit 1 / MONITOR_SOURCE_ERROR', r500.code === 1 && r500.out.includes('MONITOR_SOURCE_ERROR'));
  check('C28 500 → 応答本文を出さない', !r500.out.includes('boom'), r500.out);

  mode = 'garbage';
  const rg = await runCli(['--url', base, '--key', KEY, ...NOWARG]);
  check('C29 200 だが JSON でない → exit 1', rg.code === 1 && rg.out.includes('MONITOR_SOURCE_ERROR'));

  mode = 'ok';
  seen = null;
  const noKey = await runCli(['--url', base, ...NOWARG], { ...process.env, LAB_INTAKE_API_KEY: '' });
  check('C30 鍵が無ければ exit 2', noKey.code === 2, `exit=${noKey.code}`);
  check('C31 鍵が無ければ通信しない', seen === null, '鍵が無いのにサーバへ要求が届いた');

  const envKey = await runCli(['--url', base, ...NOWARG], { ...process.env, LAB_INTAKE_API_KEY: KEY });
  check('C32 環境変数の鍵でも通る', envKey.code === 0, `exit=${envKey.code} ${envKey.out}`);

  const unreachable = await runCli(['--url', 'http://127.0.0.1:1/x', '--key', KEY, ...NOWARG]);
  check('C33 到達できない → exit 1 / MONITOR_SOURCE_ERROR',
    unreachable.code === 1 && unreachable.out.includes('MONITOR_SOURCE_ERROR'), `exit=${unreachable.code}`);

  await new Promise((r) => server.close(r));
}

/* ══ 結果 ══════════════════════════════════════════════════════════ */

if (fails.length > 0) {
  console.error(`\n✗ verify-demecal-health FAIL (${fails.length} / ${count} 件)`);
  for (const f of fails) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(`✓ verify-demecal-health PASS (${count} 件)`);
