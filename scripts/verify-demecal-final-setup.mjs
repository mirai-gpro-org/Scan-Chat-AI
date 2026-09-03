/**
 * 回帰チェック: 最終セットアップ BAT (今回の案件専用・1 ファイル)。
 *
 * 実行: node scripts/verify-demecal-final-setup.mjs  (npm run verify:demecal-final-setup)
 * 対象: `src/lib/demecal-final-setup.ts` / `src/pages/api/ops/probe-bat.ts`
 *
 * 【層は 4 つ】
 *   A. **書き写していないこと**の固定 — C-4.1 / C-5 の安全ロジックが新ファイルに無く、
 *      同梱した本文が payload と**バイト一致**していること
 *   B. 生成物の構造 — cmd 部 ASCII / 4 段の行範囲 / 段の連結が本文を余さず覆う /
 *      失敗した段で止まる / 禁止された操作が無い
 *   C. **[1] を実際に PowerShell で走らせる** — `last_to` の判定ラダー 10 通り。
 *      通信は stub。**`force` を 1 度も送らないこと**もここで見る
 *   D. 配布口 — `?script=final-setup` が 200 / `DEMECAL_DAILY_AT` env に依存しない
 *
 * C が要る理由: [1] だけがこの案件で新しく書いたコードで、
 * **「巻き戻さない」「応答を信じず読み直す」は分岐でしか確認できない**。
 * 生成物を眺めるだけでは通ってしまう。
 */

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
if (!existsSync(resolve(ROOT, 'package.json'))) {
  console.error(`✗ リポジトリ直下で実行してください (cwd=${ROOT})`);
  process.exit(1);
}

const fails = [];
let count = 0;
function check(name, cond, extra = '') {
  count++;
  if (!cond) fails.push(`${name}${extra ? ` — ${extra}` : ''}`);
}
function throws(name, fn) {
  count++;
  let threw = '';
  try { fn(); } catch (err) { threw = err instanceof Error ? err.message : String(err); }
  if (!threw) fails.push(`${name} — 落ちなかった`);
}
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

/** ソース検査の前にコメントを落とす (C-5/C-6 と同じ規律。解説文で誤爆させない)。 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const cacheDir = resolve(ROOT, 'node_modules/.cache');
mkdirSync(cacheDir, { recursive: true });

/* ── builder を node から呼べる形にする ───────────────────────────── */
const OUT_LIB = resolve(cacheDir, 'verify-final-setup.lib.mjs');
await build({
  entryPoints: [resolve(ROOT, 'src/lib/demecal-final-setup.ts')],
  outfile: OUT_LIB, bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
});
const lib = await import(`${pathToFileURL(OUT_LIB).href}?t=${Date.now()}`);
const {
  buildDemecalFinalSetupBat, readApiBase,
  INITIAL_LAST_TO, FINAL_DAILY_AT, FINAL_SETUP_VERSION,
} = lib;

const OUT_INST = resolve(cacheDir, 'verify-final-setup.inst.mjs');
await build({
  entryPoints: [resolve(ROOT, 'src/lib/demecal-installer.ts')],
  outfile: OUT_INST, bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
});
const { buildInstallerPayload } = await import(`${pathToFileURL(OUT_INST).href}?t=${Date.now()}`);

const OUT_SCHED = resolve(cacheDir, 'verify-final-setup.sched.mjs');
await build({
  entryPoints: [resolve(ROOT, 'src/lib/demecal-scheduler.ts')],
  outfile: OUT_SCHED, bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
});
const { buildSchedulerPayload, TASK_NAME } = await import(`${pathToFileURL(OUT_SCHED).href}?t=${Date.now()}`);

const SRC = {
  productionPs1: read('scripts/demecal-production.ps1'),
  verifyPs1: read('scripts/demecal-verify.ps1'),
  rangePs1: read('scripts/demecal-range.ps1'),
  schedulerPs1: read('scripts/demecal-scheduler.ps1'),
};
const KEY = 'verify-intake-key-final-setup';
const built = buildDemecalFinalSetupBat({ ...SRC, intakeKey: KEY });
const bat = Buffer.from(built.bytes).toString('utf8');
const lines = bat.split('\r\n');
const slice = (r) => lines.slice(r.from, r.to + 1).join('\r\n') + '\r\n';
const byName = Object.fromEntries(built.ranges.map((r) => [r.name, r]));

