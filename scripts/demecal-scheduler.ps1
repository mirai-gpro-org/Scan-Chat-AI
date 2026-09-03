# デメカル 本番取得 — **タスクスケジューラ登録** (Phase C / C-5)
#
# 正本: docs/lab/demecal_recovery_plan_20260902.md §7.2 C-5
# 検査: npm run verify:demecal-scheduler
#
# 【このスクリプトがやること】
#   C-4.1 で配置済みの本番 runner を、Windows タスクスケジューラへ**登録するだけ**。
#     preflight (3 本 + 手控え + 証明書 + 資格情報) → XML 生成 → schtasks /Create → 読み戻して照合
#
# 【やらないこと — ここが C-5 最大の安全条件】
#   **登録するタスクは最初から無効 (`<Enabled>false</Enabled>`)。**
#   C-6 monitoring と最終の controlled validation が終わるまで自動取得を始めない。
#     ・`schtasks /Run` しない       ・`Enable-ScheduledTask` しない
#     ・`demecal-production.ps1` を起動しない
#     ・デメカルへ接続しない          ・取得範囲 state を GET も POST もしない
#   登録 → 設定の確認 → **無効のまま終了**。ここまで。
#
# 【Windows のパスワードを保存しない】
#   principal = **setup を実行した今のユーザー** / LogonType = `InteractiveToken` /
#   RunLevel = `LeastPrivilege`。「ユーザーがログオンしているかどうかにかかわらず実行する」は
#   採らない (`demecal_unattended_spec §4.3` の確定どおり)。
#   理由は**証明書**: mTLS のクライアント証明書は `Cert:\CurrentUser\My` にしか無いので、
#   別ユーザー / SYSTEM で走らせると証明書が見えず必ず失敗する。
#   → **「証明書と DPAPI 資格情報を持っている今のユーザー」と task principal を一致させる**のが要件。
#     だから UserId は `info` のようなアカウント名をベタ書きせず、**実行中の SID を解決して入れる**。
#
# 【-InstallRoot】配置先を明示注入する (テスト用)。空なら既定 C:\demecal\production。
#   専用PC では bat が -NoProfile で起動するので未定義 = 既定値になる。

$ErrorActionPreference = 'Continue'

$Version = 'scheduler-1.0'

# 配布生成時に差し込む。**未設定・不正なら bat を配らない**ので、ここに
# プレースホルダのまま届くことは通常ない (下の Test-DailyAt が最後の砦)。
$DailyAt = '__DAILY_AT__'

$TaskName = 'Wellfort-Demecal-Acquisition'

# C-4.1 が配置した場所と、① recon が DPAPI で資格情報を書いた場所。
# **Join-Path を使わない** — 手続き部より前に C: を触ると Windows 以外で読み込み自体が落ちる。
if (-not $InstallRoot) { $InstallRoot = 'C:\demecal\production' }
if (-not $CredPath)    { $CredPath    = 'C:\demecal\secrets\demecal.cred.xml' }
if (-not $XmlPath)     { $XmlPath     = 'C:\demecal\scheduler-task.xml' }

# C-4.1 が置く 3 本 + 手控え。**この 4 つが揃っていないと登録しない。**
$RequiredFiles = @('demecal-production.ps1', 'demecal-verify.ps1', 'demecal-range.ps1')
$ManifestName  = 'install-manifest.json'

# 証明書の絞り込み。**CN をベタ書きしない** (更新で変わる)。発行者と秘密鍵で見る。
$CertIssuerPattern = 'demecal\.net CA'

function Say([string]$m) { Write-Host $m }

function Stop-Setup([string]$code, [string]$msg) {
  Write-Host ''
  Write-Host ('SCHEDULER_INSTALL_FAILED  {0}' -f $code)
  Write-Host ('  {0}' -f $msg)
  exit 1
}

<#
.SYNOPSIS
  登録したタスクを消す。**消すだけ。/Run も有効化も絶対にしない。**
.DESCRIPTION
  戻り値 = 「消えたことを確かめられた」か。
  確かめ方は読み戻しと同じで、`/Query /XML` に `<Task` が返らないこと。
  **`/Delete` の出力の文言では判定しない** — 表示は環境で変わり得るので、
  「引けなくなったか」という観測できる事実で見る。
