# デメカル 血液CSV — 本番の自動実行 (bat ②)
#
# 正本: docs/lab/demecal_unattended_spec.md
#
# 【①との違い】①(recon) は「調べる」。②(これ) は「毎日取る」。
#   ・①が保存した資格情報 (DPAPI) を**再利用**する。対話は一切しない
#   ・**本物のデータを取る**。過去日付のドライランではない
#   ・取り込みに成功したときだけ last_to を前進させる
#   ・原本CSV は送信成功後に**必ず削除**する (PII を PC に残さない)
#   ・走ったか失敗したかを**実行ログAPIへ必ず報告**する (無人なので誰も見ていない)
#
# 【画面遷移は決め打ちしない】①v2.0 で分かったとおり、汎用CSV は
#   /hanyou/start → POST /hanyou/start → POST /hanyou/entry → … と**3 段以上**ある。
#   段数や submitType の値をコードに埋めると画面改訂で即死ぬので、
#   **「返ってきた HTML の form を、日付だけ差し替えて送り直す」を CSV が返るまで繰り返す**。
#   これが PowerShell 方式を選んだ理由 (ブラウザ要素を指さない = 画面変更に強い) そのもの。
#
# 【失敗したら last_to を動かさない】これが取り漏れゼロの根拠 (spec §1)。
#   走らない日があっても、次に成功した回が前回の続きからまとめて回収する。
#   **この性質を壊す変更をしてはいけない。**
#
# 【PII】CSV の中身は画面にもログにも出さない。実行ログAPIへ送るのは
#   件数・日付範囲・状態だけ。原本は送信成功後に削除する。

$ErrorActionPreference = 'Continue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$BaseUrl   = 'https://dl.demecal.net'
$LoginUrl  = "$BaseUrl/account/login"
$ApiBase   = 'https://scan-chat-ai.vercel.app'
$IntakeKey = '__LAB_INTAKE_KEY__'
$Version   = 'daily-1.0'

# 初回の安全弁。last_to がまだ無いとき、いきなり全期間を引かない。
# 失敗しても last_to は動かないので取り漏れは起きないが、初回から広く取ると
# 失敗時の切り分けが難しくなる (発注者と合意した進め方)。
$FirstRunDays = 7
# 1 回の実行で遡る上限。ここを超える分は次回以降が続きから拾う。
$MaxRangeDays = 60

$Root      = 'C:\demecal'
$SecretDir = Join-Path $Root 'secrets'
$CredPath  = Join-Path $SecretDir 'demecal.cred.xml'

$lines = New-Object System.Collections.Generic.List[string]
function Say($t) { Write-Host $t; $lines.Add($t) | Out-Null }

$script:StartedAt = (Get-Date).ToString('o')
$script:Stage     = 'start'
$script:Rows      = $null
$script:RangeFrom = $null
$script:RangeTo   = $null
$script:CertOn    = $null
$script:CertDays  = $null