/* ══ A. 書き写していないこと ═══════════════════════════════════════ */
console.log('[A] C-4.1 / C-5 のロジックを書き写していないか');

const newSrc = stripComments(read('src/lib/demecal-final-setup.ts'));

// **配置の安全契約は新ファイルに無い** (payload を同梱するだけ)。
for (const w of ['production.new', 'OldDir', 'OldSaved', 'Restore-Old', 'INSTALLED_MISMATCH',
  'INSTALLED_SET_INCOMPLETE', 'Get-FileHash', 'install-manifest.json', 'FromBase64String']) {
  check(`A1 配置の実装が新ファイルに無い (${w})`, !newSrc.includes(w));
}
/**
 * **登録の安全契約も無い。**
 *
 * ただし新ファイルは「禁止語を禁じるための一覧」を持っている
 * (`for (const banned of [...])`)。そこに語が出るのは当然なので、
 * **その配列だけ外してから**探す。外さないと「禁止する仕組みを入れたせいで
 * 禁止検査が落ちる」という無意味な失敗になる (実測 2026-09-03)。
 */
const banList = newSrc.match(/const banned of \[[^\]]*\]/)?.[0] ?? '';
check('A2a 禁止語の一覧が新ファイルに在る', banList.includes('schtasks') && banList.includes('force'),
  banList || '見つからない');