#>
function Remove-RegisteredTask {
  try { & schtasks /Delete /TN $TaskName /F 2>&1 | Out-Null } catch {}
  try {
    $q = (& schtasks /Query /TN $TaskName /XML 2>&1 | Out-String)
    return ($q.IndexOf('<Task') -lt 0)
  } catch {
    # 引けなかった = 消えたとは言い切れない。**確認できないものを成功にしない。**
    return $false
  }
}

<#
.SYNOPSIS
  `/Create` の**後**に失敗したとき用の終了処理。登録を残さない。
.DESCRIPTION
  【なぜ要るか — 2026-09-03 レビュー裁定】読み戻しの結果がどうであれ、
  そこへ来た時点でタスクは**もう登録されている**。とくに読み戻しが
  `Enabled=true` だった場合、失敗を報告しながら**有効なタスクが残る**。
  「C-6 monitoring と最終検証が終わるまで自動取得を開始しない」に反するので、
  **失敗するなら登録ごと引き取る**。

  消せなかったときは `REGISTERED_CLEANUP_FAILED` で明示する。
  **どちらも exit != 0。成功扱いにはしない。**
#>
function Stop-AfterCreate([string]$code, [string]$msg) {
  Write-Host ''
  Write-Host '  ※ 確認に失敗したので、いま登録したタスクを削除します (有効なまま残さないため)。'
  if (Remove-RegisteredTask) {
    Write-Host '  ※ 削除しました。'
    Stop-Setup $code $msg
  }
  # **1 行で組む。** 閉じ括弧のあとで改行して `+` を続けると、そこで式が切れて
  # 構文エラーになる (実測 2026-09-03。丸ごと parse できず手続き部が動かなくなった)。
  $why = ('{0} ({1}) のあと、登録したタスク {2} を削除できませんでした。' -f $code, $msg, $TaskName)
  $why = $why + ' タスクスケジューラから手動で削除してください。**有効化しないでください。**'
  Stop-Setup 'REGISTERED_CLEANUP_FAILED' $why
}

# ── 環境に触る部分は入口を分けておく ───────────────────────────
#    SID / 証明書ストア / schtasks は **Windows にしか無い**。入口を分けてあると、
#    検査が**その入口だけ**を差し替えて手続き部 (preflight・XML 生成・照合) を
#    丸ごと本物のまま走らせられる。実装そのものは実機で動く本物。

# 実行中のユーザー。**scriptblock 変数**にしてあるのは、`$InstallRoot` と同じ
# 「呼び出し元が先に定義していればそれを使う」形にするため。
# `WindowsIdentity` は Windows でしか動かないので、検査はここを差し替えて
# **手続き部を丸ごと**走らせる (関数だと Invoke-Expression 側の定義が後から勝つ)。
# 専用PC では -NoProfile 起動で未定義 = 下の本物が使われる。
if (-not $GetUserSid)  { $GetUserSid  = { ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value } }
if (-not $GetUserName) { $GetUserName = { ([Security.Principal.WindowsIdentity]::GetCurrent()).Name } }

<#
.SYNOPSIS
  クライアント証明書が「今のユーザーの個人ストア」に在るかだけを見る。
.DESCRIPTION
  **値は返さない・表示しない。** 在るか無いかと、参考の残日数だけ。
  発行者 CN = demecal.net CA かつ 秘密鍵あり で絞る (`demecal_unattended_spec §4.3`)。
#>
function Find-DemecalCert {
  try {
    $all = @(Get-ChildItem -Path 'Cert:\CurrentUser\My' -ErrorAction Stop)
  } catch {
    return $null
  }
  foreach ($c in $all) {
    if ($c.Issuer -match $CertIssuerPattern -and $c.HasPrivateKey) { return $c }
  }
  return $null
}

