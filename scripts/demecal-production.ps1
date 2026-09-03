# デメカル 汎用CSV — **本番取得 runner** (Phase C / C-4 Foundation)
#
# 正本: docs/lab/demecal_recovery_plan_20260902.md §7.2 C-4
# 検査: pwsh -NoProfile -File scripts/tests/demecal-production.tests.ps1
#       (npm run verify:demecal-production)
#
# 【これは何か】
#   C-1 の範囲プランナと、Phase B で**実機 PASS した取得ロジック**を繋いだ本番 runner。
#     JST today → GET demecal-state → Resolve-DemecalAcquisitionRange
#       → noop / not_initialized / invalid_state を処理 (**ポータルに触らない**)
#       → ready のときだけ 証明書 → ログイン → STATE A/B/C → CSV 検査 → watermark
#
# 【Phase B parity を最優先する — だから再設計しない】
#   STATE A/B/C・販売先 000000・DataType/OutputHeader のラベル・STATE C の download・
#   `RawContentStream`・Shift_JIS・filename/header/rows/SHA-256 は
#   **`verify-1.4` で実機実証済みの契約**。ここでは**書き写さず dot-source する**。
#   コピーすると必ずずれる。**同じ関数を呼ぶ = parity は構造で保証される**
#   (`demecal-production.tests.ps1` が「再定義していない」ことを機械で見張る)。
#   **`demecal-verify.ps1` は変更しない** (Phase B の成功証跡)。
#
# 【daily-1.7 は凍結のまま】
#   `demecal-daily.ps1` は参照もしない。探索器 (MaxHops / 候補総当たり / 戻る・cancel) は
#   本番経路に 1 つも無い (計画 §3)。
#
# 【この Foundation でやらないこと】
#   ・**後段 interface を発明しない**。rows > 0 の受領方法 (本人紐付け / DB / Elith / EC) は
#     このセクションの scope 外 → **だから rows > 0 では watermark を進めない** (下記)
#   ・scheduler への登録 (C-5) / 監視の作り込み (C-6)
#   ・same-run retry / range shrink / chunking (C-2 で「しない」と確定)
#   ・`force=true` (watermark の巻き戻しはこのスクリプトの仕事ではない)
#
# 【-LibOnly】関数だけ読み込んで何も実行しない (fixture テスト用)。
# 【-TodayJst】JST の今日を明示注入する (テスト・切り分け用)。
#   空なら時計から取る。**watermark の規則そのものは変えない**。
param([switch]$LibOnly, [string]$TodayJst = '')

$ErrorActionPreference = 'Continue'

# **自分の引数を先に退避する。**
# dot-source は相手の `param()` を**こちらのスコープに作る**ので、次の行で
# `demecal-verify.ps1 -LibOnly` を読むと **こちらの `$LibOnly` が $true に化ける**
# (実測 2026-09-03: 手続き部が丸ごと実行されなくなった)。名前が同じだと必ず踏む。
$ProdLibOnly = [bool]$LibOnly
$ProdTodayJst = [string]$TodayJst

# ── 実証済みの部品を dot-source する (書き写さない) ────────────
#   ①`demecal-verify.ps1 -LibOnly` … STATE A/B/C・CSV 検査・実行ログ・骨格回収
#   ②`demecal-range.ps1`           … C-1 の範囲プランナ (純粋関数)
. (Join-Path $PSScriptRoot 'demecal-verify.ps1') -LibOnly
. (Join-Path $PSScriptRoot 'demecal-range.ps1')

# dot-source 後に上書きする。`Report-Run` はこの値を `script_version` として送る。
$Version = 'production-1.0'

# **取り込み専用キーはこの runner が持つ。**
# dot-source した `demecal-verify.ps1` にも同名のプレースホルダがあるが、そちらに
# 依存すると**配布時に差し替える対象が「読み込まれる側」になる**ので、
# 本番で配るこのファイル側で持ち直す (実測 2026-09-03: verify 側だけ残っていて
# `INTAKE_KEY_MISSING` で止まった)。**未埋め込みなら state を読まずに止まる**のは
# `Get-DemecalLastTo` / `Set-DemecalLastTo` / `Report-Run` の共通ガードのとおり。
$IntakeKey = '__LAB_INTAKE_KEY__'