# ── 実行ログ (無人運用の本体) ────────────────────────────────
#
# **誰も見ていないので、走ったか失敗したかがサーバに残らないと運用できない。**
# 成否にかかわらず必ず 1 回呼ぶ。呼べなくても本処理は止めない。
function Report-Run([string]$result, [string]$err) {
  if ($IntakeKey -eq ('__LAB_INTAKE' + '_KEY__')) { return $false }
  try {
    $payload = @{
      started_at      = $script:StartedAt
      finished_at     = (Get-Date).ToString('o')
      result          = $result
      stage           = $script:Stage
      rows            = $script:Rows
      range           = @{ from = $script:RangeFrom; to = $script:RangeTo }
      error           = $err
      host            = $env:COMPUTERNAME
      script_version  = $Version
      cert_expires_on = $script:CertOn
      cert_days_left  = $script:CertDays
    } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "$ApiBase/api/admin/demecal-run" -Method Post -TimeoutSec 30 `
      -Body ([Text.Encoding]::UTF8.GetBytes($payload)) `
      -ContentType 'application/json; charset=utf-8' `
      -Headers @{ 'x-intake-key' = $IntakeKey } | Out-Null
    return $true
  } catch { return $false }
}

function Finish([int]$code, [string]$result, [string]$err) {
  if ($err) { Say ("エラー: {0}" -f $err) }
  $sent = Report-Run $result $err
  try {
    Set-Content -Path (Join-Path $Root 'demecal_daily_last.txt') -Value ($lines -join "`r`n") -Encoding UTF8
  } catch {}
  Say ''
  Say '=================================================='
  if ($result -eq 'ok') { Say ' 結果: ○ 取り込みまで完了しました' }
  else { Say ' 結果: × 失敗しました (last_to は前進させていません)' }
  if (-not $sent) { Say ' ※ 実行ログをサーバへ送れませんでした' }
  Say '=================================================='
  exit $code
}

Say '=================================================='
Say ' デメカル 血液CSV 自動取得'
Say (" 実行日時 : {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Say (" PC名     : {0} / ログオン : {1}" -f $env:COMPUTERNAME, $env:USERNAME)
Say (" 版       : {0}" -f $Version)
Say '=================================================='

# ── [1] 証明書 ────────────────────────────────────────────────
$script:Stage = 'cert'
$cert = $null
try {
  $cands = @(Get-ChildItem 'Cert:\CurrentUser\My' -ErrorAction Stop |
             Where-Object { $_.Issuer -match 'demecal\.net CA' -and $_.HasPrivateKey })
  if ($cands.Count -gt 0) { $cert = $cands[0] }
} catch {}
if (-not $cert) { Finish 1 'fail' '証明書が見つかりません (ログオンユーザーが違う可能性)' }
$script:CertOn   = $cert.NotAfter.ToString('yyyy-MM-dd')
$script:CertDays = [int]($cert.NotAfter - (Get-Date)).TotalDays
Say ("[1] 証明書 OK (期限 {0} / 残り {1} 日)" -f $script:CertOn, $script:CertDays)
# 期限切れは「ある日突然全部止まる」ので、余裕のあるうちから警告を残す。
if ($script:CertDays -lt 60) { Say '    ※ 証明書の期限が近づいています。更新の手配を。' }

# ── [2] 資格情報 (①が DPAPI で保存したもの) ──────────────────
$script:Stage = 'cred'
if (-not (Test-Path $CredPath)) { Finish 1 'fail' "資格情報がありません ($CredPath)。① を先に実行してください" }
$cred = $null
try { $cred = Import-Clixml -Path $CredPath -ErrorAction Stop } catch {}
if (-not $cred) { Finish 1 'fail' '資格情報を復号できません (別ユーザー/別PCで保存された可能性)' }
Say '[2] 資格情報 OK'

# ── [3] ログイン (GET でトークン → 同一セッションで POST) ─────
$script:Stage = 'login'
$session = $null
try {
  $g = Invoke-WebRequest -Uri $LoginUrl -Certificate $cert -SessionVariable session -UseBasicParsing -TimeoutSec 30
  $tok = ''
  $m = [regex]::Match($g.Content, 'name="__RequestVerificationToken"[^>]*value="([^"]+)"')
  if ($m.Success) { $tok = $m.Groups[1].Value }
  $body = @{
    UserID   = $cred.UserName
    Password = $cred.GetNetworkCredential().Password
  }
  if ($tok) { $body['__RequestVerificationToken'] = $tok }
  $p = Invoke-WebRequest -Uri $LoginUrl -Method Post -Certificate $cert -WebSession $session `
         -Body $body -UseBasicParsing -TimeoutSec 60
  # 失敗しても 200 が返る作り (spec)。**フォームが消えたか**で判定する。
  if ($p.Content -match 'name="Password"') { Finish 1 'fail' 'ログインできませんでした (ID/PW を確認)' }
} catch { Finish 1 'fail' ("ログイン中に失敗: {0}" -f $_.Exception.Message) }
Say '[3] ログイン OK'

# ── [4] 取得範囲を決める (last_to の続きから) ─────────────────
$script:Stage = 'range'
$lastTo = $null
try {
  $st = Invoke-RestMethod -Uri "$ApiBase/api/admin/demecal-state" -Method Get -TimeoutSec 30 `
          -Headers @{ 'x-intake-key' = $IntakeKey }
  if ($st.last_to) { $lastTo = [datetime]::ParseExact($st.last_to, 'yyyy-MM-dd', $null) }
} catch { Finish 1 'fail' ("状態(last_to)を読めません: {0}" -f $_.Exception.Message) }

$to = (Get-Date).Date
if ($lastTo) { $from = $lastTo.AddDays(1) } else { $from = $to.AddDays(-$FirstRunDays) }
if ($from -gt $to) {
  Say '[4] 新しい範囲がありません (前回で最新まで取得済み)。'
  $script:Rows = 0
  Finish 0 'ok' $null
}
# 遡りすぎない。残りは次回が続きから拾う (last_to は成功分までしか進まない)。
if (($to - $from).TotalDays -gt $MaxRangeDays) { $to = $from.AddDays($MaxRangeDays) }
$script:RangeFrom = $from.ToString('yyyy-MM-dd')
$script:RangeTo   = $to.ToString('yyyy-MM-dd')
Say ("[4] 取得範囲 {0} 〜 {1}" -f $script:RangeFrom, $script:RangeTo)

# ── [5] 汎用CSV 画面を辿って CSV を取る ───────────────────────
#
# **段数を決め打ちしない。** HTML が返る限り、その中の form を
# 日付だけ差し替えて送り直す。CSV (= text/html 以外) が返ったら終わり。
$script:Stage = 'download'

function Get-Forms([string]$html, [string]$pageUrl) {
  $out = @()
  foreach ($fm in [regex]::Matches($html, '(?is)<form\b[^>]*>.*?</form>')) {
    $f = $fm.Value
    $action = ''
    $ma = [regex]::Match($f, '(?i)action="([^"]*)"'); if ($ma.Success) { $action = $ma.Groups[1].Value }
    $method = 'get'
    $mm = [regex]::Match($f, '(?i)method="([^"]*)"'); if ($mm.Success) { $method = $mm.Groups[1].Value }
    $fields = @{}
    foreach ($im in [regex]::Matches($f, '(?is)<input\b[^>]*>')) {
      $tag = $im.Value
      $n = [regex]::Match($tag, '(?i)name="([^"]*)"'); if (-not $n.Success) { continue }
      $t = [regex]::Match($tag, '(?i)type="([^"]*)"')
      $v = [regex]::Match($tag, '(?i)value="([^"]*)"')
      $type = if ($t.Success) { $t.Value } else { 'text' }
      # radio/checkbox は checked のものだけ採る (既定の選択を尊重する)
      if ($type -match '(?i)radio|checkbox') {
        if ($tag -notmatch '(?i)\bchecked\b') { continue }
      }
      $fields[$n.Groups[1].Value] = if ($v.Success) { $v.Groups[1].Value } else { '' }
    }
    $out += [pscustomobject]@{ Action = $action; Method = $method; Fields = $fields; Page = $pageUrl }
  }
  return $out
}

function Resolve-Url([string]$action, [string]$pageUrl) {
  if ($action -match '^https?://') { return $action }
  if ($action) { return "$BaseUrl/" + $action.TrimStart('/') }
  return $pageUrl
}

$csvBytes = $null
try {
  $startUrl = "$BaseUrl/hanyou/start"
  $page = Invoke-WebRequest -Uri $startUrl -Certificate $cert -WebSession $session -UseBasicParsing -TimeoutSec 60
  $forms = Get-Forms $page.Content $startUrl
  if ($forms.Count -eq 0) { Finish 1 'fail' '汎用CSV画面に form がありません (画面が変わった可能性)' }
  $cur = $forms[0]

  for ($hop = 1; $hop -le 5; $hop++) {
    $body = @{}
    foreach ($k in $cur.Fields.Keys) { $body[$k] = $cur.Fields[$k] }
    # **日付欄だけを差し替える。** token を含む名前には絶対に触らない
    # (①v1.9 で `(?i)to` が __RequestVerificationToken に当たった実績)。
    foreach ($k in @($cur.Fields.Keys)) {
      if ($k -match '(?i)token|verification') { continue }
      if ($k -notmatch '(?i)date|ymd|日付') { continue }
      if ($k -match '(?i)from|start|開始') { $body[$k] = $from.ToString('yyyy/MM/dd') }
      elseif ($k -match '(?i)to|end|終了')  { $body[$k] = $to.ToString('yyyy/MM/dd') }
    }
    $u = Resolve-Url $cur.Action $cur.Page
    $mth = if ($cur.Method -match '(?i)post') { 'Post' } else { 'Get' }
    $r = Invoke-WebRequest -Uri $u -Method $mth -Certificate $cert -WebSession $session `
           -Body $body -UseBasicParsing -TimeoutSec 120
    $ct = [string]$r.Headers['Content-Type']
    Say ("    [{0}段目] {1} → HTTP {2} / {3}" -f $hop, $u, [int]$r.StatusCode, $ct)

    if ($ct -notmatch '(?i)text/html') { $csvBytes = $r.Content; break }
    $forms = Get-Forms $r.Content $u
    if ($forms.Count -eq 0) { Finish 1 'fail' ("{0} 段目の応答に form が無く CSV も返りません" -f $hop) }
    $cur = $forms[0]
  }
} catch { Finish 1 'fail' ("CSV 取得中に失敗: {0}" -f $_.Exception.Message) }