function Sha256File([string]$p) {
  return (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()
}

<#
.SYNOPSIS
  HH:mm を厳密に見る。**既定値を作らない** (repo 側で未確定のため)。
.DESCRIPTION
  `^(?:[01]\d|2[0-3]):[0-5]\d\z` 完全一致のみ。`9:30` / `24:00` / `09:60` は不可。
  `\z` を使うのは .NET の `$` が末尾の改行の手前にも一致するため。
#>
function Test-DailyAt([string]$v) {
  if ([string]::IsNullOrWhiteSpace($v)) { return $false }
  return ($v -match '^(?:[01]\d|2[0-3]):[0-5]\d\z')
}

<#
.SYNOPSIS
  登録する Task Scheduler XML を組む。
.DESCRIPTION
  **`<Enabled>false</Enabled>`** = 登録しても走らない (C-5 の安全条件)。
  トリガ側の Enabled は true のままにしてある — 後で C-6 が終わって
  タスクを有効にしたとき、トリガを別途触らずに済むようにするため。

  StartBoundary の**日付は固定値**にする。実行日を入れると
  「いつ生成したか」で XML が変わり、検査で固定できない (JST の扱いも増える)。
  日次トリガは開始日以降の毎日なので、過去日付で問題ない。
#>
function New-TaskXml([string]$sid, [string]$at, [string]$root) {
  $exe  = 'powershell.exe'
  $args = '-NoProfile -ExecutionPolicy Bypass -File "{0}\demecal-production.ps1"' -f $root
  return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Wellfort blood-test CSV acquisition ($Version). Registered disabled; enable after monitoring is in place.</Description>
    <URI>\$TaskName</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$sid</UserId>
    </LogonTrigger>
    <CalendarTrigger>
      <StartBoundary>2026-01-01T${at}:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$sid</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>false</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$exe</Command>
      <Arguments>$args</Arguments>
    </Exec>
  </Actions>
</Task>
"@
}

<#
.SYNOPSIS
  読み戻した XML が、こちらの意図どおりかを 9 点で照合する。
.DESCRIPTION
  **一致しなければ成功扱いしない。** `/Create` が通っても、OS 側が値を
  読み替える・落とすことがあり得るので、登録したこと自体を成功の証拠にしない。
  返り値は不一致の理由 (空配列 = 全部一致)。
#>
function Test-RegisteredXml([string]$xmlText, [string]$sid, [string]$at, [string]$root) {
  $bad = @()
  try {
    $doc = [xml]$xmlText
  } catch {
    return @('読み戻した XML を解析できない: ' + $_.Exception.Message)
  }
  $t = $doc.Task
  if (-not $t) { return @('Task 要素が無い') }

  $uri = ('' + $t.RegistrationInfo.URI).TrimStart('\')
  if ($uri -ne $TaskName) { $bad += ("task name: 期待 {0} / 実測 {1}" -f $TaskName, $uri) }

  $p = $t.Principals.Principal
  if (('' + $p.UserId) -ne $sid)                 { $bad += ("user SID: 期待 {0} / 実測 {1}" -f $sid, $p.UserId) }
  if (('' + $p.LogonType) -ne 'InteractiveToken'){ $bad += ("LogonType: 実測 {0}" -f $p.LogonType) }
  if (('' + $p.RunLevel) -ne 'LeastPrivilege')   { $bad += ("RunLevel: 実測 {0}" -f $p.RunLevel) }

  $s = $t.Settings
  if (('' + $s.Enabled) -ne 'false')                        { $bad += ("Enabled: 実測 {0} (無効で登録する契約)" -f $s.Enabled) }
  if (('' + $s.StartWhenAvailable) -ne 'true')              { $bad += ("StartWhenAvailable: 実測 {0}" -f $s.StartWhenAvailable) }
  if (('' + $s.MultipleInstancesPolicy) -ne 'IgnoreNew')    { $bad += ("MultipleInstancesPolicy: 実測 {0}" -f $s.MultipleInstancesPolicy) }
  if (('' + $s.ExecutionTimeLimit) -ne 'PT30M')             { $bad += ("ExecutionTimeLimit: 実測 {0}" -f $s.ExecutionTimeLimit) }

  if (-not $t.Triggers.LogonTrigger) { $bad += 'LogonTrigger が無い' }
  $cal = $t.Triggers.CalendarTrigger
  if (-not $cal) {
    $bad += 'DailyTrigger (CalendarTrigger) が無い'
  } else {
    if (-not $cal.ScheduleByDay) { $bad += 'ScheduleByDay が無い (日次でない)' }
    $sb = '' + $cal.StartBoundary
    if ($sb -notmatch ([regex]::Escape('T' + $at + ':00'))) {
      $bad += ("daily time: 期待 {0} / 実測 {1}" -f $at, $sb)
    }
  }

  $exec = $t.Actions.Exec
  if (-not $exec) {
    $bad += 'Exec アクションが無い'
  } else {
    if (('' + $exec.Command) -ne 'powershell.exe') { $bad += ("action command: 実測 {0}" -f $exec.Command) }
    $want = '{0}\demecal-production.ps1' -f $root
    if (('' + $exec.Arguments) -notlike ('*' + $want + '*')) {
      $bad += ("action path: 期待 {0} を含まない / 実測 {1}" -f $want, $exec.Arguments)
    }
  }
  return $bad
}

# ── ここから下は手続き部 ──────────────────────────────────────

Say '=================================================='
Say ' デメカル 本番取得 — 自動実行の登録'
Say (" 版     : {0}" -f $Version)
Say (" 配置先 : {0}" -f $InstallRoot)
Say (" タスク : {0}" -f $TaskName)
Say '=================================================='
Say ''
Say '  ※ 登録するだけです。取得はまだ実行しません。'
Say '  ※ 登録したタスクは「無効」の状態です。有効にするのは監視の準備が整ってからです。'
Say ''

# [1] 実行時刻。**既定値を作らない。**
if (-not (Test-DailyAt $DailyAt)) {
  Stop-Setup 'DAILY_AT_INVALID' ("実行時刻が HH:mm (00:00-23:59) ではありません: '{0}'" -f $DailyAt)
}
Say ("[1] 実行時刻 {0} (毎日) ＋ ログオン時" -f $DailyAt)

# [2] C-4.1 が配置したものが揃っているか。**揃っていなければ登録しない。**
if (-not (Test-Path -LiteralPath $InstallRoot)) {
  Stop-Setup 'INSTALL_ROOT_MISSING' ("配置先がありません: {0} — インストーラを先に実行してください" -f $InstallRoot)
}
foreach ($n in $RequiredFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot $n))) {
    Stop-Setup 'FILE_MISSING' ("{0} がありません — インストーラを再実行してください" -f $n)
  }
}
$mfPath = Join-Path $InstallRoot $ManifestName
if (-not (Test-Path -LiteralPath $mfPath)) {
  Stop-Setup 'MANIFEST_MISSING' ("{0} がありません — インストーラを再実行してください" -f $ManifestName)
}

