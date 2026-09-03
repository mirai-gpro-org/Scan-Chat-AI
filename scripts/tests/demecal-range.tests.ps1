# デメカル 取得範囲プランナ (C-1) のテスト
#
# 正本: docs/lab/demecal_recovery_plan_20260902.md §7.2 C-1
# 実行: pwsh -NoProfile -File scripts/tests/demecal-range.tests.ps1
#       (npm run verify:demecal-range)
#
# 【なぜ PowerShell で書くか】
#   検査対象は**実際に専用PC で dot-source される .ps1 そのもの**でなければ意味が無い
#   (`demecal-flow.tests.ps1` と同じ理由)。
#
# 【何を見張るか】
#   ①振る舞い (範囲・境界・うるう年・fail-closed)
#   ②**実行時に何も触らないこと** — 通信 / 現在時刻の取得を関数で覆い、
#     1 回でも呼んだらその場で落とす
#   ③**ソースに書いていないこと** — 通信・state・force・現在時刻・FirstRunDays
#   ②と③の両方をやるのは、片方だけだとすり抜けるため
#   (ソース検査は別名の呼び出しに弱く、実行時検査は「呼ばれない経路」に弱い)。

$ErrorActionPreference = 'Stop'

$Root       = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$ScriptPath = Join-Path $Root 'scripts/demecal-range.ps1'

$script:Pass = 0
$script:Fail = New-Object System.Collections.Generic.List[string]

function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { $script:Pass++; Write-Host ("  OK   {0}" -f $name) }
  else {
    $script:Fail.Add(("{0}{1}" -f $name, $(if ($detail) { " — $detail" } else { '' }))) | Out-Null
    Write-Host ("  NG   {0} — {1}" -f $name, $detail)
  }
}

# ── 実行時ガード: 通信と現在時刻を封じる ────────────────────────
# dot-source は同じスコープに入るので、ここで定義した関数が本体からの呼び出しを奪う。
function Invoke-WebRequest { throw 'テスト中に Invoke-WebRequest が呼ばれました (プランナが通信している)' }
function Invoke-RestMethod { throw 'テスト中に Invoke-RestMethod が呼ばれました (プランナが通信している)' }
function Get-Date          { throw 'テスト中に Get-Date が呼ばれました (プランナが現在時刻に依存している)' }

if (-not (Test-Path $ScriptPath)) { Write-Error "対象が見つかりません: $ScriptPath"; exit 1 }
. $ScriptPath

$src = Get-Content -Path $ScriptPath -Raw -Encoding UTF8

