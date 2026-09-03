/**
 * 回帰チェック: タスクスケジューラ登録 (Phase C / C-5)。
 *
 * 実行: node scripts/verify-demecal-scheduler.mjs   (npm run verify:demecal-scheduler)
 * 対象: `src/lib/demecal-scheduler.ts` / `scripts/demecal-scheduler.ps1` /
 *       `src/pages/api/ops/probe-bat.ts` / 生成した .bat を**実際に走らせた結果**
 * 正本: docs/lab/demecal_recovery_plan_20260902.md §7.2 C-5
 *
 * 【C-5 最大の安全条件を機械で守る】
 *   登録するタスクは**無効 (`<Enabled>false</Enabled>`)** で、
 *   登録の実行そのものが **取得を 1 回も始めない**こと。
 *   `schtasks /Run` / `Enable-ScheduledTask` / production runner の起動 /
 *   デメカルへの接続 / state API への GET・POST を**実測 0 回**で固定する。
 *
 * 【実機と同じ形で走らせる】
 *   bat の cmd 部が呼ぶのと同じ `Get-Content <bat>` → skip → `Invoke-Expression` の形。
 *   **skip 行数も bat 自身から読む。** C-4.1 で確かめたとおり、PowerShell 部だけを
 *   取り出して dot-source すると `exit 1` がプロセスの終了コードにならない。
 *
 * 【Windows の代わり】SID・証明書ストア・`schtasks` は Linux に無いので、
 *   ドライバ側で差し替える。**差し替えるのは環境の入口だけ**で、
 *   preflight も XML 生成も照合も**本物のコードが走る**。
 *   `$GetUserSid`/`$GetUserName` が scriptblock 変数なのはこのため
 *   (関数だと `Invoke-Expression` 側の定義が後から勝ち、スタブが効かない = 実測)。
 */

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
if (!existsSync(resolve(ROOT, 'package.json'))) {
  console.error(`✗ リポジトリ直下で実行してください (cwd=${ROOT})`);
  process.exit(1);
}