if (-not $csvBytes) { Finish 1 'fail' '画面を辿りましたが CSV が返りませんでした' }

# ── [6] 保存 → 送信 → 削除 ───────────────────────────────────
#
# **OneDrive 配下に置かない** (同期されるとごみ箱・版履歴に PII が残る)。
$script:Stage = 'intake'
if ($Root -match 'OneDrive') { Finish 1 'fail' "保存先が OneDrive 配下です ($Root)" }
if (-not (Test-Path $Root)) { New-Item -ItemType Directory -Path $Root -Force -ErrorAction SilentlyContinue | Out-Null }
$csvName = ("demecal_{0}_{1}.csv" -f $script:RangeFrom.Replace('-',''), $script:RangeTo.Replace('-',''))
$csvPath = Join-Path $Root $csvName
try { [IO.File]::WriteAllBytes($csvPath, $csvBytes) } catch { Finish 1 'fail' ("CSV を保存できません: {0}" -f $_.Exception.Message) }

# 行数だけ数える (中身は出さない)。
try {
  $txt = [Text.Encoding]::GetEncoding('shift_jis').GetString($csvBytes)
  $script:Rows = @($txt -split "`r?`n" | Where-Object { $_ -ne '' }).Count
} catch { $script:Rows = $null }
Say ("[6] CSV 保存 OK ({0} 行 / ヘッダ含む)" -f $script:Rows)

