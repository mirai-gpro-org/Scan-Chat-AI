/**
 * 回帰チェック: 本番 runner 3 本の**配布インストーラ** (Phase C / C-4.1)。
 *
 * 実行: node scripts/verify-demecal-installer.mjs   (npm run verify:demecal-installer)
 * 対象: `src/lib/demecal-installer.ts` / `src/pages/api/ops/probe-bat.ts` /
 *       生成された .bat を**実際に走らせた結果**
 * 正本: docs/lab/demecal_recovery_plan_20260902.md §7.2 C-4.1
 *
 * 【前提: なぜ `buildProbeBat()` ではないのか】
 *   あちらは **.ps1 を 1 本だけ** bat の中で `Invoke-Expression` する方式で、
 *   **ディスクにファイルを残さない**。本番 runner は
 *   `demecal-verify.ps1` / `demecal-range.ps1` を **dot-source** するので、
 *   その方式では隣に置くべき 2 本が存在せず**成立しない**。
 *   → 3 本を配置する別 builder。**`buildProbeBat()` は拡張しない**ので、
 *     recon / verify / 接続チェックの配布が壊れていないことも下の [B] で見る。
 *
 * 【なぜ node と PowerShell の両方を跨ぐのか】
 *   組み立ては TypeScript (Vercel 側)、展開は PowerShell (専用PC 側) で、
 *   **境界を跨いだところに事故が出る** (ハッシュの取り方 / 改行 / 文字コード /
 *   終了コードの伝わり方)。片側だけ検査しても「配って初めて壊れている」が残る。
 *   → ここでは **①builder を呼び ②配布口を実際に GET し ③出てきた .bat を
 *     専用PC と同じ形で走らせる** の 3 段を 1 本で通す。
 *
 * 【実機と同じ形で走らせる — ここを手抜きすると通ったふりになる】
 *   専用PC 上では bat の cmd 部が
 *     `powershell -Command "$s=Get-Content <bat>; Invoke-Expression ($s[N..]-join …)"`
 *   を呼ぶ。**この形でないと `exit 1` がプロセスの終了コードにならない**
 *   (実測 2026-09-03: PowerShell 部だけを取り出して dot-source すると、
 *    インストーラが失敗しても親スクリプトは走り続け、終了コードが 0 のまま通った。
 *    C-4 で踏んだ「`exit` が `&` を越えない」と同じ穴)。
 *   だから **skip 行数も bat 自身から読む** (数字を固定で書かない)。
 *
 * 【Wellfort 実機は使わない】配置先だけをテンポラリへ差し替えて Linux で走らせる。
 *   デメカルにも state API にも触らない (触っていないことも下で数える)。
 */

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  // 「落ちること」を期待する検査。落ちなければ NG (黙って配ってしまう形)。
  let threw = '';
  try { fn(); } catch (err) { threw = err instanceof Error ? err.message : String(err); }
  check(name, threw !== '', threw ? `→ ${threw.split('\n')[0].slice(0, 70)}` : '→ 落ちなかった');
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ── 準備: builder を node から呼べる形にする ──────────────────────
const OUT_LIB = resolve(ROOT, 'node_modules/.cache/verify-demecal-installer.lib.mjs');
await build({
  entryPoints: [resolve(ROOT, 'src/lib/demecal-installer.ts')],
  outfile: OUT_LIB, bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
});
const lib = await import(`${pathToFileURL(OUT_LIB).href}?t=${Date.now()}`);
const { buildDemecalProductionInstaller, INSTALL_FILES, INSTALL_ROOT } = lib;

const SRC = {
  'demecal-production.ps1': readFileSync(resolve(ROOT, 'scripts/demecal-production.ps1'), 'utf8'),
  'demecal-verify.ps1': readFileSync(resolve(ROOT, 'scripts/demecal-verify.ps1'), 'utf8'),
  'demecal-range.ps1': readFileSync(resolve(ROOT, 'scripts/demecal-range.ps1'), 'utf8'),
};
// 本物は使わない。ここで与えた値だけで完結させる。
const INTAKE = 'verify-installer-intake-key-0001';
const ADMIN = 'verify-installer-ADMIN-KEY-must-never-appear';
const PROBE = 'verify-installer-probe-token-0002';