# ── C-4 の関数 ────────────────────────────────────────────────

<#
.SYNOPSIS
  JST の今日 (YYYY-MM-DD)。**プランナには渡す側が決めた値を入れる** (C-1 の契約)。
.DESCRIPTION
  専用PC は日本時間で運用されるが、**ローカル時刻に暗黙に依存しない**。
  タイムゾーン id はプラットフォームで違う (Windows='Tokyo Standard Time' /
  IANA='Asia/Tokyo') ので両方試し、どちらも無い環境でだけローカル日付へ落ちる。
#>
function Get-JstToday {
  foreach ($id in @('Tokyo Standard Time', 'Asia/Tokyo')) {
    try {
      $z = [TimeZoneInfo]::FindSystemTimeZoneById($id)
      return ([TimeZoneInfo]::ConvertTime([DateTimeOffset]::Now, $z)).Date.ToString('yyyy-MM-dd')
    } catch {}
  }
  return (Get-Date).Date.ToString('yyyy-MM-dd')
}

<#
.SYNOPSIS
  watermark (`last_to`) を読む。**読めなければ fail-closed** (勝手に初期値を作らない)。
#>
function Get-DemecalLastTo {
  $res = [pscustomobject]@{ Ok = $false; LastTo = ''; Code = ''; Detail = '' }
  if ($IntakeKey -eq ('__LAB_INTAKE' + '_KEY__')) {
    $res.Code = 'INTAKE_KEY_MISSING'; $res.Detail = '取り込み専用キーが埋め込まれていません'
    return $res
  }
  try {
    $r = Invoke-RestMethod -Uri "$ApiBase/api/admin/demecal-state" -Method Get -TimeoutSec 30 `
           -Headers @{ 'x-intake-key' = $IntakeKey }
    if (-not $r.ok) { $res.Code = 'STATE_READ_FAILED'; $res.Detail = 'state API が ok を返しません'; return $res }
    $res.Ok = $true
    if ($r.last_to) { $res.LastTo = [string]$r.last_to }   # 未初期化なら空のまま
    return $res
  } catch {
    $res.Code = 'STATE_READ_FAILED'; $res.Detail = $_.Exception.Message
    return $res
  }
}

<#
.SYNOPSIS
  watermark を前進させる。**`force` を絶対に送らない。**
.DESCRIPTION
  巻き戻しはこのスクリプトの仕事ではない (`demecal-state.ts` の単調前進に任せる)。
  失敗しても値を作らない — 呼び出し側が「前進できなかった」として記録する。
#>
function Set-DemecalLastTo([string]$lastTo) {
  $res = [pscustomobject]@{ Ok = $false; Code = ''; Detail = '' }
  if (-not $lastTo) { $res.Code = 'STATE_WRITE_SKIPPED'; $res.Detail = '前進先が空です'; return $res }
  if ($IntakeKey -eq ('__LAB_INTAKE' + '_KEY__')) {
    $res.Code = 'INTAKE_KEY_MISSING'; $res.Detail = '取り込み専用キーが埋め込まれていません'
    return $res
  }
  try {
    $payload = @{ last_to = $lastTo } | ConvertTo-Json -Compress
    $r = Invoke-RestMethod -Uri "$ApiBase/api/admin/demecal-state" -Method Post -TimeoutSec 30 `
           -Body ([Text.Encoding]::UTF8.GetBytes($payload)) `
           -ContentType 'application/json; charset=utf-8' `
           -Headers @{ 'x-intake-key' = $IntakeKey }
    if (-not $r.ok) { $res.Code = 'STATE_WRITE_FAILED'; $res.Detail = 'state API が ok を返しません'; return $res }
    $res.Ok = $true
    return $res
  } catch {
    $res.Code = 'STATE_WRITE_FAILED'; $res.Detail = $_.Exception.Message
    return $res
  }
}

<#
.SYNOPSIS
  プランナの結論から「ポータルへ行ってよいか」を決める (純粋関数)。
