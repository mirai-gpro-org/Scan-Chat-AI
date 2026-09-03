# デメカル 本番取得 runner (C-4 Foundation) のテスト
#
# 正本: docs/lab/demecal_recovery_plan_20260902.md §7.2 C-4
# 実行: pwsh -NoProfile -File scripts/tests/demecal-production.tests.ps1
#       (npm run verify:demecal-production)
#
# 【3 層で見る】
#   ①純粋関数の振る舞い (Get-RunAction / Get-WatermarkDecision)
#   ②**Phase B parity** — STATE A/B/C と CSV 検査を**再定義していない**ことを
#     ScriptBlock の同一性で機械確認する (書き写すと必ずずれる)
#   ③**手続き部を子プロセスで実際に走らせる** — noop / not_initialized /
#     invalid_state のとき **`Invoke-WebRequest` が 1 回も呼ばれない**ことを実測する。
#     ソース検査だけでは「呼ばれない経路」を保証できない。
#
# 実サイトへは接続しない (fixture と偽の口だけ)。

$ErrorActionPreference = 'Stop'

$Root    = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$Prod    = Join-Path $Root 'scripts/demecal-production.ps1'
$Verify  = Join-Path $Root 'scripts/demecal-verify.ps1'
$Daily   = Join-Path $Root 'scripts/demecal-daily.ps1'
$FixDir  = Join-Path $PSScriptRoot 'fixtures/demecal'

$script:Pass = 0
$script:Fail = New-Object System.Collections.Generic.List[string]

function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { $script:Pass++; Write-Host ("  OK   {0}" -f $name) }
  else {
    $script:Fail.Add(("{0}{1}" -f $name, $(if ($detail) { " — $detail" } else { '' }))) | Out-Null
    Write-Host ("  NG   {0} — {1}" -f $name, $detail)
  }
}

# ── この親プロセスでは通信させない ────────────────────────────
function Invoke-WebRequest { throw 'テスト中に Invoke-WebRequest が呼ばれました' }
function Invoke-RestMethod { throw 'テスト中に Invoke-RestMethod が呼ばれました' }

foreach ($p in @($Prod, $Verify, $Daily)) {
  if (-not (Test-Path $p)) { Write-Error "対象が見つかりません: $p"; exit 1 }
}

. $Prod -LibOnly

