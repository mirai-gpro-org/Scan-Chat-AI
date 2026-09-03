/**
 * デメカル 本番取得 runner (production) の **配布インストーラ** を 1 ファイルの .bat に組む。
 * (Phase C / C-4.1 — 正本 `docs/lab/demecal_recovery_plan_20260902.md` §7.2 C-4.1)
 *
 * 【なぜ `buildProbeBat()` をそのまま使えないのか — この節が本モジュールの存在理由】
 *   `buildProbeBat()` は **.ps1 を 1 本だけ** bat 自身の中へ置き、bat が自分を読み直して
 *   `Invoke-Expression` する方式。**ファイルはディスクに 1 つも残らない。**
 *   ところが本番 runner は
 *       . (Join-Path $PSScriptRoot 'demecal-verify.ps1') -LibOnly
 *       . (Join-Path $PSScriptRoot 'demecal-range.ps1')
 *   を **dot-source** する (C-4 の「書き写さない = parity を構造で保証する」設計)。
 *   `Invoke-Expression` された文字列に `$PSScriptRoot` は無く、隣に置くべき 2 本も
 *   存在しないので、**production.ps1 だけを自己実行 bat へ包んでも成立しない**。
 *   → だから「3 本をディスクへ**配置する**インストーラ」という別物が要る。
 *
 *   **`buildProbeBat()` を production 向けに拡張しない。** あちらは recon / verify /
 *   接続チェックの配布に現に使われている経路で、多目的化すると 3 種類の配布が
 *   1 つの分岐だらけの関数に相乗りする。ここは新しい builder として分ける。
 *
 * 【方式】3 本を **base64 で埋め込む**。生のまま埋めない理由は 2 つ:
 *   ①中身が日本語なので、bat の読み直し (`Get-Content -Encoding UTF8`) を通しても
 *     **バイト単位で同一**であることを保証したい (SHA-256 照合の意味が出る)。
 *   ②インストーラ自身のコードに `Invoke-WebRequest` / `demecal-state` /
 *     `schtasks` 等が**含まれていないこと**を、grep で言い切れる
 *     (base64 の中には現れないため。検査 = `verify:demecal-installer`)。
 *
 * 【fail-closed】3 本のうち 1 本でも生成・展開・照合に失敗したら `INSTALL_FAILED` /
 *   exit != 0。**一部だけ新しい「混成セット」を正常扱いしない。**
 *   展開は temp → 3 本すべて照合 → target を入れ替え、の順にするので、
 *   途中で失敗しても**既に入っている正常セットは壊れない**。
 *
 * 【秘密】`__LAB_INTAKE_KEY__` は **配布生成時 (Vercel env) に注入する**。
 *   リポジトリには実値を置かない。**`ADMIN_API_KEY` は引数にも無い** =
 *   このモジュールを通っては焼き込めない (`demecal_unattended_spec §3.1`)。
 *   デメカルの ID/PW も埋め込まない — ①(recon) が DPAPI で保存した資格情報を
 *   本番 runner がそのまま読む。
 */

import { createHash } from 'node:crypto';
import { INTAKE_KEY_PLACEHOLDER, PROBE_TOKEN_PLACEHOLDER } from './probe-bat';
import { psQuote, readPs1Version, wrapPs1AsBat } from './demecal-bat';

/** 配置先。**固定**。`C:\demecal\` 直下に置く運用ルールに合わせる (spec §4.4)。 */
export const INSTALL_ROOT = 'C:\\demecal\\production';

/** 配置する 3 本。**名前も順序も固定** (production が dot-source する名前そのもの)。 */
export const INSTALL_FILES = [
  'demecal-production.ps1',
  'demecal-verify.ps1',
  'demecal-range.ps1',
] as const;
export type InstallFileName = (typeof INSTALL_FILES)[number];