// ══ A. builder ════════════════════════════════════════════════════
console.log('\n[A] インストーラの組み立て');

const built = buildDemecalProductionInstaller({ files: { ...SRC }, intakeKey: INTAKE });
const bat = Buffer.from(built.bytes);
const batText = bat.toString('utf8');

check('A01 3 本を入れて出てくるのは .bat 1 本', bat.byteLength > 0 && built.entries.length === 3,
  `${bat.byteLength} bytes`);
check('A02 版は production.ps1 の $Version', built.version === 'production-1.0', built.version);
check('A03 配置する順序と名前が固定',
  built.entries.map((e) => e.name).join(',') === INSTALL_FILES.join(','),
  built.entries.map((e) => e.name).join(','));

// 依存が 1 本でも欠けたら**配る前に**落ちる (現地で気づく事故にしない)。
for (const missing of INSTALL_FILES) {
  const files = { ...SRC };
  delete files[missing];
  must(`A04 dependency 欠損で落ちる (${missing})`,
    () => buildDemecalProductionInstaller({ files, intakeKey: INTAKE }));
}
must('A05 知らないファイルを渡すと落ちる',
  () => buildDemecalProductionInstaller({ files: { ...SRC, 'evil.ps1': 'x' }, intakeKey: INTAKE }));
must('A06 取り込み専用キーが空だと落ちる',
  () => buildDemecalProductionInstaller({ files: { ...SRC }, intakeKey: '' }));
must('A07 production の差し込み先が消えていたら落ちる', () => buildDemecalProductionInstaller({
  files: { ...SRC, 'demecal-production.ps1': SRC['demecal-production.ps1'].replace('__LAB_INTAKE_KEY__', 'x') },
  intakeKey: INTAKE,
}));
must('A08 verify の __PROBE_TOKEN__ を消したら落ちる', () => buildDemecalProductionInstaller({
  files: { ...SRC, 'demecal-verify.ps1': SRC['demecal-verify.ps1'].replace('__PROBE_TOKEN__', PROBE) },
  intakeKey: INTAKE,
}));

// ── 埋め込まれた 3 本を取り出して中身を見る ──────────────────────
/** bat から `$Blob<i>` の here-string を取り出して復号する。 */
function decodeBlob(i) {
  const m = batText.match(new RegExp(`\\$Blob${i} = @'\\r\\n([\\s\\S]*?)\\r\\n'@`));
  if (!m) throw new Error(`$Blob${i} が bat に見つかりません`);
  return Buffer.from(m[1].replace(/\s/g, ''), 'base64');
}
const decoded = INSTALL_FILES.map((_, i) => decodeBlob(i));

check('A09 埋め込みの SHA-256 が実体と一致',
  decoded.every((buf, i) => sha256(buf) === built.entries[i].sha256),
  built.entries.map((e) => e.sha256.slice(0, 8)).join(' / '));
check('A10 復号したバイト数が申告と一致',
  decoded.every((buf, i) => buf.byteLength === built.entries[i].bytes));

const decodedText = decoded.map((b) => b.toString('utf8'));
check('A11 取り込み専用キーは production だけに入る',
  decodedText[0].includes(INTAKE) && !decodedText[1].includes(INTAKE) && !decodedText[2].includes(INTAKE));
check('A12 production に差し込み残しが無い', !decodedText[0].includes('__LAB_INTAKE_KEY__'));
check('A13 verify の __PROBE_TOKEN__ は未注入のまま (Send-Skeleton は no-op)',
  decodedText[1].includes('__PROBE_TOKEN__'));
check('A14 verify は verify-1.4 のまま埋め込まれる',
  /^\s*\$Version\s*=\s*'verify-1\.4'/m.test(decodedText[1]));