.DESCRIPTION
  **`Proceed` が $true のときだけ**、証明書・ログイン・STATE A/B/C へ進む。
  それ以外は**ポータルに 1 回も触らずに終わる**。

  実行ログ (`/api/admin/demecal-run`) の `result` は **`ok` か `fail` の 2 値だけ**
  (`demecal-run.ts:97`)。`ok_noop` / `ok_zero` は **API の result ではない**:
    zero    → result=ok   / rows=0 / range あり
    noop    → result=ok   / rows=0 / range なし
    failure → result=fail
#>
function Get-RunAction([pscustomobject]$plan) {
  $a = [pscustomobject]@{
    Proceed = $false; Result = 'fail'; Stage = 'plan'
    Rows = $null; RangeFrom = ''; RangeTo = ''
    Code = ''; Detail = ''
  }
  if (-not $plan) { $a.Code = 'PLAN_MISSING'; $a.Detail = 'プランナの結果がありません'; return $a }

  if ($plan.Status -eq 'ready') {
    $a.Proceed = $true; $a.Result = 'ok'; $a.Stage = 'range'
    $a.RangeFrom = $plan.From; $a.RangeTo = $plan.To
    return $a
  }
  if ($plan.Status -eq 'noop') {
    # 追いついている。**range を報告しない** (要求していないので)。
    $a.Result = 'ok'; $a.Stage = 'noop'; $a.Rows = 0; $a.Code = $plan.Code
    $a.Detail = $plan.Detail
    return $a
  }
  # not_initialized / invalid_state。**人に見せて止まる** (勝手に初期値を作らない)。
  $a.Stage = 'plan'; $a.Code = $plan.Code; $a.Detail = $plan.Detail
  return $a
}

<#
.SYNOPSIS
  CSV の検査結果から watermark を前進させてよいかを決める (純粋関数)。
.DESCRIPTION
  **valid CSV + rows=0**  → 後段へ渡すデータが無いので前進してよい
                            (「その range について正常に 0 件だった」と確認できた)
  **valid CSV + rows>0**  → 取得は成功。**しかし前進させない** —
                            「取得した bytes を次工程が確実に受領した」という
                            **外部契約がまだ無い**ため。ここで後段 interface を発明しない。
  **invalid**             → 前進させない (fail-closed)
#>
function Get-WatermarkDecision([pscustomobject]$csv) {
  $d = [pscustomobject]@{ Advance = $false; Reason = ''; Detail = '' }
  if (-not $csv -or -not $csv.Ok) {
    $d.Reason = 'CSV_INVALID'; $d.Detail = 'CSV 検査を通っていないので前進させない'
    return $d
  }
  if ($null -eq $csv.Rows) {
    $d.Reason = 'ROWS_UNKNOWN'; $d.Detail = '行数を数えていないので前進させない'
    return $d
  }
  if ([int]$csv.Rows -eq 0) {
    $d.Advance = $true; $d.Reason = 'ZERO_ROWS'; $d.Detail = 'その範囲は正常に 0 件だった'
    return $d
  }
  $d.Reason = 'HANDOFF_NOT_IMPLEMENTED'
  $d.Detail = '取得は成功したが、後段が受領したという契約が無いので前進させない (C-4 Foundation)'
  return $d
}

# ── 終了処理 (verify-1.4 の Finish とは文言も意味も違うので別名) ──
function Stop-ProductionRun([int]$code, [string]$result, [string]$errCode, [string]$detail) {
  $err = $errCode
  if ($detail) { $err = ("{0}: {1}" -f $errCode, $detail) }
  if ($err) { Say ("コード: {0}" -f $err) }
  $sent = Report-Run $result $err
  Say ''
  Say '=================================================='
  if ($result -eq 'ok') { Say ' 結果: ○' } else { Say ' 結果: ×' }
  Say (" 取得範囲 : {0}" -f $(if ($script:RangeFrom) { "$($script:RangeFrom) 〜 $($script:RangeTo)" } else { '(要求なし)' }))
  Say (" 件数     : {0}" -f $(if ($null -eq $script:Rows) { '(数えていない)' } else { $script:Rows }))
  Say (" watermark: {0}" -f $script:Watermark)
  if (-not $sent) { Say ' ※ 実行ログをサーバへ送れませんでした' }
  Say '=================================================='
  exit $code
}