const newBody = newSrc.replace(banList, '');
for (const w of ['schtasks', 'Register-ScheduledTask', 'LogonTrigger', 'CalendarTrigger',
  'InteractiveToken', 'Enabled>false', 'REGISTERED_MISMATCH', 'Remove-RegisteredTask']) {
  check(`A2 登録の実装が新ファイルに無い (${w})`, !newBody.includes(w));
}
// 既存 builder を**呼んでいる**こと (呼ばずに済ませていない)。
check('A3 インストーラ payload を呼んでいる', /buildInstallerPayload\(/.test(newSrc));
check('A4 登録 payload を呼んでいる', /buildSchedulerPayload\(/.test(newSrc));
/**
 * 禁止事項が**実装コードとして**書かれていないこと。
 *
 * **`force` はここでは見ない。** 新ファイルは [1] へ
 * `P('# **\`force\` を送らない。**…')` という **PowerShell のコメント行を生成する**ので、
 * TS ソースの文字列としては必ず出る (残すべき文)。
 * `force` を送っていないことの保証は
 *   ・B16 = 生成物の**実行行**に `force` が無い
 *   ・C5  = 実際に走らせた POST の body に `force` が無い
 * の 2 つが持つ。ここで重ねて見ると、正しい注意書きを消さないと通らなくなる。
 */
for (const w of ['Enable-ScheduledTask', '/Run']) {
  check(`A5 禁止された操作が新ファイルに無い (${w})`, !newBody.includes(w));
}
check('A6 案件値が固定されている',
  INITIAL_LAST_TO === '2026-09-01' && FINAL_DAILY_AT === '11:00',
  `${INITIAL_LAST_TO} / ${FINAL_DAILY_AT}`);
check('A7 API base は verify.ps1 から読む',
  readApiBase(SRC.verifyPs1) === 'https://scan-chat-ai.vercel.app'
  && built.apiBase === readApiBase(SRC.verifyPs1), built.apiBase);
check('A8 URL を新ファイルにベタ書きしていない', !/https:\/\/scan-chat-ai/.test(newSrc));
throws('A9 $ApiBase が読めなければ落とす', () => readApiBase('# no api base'));
throws('A10 取り込み鍵が無ければ配らない',
  () => buildDemecalFinalSetupBat({ ...SRC, intakeKey: '' }));
throws('A11 鍵に \' が入れば落とす',
  () => buildDemecalFinalSetupBat({ ...SRC, intakeKey: "ab'cd" }));

// **同梱した本文が payload とバイト一致** = 書き写していない機械的な証拠。
const instPs = buildInstallerPayload({
  files: {
    'demecal-production.ps1': SRC.productionPs1,
    'demecal-verify.ps1': SRC.verifyPs1,
    'demecal-range.ps1': SRC.rangePs1,
  },
  intakeKey: KEY,
}).ps;
const schedPs = buildSchedulerPayload({ ps1: SRC.schedulerPs1, dailyAt: FINAL_DAILY_AT }).ps;
check('A12 [2] の本文がインストーラ payload と完全一致', slice(byName.install) === instPs,
  `${slice(byName.install).length} vs ${instPs.length}`);
check('A13 [3] の本文が登録 .ps1 と完全一致', slice(byName.scheduler) === schedPs,
  `${slice(byName.scheduler).length} vs ${schedPs.length}`);
// 登録 .ps1 は差し込み以外そのまま (=C-5 の中身を編集していない)。
check('A14 [3] は __DAILY_AT__ を差し替えただけ',
  slice(byName.scheduler) === SRC.schedulerPs1.replace(/\r?\n/g, '\r\n').split('__DAILY_AT__').join(FINAL_DAILY_AT));
check('A15 [3] に実行時刻 11:00 が焼き込まれている',
  slice(byName.scheduler).includes("$DailyAt = '11:00'"));
check('A16 [3] のタスク名が C-5 と同じ', slice(byName.scheduler).includes(`$TaskName = '${TASK_NAME}'`));
check('A17 [3] は Enabled=false のまま', slice(byName.scheduler).includes('<Enabled>false</Enabled>'));

/* ══ B. 生成物の構造 ═══════════════════════════════════════════════ */
console.log('[B] 生成した bat の構造');

const psStart = built.ranges[0].from;
// eslint-disable-next-line no-control-regex
check('B1 cmd 部は ASCII のみ', lines.slice(0, psStart).every((l) => /^[\x00-\x7F]*$/.test(l)));
check('B2 段は 4 つ・順序が state→install→scheduler→done',
  built.ranges.map((r) => r.name).join(',') === 'state,install,scheduler,done',
  built.ranges.map((r) => r.name).join(','));
for (const r of built.ranges) {
  check(`B3 段 ${r.name} の 1 行目が # で始まる`, lines[r.from]?.startsWith('#'), lines[r.from]);
}
check('B4 行範囲に隙間が無い',
  built.ranges.every((r, i) => i === 0 || r.from === built.ranges[i - 1].to + 1));
check('B5 最後の段が本文末尾まで届く', built.ranges[3].to === lines.length - 2);
check('B6 4 段を繋ぐと PowerShell 部と一致',
  built.ranges.map(slice).join('') === lines.slice(psStart).join('\r\n'));
check('B7 差し込み漏れが無い', !bat.includes('{R'));
// 各段が**自分の行範囲だけ**を読む別プロセスであること。
for (let i = 0; i < 4; i++) {
  const r = built.ranges[i];
  check(`B8 段 ${r.name} を呼ぶ powershell 行がある`,
    lines.some((l) => l.startsWith('powershell ') && l.includes(`$s[${r.from}..${r.to}]`)),
    `${r.from}..${r.to}`);
}
check('B9 powershell 行は 4 本だけ',
  lines.filter((l) => l.startsWith('powershell ')).length === 4);
// **失敗した段で止まる。** 3 か所のガード (最後の段の後には要らない)。
check('B10 段の間に終了コードのガードがある',
  lines.filter((l) => l === 'if not "%RC%"=="0" goto stopped').length === 3);
check('B11 bat が終了コードを返す', lines.includes('exit /b %RC%'));
check('B12 止まったことが画面に出る', bat.includes('FINAL_SETUP_STOPPED'));
check('B13 完了表示は 4 段目 (PowerShell 側)',
  slice(byName.done).includes("Write-Host 'FINAL_SETUP_OK'")
  && !lines.slice(0, psStart).some((l) => l.includes('FINAL_SETUP_OK')));
check('B14 一時ファイルを作らない (自分自身を読む)',
  bat.includes("-LiteralPath '%~f0'") && !/New-Item|Set-Content .*\$env:TEMP|Out-File/.test(slice(byName.state)));
// 禁止事項は **この builder が書いた部分** に当てる。同梱した 2 本の中身は
// それぞれの検査 (installer 84 / scheduler 133) が見張っており、全文に当てると
// C-5 の解説文『schtasks /Run しない』へ誤爆する (実測 2026-09-03)。
// 行頭 # (解説) を落として実行行だけ見る。禁止語は『やらない』と書いた文にこそ出る
// (builder 側と同じ理由。実測で 2 回誤爆した)。
const onlyCode = (t) => t.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
const mine = onlyCode([lines.slice(0, psStart).join('\r\n'), slice(byName.state), slice(byName.done)].join('\r\n'));
for (const w of ['schtasks', 'Enable-ScheduledTask', 'demecal-production.ps1']) {
  check(`B15 [1]/[4]/cmd に ${w} が無い`, !mine.includes(w));
}
check('B16 [1]/[4]/cmd に force を送る箇所が無い', !/force/i.test(mine));
check('B16b 同梱した 2 本は中身を検査し直さない (誤爆を招くため)',
  bat.includes('schtasks') && slice(byName.scheduler).includes('schtasks'),
  '登録本文には当然 schtasks が入る');
check('B17 版が入っている', built.version === FINAL_SETUP_VERSION);
check('B18 焼き込んだ値が返る',
  built.initialLastTo === '2026-09-01' && built.dailyAt === '11:00');
check('B19 配置される 3 本の SHA が返る',
  built.entries.length === 3 && built.entries.every((e) => /^[0-9a-f]{64}$/.test(e.sha256)));
// 鍵は [1] と [2] に入る (production.ps1 の中)。**それ以外の段には入れない。**
check('B20 [1] に鍵が入っている', slice(byName.state).includes(KEY));
check('B21 [3] に鍵を入れていない', !slice(byName.scheduler).includes(KEY));
check('B22 [4] に鍵を入れていない', !slice(byName.done).includes(KEY));
check('B23 cmd 部に鍵を入れていない', !lines.slice(0, psStart).join('\n').includes(KEY));
check('B24 ADMIN_API_KEY への通り道が無い', !bat.includes('ADMIN_API_KEY'));
check('B25 未注入のプレースホルダが残っていない',
  !slice(byName.state).includes('__LAB_INTAKE_KEY__') && !bat.includes('__DAILY_AT__'));

/* ══ C. [1] を実際に走らせる ═══════════════════════════════════════ */
console.log('[C] [1] 取得範囲の初期化を PowerShell で走らせる');

const pwsh = ['pwsh', 'pwsh-preview', 'powershell']
  .concat(process.env.PWSH ? [process.env.PWSH] : [])
  .reverse()
  .find((c) => spawnSync(c, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0);
if (!pwsh) {
  console.error('\n✗ PowerShell (pwsh) が見つかりません。配布物は .bat なので検査も PowerShell で走らせます。');
  console.error('  PWSH=<pwsh のパス> npm run verify:demecal-final-setup でも指定できます。');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'demecal-final-'));

/**
 * [1] の本文をそのまま走らせる。通信だけ stub。
 *
 * **`Invoke-RestMethod` を関数で差し替える** — 本文は自分で `Get-LastTo` を
 * 定義するので (C-5 の教訓: payload 側の定義が後から勝つ)、
 * 差し替えるのは**本文が定義していない cmdlet** にする。
 */
function runState(mode, opts = {}) {
  const logPath = join(work, `calls-${mode}-${Math.random().toString(36).slice(2)}.txt`);
  let body = slice(byName.state);
  // here-string の終端と紛れる行が無いこと (あれば黙って壊れるので落とす)。
  if (/^'@/m.test(body)) throw new Error('payload に here-string 終端と紛れる行がある');
  if (opts.stripKey) body = body.split(KEY).join('__LAB_INTAKE' + '_KEY__');

  const drv = [
    "$ErrorActionPreference = 'Continue'",
    `$LOG = '${logPath.replace(/\\/g, '\\\\')}'`,
    `$MODE = '${mode}'`,
    '$script:GetCount = 0',
    'function Invoke-RestMethod {',
    '  param([string]$Uri, [string]$Method, [int]$TimeoutSec, $Headers, [string]$ContentType, $Body,',
    '        [Parameter(ValueFromRemainingArguments=$true)]$Rest)',
    '  $m = if ($Method) { $Method } else { \'Get\' }',
    "  ('{0} {1} body={2}' -f $m, $Uri, $Body) | Add-Content -LiteralPath $LOG",
    "  if ($m -eq 'Post') {",
    "    if ($MODE -eq 'writefail') { throw 'boom-post' }",
    "    if ($MODE -eq 'notok') { return [pscustomobject]@{ ok = $false } }",
    '    return [pscustomobject]@{ ok = $true; updated = $true }',
    '  }',
    '  $script:GetCount++',
    "  if ($MODE -eq 'readfail') { throw 'boom-get' }",
    "  if ($MODE -eq 'notokget') { return [pscustomobject]@{ ok = $false } }",
    "  if ($MODE -eq 'equal')  { return [pscustomobject]@{ ok = $true; last_to = '2026-09-01' } }",
    "  if ($MODE -eq 'ahead')  { return [pscustomobject]@{ ok = $true; last_to = '2026-09-05' } }",
    "  if ($MODE -eq 'badfmt') { return [pscustomobject]@{ ok = $true; last_to = '2026/09/01' } }",
    "  if ($MODE -eq 'past')   {",
    "    if ($script:GetCount -eq 1) { return [pscustomobject]@{ ok = $true; last_to = '2026-08-20' } }",
    "    return [pscustomobject]@{ ok = $true; last_to = '2026-09-01' }",
    '  }',
    "  if ($MODE -eq 'mismatch') {",
    '    if ($script:GetCount -eq 1) { return [pscustomobject]@{ ok = $true; last_to = $null } }',
    "    return [pscustomobject]@{ ok = $true; last_to = '2026-08-31' }",
    '  }',
    "  if ($MODE -eq 'verifyfail') {",
    '    if ($script:GetCount -eq 1) { return [pscustomobject]@{ ok = $true; last_to = $null } }',
    "    throw 'boom-verify'",
    '  }',
    '  # null (未初期化) → POST → 2026-09-01',
    '  if ($script:GetCount -eq 1) { return [pscustomobject]@{ ok = $true; last_to = $null } }',
    "  return [pscustomobject]@{ ok = $true; last_to = '2026-09-01' }",
    '}',
    '',
    // **単一引用符の here-string を使う。** 二重引用符 (@" "@) だと PowerShell が
    // 中の $false / $IntakeKey を**先に展開してしまい**、
    // 'Ok = ' のような壊れた式になって payload が parse できない (実測 2026-09-03)。
    "$payload = @'",
    body,
    "'@",
    'Invoke-Expression $payload',
  ].join('\n');

  const drvPath = join(work, `drv-${mode}-${Math.random().toString(36).slice(2)}.ps1`);
  writeFileSync(drvPath, drv);
  const r = spawnSync(pwsh, ['-NoProfile', '-File', drvPath], { encoding: 'utf8', timeout: 60_000 });
  const calls = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  return {
    code: r.status,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    calls,
    posts: (calls.match(/^Post /gm) || []).length,
    gets: (calls.match(/^Get /gm) || []).length,
  };
}

{
  const r = runState('null');
  check('C1 未初期化 → exit 0', r.code === 0, `exit=${r.code} ${r.out}`);
  check('C2 未初期化 → POST 1 回', r.posts === 1, r.calls);
  check('C3 未初期化 → 書き込み後に読み直す (GET 2 回)', r.gets === 2, r.calls);
  check('C4 POST の body に last_to=2026-09-01', /"last_to"\s*:\s*"2026-09-01"/.test(r.calls), r.calls);
  check('C5 POST の body に force を入れない', !/force/i.test(r.calls), r.calls);
  check('C6 叩く先は demecal-state だけ',
    (r.calls.match(/api\/admin\/demecal-state/g) || []).length === 3
    && !/demecal-run|probe-upload/.test(r.calls), r.calls);
  check('C7 完了が画面に出る', r.out.includes('[1/3] 完了'));
}
{
  const r = runState('past');
  check('C8 初期値より過去 → exit 0 / POST 1 回', r.code === 0 && r.posts === 1, `exit=${r.code} ${r.calls}`);
}
{
  const r = runState('equal');
  check('C9 すでに初期値 → exit 0', r.code === 0, `exit=${r.code} ${r.out}`);
  check('C10 すでに初期値 → POST しない', r.posts === 0, r.calls);
  check('C11 すでに初期値 → GET 1 回だけ', r.gets === 1, r.calls);
}
{
  // **ここが要**: 巻き戻さない。
  const r = runState('ahead');
  check('C12 初期値より先 → exit 非 0', r.code === 1, `exit=${r.code}`);
  check('C13 初期値より先 → POST しない (巻き戻さない)', r.posts === 0, r.calls);
  check('C14 初期値より先 → LAST_TO_AHEAD', r.out.includes('LAST_TO_AHEAD'), r.out);
  check('C15 初期値より先 → 変更していないと明示', r.out.includes('値は変更していません'), r.out);
}
{
  const r = runState('readfail');
  check('C16 GET 失敗 → exit 1 / STATE_READ_FAILED',
    r.code === 1 && r.out.includes('STATE_READ_FAILED'), `exit=${r.code} ${r.out}`);
  check('C17 GET 失敗 → POST しない', r.posts === 0, r.calls);
}
{
  const r = runState('notokget');
  check('C18 GET が ok:false → exit 1 / POST しない',
    r.code === 1 && r.posts === 0 && r.out.includes('STATE_READ_FAILED'), `exit=${r.code} ${r.out}`);
}
{
  const r = runState('writefail');
  check('C19 POST 失敗 → exit 1 / STATE_WRITE_FAILED',
    r.code === 1 && r.out.includes('STATE_WRITE_FAILED'), `exit=${r.code} ${r.out}`);
}
{
  const r = runState('notok');
  check('C20 POST が ok:false → exit 1 / STATE_WRITE_FAILED',
    r.code === 1 && r.out.includes('STATE_WRITE_FAILED'), `exit=${r.code} ${r.out}`);
}
{
  // **応答を信じない**: POST は成功したが読み直すと違う値。
  const r = runState('mismatch');
  check('C21 読み直して不一致 → exit 1 / STATE_VERIFY_MISMATCH',
    r.code === 1 && r.out.includes('STATE_VERIFY_MISMATCH'), `exit=${r.code} ${r.out}`);
  check('C22 読み直しを実際に行っている (GET 2 回)', r.gets === 2, r.calls);
}
{
  const r = runState('verifyfail');
  check('C23 読み直しが失敗 → exit 1 / STATE_VERIFY_FAILED',
    r.code === 1 && r.out.includes('STATE_VERIFY_FAILED'), `exit=${r.code} ${r.out}`);
}
{
  const r = runState('badfmt');
  check('C24 日付の形でない → exit 1 / STATE_FORMAT_UNEXPECTED',
    r.code === 1 && r.out.includes('STATE_FORMAT_UNEXPECTED'), `exit=${r.code} ${r.out}`);
  check('C25 日付の形でない → POST しない', r.posts === 0, r.calls);
}
{
  // 鍵が未注入のまま配られた場合 (生成では起きないが、ガードが生きていること)。
  const r = runState('null', { stripKey: true });
  check('C26 鍵が未注入 → exit 1 / INTAKE_KEY_MISSING',
    r.code === 1 && r.out.includes('INTAKE_KEY_MISSING'), `exit=${r.code} ${r.out}`);
  check('C27 鍵が未注入 → 通信しない', r.gets === 0 && r.posts === 0, r.calls);
}

rmSync(work, { recursive: true, force: true });

/* ══ D. 配布口 ═════════════════════════════════════════════════════ */
console.log('[D] 配布口 ?script=final-setup');

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
const OUT_ROUTE = resolve(cacheDir, 'verify-final-setup.route.mjs');
await build({
  entryPoints: [resolve(ROOT, 'src/pages/api/ops/probe-bat.ts')],
  outfile: OUT_ROUTE, bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
  define: { 'import.meta.env': '{}' }, plugins: [ps1RawPlugin],
});

const TOKEN = 'verify-final-setup-token';
process.env.PROBE_UPLOAD_TOKEN = TOKEN;
process.env.LAB_INTAKE_API_KEY = 'verify-intake-key';
process.env.DEMECAL_USER_ID = 'u';
process.env.DEMECAL_PASSWORD = 'p';
// **実行時刻 env は意図的に外す** — 案件値をコード側に持つので依存しないこと。
delete process.env.DEMECAL_DAILY_AT;

const { GET } = await import(`${pathToFileURL(OUT_ROUTE).href}?t=${Date.now()}`);
const call = (q) => GET({ url: new URL(`https://example.invalid/api/ops/probe-bat?k=${TOKEN}${q}`) });

{
  const res = await call('&script=final-setup');
  check('D1 200 が返る', res.status === 200, String(res.status));
  const cd = res.headers.get('content-disposition') ?? '';
  check('D2 ファイル名に版が入る', cd.includes('demecal-final-setup-v1.0.bat'), cd);
  check('D3 日本語のファイル名も出す',
    cd.includes(encodeURIComponent('デメカル自動取得_最終セットアップ_v1.0.bat')), cd);
  check('D4 キャッシュさせない (機密ファイル)', res.headers.get('cache-control') === 'no-store');
  check('D5 検索避け', res.headers.get('x-robots-tag') === 'noindex');
  const body = Buffer.from(await res.arrayBuffer()).toString('utf8');
  check('D6 中身が bat になっている', body.startsWith('@echo off\r\n'));
  check('D7 env の取り込み鍵が注入される', body.includes('verify-intake-key'));
  check('D8 DEMECAL_DAILY_AT が無くても 11:00 が焼き込まれる',
    body.includes("$DailyAt = '11:00'"), '案件値をコード側で持つ契約');
}
{
  // 実行時刻 env に依存しない = scheduler 単体の口とは独立していること。
  const sched = await call('&script=production-scheduler');
  check('D9 DEMECAL_DAILY_AT 未設定なら scheduler 単体は配らない (現行契約のまま)',
    sched.status === 500, String(sched.status));
}
{
  const res = await call('');
  const body = await res.text();
  check('D10 script なしの案内に final-setup が載る',
    res.status === 400 && body.includes('final-setup'), body);
}
{
  const res = await call('&script=nope');
  check('D11 未知の script は 400', res.status === 400);
}
{
  const bad = await GET({ url: new URL('https://example.invalid/api/ops/probe-bat?k=wrong&script=final-setup') });
  check('D12 認可が script より先に効く', bad.status === 401, String(bad.status));
}
{
  delete process.env.LAB_INTAKE_API_KEY;
  const res = await call('&script=final-setup');
  const body = await res.text();
  check('D13 取り込み鍵が無ければ 500 (黙って配らない)',
    res.status === 500 && body.includes('LAB_INTAKE_API_KEY'), `${res.status} ${body}`);
  process.env.LAB_INTAKE_API_KEY = 'verify-intake-key';
}

/* ══ 結果 ══════════════════════════════════════════════════════════ */
if (fails.length > 0) {
  console.error(`\n✗ verify-demecal-final-setup FAIL (${fails.length} / ${count} 件)`);
  for (const f of fails) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(`\n✓ verify-demecal-final-setup PASS (${count} 件)`);