// **`ADMIN_API_KEY` はこのモジュールを通っては入れられない。** 引数にも無い。
const installerSrc = readFileSync(resolve(ROOT, 'src/lib/demecal-installer.ts'), 'utf8');
const installerCode = installerSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('A15 builder のコードに ADMIN_API_KEY が出てこない', !installerCode.includes('ADMIN_API_KEY'));
check('A16 生成した bat に admin キーの値が 1 度も出ない', !bat.includes(ADMIN));
check('A17 builder は buildProbeBat を呼ばない (配布経路を混ぜない)',
  !installerCode.includes('buildProbeBat'));

// ── インストーラ自身が「取得しない」ことをコードで固定する ────────
//   3 本は base64 なので、この grep は**インストーラのコードだけ**を見ている。
const NOT_ALLOWED = [
  'Invoke-WebRequest', 'Invoke-RestMethod', 'dl.demecal.net', 'demecal-state',
  'demecal-run', 'schtasks', 'Register-ScheduledTask', 'Start-Process',
];
for (const word of NOT_ALLOWED) {
  check(`A18 インストーラのコードに ${word} が無い`, !batText.includes(word));
}

// ── bat の形 ───────────────────────────────────────────────────────
const lines = batText.split('\r\n');
const skipMatch = batText.match(/\$s\[(\d+)\.\./);
const SKIP = skipMatch ? Number(skipMatch[1]) : -1;
check('A19 cmd 部は ASCII のみ', SKIP > 0 && lines.slice(0, SKIP).every((l) => /^[\x00-\x7F]*$/.test(l)));
check('A20 PowerShell 部の開始位置が合っている', lines[SKIP]?.startsWith('#'), lines[SKIP]?.slice(0, 30));
check('A21 bat が終了コードを返す (握りつぶさない)', batText.includes('exit /b %RC%'));
check('A22 配置先の既定は C:\\demecal\\production',
  batText.includes(`if (-not $InstallRoot) { $InstallRoot = '${INSTALL_ROOT}' }`), INSTALL_ROOT);

/*
 * 照合は **2 回** ある: ①作業フォルダへ書いた直後 ②target へ入れ替えた**後**。
 * ②を消しても手元の Linux では再現できる失敗が作れず、実行時の検査では捕まらない
 * (実測 2026-09-03: ②を外しても 69 件すべて通った)。**移動が半端に終わる**形の
 * 混成セットはそこでしか止まらないので、ここはソースで固定する。
 */
const shaCalls = (batText.match(/\$got = Sha256File \$dest/g) ?? []).length;
check('A23 ハッシュ照合が 作業フォルダと配置後の 2 回ある', shaCalls === 2, `${shaCalls} 回`);
check('A24 配置後の欠損・不一致に別のコードを持つ',
  batText.includes('INSTALLED_MISSING') && batText.includes('INSTALLED_MISMATCH'));

// ══ B. 配布口 ═════════════════════════════════════════════════════
console.log('\n[B] 配布口 /api/ops/probe-bat');

const OUT_ROUTE = resolve(ROOT, 'node_modules/.cache/verify-demecal-installer.route.mjs');
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

const TOKEN = 'verify-demecal-installer-token';
process.env.PROBE_UPLOAD_TOKEN = TOKEN;
process.env.DEMECAL_USER_ID = 'verify-user';
process.env.DEMECAL_PASSWORD = 'verify-pass';
process.env.LAB_INTAKE_API_KEY = INTAKE;
process.env.ADMIN_API_KEY = ADMIN;   // 置いてあっても配布物に出ないこと

const { GET } = await import(`${pathToFileURL(OUT_ROUTE).href}?t=${Date.now()}`);
const call = (q) => GET({ url: new URL(`https://example.invalid/api/ops/probe-bat?k=${TOKEN}${q}`) });

const inst = await call('&script=production-install');
check('B01 ?script=production-install が 200', inst.status === 200, String(inst.status));
const cd = inst.headers.get('content-disposition') ?? '';
check('B02 ファイル名に版が入る', cd.includes('demecal-install-v1.0.bat'), cd.split(';')[1]?.trim());
const served = Buffer.from(await inst.arrayBuffer());
check('B03 配られる bat に admin キーが入っていない', !served.includes(ADMIN));
check('B04 配られる bat は builder の出力と同一', served.equals(bat));

for (const [name, q, status, body] of [
  ['B05 script なし → 400', '', 400, 'script is required'],
  ['B06 script=daily は凍結のまま 409', '&script=daily', 409, '凍結中'],
  ['B07 script=verify は 200 のまま', '&script=verify', 200, ''],
  ['B08 script=recon は 200 のまま', '&script=recon', 200, ''],
  ['B09 script=probe は 200 のまま', '&script=probe', 200, ''],
  ['B10 unknown → 400', '&script=nope', 400, 'unknown script'],
]) {
  const res = await call(q);
  const text = res.status === 200 ? '' : await res.text();
  check(name, res.status === status && (!body || text.includes(body)),
    `${res.status}${text ? ` ${JSON.stringify(text.split('\n')[0].slice(0, 40))}` : ''}`);
}

// 取り込み専用キーが無ければ**配らない** (動かない bat を握らせない)。
process.env.LAB_INTAKE_API_KEY = '';
const noKey = await call('&script=production-install');
const noKeyText = noKey.status === 200 ? '' : await noKey.text();
check('B11 LAB_INTAKE_API_KEY 未設定なら配らない', noKey.status === 500 && noKeyText.includes('build_failed'),
  `${noKey.status} ${noKeyText.slice(0, 50)}`);
process.env.LAB_INTAKE_API_KEY = INTAKE;

// ══ C. 実際に走らせる ═════════════════════════════════════════════
console.log('\n[C] 生成した bat を専用PC と同じ形で走らせる');

const pwsh = ['pwsh', 'pwsh-preview', 'powershell']
  .concat(process.env.PWSH ? [process.env.PWSH] : [])
  .reverse()
  .find((c) => spawnSync(c, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0);
if (!pwsh) {
  console.error('\n✗ PowerShell (pwsh) が見つかりません。配布物は .bat なので検査も PowerShell で走らせます。');
  console.error('  PWSH=<pwsh のパス> npm run verify:demecal-installer でも指定できます。');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'demecal-installer-'));
const batPath = join(work, 'install.bat');
writeFileSync(batPath, bat);

/**
 * bat の cmd 部と**同じ呼び方**で PowerShell 部を走らせる。
 *   ・skip 行数は bat から読む (固定で書かない)
 *   ・配置先だけ差し替える (`$InstallRoot` は bat 側が未定義なら既定を使う作り)
 *   ・デメカル / 実行ログ / タスク登録に触ったら数える
 */
function runInstaller(file, installRoot) {
  const counter = join(work, 'touched.txt');
  rmSync(counter, { force: true });
  const driver = join(work, 'driver.ps1');
  const stubs = ['Invoke-WebRequest', 'Invoke-RestMethod', 'Start-Process', 'Register-ScheduledTask', 'schtasks']
    .map((n) => `function ${n} { '${n}' | Add-Content -LiteralPath '${counter}' }`).join('\n');
  writeFileSync(driver, [
    stubs,
    `$InstallRoot = '${installRoot}'`,
    `$s = Get-Content -LiteralPath '${file}' -Encoding UTF8`,
    `Invoke-Expression (($s[${SKIP}..($s.Count-1)]) -join [Environment]::NewLine)`,
    // ここへ来たら **インストーラが exit しなかった** = 終了コードが伝わっていない。
    `Write-Host 'DRIVER_REACHED_END'`,
    'exit 99',
  ].join('\n'), 'utf8');
  const r = spawnSync(pwsh, ['-NoProfile', '-File', driver], { encoding: 'utf8' });
  return {
    code: r.status,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    touched: existsSync(counter) ? readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean) : [],
  };
}