const failures = [];
let checks = 0;
function check(name, ok, detail = '') {
  checks += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
function must(name, fn) {
  let threw = '';
  try { fn(); } catch (err) { threw = err instanceof Error ? err.message : String(err); }
  check(name, threw !== '', threw ? `→ ${threw.split('\n')[0].slice(0, 66)}` : '→ 落ちなかった');
}

// ── 準備 ──────────────────────────────────────────────────────────
const OUT_LIB = resolve(ROOT, 'node_modules/.cache/verify-demecal-scheduler.lib.mjs');
await build({
  entryPoints: [resolve(ROOT, 'src/lib/demecal-scheduler.ts')],
  outfile: OUT_LIB, bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
});
const lib = await import(`${pathToFileURL(OUT_LIB).href}?t=${Date.now()}`);
const { buildDemecalSchedulerBat, DAILY_AT_RE, TASK_NAME } = lib;

const PS1 = readFileSync(resolve(ROOT, 'scripts/demecal-scheduler.ps1'), 'utf8');
// **fixture 値。production の既定値ではない** (実行時刻は業務判断・repo で未確定)。
const AT = '09:30';
const ADMIN = 'verify-scheduler-ADMIN-KEY-must-never-appear';
const INTAKE = 'verify-scheduler-intake-key';
const PROBE = 'verify-scheduler-probe-token';

// ══ A. 組み立て ═══════════════════════════════════════════════════
console.log('\n[A] 登録 bat の組み立て');

const built = buildDemecalSchedulerBat({ ps1: PS1, dailyAt: AT });
const bat = Buffer.from(built.bytes);
const batText = bat.toString('utf8');

check('A01 1 ファイルの .bat が出る', bat.byteLength > 0, `${bat.byteLength} bytes`);
check('A02 版は .ps1 の $Version', built.version === 'scheduler-1.0', built.version);
check('A03 実行時刻が焼き込まれる', batText.includes(`$DailyAt = '${AT}'`) && !batText.includes('__DAILY_AT__'));

// **既定値を作らない。** 未設定・不正なら配らない = ここで落ちる。
must('A04 実行時刻が空だと落ちる', () => buildDemecalSchedulerBat({ ps1: PS1, dailyAt: '' }));
for (const bad of ['9:30', '24:00', '09:60', '0930', '09:30:00', '２１:００', 'HH:mm', '09.30', '9', '']) {
  must(`A05 不正な実行時刻で落ちる (${JSON.stringify(bad)})`,
    () => buildDemecalSchedulerBat({ ps1: PS1, dailyAt: bad }));
}
for (const good of ['00:00', '23:59', '09:30', '19:05']) {
  check(`A06 正しい実行時刻は通る (${good})`,
    buildDemecalSchedulerBat({ ps1: PS1, dailyAt: good }).dailyAt === good);
}
// env の値は貼り付けで前後に空白・改行が付きやすい。**空白を落とすだけ**なら
// 不正な時刻が正しい時刻に化けることはないので受ける (落として配れない方が困る)。
// ただし**焼き込むのは trim 後の値**であることを固定する。
for (const pad of ['09:30 ', ' 09:30', '09:30\n', '\t09:30\t']) {
  const r = buildDemecalSchedulerBat({ ps1: PS1, dailyAt: pad });
  check(`A05b 前後の空白は落として受ける (${JSON.stringify(pad)})`,
    r.dailyAt === AT && Buffer.from(r.bytes).toString('utf8').includes(`$DailyAt = '${AT}'`));
}
check('A07 書式は正規表現で 1 か所に持つ',
  DAILY_AT_RE.test('00:00') && DAILY_AT_RE.test('23:59')
  && !DAILY_AT_RE.test('24:00') && !DAILY_AT_RE.test('9:30'));
must('A08 差し込み先が消えたら落ちる',
  () => buildDemecalSchedulerBat({ ps1: PS1.replace('__DAILY_AT__', 'x'), dailyAt: AT }));
must('A09 タスク名がずれたら落ちる',
  () => buildDemecalSchedulerBat({ ps1: PS1.replace(TASK_NAME, 'Other-Task'), dailyAt: AT }));

// ── 秘密を焼き込まない ────────────────────────────────────────────
const schedSrc = readFileSync(resolve(ROOT, 'src/lib/demecal-scheduler.ts'), 'utf8');
const schedCode = schedSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
for (const [name, word] of [
  ['A10 builder のコードに ADMIN_API_KEY が無い', 'ADMIN_API_KEY'],
  ['A11 builder のコードに LAB_INTAKE_API_KEY が無い', 'LAB_INTAKE_API_KEY'],
  ['A12 builder のコードに PROBE_UPLOAD_TOKEN が無い', 'PROBE_UPLOAD_TOKEN'],
]) check(name, !schedCode.includes(word));
check('A13 bat に admin キーの値が出ない', !bat.includes(ADMIN));
check('A14 bat に取り込み専用キーの値が出ない', !bat.includes(INTAKE));
check('A15 bat に診断トークンの値が出ない', !bat.includes(PROBE));
check('A16 builder は buildProbeBat を呼ばない', !schedCode.includes('buildProbeBat'));

// ── Windows のパスワードを保存しない / 取得を始めない ──────────────
const PW_WORDS = ['/RU ', '/RP ', 'Password', 'S4U', 'ServiceAccount', '-User ', 'LogonType>Password'];
for (const w of PW_WORDS) {
  check(`A17 パスワード保存の痕跡が無い (${w.trim()})`, !batText.includes(w));
}
check('A18 LogonType は InteractiveToken だけ',
  (batText.match(/<LogonType>([^<]*)<\/LogonType>/g) ?? []).join('|') === '<LogonType>InteractiveToken</LogonType>');
check('A19 RunLevel は LeastPrivilege', batText.includes('<RunLevel>LeastPrivilege</RunLevel>'));

/*
 * **コメントを先に落としてから grep する。**
 * この .ps1 は「`schtasks /Run` しない」「`Enable-ScheduledTask` しない」と
 * 冒頭で宣言しているので、素のテキストを見ると自分の説明文で誤検出する (実測)。
 * ブロックコメント `<# #>` を先に落とす — 行コメントを先に消すと `#>` が消えて
 * 対応が壊れる (C-4.1 で踏んだのと同じ穴)。
 */
const psCode = batText
  .replace(/<#[\s\S]*?#>/g, '')
  .split('\r\n').map((l) => l.replace(/^\s*#.*$/, '')).join('\n');

// `/Run` は `<RunLevel>` `<RunOnlyIfIdle>` に部分一致するので**語として**見る (実測)。
const START_WORDS = [
  ['schtasks /Run', /\/Run(?![A-Za-z])/],
  ['Enable-ScheduledTask', /Enable-ScheduledTask/],
  ['Start-ScheduledTask', /Start-ScheduledTask/],
  ['Invoke-WebRequest', /Invoke-WebRequest/],
  ['Invoke-RestMethod', /Invoke-RestMethod/],
  ['dl.demecal.net', /dl\.demecal\.net/],
  ['demecal-state', /demecal-state/],
  ['demecal-run', /demecal-run/],
  ['Start-Process', /Start-Process/],
];
for (const [label, re] of START_WORDS) {
  check(`A20 登録スクリプトのコードに ${label} が無い`, !re.test(psCode));
}
/*
 * production runner の名前は **データとして** 4 か所に出る
 *   ①必須ファイル一覧 ②XML の Arguments ③読み戻しの照合 ④手控えのハッシュ表
 * どれも実行ではない。**実行する形が 1 行も無いこと**を行単位で見る
 * (件数を数える形にすると、正当な追加のたびに落ちて意味が薄れる)。
 */
const runnerLines = psCode.split('\n').filter((l) => l.includes('demecal-production.ps1'));
const invoking = runnerLines.filter((l) => /(^|[^\w])(&|Start-Process|Invoke-Item|iex)\s|^\s*\.\s+/.test(l));
check('A21 production runner を起動する行が 1 つも無い', invoking.length === 0,
  invoking[0]?.trim().slice(0, 60) ?? `${runnerLines.length} 行すべてデータ`);
check('A22 名前が出るのはデータの行だけ (実行でない)', runnerLines.length > 0,
  `${runnerLines.length} 行`);

// ── 契約が XML テンプレートに書かれている ─────────────────────────
for (const [name, frag] of [
  ['A23 タスク名', `$TaskName = '${TASK_NAME}'`],
  ['A24 無効で登録する', '<Enabled>false</Enabled>'],
  ['A25 StartWhenAvailable', '<StartWhenAvailable>true</StartWhenAvailable>'],
  ['A26 IgnoreNew', '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'],
  ['A27 PT30M', '<ExecutionTimeLimit>PT30M</ExecutionTimeLimit>'],
  ['A28 ログオン時トリガ', '<LogonTrigger>'],
  ['A29 日次トリガ', '<ScheduleByDay>'],
  ['A30 SID を解決して入れる', 'WindowsIdentity]::GetCurrent()).User.Value'],
]) check(name, batText.includes(frag));
check('A31 配置先の既定は C:\\demecal\\production',
  batText.includes("if (-not $InstallRoot) { $InstallRoot = 'C:\\demecal\\production' }"));
check('A32 資格情報の既定は C:\\demecal\\secrets',
  batText.includes("if (-not $CredPath)    { $CredPath    = 'C:\\demecal\\secrets\\demecal.cred.xml' }"));
check('A33 証明書は発行者と秘密鍵で絞る (CN をベタ書きしない)',
  batText.includes("$CertIssuerPattern = 'demecal\\.net CA'") && batText.includes('$c.HasPrivateKey'));

// ── bat の形 ───────────────────────────────────────────────────────
const lines = batText.split('\r\n');
const SKIP = Number(batText.match(/\$s\[(\d+)\.\./)?.[1] ?? -1);
check('A34 cmd 部は ASCII のみ', SKIP > 0 && lines.slice(0, SKIP).every((l) => /^[\x00-\x7F]*$/.test(l)));
check('A35 PowerShell 部の開始位置が合っている', lines[SKIP]?.startsWith('#'));
check('A36 bat が終了コードを返す', batText.includes('exit /b %RC%'));

// ══ B. 配布口 ═════════════════════════════════════════════════════
console.log('\n[B] 配布口 /api/ops/probe-bat');

const OUT_ROUTE = resolve(ROOT, 'node_modules/.cache/verify-demecal-scheduler.route.mjs');
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
  entryPoints: [resolve(ROOT, 'src/pages/api/ops/probe-bat.ts')],
  outfile: OUT_ROUTE, bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
  define: { 'import.meta.env': '{}' }, plugins: [ps1RawPlugin],
});

const TOKEN = 'verify-demecal-scheduler-token';
process.env.PROBE_UPLOAD_TOKEN = TOKEN;
process.env.DEMECAL_USER_ID = 'verify-user';
process.env.DEMECAL_PASSWORD = 'verify-pass';
process.env.LAB_INTAKE_API_KEY = INTAKE;
process.env.ADMIN_API_KEY = ADMIN;
process.env.DEMECAL_DAILY_AT = AT;

const { GET } = await import(`${pathToFileURL(OUT_ROUTE).href}?t=${Date.now()}`);
const call = (q) => GET({ url: new URL(`https://example.invalid/api/ops/probe-bat?k=${TOKEN}${q}`) });

const res = await call('&script=production-scheduler');
check('B01 ?script=production-scheduler が 200', res.status === 200, String(res.status));
const cd = res.headers.get('content-disposition') ?? '';
check('B02 ファイル名に版が入る', cd.includes('demecal-scheduler-v1.0.bat'), cd.split(';')[1]?.trim());
const served = Buffer.from(await res.arrayBuffer());
check('B03 配られる bat は builder の出力と同一', served.equals(bat));
check('B04 配られる bat に admin キーが入っていない', !served.includes(ADMIN));

for (const [name, q, status, body] of [
  ['B05 script なし → 400', '', 400, 'script is required'],
  ['B06 script=daily は凍結のまま 409', '&script=daily', 409, '凍結中'],
  ['B07 script=production-install は 200 のまま', '&script=production-install', 200, ''],
  ['B08 script=verify は 200 のまま', '&script=verify', 200, ''],
  ['B09 script=recon は 200 のまま', '&script=recon', 200, ''],
  ['B10 script=probe は 200 のまま', '&script=probe', 200, ''],
  ['B11 unknown → 400', '&script=nope', 400, 'unknown script'],
]) {
  const r = await call(q);
  const t = r.status === 200 ? '' : await r.text();
  check(name, r.status === status && (!body || t.includes(body)),
    `${r.status}${t ? ` ${JSON.stringify(t.split('\n')[0].slice(0, 34))}` : ''}`);
}

// **実行時刻が無い / 壊れているなら配らない。**
for (const [name, v] of [['B12 DEMECAL_DAILY_AT 未設定なら配らない', ''], ['B13 不正な値なら配らない', '25:00']]) {
  process.env.DEMECAL_DAILY_AT = v;
  const r = await call('&script=production-scheduler');
  const t = r.status === 200 ? '' : await r.text();
  check(name, r.status === 500 && t.includes('build_failed'), `${r.status} ${t.slice(0, 46)}`);
}
process.env.DEMECAL_DAILY_AT = AT;

// ══ C. 実際に走らせる ═════════════════════════════════════════════
console.log('\n[C] 生成した bat を専用PC と同じ形で走らせる');

const pwsh = ['pwsh', 'pwsh-preview', 'powershell']
  .concat(process.env.PWSH ? [process.env.PWSH] : []).reverse()
  .find((c) => spawnSync(c, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0);
if (!pwsh) {
  console.error('\n✗ PowerShell (pwsh) が見つかりません。PWSH=<pwsh のパス> で指定できます。');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'demecal-scheduler-'));
const batPath = join(work, 'scheduler.bat');
writeFileSync(batPath, bat);

// C-4.1 の installer で**本物の 3 本 + 手控え**を置く (preflight の入力を捏造しない)。
const OUT_INST = resolve(ROOT, 'node_modules/.cache/verify-demecal-scheduler.inst.mjs');
await build({
  entryPoints: [resolve(ROOT, 'src/lib/demecal-installer.ts')],
  outfile: OUT_INST, bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
});
const inst = await import(`${pathToFileURL(OUT_INST).href}?t=${Date.now()}`);
const instBuilt = inst.buildDemecalProductionInstaller({
  files: {
    'demecal-production.ps1': readFileSync(resolve(ROOT, 'scripts/demecal-production.ps1'), 'utf8'),
    'demecal-verify.ps1': readFileSync(resolve(ROOT, 'scripts/demecal-verify.ps1'), 'utf8'),
    'demecal-range.ps1': readFileSync(resolve(ROOT, 'scripts/demecal-range.ps1'), 'utf8'),
  },
  intakeKey: INTAKE,
});
const instBat = join(work, 'install.bat');
writeFileSync(instBat, Buffer.from(instBuilt.bytes));
const INSTALL_ROOT = join(work, 'demecal', 'production');
const instSkip = Number(Buffer.from(instBuilt.bytes).toString('utf8').match(/\$s\[(\d+)\.\./)[1]);
{
  const d = join(work, 'inst-driver.ps1');
  writeFileSync(d, [
    `$InstallRoot = '${INSTALL_ROOT}'`,
    `$s = Get-Content -LiteralPath '${instBat}' -Encoding UTF8`,
    `Invoke-Expression (($s[${instSkip}..($s.Count-1)]) -join [Environment]::NewLine)`,
  ].join('\n'), 'utf8');
  const r = spawnSync(pwsh, ['-NoProfile', '-File', d], { encoding: 'utf8' });
  check('C01 preflight の入力は C-4.1 installer が置いた本物',
    r.status === 0 && existsSync(join(INSTALL_ROOT, 'install-manifest.json')), `exit=${r.status}`);
}
const CRED = join(work, 'demecal', 'secrets', 'demecal.cred.xml');
mkdirSync(dirname(CRED), { recursive: true });
writeFileSync(CRED, 'dpapi-blob-placeholder');

/**
 * bat の cmd 部と同じ呼び方で PowerShell 部を走らせる。
 * 差し替えるのは **Windows にしか無いもの** (SID / 証明書ストア / schtasks) だけ。
 * 取得を始める操作は全部スタブで数える (**期待 0 回**)。
 */
function runScheduler(opts = {}) {
  const dir = mkdtempSync(join(work, 'run-'));
  const touched = join(dir, 'touched.txt');
  const called = join(dir, 'schtasks.txt');
  const registered = join(dir, 'registered.xml');
  const cert = opts.cert === false
    ? '@()'
    : "@([pscustomobject]@{ Issuer='CN=demecal.net CA, O=Demecal'; HasPrivateKey=$true })";
  const driver = join(dir, 'driver.ps1');
  writeFileSync(driver, [
    // 取得を始める操作。**1 回でも呼ばれたら記録される。**
    ...['Invoke-WebRequest', 'Invoke-RestMethod', 'Start-Process', 'Enable-ScheduledTask',
      'Start-ScheduledTask', 'Register-ScheduledTask', 'powershell', 'powershell.exe']
      .map((n) => `function ${n} { '${n}' | Add-Content -LiteralPath '${touched}' }`),
    // 環境の入口 3 つ
    `$GetUserSid  = { '${opts.sid ?? 'S-1-5-21-111-222-333-1001'}' }`,
    `$GetUserName = { 'TESTPC\\info' }`,
    `function Get-ChildItem { param([string]$Path) if ($Path -like 'Cert:*') { return ${cert} } return @() }`,
    'function schtasks {',
    `  ($args -join ' ') | Add-Content -LiteralPath '${called}'`,
    "  if ($args -contains '/Run') { '/Run' | Add-Content -LiteralPath '" + touched + "' }",
    "  if ($args -contains '/Create') {",
    "    $i = [array]::IndexOf($args, '/XML')",
    `    Copy-Item -LiteralPath $args[$i+1] -Destination '${registered}' -Force`,
    "    return 'SUCCESS: The scheduled task has been created.'",
    '  }',
    `  if ($args -contains '/Query') {`,
    `    if (-not (Test-Path -LiteralPath '${registered}')) { return 'ERROR: task not found' }`,
    `    $x = Get-Content -LiteralPath '${registered}' -Raw`,
    ...(opts.tamperReadback ? [`    $x = $x -replace '${opts.tamperReadback[0]}', '${opts.tamperReadback[1]}'`] : []),
    '    return $x',
    '  }',
    "  return ''",
    '}',
    `$InstallRoot = '${opts.installRoot ?? INSTALL_ROOT}'`,
    `$CredPath    = '${opts.credPath ?? CRED}'`,
    `$XmlPath     = '${join(dir, 'task.xml')}'`,
    `$s = Get-Content -LiteralPath '${opts.bat ?? batPath}' -Encoding UTF8`,
    `Invoke-Expression (($s[${SKIP}..($s.Count-1)]) -join [Environment]::NewLine)`,
    // ここへ来たら **登録スクリプトが exit しなかった** = 終了コードが伝わっていない。
    `Write-Host 'DRIVER_REACHED_END'`,
    'exit 99',
  ].join('\n'), 'utf8');

  const r = spawnSync(pwsh, ['-NoProfile', '-File', driver], { encoding: 'utf8' });
  return {
    code: r.status,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    touched: existsSync(touched) ? readFileSync(touched, 'utf8').trim().split('\n').filter(Boolean) : [],
    calls: existsSync(called) ? readFileSync(called, 'utf8').trim().split('\n').filter(Boolean) : [],
    xml: existsSync(registered) ? readFileSync(registered, 'utf16le') : '',
  };
}

const ok = runScheduler();
check('C02 正常な登録は exit 0', ok.code === 0, `exit=${ok.code}`);
check('C03 終了コードが伝わっている', !ok.out.includes('DRIVER_REACHED_END'));
check('C04 SCHEDULER_INSTALL_OK を表示', ok.out.includes('SCHEDULER_INSTALL_OK'));
check('C05 登録は schtasks /Create 1 回だけ',
  ok.calls.filter((l) => l.includes('/Create')).length === 1, ok.calls.join(' | ').slice(0, 70));
check('C06 読み戻して照合している (/Query)', ok.calls.some((l) => l.includes('/Query')));

// **登録しただけでは取得を 1 回も始めない。**
check('C07 production runner を実行していない', !ok.touched.includes('powershell') && !ok.touched.includes('powershell.exe'));
check('C08 デメカルへ接続していない', !ok.touched.includes('Invoke-WebRequest'));
check('C09 state API を呼んでいない', !ok.touched.includes('Invoke-RestMethod'));
check('C10 タスクを起動・有効化していない',
  !ok.touched.includes('/Run') && !ok.touched.includes('Enable-ScheduledTask')
  && !ok.touched.includes('Start-ScheduledTask'));
check('C11 触れた外部操作は 0 件', ok.touched.length === 0, ok.touched.join(',') || '0 回');

// ── 登録された XML を実測で見る ────────────────────────────────────
const X = ok.xml;
for (const [name, frag] of [
  ['C12 task name', `<URI>\\${TASK_NAME}</URI>`],
  ['C13 user SID', '<UserId>S-1-5-21-111-222-333-1001</UserId>'],
  ['C14 InteractiveToken', '<LogonType>InteractiveToken</LogonType>'],
  ['C15 RunLevel LeastPrivilege', '<RunLevel>LeastPrivilege</RunLevel>'],
  ['C16 Enabled=false (無効で登録)', '<Enabled>false</Enabled>'],
  ['C17 daily time', `<StartBoundary>2026-01-01T${AT}:00</StartBoundary>`],
  ['C18 LogonTrigger あり', '<LogonTrigger>'],
  ['C19 DailyTrigger あり', '<ScheduleByDay>'],
  ['C20 StartWhenAvailable=true', '<StartWhenAvailable>true</StartWhenAvailable>'],
  ['C21 MultipleInstancesPolicy=IgnoreNew', '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'],
  ['C22 ExecutionTimeLimit=PT30M', '<ExecutionTimeLimit>PT30M</ExecutionTimeLimit>'],
  ['C23 action は powershell.exe', '<Command>powershell.exe</Command>'],
]) check(name, X.includes(frag), X.includes(frag) ? '' : '見つからない');
check('C24 action path が配置先を指す',
  X.includes(`-File "${INSTALL_ROOT}\\demecal-production.ps1"`));
check('C25 XML に Windows のパスワードを書かない',
  !/Password|<RunLevel>HighestAvailable|S4U/.test(X));

// ── preflight で止まること ────────────────────────────────────────
function failCase(name, code, opts) {
  const r = runScheduler(opts);
  const okNow = r.out.includes('SCHEDULER_INSTALL_FAILED') && r.out.includes(code)
    && r.code !== 0 && r.code !== 99
    && r.calls.length === 0 && r.touched.length === 0;
  check(name, okNow,
    `exit=${r.code} / schtasks ${r.calls.length} 回 / 外部 ${r.touched.length} 回`);
}
failCase('C26 配置先が無ければ登録 0', 'INSTALL_ROOT_MISSING', { installRoot: join(work, 'nope') });

// 手控えを消す / ハッシュを 1 文字変える → **どちらも登録 0**
{
  const dup = join(work, 'copy1', 'production');
  mkdirSync(dup, { recursive: true });
  for (const n of ['demecal-production.ps1', 'demecal-verify.ps1', 'demecal-range.ps1']) {
    writeFileSync(join(dup, n), readFileSync(join(INSTALL_ROOT, n)));
  }
  failCase('C27 手控えが無ければ登録 0', 'MANIFEST_MISSING', { installRoot: dup });

  const mf = JSON.parse(readFileSync(join(INSTALL_ROOT, 'install-manifest.json'), 'utf8'));
  mf.production_sha256 = `0${mf.production_sha256.slice(1)}`;
  writeFileSync(join(dup, 'install-manifest.json'), JSON.stringify(mf, null, 2));
  failCase('C28 手控えとファイルが食い違えば登録 0', 'HASH_MISMATCH', { installRoot: dup });

  const dup2 = join(work, 'copy2', 'production');
  mkdirSync(dup2, { recursive: true });
  for (const n of ['demecal-verify.ps1', 'demecal-range.ps1', 'install-manifest.json']) {
    writeFileSync(join(dup2, n), readFileSync(join(INSTALL_ROOT, n)));
  }
  failCase('C29 3 本が揃っていなければ登録 0', 'FILE_MISSING', { installRoot: dup2 });
}
failCase('C30 証明書が無ければ登録 0', 'CERT_MISSING', { cert: false });
failCase('C31 資格情報が無ければ登録 0', 'CREDENTIAL_MISSING', { credPath: join(work, 'no-cred.xml') });
failCase('C32 SID を解決できなければ登録 0', 'SID_UNRESOLVED', { sid: '' });

// 実行時刻が壊れたまま届いた bat (配布口を通らなかった場合の最後の砦)
{
  const raw = Buffer.from(batText.replace(`$DailyAt = '${AT}'`, "$DailyAt = '25:00'"), 'utf8');
  const p = join(work, 'bad-at.bat');
  writeFileSync(p, raw);
  failCase('C33 実行時刻が不正なら登録 0', 'DAILY_AT_INVALID', { bat: p });
}

// ── 読み戻しが意図と違えば成功にしない ────────────────────────────
for (const [name, from, to] of [
  ['C34 読み戻しで Enabled が true なら失敗', '<Enabled>false</Enabled>', '<Enabled>true</Enabled>'],
  ['C35 読み戻しで LogonType が違えば失敗', 'InteractiveToken', 'Password'],
  ['C36 読み戻しで ExecutionTimeLimit が違えば失敗', 'PT30M', 'PT8H'],
  ['C37 読み戻しで日次トリガが消えていれば失敗', '<ScheduleByDay>', '<ScheduleByWeek>'],
]) {
  const r = runScheduler({ tamperReadback: [from, to] });
  check(name,
    r.out.includes('REGISTERED_MISMATCH') && r.code !== 0 && r.code !== 99 && r.touched.length === 0,
    `exit=${r.code}`);
}

// ══ D. 凍結の維持 ═════════════════════════════════════════════════
console.log('\n[D] 凍結の維持');
const ver = (f) => readFileSync(resolve(ROOT, f), 'utf8').match(/^\s*\$Version\s*=\s*'([^']+)'/m)?.[1];
check('D01 demecal-daily.ps1 は daily-1.7 のまま', ver('scripts/demecal-daily.ps1') === 'daily-1.7');
check('D02 demecal-verify.ps1 は verify-1.4 のまま', ver('scripts/demecal-verify.ps1') === 'verify-1.4');
check('D03 demecal-production.ps1 は production-1.0 のまま',
  ver('scripts/demecal-production.ps1') === 'production-1.0');

rmSync(work, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n✗ verify-demecal-scheduler FAIL (${failures.length} / ${checks} 件)`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(`\n✓ verify-demecal-scheduler PASS (${checks} ケース)`);