$prodSrc = Get-Content -Path $Prod -Raw -Encoding UTF8
# コメントを落とした「実際に動く行」だけを見る。
# **ブロックコメントを先に落とす。** 行コメントを先に消すと `#>` の行まで
# 消えてしまい、`<#...#>` の対応が壊れて help の中身が残る
# (実測 2026-09-03: help に書いた `force` の語で誤検出した)。
$prodCode = [regex]::Replace($prodSrc, '(?s)<#.*?#>', '')
$prodCode = ($prodCode -split "`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"

function Read-Html([string]$n) { return (Get-Content -Path (Join-Path $FixDir $n) -Raw -Encoding UTF8) }
function Read-Bytes([string]$n) { return [IO.File]::ReadAllBytes((Join-Path $FixDir $n)) }
function Plan([string]$lastTo, [string]$today) {
  return (Resolve-DemecalAcquisitionRange -LastTo $lastTo -TodayJst $today)
}

Write-Host "`n― Get-RunAction (ポータルへ行ってよいかを決める) ―――――"

$a = Get-RunAction (Plan '2026-08-31' '2026-09-03')
Check 'P01 ready → Proceed=true / range を持つ' `
  ($a.Proceed -and $a.Result -eq 'ok' -and $a.RangeFrom -eq '2026-09-01' -and $a.RangeTo -eq '2026-09-02') `
  ("{0}/{1} {2}..{3}" -f $a.Proceed, $a.Result, $a.RangeFrom, $a.RangeTo)

$a = Get-RunAction (Plan '2026-09-02' '2026-09-03')
Check 'P02 noop → Proceed=false / result=ok / rows=0 / range なし' `
  ((-not $a.Proceed) -and $a.Result -eq 'ok' -and $a.Rows -eq 0 -and $a.RangeFrom -eq '' -and $a.RangeTo -eq '') `
  ("{0}/{1} rows={2} range={3}..{4}" -f $a.Proceed, $a.Result, $a.Rows, $a.RangeFrom, $a.RangeTo)

$a = Get-RunAction (Plan '' '2026-09-03')
Check 'P03 not_initialized → Proceed=false / result=fail' `
  ((-not $a.Proceed) -and $a.Result -eq 'fail' -and $a.Code -eq 'STATE_NOT_INITIALIZED') `
  ("{0}/{1} {2}" -f $a.Proceed, $a.Result, $a.Code)

$a = Get-RunAction (Plan '2026-09-05' '2026-09-03')
Check 'P04 invalid_state (窓より未来) → Proceed=false / result=fail' `
  ((-not $a.Proceed) -and $a.Result -eq 'fail' -and $a.Code -eq 'STATE_LAST_TO_AHEAD_OF_WINDOW') `
  ("{0}/{1} {2}" -f $a.Proceed, $a.Result, $a.Code)

$a = Get-RunAction (Plan 'こわれた日付' '2026-09-03')
Check 'P05 last_to が壊れている → Proceed=false / result=fail' `
  ((-not $a.Proceed) -and $a.Result -eq 'fail') ("{0}/{1} {2}" -f $a.Proceed, $a.Result, $a.Code)

$a = Get-RunAction $null
Check 'P06 プランナの結果が無い → Proceed=false / result=fail (fail-closed)' `
  ((-not $a.Proceed) -and $a.Result -eq 'fail') ("{0}/{1}" -f $a.Proceed, $a.Result)

Write-Host "`n― Get-WatermarkDecision (前進してよいか) ―――――――――"

$cd0 = 'attachment; filename="Q05-0010-000000result_20260701_0.csv"'
$cd2 = 'attachment; filename="Q05-0010-000000result_20260701_2.csv"'

$zero = Test-CsvResponse (Read-Bytes 'sample-empty.csv') 'text/csv' $cd0
Check 'P10 valid CSV + rows=0 → 前進してよい (ZERO_ROWS)' `
  ((Get-WatermarkDecision $zero).Advance -and (Get-WatermarkDecision $zero).Reason -eq 'ZERO_ROWS') `
  ((Get-WatermarkDecision $zero).Reason)

$some = Test-CsvResponse (Read-Bytes 'sample.csv') 'text/csv' $cd2
$dSome = Get-WatermarkDecision $some
Check 'P11 valid CSV + rows>0 → 前進させない (後段の受領契約が無い)' `
  ((-not $dSome.Advance) -and $dSome.Reason -eq 'HANDOFF_NOT_IMPLEMENTED') `
  ("advance={0} reason={1} rows={2}" -f $dSome.Advance, $dSome.Reason, $some.Rows)

$bad = Test-CsvResponse (Read-Bytes 'sample-noheader.csv') 'text/csv' $cd0
Check 'P12 CSV が invalid → 前進させない' `
  ((-not (Get-WatermarkDecision $bad).Advance) -and (Get-WatermarkDecision $bad).Reason -eq 'CSV_INVALID') `
  ((Get-WatermarkDecision $bad).Reason)

$html = Test-CsvResponse ([Text.Encoding]::UTF8.GetBytes('<html>x</html>')) 'text/html' ''
Check 'P13 HTML が返った → 前進させない' `
  (-not (Get-WatermarkDecision $html).Advance) ((Get-WatermarkDecision $html).Reason)

Check 'P14 CSV 検査結果が無い → 前進させない (fail-closed)' `
  (-not (Get-WatermarkDecision $null).Advance) ((Get-WatermarkDecision $null).Reason)

# Ok=true なのに行数が無い、という壊れ方でも前進させない。
$fakeRowsNull = [pscustomobject]@{ Ok = $true; Rows = $null }
Check 'P15 Ok なのに rows が null → 前進させない (ROWS_UNKNOWN)' `
  ((-not (Get-WatermarkDecision $fakeRowsNull).Advance) -and (Get-WatermarkDecision $fakeRowsNull).Reason -eq 'ROWS_UNKNOWN') `
  ((Get-WatermarkDecision $fakeRowsNull).Reason)

Write-Host "`n― Phase B parity (書き写していないことの機械確認) ―――"

# verify-1.4 を**別スコープ**で読み、同じ名前の関数が**同一の中身**であることを見る。
$vScope = [powershell]::Create()
$null = $vScope.AddScript(@"
. '$Verify' -LibOnly
`$names = @('Get-Forms','Get-StateOf','Select-ExpectedForm','Test-DealerCode','Select-Hanbaiten',
            'New-StateARequest','Test-StateBContract','New-StateBRequest','Test-StateCContract',
            'New-StateCRequest','Test-CsvResponse','Html-Decode','Get-Skeleton','Get-StateCHtmlForSkeleton')
`$out = @{}
foreach (`$n in `$names) { `$out[`$n] = (Get-Command `$n).ScriptBlock.ToString() }
`$out
"@)
$vOut = $vScope.Invoke()
$vScope.Dispose()
$vMap = $vOut[0]

$shared = @('Get-Forms','Get-StateOf','Select-ExpectedForm','Test-DealerCode','Select-Hanbaiten',
            'New-StateARequest','Test-StateBContract','New-StateBRequest','Test-StateCContract',
            'New-StateCRequest','Test-CsvResponse','Html-Decode','Get-Skeleton','Get-StateCHtmlForSkeleton')
$drift = @()
foreach ($n in $shared) {
  $mine = (Get-Command $n -ErrorAction SilentlyContinue)
  if (-not $mine) { $drift += "$n : production 側に無い"; continue }
  if ($mine.ScriptBlock.ToString() -ne $vMap[$n]) { $drift += "$n : 中身が違う" }
}
Check ("P20 STATE A/B/C・CSV 検査の {0} 関数が verify-1.4 と同一 (再定義していない)" -f $shared.Count) `
  ($drift.Count -eq 0) ($drift -join ' / ')

# production 自身がこれらを定義していない = dot-source して使っている、の裏取り。
$redef = @($shared | Where-Object { $prodCode -match ('(?m)^\s*function\s+' + [regex]::Escape($_) + '\b') })
Check 'P21 production はこれらの関数を自分で定義していない (dot-source して使う)' `
  ($redef.Count -eq 0) ($redef -join ' ')

Check 'P22 verify-1.4 を dot-source している' `
  ($prodCode -match "demecal-verify\.ps1'\)\s*-LibOnly") ''
Check 'P23 range プランナ (C-1) を dot-source している' `
  ($prodCode -match "demecal-range\.ps1'\)") ''
Check 'P24 daily-1.7 を参照しない (凍結・探索器を持ち込まない)' `
  (-not ($prodCode -match 'demecal-daily')) ''

Write-Host "`n― ready なら Phase B と同じ STATE A/B/C 要求を組む ―――"

$htmlA = Read-Html 'state-a.html'
$htmlB = Read-Html 'state-b.html'
$htmlC = Read-Html 'state-c.html'
function Form-Exp([string]$html, [string]$expect) {
  $r = Select-ExpectedForm (Get-Forms $html) $expect
  if (-not $r.Ok) { return $null }
  return $r.Form
}

$fa = Form-Exp $htmlA 'A'
$fb = Form-Exp $htmlB 'B'
$fc = Form-Exp $htmlC 'C'
Check 'P30 3 つの fixture がそれぞれ A / B / C と判定される' `
  ($null -ne $fa -and $null -ne $fb -and $null -ne $fc) `
  ("A={0} B={1} C={2}" -f ($null -ne $fa), ($null -ne $fb), ($null -ne $fc))

$ra = New-StateARequest $fa '000000' '架空テスト販売先'
Check 'P31 STATE A: 販売先 000000 を載せる' `
  ($ra.Ok -and (($ra.Body.Values -join ' ') -match '000000')) ("code={0}" -f $ra.Code)

# ready のときに渡る範囲 (Get-RunAction の結果) をそのまま使う。
$act = Get-RunAction (Plan '2026-08-31' '2026-09-03')
$pFrom = [datetime]::ParseExact($act.RangeFrom, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
$pTo   = [datetime]::ParseExact($act.RangeTo,   'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
$rb = New-StateBRequest $fb $htmlB $pFrom $pTo
Check 'P32 STATE B: 日付は yyyy/MM/dd で載る (プランナの範囲がそのまま届く)' `
  ($rb.Ok -and $rb.Body['DateFrom'] -eq '2026/09/01' -and $rb.Body['DateTo'] -eq '2026/09/02') `
  ("from={0} to={1} code={2}" -f $rb.Body['DateFrom'], $rb.Body['DateTo'], $rb.Code)
Check 'P33 STATE B: submitType は空のまま (Phase B 実測)' `
  ($rb.Body['submitType'] -eq '') ("submitType=[{0}]" -f $rb.Body['submitType'])
Check 'P34 STATE B: DataType / OutputHeader をラベルから取った値で明示' `
  ($rb.Body.ContainsKey('DataType') -and $rb.Body.ContainsKey('OutputHeader') -and
   $rb.Body['DataType'] -ne '' -and $rb.Body['OutputHeader'] -ne '') `
  ("DataType=[{0}] OutputHeader=[{1}]" -f $rb.Body['DataType'], $rb.Body['OutputHeader'])

$rc = New-StateCRequest $fc $htmlC
Check 'P35 STATE C: submitType=download を載せる (Phase B 実測)' `
  ($rc.Ok -and $rc.Body['submitType'] -eq 'download') `
  ("submitType=[{0}] code={1}" -f $rc.Body['submitType'], $rc.Code)

Write-Host "`n― 手続き部を実際に走らせる (ポータルに触らないこと) ――"

# **子プロセスで本物の手続き部を走らせる。**
#   ・`Invoke-WebRequest` は呼ばれたらその場で throw する (= ポータルに触った証拠)
#   ・`Invoke-RestMethod` は state / run の偽の口。呼ばれた URL を数える
#   ・取り込み専用キーは実運用と同じく埋め込み済みにする (未埋め込みだと手前で止まる)
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("demecal-c4-" + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $tmp
Copy-Item $Verify (Join-Path $tmp 'demecal-verify.ps1')
Copy-Item (Join-Path $Root 'scripts/demecal-range.ps1') (Join-Path $tmp 'demecal-range.ps1')
$prodTmp = Join-Path $tmp 'demecal-production.ps1'
# bat 生成と同じ置換 (プレースホルダを実キーに差し替える)。
Set-Content -Path $prodTmp -Encoding UTF8 -Value ($prodSrc -replace [regex]::Escape('__LAB_INTAKE' + '_KEY__'), 'test-intake-key')

# 引数は**環境変数で渡す** — `Start-Process` は空文字の引数を落とすので、
# `-LastTo ''` (未初期化のケース) が後ろの引数へずれる (実測 2026-09-03)。
# 証明書ストア・資格情報も差し替える。**そうしないと Linux では [2] 証明書で必ず止まり、
# 「ポータルへのアクセス 0 回」が常に真になって検査が意味を失う** (P49 がそれを見張る)。
$driver = @'
$ErrorActionPreference = 'Continue'
function Invoke-WebRequest {
  'PORTAL' | Out-File -FilePath $env:C4_OUT -Append -Encoding utf8
  throw 'PORTAL_TOUCHED'
}
function Invoke-RestMethod {
  param($Uri, $Method, $TimeoutSec, $Body, $ContentType, $Headers)
  ("API " + $Method + " " + $Uri) | Out-File -FilePath $env:C4_OUT -Append -Encoding utf8
  if ($Uri -like '*demecal-state*') {
    if ($Method -eq 'Post') { return [pscustomobject]@{ ok = $true; updated = $true } }
    return [pscustomobject]@{ ok = $true; last_to = $env:C4_LASTTO }
  }
  return [pscustomobject]@{ ok = $true }
}
function Get-ChildItem {
  param([Parameter(ValueFromRemainingArguments = $true)]$Rest)
  return @([pscustomobject]@{
    Issuer = 'CN=demecal.net CA'; HasPrivateKey = $true
    NotAfter = ([datetime]'2028-12-12')
  })
}
function Test-Path { return $true }
function Import-Clixml {
  param([Parameter(ValueFromRemainingArguments = $true)]$Rest)
  return (New-Object System.Management.Automation.PSCredential(
    'tester', (ConvertTo-SecureString 'dummy' -AsPlainText -Force)))
}
& $env:C4_SCRIPT -TodayJst $env:C4_TODAY
# `&` で呼んだスクリプトの `exit` は**そのスクリプトを抜けるだけ**。
# ここで拾い直さないとプロセスは必ず 0 で終わる (実測 2026-09-03)。
exit $LASTEXITCODE
'@
$driverPath = Join-Path $tmp 'driver.ps1'
Set-Content -Path $driverPath -Encoding UTF8 -Value $driver

function Invoke-Runner([string]$lastTo, [string]$today) {
  $out = Join-Path $tmp ("out-" + [Guid]::NewGuid().ToString('N') + '.txt')
  $env:C4_OUT    = $out
  $env:C4_LASTTO = $lastTo
  $env:C4_TODAY  = $today
  $env:C4_SCRIPT = $prodTmp
  $pwshExe = (Get-Process -Id $PID).Path
  $p = Start-Process -FilePath $pwshExe -ArgumentList @('-NoProfile', '-File', $driverPath) `
        -Wait -PassThru -RedirectStandardOutput (Join-Path $tmp 'stdout.txt') `
        -RedirectStandardError (Join-Path $tmp 'stderr.txt')
  $lines = @()
  if (Test-Path $out) { $lines = @(Get-Content $out) }
  return [pscustomobject]@{
    Exit   = $p.ExitCode
    Portal = @($lines | Where-Object { $_ -match 'PORTAL' }).Count
    Api    = @($lines | Where-Object { $_ -match '^API ' })
    Stdout = (Get-Content (Join-Path $tmp 'stdout.txt') -Raw -ErrorAction SilentlyContinue)
  }
}

$rNoop = Invoke-Runner '2026-09-02' '2026-09-03'
Check 'P40 noop → ポータルへのアクセス 0 回' ($rNoop.Portal -eq 0) ("portal={0}" -f $rNoop.Portal)
Check 'P41 noop → 終了コード 0 (正常)' ($rNoop.Exit -eq 0) ("exit={0}" -f $rNoop.Exit)
Check 'P42 noop → state を書かない (POST 0 回)' `
  (@($rNoop.Api | Where-Object { $_ -match 'demecal-state' -and $_ -match 'Post' }).Count -eq 0) `
  ($rNoop.Api -join ' | ')

$rNotInit = Invoke-Runner '' '2026-09-03'
Check 'P43 not_initialized → ポータルへのアクセス 0 回' ($rNotInit.Portal -eq 0) ("portal={0}" -f $rNotInit.Portal)
Check 'P44 not_initialized → 終了コード 1 (人に見せて止まる)' ($rNotInit.Exit -eq 1) ("exit={0}" -f $rNotInit.Exit)
Check 'P45 not_initialized → state を書かない' `
  (@($rNotInit.Api | Where-Object { $_ -match 'demecal-state' -and $_ -match 'Post' }).Count -eq 0) `
  ($rNotInit.Api -join ' | ')

$rAhead = Invoke-Runner '2026-09-05' '2026-09-03'
Check 'P46 invalid_state (窓より未来) → ポータルへのアクセス 0 回' ($rAhead.Portal -eq 0) ("portal={0}" -f $rAhead.Portal)
Check 'P47 invalid_state → 終了コード 1' ($rAhead.Exit -eq 1) ("exit={0}" -f $rAhead.Exit)
Check 'P48 invalid_state → state を書かない' `
  (@($rAhead.Api | Where-Object { $_ -match 'demecal-state' -and $_ -match 'Post' }).Count -eq 0) `
  ($rAhead.Api -join ' | ')

# ready のときは**ポータルへ行こうとする** (= 上の 0 回が「常に 0」ではないことの確認)。
$rReady = Invoke-Runner '2026-08-31' '2026-09-03'
Check 'P49 ready → ポータルへ行こうとする (0 回が常に 0 ではない)' ($rReady.Portal -ge 1) ("portal={0}" -f $rReady.Portal)
Check 'P50 ready で通信が落ちたら fail・state は書かない' `
  ($rReady.Exit -eq 1 -and @($rReady.Api | Where-Object { $_ -match 'demecal-state' -and $_ -match 'Post' }).Count -eq 0) `
  ("exit={0} api={1}" -f $rReady.Exit, ($rReady.Api -join ' | '))

# 実行ログは必ず 1 回送る (無人運用で黙って失敗しないため)。
Check 'P51 どの経路でも実行ログ (demecal-run) を 1 回送る' `
  ((@($rNoop.Api  | Where-Object { $_ -match 'demecal-run' }).Count -eq 1) -and
   (@($rNotInit.Api | Where-Object { $_ -match 'demecal-run' }).Count -eq 1) -and
   (@($rAhead.Api | Where-Object { $_ -match 'demecal-run' }).Count -eq 1) -and
   (@($rReady.Api | Where-Object { $_ -match 'demecal-run' }).Count -eq 1)) `
  ("noop={0} notinit={1} ahead={2} ready={3}" -f `
    @($rNoop.Api | Where-Object { $_ -match 'demecal-run' }).Count,
    @($rNotInit.Api | Where-Object { $_ -match 'demecal-run' }).Count,
    @($rAhead.Api | Where-Object { $_ -match 'demecal-run' }).Count,
    @($rReady.Api | Where-Object { $_ -match 'demecal-run' }).Count)

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "`n― ソースに書いていないこと ―――――――――――――――――"

$forbidden = @(
  @{ n = 'force=true (watermark の巻き戻し)'; p = 'force' },
  @{ n = '同一 run 内の再試行 (retry / attempt / MaxHops)'; p = '\bretry|\bRetry|attempt|Attempt|MaxHops|maxTr|MaxTr' },
  @{ n = '待機 (sleep / backoff)'; p = 'Start-Sleep|\bsleep\b|backoff' },
  @{ n = '範囲の自動調整 (chunk / split / shrink / clamp / MaxRangeDays)'; p = 'chunk|Chunk|shrink|Shrink|clamp|Clamp|MaxRangeDays' },
  @{ n = '初回 fallback (FirstRunDays)'; p = 'FirstRunDays' },
  @{ n = 'CSV をディスクへ保存する'; p = 'Set-Content|Out-File|\[IO\.File\]::Write|Export-Csv' },
  @{ n = '候補総当たり ($tried)'; p = '\$tried' }
)
foreach ($f in $forbidden) {
  $hit = [regex]::Matches($prodCode, $f.p)
  Check ("P60 ソースに無い: {0}" -f $f.n) ($hit.Count -eq 0) ("{0} 件" -f $hit.Count)
}

# 後段 interface を発明していない (rows>0 の受け渡し先を作っていない)。
$downstream = @('elith-blood-csv', 'BloodTestData', 'diagnostic_user_id', 'lab_tests', 's3://', 'AWS_')
$dsHit = @($downstream | Where-Object { $prodCode -match [regex]::Escape($_) })
Check 'P61 後段 interface を発明していない (Elith / DB / 本人紐付けへ触れない)' `
  ($dsHit.Count -eq 0) ($dsHit -join ' ')

Write-Host ""
if ($script:Fail.Count -gt 0) {
  Write-Host ("✗ {0} 件失敗 / {1} 件成功" -f $script:Fail.Count, $script:Pass)
  foreach ($f in $script:Fail) { Write-Host ("   - {0}" -f $f) }
  exit 1
}
Write-Host ("✓ 全 {0} 件 OK" -f $script:Pass)
exit 0