const target = join(work, 'demecal', 'production');
const ok1 = runInstaller(batPath, target);
check('C01 正常インストールは exit 0', ok1.code === 0, `exit=${ok1.code}`);
check('C02 終了コードが伝わっている (exit が握りつぶされない)', !ok1.out.includes('DRIVER_REACHED_END'));
check('C03 INSTALL_OK を表示', ok1.out.includes('INSTALL_OK'));
check('C04 3 本が配置される',
  INSTALL_FILES.every((n) => existsSync(join(target, n))),
  readdirSync(target).join(' '));
check('C05 配置された 3 本の SHA-256 が一致',
  built.entries.every((e) => sha256(readFileSync(join(target, e.name))) === e.sha256));
check('C06 版が画面に出る', ok1.out.includes('production-1.0'));

const manifest = JSON.parse(readFileSync(join(target, 'install-manifest.json'), 'utf8'));
check('C07 手控えに版と 3 本のハッシュが残る',
  manifest.production_version === built.version
  && manifest.production_sha256 === built.entries[0].sha256
  && manifest.verify_sha256 === built.entries[1].sha256
  && manifest.range_sha256 === built.entries[2].sha256
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(manifest.installed_at ?? ''),
  manifest.installed_at);
check('C08 手控えに鍵を書かない', !JSON.stringify(manifest).includes(INTAKE));