export interface InstallerInput {
  /** ファイル名 → `.ps1` の中身 (リポジトリのまま・プレースホルダ入り)。 */
  files: Record<string, string>;
  /** `LAB_INTAKE_API_KEY`。production の `__LAB_INTAKE_KEY__` へ注入する。 */
  intakeKey: string;
}

export interface InstallerEntry {
  name: InstallFileName;
  /** 配置されるファイルの **SHA-256 (hex 小文字)**。installer が実測値と突き合わせる。 */
  sha256: string;
  bytes: number;
}

export interface InstallerResult {
  /** BOM 無し UTF-8 / CRLF の .bat。 */
  bytes: Uint8Array;
  /** `production-1.0` 等。配布ファイル名と画面に出す。 */
  version: string;
  entries: InstallerEntry[];
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** base64 を読みやすい幅で折る (bat の差分と表示のため。復号側は空白を捨てる)。 */
function wrap(b64: string, width = 120): string {
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += width) out.push(b64.slice(i, i + width));
  return out.join('\r\n');
}

/**
 * 本番 runner 3 本を配置するインストーラ .bat を組む。
 *
 * @throws 3 本が揃っていない / 版が読めない / 取り込み専用キーが無い / 注入し残しがある
 */
export function buildDemecalProductionInstaller(input: InstallerInput): InstallerResult {
  // ── 1. 入力の検算。**3 本ちょうど**でなければここで落とす ──────────
  //    「dependency 1 本欠損」は現地で気づく事故ではなく、配る前に止める事故。
  const given = Object.keys(input.files);
  for (const name of INSTALL_FILES) {
    if (typeof input.files[name] !== 'string' || input.files[name] === '') {
      throw new Error(`必須ファイルがありません: ${name}`);
    }
  }
  for (const name of given) {
    if (!(INSTALL_FILES as readonly string[]).includes(name)) {
      throw new Error(`知らないファイルは配置しません: ${name}`);
    }
  }
  if (!input.intakeKey) {
    throw new Error('LAB_INTAKE_API_KEY が未設定です (本番 runner は取り込み専用キーが無いと動きません)');
  }
  if (input.intakeKey.includes("'")) throw new Error("LAB_INTAKE_API_KEY に ' は使えません");

  // ── 2. 秘密の注入。**production 1 本だけ** ────────────────────────
  //
  //   ・`demecal-verify.ps1` は dependency としてそのまま置く。
  //     `__PROBE_TOKEN__` は **未注入のまま**にする = 本番では `Send-Skeleton` が
  //     no-op になる現行契約 (`demecal-verify.ps1:846`) を維持する。Phase B 用の
  //     診断トークンを本番 PC へ再導入しない。必要になったら C-6 で別途判断する。
  //   ・verify 側の `$IntakeKey` も**未注入のまま**でよい。production は
  //     dot-source の**後**に自分の `$IntakeKey` を代入するので (production.ps1:61)、
  //     `Report-Run` が見るのは production の値。
  //     → **秘密が載るファイルを 1 本に閉じられる。**
  //   ・`demecal-range.ps1` は純粋関数だけなので注入対象が無い。
  const contents: Record<string, string> = { ...input.files };

  const prod = contents['demecal-production.ps1'];
  if (!prod.includes(INTAKE_KEY_PLACEHOLDER)) {
    throw new Error(`${INTAKE_KEY_PLACEHOLDER} が demecal-production.ps1 にありません (差し込み先が消えた)`);
  }
  contents['demecal-production.ps1'] = prod.split(INTAKE_KEY_PLACEHOLDER).join(psQuote(input.intakeKey));
  if (contents['demecal-production.ps1'].includes(INTAKE_KEY_PLACEHOLDER)) {
    throw new Error('取り込み専用キーの差し込みに漏れがあります');
  }
  // verify 側は触っていないこと (= 診断トークンを持ち込んでいないこと) を明示的に確かめる。
  if (!contents['demecal-verify.ps1'].includes(PROBE_TOKEN_PLACEHOLDER)) {
    throw new Error('demecal-verify.ps1 の __PROBE_TOKEN__ が消えています (本番へ診断トークンを持ち込まない契約)');
  }

  const version = readPs1Version(contents['demecal-production.ps1']);

  // ── 3. 配置されるバイト列を確定し、その SHA-256 を採る ────────────
  //    **改行は LF のまま**触らない。ここで採ったハッシュと、専用PC 上で
  //    `Get-FileHash` が出す値が一致することが「混成セットでない」証拠になる。
  const entries: InstallerEntry[] = [];
  const blobs: { name: string; b64: string }[] = [];
  for (const name of INSTALL_FILES) {
    const bytes = new TextEncoder().encode(contents[name]);
    entries.push({ name, sha256: sha256Hex(bytes), bytes: bytes.byteLength });
    blobs.push({ name, b64: Buffer.from(bytes).toString('base64') });
  }

  // ── 4. インストーラ本体 (PowerShell) ──────────────────────────────
  const ps: string[] = [];
  const P = (s: string) => ps.push(s);

  P(`# デメカル 本番取得 — インストーラ (${version})`);
  P('#');
  P('# 3 本を C:\\demecal\\production へ配置するだけ。**取得は実行しない。**');
  P('#   ・デメカルへ接続しない / 取得範囲の state を読み書きしない');
  P('#   ・本番 runner をその場で起動しない / タスクスケジューラへ登録しない');
  P('# インストールと本番取得を同じ実機操作にしないため (計画 §7.2 C-4.1)。');
  P('');
  P("$ErrorActionPreference = 'Stop'");
  P('');
  P('# 配置先は固定。テストからは呼び出し元が $InstallRoot を先に定義して差し替える');
  P('# (専用PC では -NoProfile で起動するので未定義 = 既定値になる)。');
  P(`if (-not $InstallRoot) { $InstallRoot = '${INSTALL_ROOT}' }`);
  P('');
  P('# OneDrive 配下へは置かない。3 本のうち production には取り込み専用キーが');
  P('# 焼き込まれているので、同期フォルダだと版履歴・ごみ箱に残る (spec §4.4)。');
  P("if ($InstallRoot -match 'OneDrive') {");
  P("  Write-Host 'INSTALL_FAILED  ONEDRIVE_PATH'");
  P('  Write-Host ("  配置先が OneDrive 配下です: {0}" -f $InstallRoot)');
  P('  exit 1');
  P('}');
  P('');
  P(`$Version = '${psQuote(version)}'`);
  P('');

  // 埋め込み本体
  blobs.forEach((b, i) => {
    P(`# ${b.name} (${entries[i].bytes} bytes / sha256 ${entries[i].sha256})`);
    P(`$Name${i} = '${b.name}'`);
    P(`$Sha${i}  = '${entries[i].sha256}'`);
    P(`$Blob${i} = @'`);
    P(wrap(b.b64));
    P("'@");
    P('');
  });

  P('$Files = @(');
  blobs.forEach((_, i) => {
    P(`  @{ Name = $Name${i}; Sha = $Sha${i}; B64 = $Blob${i} }${i === blobs.length - 1 ? '' : ','}`);
  });
  P(')');
  P('');
  P('function Fail([string]$code, [string]$msg) {');
  P("  Write-Host ''");
  P("  Write-Host ('INSTALL_FAILED  {0}' -f $code)");
  P("  Write-Host ('  {0}' -f $msg)");
  P('  # 途中まで作った作業フォルダは残さない (取り込み専用キーを含むため)。');
  P('  try { if ($TmpDir -and (Test-Path -LiteralPath $TmpDir)) { Remove-Item -LiteralPath $TmpDir -Recurse -Force } } catch {}');
  P('  exit 1');
  P('}');
  P('');
  P('function Sha256File([string]$p) {');
  P("  return (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()");
  P('}');
  P('');
  P("Write-Host '=================================================='");
  P("Write-Host ' デメカル 本番取得 — インストール'");
  P('Write-Host ("  版     : {0}" -f $Version)');
  P('Write-Host ("  配置先 : {0}" -f $InstallRoot)');
  P('Write-Host ("  本数   : {0}" -f $Files.Count)');
  P("Write-Host '=================================================='");
  P("Write-Host ''");
  P('');
  P('$TmpDir = $InstallRoot + ".new"');
  P('$OldDir = $InstallRoot + ".old"');
  P('');
  P('# ── 1. 作業フォルダへ 3 本を書き出し、その場で 1 本ずつ照合する ──');
  P('#    target へ直接書かない。途中で落ちても既存の正常セットを壊さないため。');
  P('try {');
  P('  $parent = Split-Path -Parent $InstallRoot');
  P('  if ($parent -and -not (Test-Path -LiteralPath $parent)) {');
  P('    New-Item -ItemType Directory -Path $parent -Force | Out-Null');
  P('  }');
  P('  if (Test-Path -LiteralPath $TmpDir) { Remove-Item -LiteralPath $TmpDir -Recurse -Force }');
  P('  New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null');
  P('} catch {');
  P("  Fail 'WORKDIR_FAILED' $_.Exception.Message");
  P('}');
  P('');
  P('foreach ($f in $Files) {');
  P('  $dest = Join-Path $TmpDir $f.Name');
  P('  try {');
  P("    $raw = [Convert]::FromBase64String(($f.B64 -replace '\\s', ''))");
  P('    [IO.File]::WriteAllBytes($dest, $raw)');
  P('  } catch {');
  P("    Fail 'WRITE_FAILED' ('{0}: {1}' -f $f.Name, $_.Exception.Message)");
  P('  }');
  P('  $got = Sha256File $dest');
  P('  if ($got -ne $f.Sha) {');
  P("    Fail 'HASH_MISMATCH' ('{0}: 期待 {1} / 実測 {2}' -f $f.Name, $f.Sha, $got)");
  P('  }');
  P('  Write-Host ("  作成 OK  {0}  ({1} bytes)" -f $f.Name, $raw.Length)');
  P('}');
  P('');
  P('# 余計なものが混ざっていない・欠けていないことを本数で見る。');
  P('$made = @(Get-ChildItem -LiteralPath $TmpDir -File | ForEach-Object { $_.Name } | Sort-Object)');
  P('$want = @($Files | ForEach-Object { $_.Name } | Sort-Object)');
  P("if (($made -join '|') -ne ($want -join '|')) {");
  P("  Fail 'SET_INCOMPLETE' ('作業フォルダの内容が一致しません: {0}' -f ($made -join ', '))");
  P('}');
  P('');
  P('# ── 2. ここで初めて target を入れ替える ────────────────────────');
  P('#    **旧セット (.old) はまだ捨てない。** 捨ててよいのは 配置後の照合が');
  P('#    全部通ったあとだけ (下記 ── 4)。先に捨てると、照合に落ちたときに');
  P('#    戻す先が無く、**壊れた新セットが target に居座る**。');
  P('$OldSaved = $false');
  P('try {');
  P('  if (Test-Path -LiteralPath $OldDir) { Remove-Item -LiteralPath $OldDir -Recurse -Force }');
  P('  if (Test-Path -LiteralPath $InstallRoot) {');
  P('    Move-Item -LiteralPath $InstallRoot -Destination $OldDir -Force');
  P('    $OldSaved = $true');
  P('  }');
  P('  Move-Item -LiteralPath $TmpDir -Destination $InstallRoot -Force');
  P('} catch {');
  P('  # 入れ替えの途中で落ちたら、退避した旧セットを必ず戻す。');
  P('  try { if ($OldSaved -and -not (Test-Path -LiteralPath $InstallRoot)) { Move-Item -LiteralPath $OldDir -Destination $InstallRoot -Force } } catch {}');
  P("  Fail 'SWAP_FAILED' $_.Exception.Message");
  P('}');
  P('');
  P('# ── 3. 入れ替えた**後**の実物をもう一度照合する ────────────────');
  P('#    ここを省くと「移動に失敗したが気づかない」形の混成セットが通る。');
  P('#    落ちたら target を元へ戻す。**壊れた新セットを置いたままにしない。**');
  P('function Restore-Old {');
  P('  # 配置後の照合に落ちた = target に信用できないセットが在る。まず消す。');
  P('  try { if (Test-Path -LiteralPath $InstallRoot) { Remove-Item -LiteralPath $InstallRoot -Recurse -Force } } catch {}');
  P('  # 旧セットが在ったなら必ず戻す。初回で旧セットが無いときは、target ごと');
  P('  # 無い状態にする (壊れたものを残すより、次の install をやり直せる方がよい)。');
  P('  if ($OldSaved) {');
  P('    try { Move-Item -LiteralPath $OldDir -Destination $InstallRoot -Force } catch {}');
  P('  }');
  P('}');
  P('');
  P('foreach ($f in $Files) {');
  P('  $dest = Join-Path $InstallRoot $f.Name');
  P('  if (-not (Test-Path -LiteralPath $dest)) {');
  P('    Restore-Old');
  P("    Fail 'INSTALLED_MISSING' ('配置後に見つかりません: {0}' -f $f.Name)");
  P('  }');
  P('  $got = Sha256File $dest');
  P('  if ($got -ne $f.Sha) {');
  P('    Restore-Old');
  P("    Fail 'INSTALLED_MISMATCH' ('{0}: 期待 {1} / 実測 {2}' -f $f.Name, $f.Sha, $got)");
  P('  }');
  P('  Write-Host ("  照合 OK  {0}  {1}" -f $f.Name, $f.Sha.Substring(0, 16))');
  P('}');
  P('');
  P('# 配置後も本数と名前を見る (作業フォルダのときと同じ検算をもう一度)。');
  P('$done = @(Get-ChildItem -LiteralPath $InstallRoot -File | ForEach-Object { $_.Name } | Sort-Object)');
  P("if (($done -join '|') -ne ($want -join '|')) {");
  P('  Restore-Old');
  P("  Fail 'INSTALLED_SET_INCOMPLETE' ('配置後の内容が一致しません: {0}' -f ($done -join ', '))");
  P('}');
  P('');
  P('# ── 4. 配置後の照合が全部通った。ここで初めて旧セットを捨てる ──');
  P('if ($OldSaved) { try { Remove-Item -LiteralPath $OldDir -Recurse -Force } catch {} }');
  P('');
  P('# ── 5. 手控え (非 PII。個人情報も鍵も書かない) ──────────────────');
  P('try {');
  P('  $mf = [ordered]@{');
  P('    production_version = $Version');
  blobs.forEach((b, i) => {
    const key = b.name.replace(/^demecal-/, '').replace(/\.ps1$/, '').replace(/-/g, '_');
    P(`    ${key}_sha256 = $Sha${i}`);
  });
  P('    installed_at = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(9)).ToString("yyyy-MM-ddTHH:mm:sszzz")');
  P('  }');
  P("  $mf | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $InstallRoot 'install-manifest.json') -Encoding UTF8");
  P('} catch {}');
  P('');
  P("Write-Host ''");
  P('Write-Host ("INSTALL_OK  {0}  →  {1}" -f $Version, $InstallRoot)');
  P("Write-Host ''");
  P("Write-Host '  ここまでで配置は完了です。取得はまだ実行していません。'");
  P("Write-Host '  自動実行の登録 (タスクスケジューラ) は次の手順で行います。'");
  P('exit 0');

  // ── 5. cmd 部は配布共通 (`demecal-bat.ts`)。終了コードを返す形が要る ──
  const { bytes } = wrapPs1AsBat(
    ps.join('\r\n') + '\r\n',
    `demecal-install v${version.split('-').pop()}`,
    'demecal_install_error.txt',
  );

  return { bytes, version, entries };
}