# ── ここから下は手続き部。-LibOnly なら実行しない ─────────────
if ($ProdLibOnly) { return }

$script:Watermark = '据置'

Say '=================================================='
Say ' デメカル 汎用CSV 本番取得'
Say (" 実行日時 : {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Say (" PC名     : {0} / ログオン : {1}" -f $env:COMPUTERNAME, $env:USERNAME)
Say (" 版       : {0}" -f $Version)
Say '=================================================='

# [1] watermark を読む → 取得範囲を決める。
#     **ここで noop / not_initialized / invalid_state ならポータルに 1 回も触らない。**
$script:Stage = 'state'
$today = $ProdTodayJst
if (-not $today) { $today = Get-JstToday }
Diag ("  today_jst={0}" -f $today)

$st = Get-DemecalLastTo
if (-not $st.Ok) { Stop-ProductionRun 1 'fail' $st.Code $st.Detail }
Diag ("  last_to={0}" -f $(if ($st.LastTo) { $st.LastTo } else { '(未初期化)' }))

$script:Stage = 'range'
$plan = Resolve-DemecalAcquisitionRange -LastTo $st.LastTo -TodayJst $today
$action = Get-RunAction $plan
$script:Stage     = $action.Stage
$script:Rows      = $action.Rows
$script:RangeFrom = $action.RangeFrom
$script:RangeTo   = $action.RangeTo
Diag ("  plan={0}/{1} {2}..{3}" -f $plan.Status, $plan.Code, $plan.From, $plan.To)

if (-not $action.Proceed) {
  # **ポータルへ行かずに終わる。** 証明書もログインも触らない。
  if ($action.Result -eq 'ok') { Say ("[1] 新しい取得範囲はありません ({0})" -f $action.Detail) }
  else { Say ("[1] 取得できる状態ではありません: {0}" -f $action.Code) }
  Stop-ProductionRun $(if ($action.Result -eq 'ok') { 0 } else { 1 }) $action.Result $action.Code $action.Detail
}
Say ("[1] 取得範囲 {0} 〜 {1} (結果承認日)" -f $script:RangeFrom, $script:RangeTo)

$from = [datetime]::ParseExact($script:RangeFrom, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
$to   = [datetime]::ParseExact($script:RangeTo,   'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)

# [2] 証明書 (Phase B と同じ選び方: 発行者 CN と秘密鍵で絞る。CN ベタ書きにしない)
$script:Stage = 'cert'
$cert = $null
try {
  $cands = @(Get-ChildItem 'Cert:\CurrentUser\My' -ErrorAction Stop |
             Where-Object { $_.Issuer -match 'demecal\.net CA' -and $_.HasPrivateKey })
  if ($cands.Count -gt 0) { $cert = $cands[0] }
} catch {}
if (-not $cert) { Stop-ProductionRun 1 'fail' 'CERT_NOT_FOUND' '証明書が見つかりません (ログオンユーザーが違う可能性)' }
$script:CertOn   = $cert.NotAfter.ToString('yyyy-MM-dd')
$script:CertDays = [int]($cert.NotAfter - (Get-Date)).TotalDays
Say ("[2] 証明書 OK (期限 {0} / 残り {1} 日)" -f $script:CertOn, $script:CertDays)

# [3] 資格情報 (① recon が DPAPI で保存したもの)
$script:Stage = 'cred'
if (-not (Test-Path $CredPath)) { Stop-ProductionRun 1 'fail' 'CRED_NOT_FOUND' "資格情報がありません ($CredPath)" }
$cred = $null
try { $cred = Import-Clixml -Path $CredPath -ErrorAction Stop } catch {}
if (-not $cred) { Stop-ProductionRun 1 'fail' 'CRED_NOT_FOUND' '資格情報を復号できません' }
Say '[3] 資格情報 OK'

# [4] ログイン (GET でトークン → 同一セッションで POST。証明書は両方に付ける)
$script:Stage = 'login'
$session = $null
try {
  $g = Invoke-WebRequest -Uri $LoginUrl -Certificate $cert -SessionVariable session -UseBasicParsing -TimeoutSec 30
  $tok = ''
  $m = [regex]::Match($g.Content, 'name="__RequestVerificationToken"[^>]*value="([^"]+)"')
  if ($m.Success) { $tok = Html-Decode $m.Groups[1].Value }
  $lb = @{ UserID = $cred.UserName; Password = $cred.GetNetworkCredential().Password }
  if ($tok) { $lb['__RequestVerificationToken'] = $tok }
  $p = Invoke-WebRequest -Uri $LoginUrl -Method Post -Certificate $cert -WebSession $session `
         -Body $lb -UseBasicParsing -TimeoutSec 60
  if ($p.Content -match 'name="Password"') { Stop-ProductionRun 1 'fail' 'LOGIN_FAILED' 'ログインできませんでした (ID/PW を確認)' }
} catch { Stop-ProductionRun 1 'fail' 'LOGIN_FAILED' $_.Exception.Message }
Say '[4] ログイン OK'

# [5] STATE A → B → C → CSV。**Phase B と同じ 3 段固定。探索しない。**
$script:Stage = 'state_a'
$pageHtml = ''
$csvBytes = $null
$respCt = ''
$respCd = ''

try {
  $page = Invoke-WebRequest -Uri $StartUrl -Certificate $cert -WebSession $session -UseBasicParsing -TimeoutSec 60
  $pageHtml = [string]$page.Content

  $steps = @(
    [pscustomobject]@{ Stage = 'state_a'; Expect = 'A'; Fail = 'STATE_A_EXPECTATION_FAILED' },
    [pscustomobject]@{ Stage = 'state_b'; Expect = 'B'; Fail = 'STATE_B_EXPECTATION_FAILED' },
    [pscustomobject]@{ Stage = 'state_c'; Expect = 'C'; Fail = 'STATE_C_EXPECTATION_FAILED' }
  )

  foreach ($stp in $steps) {
    $script:Stage = $stp.Stage
    $forms = Get-Forms $pageHtml
    $seen = ((@($forms | ForEach-Object { Get-StateOf $_ })) -join ',')
    Diag ("  [{0}] form {1}個 / 判定=[{2}] (期待={3})" -f $stp.Stage, @($forms).Count, $seen, $stp.Expect)

    $pick = Select-ExpectedForm $forms $stp.Expect
    if (-not $pick.Ok) {
      Send-Skeleton $pageHtml ("{0}: {1}" -f $stp.Stage, $pick.Detail)
      Stop-ProductionRun 1 'fail' $pick.Code $pick.Detail
    }
    $cur = $pick.Form
    foreach ($s in $cur.Shape) { Diag $s }

    $req = $null
    if ($stp.Expect -eq 'A') {
      $dealer = Test-DealerCode $cur
      if (-not $dealer.Ok) {
        Send-Skeleton $pageHtml ("state_a: {0}" -f $dealer.Detail)
        Stop-ProductionRun 1 'fail' $dealer.Code $dealer.Detail
      }
      $list = Get-HanbaitenList $cert $session $dealer.DealerCode
      Diag ("      販売先一覧 HTTP {0} / 件数 {1}" -f $list.Status, @($list.Items).Count)
      if (-not $list.Ok) { Stop-ProductionRun 1 'fail' 'STATE_A_HANBAITEN_FETCH_FAILED' $list.Detail }
      $sel = Select-Hanbaiten $list.Items
      Diag ("      {0} の一致件数 {1}" -f $ExpectedSellerCode, $sel.Matched)
      if (-not $sel.Ok) { Stop-ProductionRun 1 'fail' $sel.Code $sel.Detail }
      $req = New-StateARequest $cur $sel.SellerCode $sel.SellerName
    }
    elseif ($stp.Expect -eq 'B') { $req = New-StateBRequest $cur $pageHtml $from $to }
    else { $req = New-StateCRequest $cur $pageHtml }

    if (-not $req.Ok) {
      Send-Skeleton $pageHtml ("{0} で契約を満たせない" -f $stp.Stage)
      Stop-ProductionRun 1 'fail' $req.Code $req.Detail
    }
    Diag ("      押す = {0} {1}" -f $req.Press.Kind, $req.Press.Label)

    $u = $cur.Action
    if ($u -notmatch '^https?://') { $u = "$BaseUrl/" + $u.TrimStart('/') }
    $mth = 'Get'; if ($cur.Method -match '(?i)post') { $mth = 'Post' }
    $r = Invoke-WebRequest -Uri $u -Method $mth -Certificate $cert -WebSession $session `
           -Body $req.Body -UseBasicParsing -TimeoutSec 120
    $respCt = [string]$r.Headers['Content-Type']
    $respCd = [string]$r.Headers['Content-Disposition']
    Say ("    [{0}] {1} → HTTP {2} / {3}" -f $stp.Stage, $u, [int]$r.StatusCode, $respCt)
    Diag ("      → HTTP {0} / ct={1} / cd={2}" -f [int]$r.StatusCode, $respCt, ($respCd -replace '^(.{0,80}).*$', '$1'))

    if ($stp.Expect -eq 'C') {
      # **バイト列は RawContentStream から取る** (5.1 の $r.Content は文字列)。
      try { if ($r.RawContentStream) { $csvBytes = $r.RawContentStream.ToArray() } } catch {}
      break
    }
    $pageHtml = [string]$r.Content
  }
} catch { Stop-ProductionRun 1 'fail' 'STATE_TRANSITION_ERROR' $_.Exception.Message }

# [6] CSV の検査 (**メモリ内だけ。ディスクへ保存しない・本文を送らない**)
$script:Stage = 'csv'
$chk = Test-CsvResponse $csvBytes $respCt $respCd
$script:Rows = $chk.Rows
Diag ("  csv bytes={0} rows={1} header={2} filename={3} sha256={4}" -f `
      $chk.Bytes, $chk.Rows, $chk.HeaderOk, $chk.Filename, $chk.Sha256)
Say ("[6] CSV 検査: bytes={0} / rows={1} / 必須ヘッダ={2} / filename={3}" -f `
     $chk.Bytes, $chk.Rows, $chk.HeaderOk, $chk.Filename)
Say ("    SHA-256 : {0}" -f $chk.Sha256)
if (-not $chk.Ok) {
  $skHtml = Get-StateCHtmlForSkeleton $csvBytes $respCt $respCd $chk.Code
  if ($skHtml) { Send-Skeleton $skHtml ("csv: {0}" -f $chk.Detail) }
  Stop-ProductionRun 1 'fail' $chk.Code $chk.Detail
}

# [7] watermark。**rows > 0 では進めない** (後段が受領したという契約がまだ無い)。
$script:Stage = 'state_advance'
$dec = Get-WatermarkDecision $chk
Diag ("  watermark advance={0} reason={1}" -f $dec.Advance, $dec.Reason)
if (-not $dec.Advance) {
  $script:Watermark = ("据置 ({0})" -f $dec.Reason)
  Say ("[7] watermark は前進させません: {0}" -f $dec.Detail)
  $script:Stage = 'done'
  Stop-ProductionRun 0 'ok' '' ''
}

$adv = Set-DemecalLastTo $script:RangeTo
if (-not $adv.Ok) {
  # 取得は成功したが watermark を書けなかった。**据置のまま fail で残す** —
  # 次回 run が同じ範囲を取り直す (C-2 の retry 契約どおり・取り漏れは起きない)。
  $script:Watermark = ("据置 ({0})" -f $adv.Code)
  Stop-ProductionRun 1 'fail' $adv.Code $adv.Detail
}
$script:Watermark = ("前進 {0}" -f $script:RangeTo)
Say ("[7] watermark を {0} まで前進させました" -f $script:RangeTo)

$script:Stage = 'done'
Stop-ProductionRun 0 'ok' '' ''