// **install だけでは何も取りに行かない。**
check('C09 デメカル / 実行ログ / タスク登録に触っていない', ok1.touched.length === 0,
  ok1.touched.join(',') || '0 回');
check('C10 作業フォルダ (.new / .old) を残さない',
  !existsSync(`${target}.new`) && !existsSync(`${target}.old`));

// ── 配置した 3 本が「噛み合う」ことを確かめる ──────────────────────
//   production は隣の 2 本を dot-source する。ここが噛み合っていなければ
//   「3 本置けた」だけでは意味が無い。
const probe = join(work, 'probe.ps1');
writeFileSync(probe, [
  `. '${join(target, 'demecal-production.ps1')}' -LibOnly`,
  'Write-Host "V=$Version"',
  'Write-Host "K=$IntakeKey"',
  'Write-Host "P=$ProbeToken"',
  'Write-Host "J=$(Get-JstToday)"',
  `Write-Host "R=$((Resolve-DemecalAcquisitionRange -LastTo '2026-08-01' -TodayJst '2026-09-03').From)"`,
  'Write-Host "C=$((Get-Command -CommandType Function Test-CsvResponse -ErrorAction SilentlyContinue).Name)"',
].join('\n'), 'utf8');
const pr = spawnSync(pwsh, ['-NoProfile', '-File', probe], { encoding: 'utf8' });
const po = `${pr.stdout ?? ''}${pr.stderr ?? ''}`;
check('C11 配置した production が隣の 2 本を読み込める', pr.status === 0 && po.includes('V=production-1.0'));
check('C12 取り込み専用キーは production の値が勝つ', po.includes(`K=${INTAKE}`));
check('C13 診断トークンは未注入のまま', po.includes('P=__PROBE_TOKEN__'));
check('C14 C-4 の JST と C-1 の範囲プランナが動く', po.includes('J=') && po.includes('R=2026-08-02'));
check('C15 verify-1.4 の CSV 検査が読み込まれている', po.includes('C=Test-CsvResponse'));

// ── 失敗のさせ方 1: 期待ハッシュを 1 文字変える (混成セット防止) ────
const shaLine = batText.match(/\$Sha1\s+= '([0-9a-f]{64})'/);
const tamperedHash = join(work, 'tampered-hash.bat');
writeFileSync(tamperedHash, Buffer.from(
  batText.replace(shaLine[0], shaLine[0].replace(shaLine[1], `0${shaLine[1].slice(1)}`)), 'utf8'));
const bad1 = runInstaller(tamperedHash, target);
check('C16 ハッシュ不一致で INSTALL_FAILED', bad1.out.includes('INSTALL_FAILED') && bad1.out.includes('HASH_MISMATCH'));
check('C17 ハッシュ不一致で exit != 0', bad1.code !== 0 && bad1.code !== 99, `exit=${bad1.code}`);