try {
  $payload = @{
    csvBase64 = [Convert]::ToBase64String($csvBytes)
    filename  = $csvName
  } | ConvertTo-Json -Compress
  $res = Invoke-RestMethod -Uri "$ApiBase/api/admin/elith-blood-csv" -Method Post -TimeoutSec 300 `
           -Body ([Text.Encoding]::UTF8.GetBytes($payload)) `
           -ContentType 'application/json; charset=utf-8' `
           -Headers @{ 'x-intake-key' = $IntakeKey }
  if (-not $res.ok) { Finish 1 'fail' ("取り込みAPIが失敗を返しました: {0}" -f $res.error) }
  Say ("    取り込み OK ({0} 件)" -f $res.count)
} catch { Finish 1 'fail' ("取り込みAPIへ送れません: {0}" -f $_.Exception.Message) }

# **ここまで来て初めて** last_to を前進させる。これが取り漏れゼロの根拠。
$script:Stage = 'state'
try {
  $sp = @{ last_to = $script:RangeTo } | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri "$ApiBase/api/admin/demecal-state" -Method Post -TimeoutSec 30 `
    -Body ([Text.Encoding]::UTF8.GetBytes($sp)) `
    -ContentType 'application/json; charset=utf-8' `
    -Headers @{ 'x-intake-key' = $IntakeKey } | Out-Null
  Say ("    last_to を {0} へ前進" -f $script:RangeTo)
} catch { Finish 1 'fail' ("last_to を更新できません: {0}" -f $_.Exception.Message) }

# 原本は PII を含む。取り込みが終わったら PC に残さない。
try { Remove-Item -Path $csvPath -Force -ErrorAction Stop; Say '    原本CSV を削除しました' }
catch { Say ("    ※ 原本CSV を削除できませんでした: {0}" -f $csvPath) }

$script:Stage = 'done'
Finish 0 'ok' $null