# [3] 手控えの 3 SHA と実ファイルを再照合する。
#     **混成セット (一部だけ古い) の上へタスクを登録しない。**
try {
  $mf = Get-Content -LiteralPath $mfPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  Stop-Setup 'MANIFEST_UNREADABLE' ("{0} を読めません: {1}" -f $ManifestName, $_.Exception.Message)
}
$sha = @{
  'demecal-production.ps1' = '' + $mf.production_sha256
  'demecal-verify.ps1'     = '' + $mf.verify_sha256
  'demecal-range.ps1'      = '' + $mf.range_sha256
}
foreach ($n in $RequiredFiles) {
  $want = $sha[$n]
  if ([string]::IsNullOrWhiteSpace($want)) {
    Stop-Setup 'MANIFEST_INCOMPLETE' ("{0} の SHA-256 が手控えにありません" -f $n)
  }
  $got = Sha256File (Join-Path $InstallRoot $n)
  if ($got -ne $want.ToLowerInvariant()) {
    Stop-Setup 'HASH_MISMATCH' ("{0}: 期待 {1} / 実測 {2} — インストーラを再実行してください" -f $n, $want, $got)
  }
}
Say ("[2] 配置 OK  3 本 + 手控え (版 {0})" -f $mf.production_version)

# [4] 証明書。**在るかどうかだけ。値も拇印も出さない。**
$cert = Find-DemecalCert
if (-not $cert) {
  Stop-Setup 'CERT_MISSING' ("このユーザーの証明書ストアに demecal.net CA 発行の証明書 (秘密鍵あり) がありません")
}
Say '[3] 証明書 OK (このユーザーの個人ストアに在り・秘密鍵あり)'