// ── 失敗のさせ方 2: 3 本目の中身を壊す (書込み途中で落ちる) ─────────
//   **ここが「一部だけ新しい」を許さないことの本番**。1 本目・2 本目は作れて
//   3 本目で落ちる形にし、**target が古い正常セットのまま**であることを見る。
//   target へ直接書く実装だと、ここで 1・2 本目だけ新しくなって落ちる。
const b2 = batText.indexOf("$Blob2 = @'");
const nl = batText.indexOf('\r\n', b2 + 12);
const tamperedBlob = join(work, 'tampered-blob.bat');
writeFileSync(tamperedBlob, Buffer.from(`${batText.slice(0, nl + 2)}!!!!${batText.slice(nl + 2)}`, 'utf8'));

// 先に「違う中身」で 1 度入れ替えておき、古い方が生き残ることを見分けられるようにする。
const built2 = buildDemecalProductionInstaller({ files: { ...SRC }, intakeKey: `${INTAKE}-second` });
const bat2 = join(work, 'install2.bat');
writeFileSync(bat2, Buffer.from(built2.bytes));
const ok2 = runInstaller(bat2, target);
check('C18 上書きインストールが通る', ok2.code === 0, `exit=${ok2.code}`);
check('C19 上書きで中身が入れ替わる',
  sha256(readFileSync(join(target, 'demecal-production.ps1'))) === built2.entries[0].sha256);

/** 消えていても落ちない読み方 (退行を入れると本当に消えるため)。 */
const shaOrGone = (p) => (existsSync(p) ? sha256(readFileSync(p)) : 'GONE');

const before = INSTALL_FILES.map((n) => shaOrGone(join(target, n)));
const bad2 = runInstaller(tamperedBlob, target);
check('C20 3 本目が作れないと INSTALL_FAILED', bad2.out.includes('INSTALL_FAILED'));
check('C21 3 本目が作れないと exit != 0', bad2.code !== 0 && bad2.code !== 99, `exit=${bad2.code}`);
check('C22 失敗しても既存の正常セットが 1 バイトも変わらない',
  INSTALL_FILES.every((n, i) => shaOrGone(join(target, n)) === before[i]),
  INSTALL_FILES.map((n) => shaOrGone(join(target, n)).slice(0, 8)).join(' / '));
check('C23 失敗しても中途半端な作業フォルダを残さない', !existsSync(`${target}.new`));

// ── 失敗のさせ方 3: OneDrive 配下 ─────────────────────────────────
const od = join(work, 'OneDrive', 'demecal', 'production');
mkdirSync(dirname(od), { recursive: true });
const bad3 = runInstaller(batPath, od);
check('C24 OneDrive 配下へは配置しない', bad3.out.includes('ONEDRIVE_PATH') && bad3.code !== 0, `exit=${bad3.code}`);
check('C25 OneDrive のときは 1 本も作らない', !existsSync(od));

// ══ D. 凍結されているものが動いていない ═══════════════════════════
console.log('\n[D] 凍結の維持');
const verifyVer = SRC['demecal-verify.ps1'].match(/^\s*\$Version\s*=\s*'([^']+)'/m)?.[1];
const dailyVer = readFileSync(resolve(ROOT, 'scripts/demecal-daily.ps1'), 'utf8')
  .match(/^\s*\$Version\s*=\s*'([^']+)'/m)?.[1];
check('D01 demecal-verify.ps1 は verify-1.4 のまま', verifyVer === 'verify-1.4', verifyVer);
check('D02 demecal-daily.ps1 は daily-1.7 のまま', dailyVer === 'daily-1.7', dailyVer);

rmSync(work, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n✗ verify-demecal-installer FAIL (${failures.length} / ${checks} 件)`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(`\n✓ verify-demecal-installer PASS (${checks} ケース)`);