# コメントを外した「実際に動く行」だけを見る (説明文に書いた語で誤検出しないため)。
$code = ($src -split "`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
$code = [regex]::Replace($code, '(?s)<#.*?#>', '')

function Get-Plan([string]$lastTo, [string]$today) {
  return (Resolve-DemecalAcquisitionRange -LastTo $lastTo -TodayJst $today)
}
function IsReady($r, [string]$from, [string]$to) {
  return ($r.Status -eq 'ready' -and $r.From -eq $from -and $r.To -eq $to)
}
function Desc($r) { return ("{0}/{1} {2}..{3}" -f $r.Status, $r.Code, $r.From, $r.To) }

Write-Host "`n― C-1 必須ケース ―――――――――――――――――――――――"

$r = Get-Plan '2026-09-01' '2026-09-03'
Check 'C01 last_to=2026-09-01 / today=2026-09-03 → ready 09-02..09-02' (IsReady $r '2026-09-02' '2026-09-02') (Desc $r)

$r = Get-Plan '2026-08-31' '2026-09-03'
Check 'C02 last_to=2026-08-31 / today=2026-09-03 → ready 09-01..09-02' (IsReady $r '2026-09-01' '2026-09-02') (Desc $r)

$r = Get-Plan '2026-09-02' '2026-09-03'
Check 'C03 last_to=2026-09-02 / today=2026-09-03 → noop' ($r.Status -eq 'noop') (Desc $r)
Check 'C03b noop は From/To を返さない (誤って取りに行かせない)' ($r.From -eq '' -and $r.To -eq '') (Desc $r)
Check 'C03c noop の Code は OK_NOOP' ($r.Code -eq 'OK_NOOP') (Desc $r)

$r = Get-Plan $null '2026-09-03'
Check 'C04 last_to=null → not_initialized' ($r.Status -eq 'not_initialized') (Desc $r)
Check 'C04b Code=STATE_NOT_INITIALIZED' ($r.Code -eq 'STATE_NOT_INITIALIZED') (Desc $r)
Check 'C04c 範囲を作らない (From/To 空)' ($r.From -eq '' -and $r.To -eq '') (Desc $r)

$r = Get-Plan '' '2026-09-03'
Check 'C04d last_to="" も STATE_NOT_INITIALIZED' ($r.Status -eq 'not_initialized' -and $r.Code -eq 'STATE_NOT_INITIALIZED') (Desc $r)
$r = Get-Plan '   ' '2026-09-03'
Check 'C04e last_to=空白のみ も STATE_NOT_INITIALIZED' ($r.Status -eq 'not_initialized' -and $r.Code -eq 'STATE_NOT_INITIALIZED') (Desc $r)

Write-Host "`n― 月・年・うるう年の繰り上がり ―――――――――――――――"

$r = Get-Plan '2026-01-31' '2026-03-01'
Check 'C05 2026-01-31 → from=2026-02-01' (IsReady $r '2026-02-01' '2026-02-28') (Desc $r)

$r = Get-Plan '2026-12-31' '2027-03-01'
Check 'C06 2026-12-31 → from=2027-01-01' (IsReady $r '2027-01-01' '2027-02-28') (Desc $r)

$r = Get-Plan '2024-02-28' '2024-03-05'
Check 'C07 2024-02-28 → from=2024-02-29 (うるう年)' (IsReady $r '2024-02-29' '2024-03-04') (Desc $r)

$r = Get-Plan '2024-02-29' '2024-03-05'
Check 'C08 2024-02-29 → from=2024-03-01' (IsReady $r '2024-03-01' '2024-03-04') (Desc $r)

$r = Get-Plan '2025-02-28' '2025-03-05'
Check 'C09 2025-02-28 → from=2025-03-01 (平年は 29 日が無い)' (IsReady $r '2025-03-01' '2025-03-04') (Desc $r)

$r = Get-Plan '2100-02-28' '2100-03-05'
Check 'C10 2100-02-28 → from=2100-03-01 (100 年規則)' (IsReady $r '2100-03-01' '2100-03-04') (Desc $r)

$r = Get-Plan '2000-02-28' '2000-03-05'
Check 'C11 2000-02-28 → from=2000-02-29 (400 年規則)' (IsReady $r '2000-02-29' '2000-03-04') (Desc $r)

$r = Get-Plan '2026-02-27' '2026-03-01'
Check 'C12 to も月をまたぐ (today=2026-03-01 → to=2026-02-28)' (IsReady $r '2026-02-28' '2026-02-28') (Desc $r)

$r = Get-Plan '2025-12-30' '2026-01-01'
Check 'C13 to が年をまたぐ (today=2026-01-01 → to=2025-12-31)' (IsReady $r '2025-12-31' '2025-12-31') (Desc $r)

Write-Host "`n― 壊れた入力は fail-closed ―――――――――――――――――"

$malformed = @(
  '20260901', '2026/09/01', '2026.09.01', '2026-9-1', '2026-09-1', '26-09-01',
  ' 2026-09-01', '2026-09-01 ', "2026-09-01`n", '2026-09-01T00:00:00',
  'abc', '2026-09-01Z', '+2026-09-01', '2026-09-01;'
)
foreach ($m in $malformed) {
  $r = Get-Plan $m '2026-09-03'
  $shown = $m -replace "`n", '\n'
  Check ("C20 malformed last_to '{0}' → invalid_state" -f $shown) `
    ($r.Status -eq 'invalid_state' -and $r.Code -eq 'STATE_LAST_TO_INVALID') (Desc $r)
}

$impossible = @('2026-02-30', '2025-02-29', '2100-02-29', '2026-13-01', '2026-00-10', '2026-09-31', '2026-04-31', '2026-01-00')
foreach ($m in $impossible) {
  $r = Get-Plan $m '2026-09-03'
  Check ("C21 実在しない暦日 '{0}' → invalid_state" -f $m) `
    ($r.Status -eq 'invalid_state' -and $r.Code -eq 'STATE_LAST_TO_INVALID') (Desc $r)
}

foreach ($m in @('2026/09/03', '2026-13-01', '', $null, 'today')) {
  $r = Get-Plan '2026-09-01' $m
  $shown = if ($null -eq $m) { '<null>' } elseif ($m -eq '') { '<empty>' } else { $m }
  Check ("C22 today_jst '{0}' が壊れていたら invalid_state" -f $shown) `
    ($r.Status -eq 'invalid_state' -and $r.Code -eq 'TODAY_JST_INVALID') (Desc $r)
}

$r = Get-Plan $null 'not-a-date'
Check 'C23 today_jst が壊れていれば last_to=null より優先して invalid_state' `
  ($r.Status -eq 'invalid_state' -and $r.Code -eq 'TODAY_JST_INVALID') (Desc $r)

$r = Get-Plan '9999-12-31' '2026-09-03'
Check 'C24 last_to=9999-12-31 (足すと溢れる) → invalid_state' ($r.Status -eq 'invalid_state') (Desc $r)
$r = Get-Plan '2026-09-01' '0001-01-01'
Check 'C25 today=0001-01-01 (引くと溢れる) → invalid_state' ($r.Status -eq 'invalid_state') (Desc $r)

Write-Host "`n― overlap しない / 今日を含めない ―――――――――――――"

$pairs = @(
  @('2026-09-01', '2026-09-03'), @('2026-08-31', '2026-09-03'), @('2026-01-31', '2026-03-01'),
  @('2026-12-31', '2027-03-01'), @('2024-02-28', '2024-03-05'), @('2026-01-01', '2026-09-03'),
  @('2025-12-30', '2026-01-01'), @('2026-02-27', '2026-03-01')
)
$overlap = 0; $includesToday = 0; $gap = 0
foreach ($p in $pairs) {
  $r = Get-Plan $p[0] $p[1]
  if ($r.Status -ne 'ready') { continue }
  if ($r.From -le $p[0]) { $overlap++ }                       # from は last_to より必ず後
  if ($r.To   -ge $p[1]) { $includesToday++ }                 # to は today より必ず前
  $expFrom = (Format-DemecalDate ((ConvertTo-DemecalDate $p[0]).AddDays(1)))
  if ($r.From -ne $expFrom) { $gap++ }                        # 隙間も作らない (last_to+1 ちょうど)
}
Check 'C30 overlap 0 (from は必ず last_to より後)' ($overlap -eq 0) ("overlap={0}" -f $overlap)
Check 'C31 today を含めない (to は必ず today より前)' ($includesToday -eq 0) ("含んだ={0}" -f $includesToday)
Check 'C32 隙間 0 (from は last_to + 1日 ちょうど)' ($gap -eq 0) ("ずれ={0}" -f $gap)

$r = Get-Plan '2026-09-05' '2026-09-03'
Check 'C33 last_to が未来 (時計ずれ等) でも取りに行かない → noop' ($r.Status -eq 'noop') (Desc $r)
$r = Get-Plan '2026-09-03' '2026-09-03'
Check 'C34 last_to == today でも noop (今日は取らない)' ($r.Status -eq 'noop') (Desc $r)

Write-Host "`n― 初回 fallback / 上限 clamp を持ち込んでいない ―――――"

$r = Get-Plan '2026-08-27' '2026-09-03'
Check 'C40 直近7日を勝手に作らない (last_to があればそこから続ける)' (IsReady $r '2026-08-28' '2026-09-02') (Desc $r)

# 上限は**未確定**。根拠が出るまで切らない (demecal-range.ps1 冒頭の注記が正)。
$r = Get-Plan '2026-01-01' '2026-09-03'
Check 'C41 245 日の backlog を 60 日で切らない (上限は未確定・推測で固定しない)' `
  (IsReady $r '2026-01-02' '2026-09-02') (Desc $r)
$r = Get-Plan '2020-01-01' '2026-09-03'
Check 'C42 数年の backlog でも切らない' (IsReady $r '2020-01-02' '2026-09-02') (Desc $r)

Write-Host "`n― ソースに書いていないこと ―――――――――――――――――"

$forbidden = @(
  @{ n = 'ネットワーク (Invoke-WebRequest / RestMethod)'; p = 'Invoke-WebRequest|Invoke-RestMethod' },
  @{ n = 'ネットワーク (WebClient / HttpClient / System.Net / curl)'; p = 'WebClient|HttpClient|System\.Net|\bcurl\b|Net\.Http' },
  @{ n = 'API の口 (state / probe-upload / elith-blood-csv / /api/)'; p = 'demecal-state|probe-upload|elith-blood-csv|demecal-run|/api/' },
  @{ n = 'S3 / 認可キー'; p = 'AWS_|s3://|INTAKE_KEY|ADMIN_API_KEY|x-intake-key' },
  @{ n = 'force (watermark の巻き戻し)'; p = 'force' },
  @{ n = '現在時刻 (Get-Date / Now / Today / UtcNow)'; p = 'Get-Date|::Now|::Today|::UtcNow|DateTime\]::Now' },
  @{ n = '初回 fallback (FirstRunDays)'; p = 'FirstRunDays' },
  @{ n = '範囲上限の決め打ち (MaxRangeDays)'; p = 'MaxRangeDays' },
  @{ n = 'ファイル書き込み'; p = 'Set-Content|Out-File|Export-Clixml|\[IO\.File\]::Write' }
)
foreach ($f in $forbidden) {
  $hit = [regex]::Matches($code, $f.p)
  Check ("C50 ソースに無い: {0}" -f $f.n) ($hit.Count -eq 0) ("{0} 件" -f $hit.Count)
}

# 「AddDays(-7)」のような直近N日 fallback を後から足されないように、
# **負の AddDays は to の -1 日だけ**であることを固定する。
$neg = [regex]::Matches($code, 'AddDays\(\s*-\s*(\d+)')
$badNeg = @($neg | Where-Object { $_.Groups[1].Value -ne '1' })
Check 'C51 過去方向の AddDays は -1 (昨日) だけ' ($badNeg.Count -eq 0) `
  ("他の負値 {0} 件" -f $badNeg.Count)

Check 'C52 現在時刻を実行時にも取っていない (Get-Date を投げる関数で覆って全ケース走破済み)' $true ''

Write-Host ""
if ($script:Fail.Count -gt 0) {
  Write-Host ("✗ {0} 件失敗 / {1} 件成功" -f $script:Fail.Count, $script:Pass)
  foreach ($f in $script:Fail) { Write-Host ("   - {0}" -f $f) }
  exit 1
}
Write-Host ("✓ 全 {0} 件 OK" -f $script:Pass)
exit 0