# [5] ① recon が保存した資格情報。**在るかどうかだけ。中身は開かない。**
if (-not (Test-Path -LiteralPath $CredPath)) {
  Stop-Setup 'CREDENTIAL_MISSING' ("資格情報がありません — 初回セットアップ (recon) を先に実行してください")
}
Say '[4] 資格情報 OK (中身は読みません)'

# [6] principal = 今のユーザー。SID で固定する。
try {
  $sid = & $GetUserSid
  $who = & $GetUserName
} catch {
  Stop-Setup 'SID_UNRESOLVED' ("実行中のユーザーを解決できません: {0}" -f $_.Exception.Message)
}
if ([string]::IsNullOrWhiteSpace($sid)) { Stop-Setup 'SID_UNRESOLVED' '実行中のユーザーの SID が空です' }
Say ("[5] 実行ユーザー {0}" -f $who)

# [7] XML を書く。**Windows のパスワードは保存しない** (InteractiveToken)。
$xml = New-TaskXml $sid $DailyAt $InstallRoot
try {
  $xmlDir = Split-Path -Parent $XmlPath
  if ($xmlDir -and -not (Test-Path -LiteralPath $xmlDir)) {
    New-Item -ItemType Directory -Path $xmlDir -Force | Out-Null
  }
  Set-Content -LiteralPath $XmlPath -Value $xml -Encoding Unicode
} catch {
  Stop-Setup 'XML_WRITE_FAILED' $_.Exception.Message
}
Say ("[6] 定義を作成 {0}" -f $XmlPath)

# [8] 登録。**タスクスケジューラの画面は開かせない。**
$created = & schtasks /Create /TN $TaskName /XML $XmlPath /F 2>&1
Say ("[7] 登録 {0}" -f (($created | Out-String).Trim()))

# [9] 読み戻して照合する。**登録できたこと自体を成功の証拠にしない。**
#
#     ここから先の失敗では **登録したタスクを残さない** (下記 Stop-AfterCreate)。
#     残すと「失敗を報告しながら、有効なタスクが残る」ことが起こり得る
#     — 読み戻しが `Enabled=true` だった場合がまさにそれで、
#     「C-6 まで自動取得を開始しない」に正面から反する。
$queried = & schtasks /Query /TN $TaskName /XML 2>&1
$text = ($queried | Out-String)
$cut = $text.IndexOf('<')
if ($cut -lt 0) {
  Stop-AfterCreate 'READBACK_FAILED' ("登録したタスクの定義を読み戻せません: {0}" -f $text.Trim())
}
$xmlText = $text.Substring($cut)
try {
  $null = [xml]$xmlText
} catch {
  Stop-AfterCreate 'READBACK_UNPARSABLE' ("読み戻した定義を解析できません: {0}" -f $_.Exception.Message)
}
$bad = Test-RegisteredXml $xmlText $sid $DailyAt $InstallRoot
if ($bad.Count -gt 0) {
  Stop-AfterCreate 'REGISTERED_MISMATCH' ("登録内容が意図と違います: " + ($bad -join ' / '))
}

Say '[8] 読み戻して照合 OK'
Say '      タスク名 / 実行ユーザー(SID) / InteractiveToken / LeastPrivilege'
Say '      無効(Enabled=false) / ログオン時トリガ / 毎日トリガ'
Say '      StartWhenAvailable / IgnoreNew / PT30M / 実行するファイル'
Say ''
Say ('SCHEDULER_INSTALL_OK  {0}  {1}  daily {2}' -f $Version, $TaskName, $DailyAt)
Say ''
Say '  登録しました。**まだ無効なので自動では走りません。**'
Say '  取得を始めてよい状態になったら、こちらから有効化の手順をご案内します。'
exit 0
