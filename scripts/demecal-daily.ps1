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
# **失敗したときだけ**、画面の「骨格」を回収するためのトークン (`/api/ops/probe-upload`)。
# 成功時は何も送らない。送るのは form 内のタグと script だけで、本文テキストは含めない
# (= 受診者一覧のような表は構造上入らない)。**ここを最初からやっておくべきだった。**
$ProbeToken = '__PROBE_TOKEN__'
$Version   = 'daily-1.7'

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
# 画面遷移の構造だけを積む診断ログ (実行ログAPI へ送る)。
# **値は入れない。** 入れるのは 名前 / 型 / 選択肢の数 / ボタンの見出し / 送った日付 だけ
# = 受診者の情報は 1 文字も乗らない。ここが空だと、失敗したとき現地で
# もう一度 bat を回してもらう羽目になる (v1.0 で実際にそうなった)。
$script:Diag      = New-Object System.Collections.Generic.List[string]
function Diag($t) { if ($script:Diag.Count -lt 60) { $script:Diag.Add($t) | Out-Null } }

# **HTML の属性値は実体参照で書かれている。デコードしてから送る。**
#
# 【実障害 2026-09-02・骨格で確定】これをやっていなかったため、
#   `DairitenName` が 1 回 POST するごとに 1 段ずつ多重エスケープされ、
#   3 段目には `&amp;amp;amp;#x682A;…` (4 重) になっていた。
#   = **こちらが値を壊しながら送り続け、サーバに 1 段目へ突き返されていた。**
#   「押し方が分からない」のではなく「送っている中身が壊れていた」のが真因。
#
# ブラウザと同じ**1 回だけ**デコードする (2 回やると別の壊し方になる)。
function Html-Decode([string]$v) {
  if (-not $v) { return $v }
  try { return [System.Net.WebUtility]::HtmlDecode($v) } catch {}
  # 古い環境向けの保険。順序は &amp; を最後にする (先に戻すと二重に解ける)。
  $v = $v -replace '&lt;', '<' -replace '&gt;', '>' -replace '&quot;', '"' -replace '&#39;', "'"
  return ($v -replace '&amp;', '&')
}

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
      diag            = @($script:Diag)
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

# 画面の骨格だけを取り出す。**テキストノードは載せない。**
#   ・form 内の <input>/<select>/<option>/<button>/<label> の**タグそのもの**
#   ・inline <script> の中身 (押し方はここにしか書かれていない)
#   ・外部 script の src 一覧
# hidden の value も含む — antiforgery トークンは 1 回きりで、
# 回収時にはセッションごと無効になっているため実害が無い。
function Get-Skeleton([string]$html) {
  $o = New-Object System.Collections.Generic.List[string]
  if (-not $html) { return $o }
  $fi = 0
  foreach ($fm in [regex]::Matches($html, '(?is)<form\b[^>]*>.*?</form>')) {
    $fi++
    $f = $fm.Value
    $o.Add(("---- form#{0} ----" -f $fi)) | Out-Null
    $ot = [regex]::Match($f, '(?is)<form\b[^>]*>'); if ($ot.Success) { $o.Add($ot.Value) | Out-Null }
    foreach ($tm in [regex]::Matches($f, '(?is)<(?:input|select|option|button|label|textarea)\b[^>]*>')) {
      $o.Add(($tm.Value -replace '\s+', ' ')) | Out-Null
      if ($o.Count -gt 400) { break }
    }
  }
  foreach ($sm in [regex]::Matches($html, '(?is)<script\b([^>]*)>(.*?)</script>')) {
    $attr = $sm.Groups[1].Value
    if ($attr -match '(?i)\bsrc="([^"]+)"') { $o.Add(("---- script src: {0}" -f $Matches[1])) | Out-Null; continue }
    $body = $sm.Groups[2].Value
    if (-not $body.Trim()) { continue }
    $o.Add('---- inline script ----') | Out-Null
    $o.Add($body) | Out-Null
  }
  return $o
}

function Send-Skeleton([string]$html, [string]$why) {
  if ($ProbeToken -eq ('__PROBE' + '_TOKEN__')) { return }
  try {
    $sk = Get-Skeleton $html
    if ($sk.Count -eq 0) { return }
    $payload = @{
      report = ("[{0}] {1}`r`n`r`n{2}" -f $Version, $why, ($sk -join "`r`n"))
      label  = 'demecal-skeleton'
      host   = $env:COMPUTERNAME
    } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri 'https://scan-chat-ai.vercel.app/api/ops/probe-upload' -Method Post -TimeoutSec 30 `
      -Body ([Text.Encoding]::UTF8.GetBytes($payload)) `
      -ContentType 'application/json; charset=utf-8' `
      -Headers @{ 'x-probe-token' = $ProbeToken } | Out-Null
    Say '    ※ 解析用に画面の骨格 (タグと script のみ) を送信しました'
  } catch { }
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
  if ($m.Success) { $tok = Html-Decode $m.Groups[1].Value }
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

# 【v1.0 の欠陥・実測 2026-09-02】ここが `<input>` しか見ていなかった。
#   ①(recon) の `Get-FormMeta` は `<select>` も `<button>` も読むのに、②だけ落ちていた。
#   結果、選択欄と実行ボタンを**送らないまま**同じ画面を POST し続け、
#   `/hanyou/entry` が 4 回連続で返って CSV に到達しなかった。
#   ブラウザは「押したボタン 1 個だけ」を送るので、submit 系は fields と分けて持つ。
# hidden へ JS が入れる値を、与えられたテキスト (ページ本文でも .js でも) から拾う。
#   X.value='v' / X.value = "v" / ["X"].value='v' / $('#X').val('v')
# **値をコードに埋めないための唯一の手段**なので、探す場所だけを増やしていく。
function Find-ActionValues([string]$text, [string]$field) {
  $out = @()
  if (-not $text -or -not $field) { return $out }
  $pat = ('(?i)' + [regex]::Escape($field) + '["\x27\]]{0,3}\s*\)?\s*\.\s*(?:value|val)\s*(?:=|\(\s*)\s*["\x27]([^"\x27]{1,40})["\x27]')
  foreach ($m in [regex]::Matches($text, $pat)) {
    $v = $m.Groups[1].Value
    if ($v -and ($out -notcontains $v)) { $out += $v }
  }
  return $out
}

function Get-Forms([string]$html, [string]$pageUrl) {
  $out = @()
  foreach ($fm in [regex]::Matches($html, '(?is)<form\b[^>]*>.*?</form>')) {
    $f = $fm.Value
    $action = ''
    $ma = [regex]::Match($f, '(?i)action="([^"]*)"'); if ($ma.Success) { $action = $ma.Groups[1].Value }
    $method = 'get'
    $mm = [regex]::Match($f, '(?i)method="([^"]*)"'); if ($mm.Success) { $method = $mm.Groups[1].Value }
    $fields  = @{}
    $types   = @{}
    $submits = @()   # 名前つきの実行ボタン (押した 1 個だけを送る)
    $radios  = @()   # ラジオ/チェックの全選択肢 (ラベル付き。既定でない側も持つ)
    $hiddens = @()   # hidden の名前 (外部 .js まで値を探しに行く対象)
    $shape   = @()   # 診断用の形だけ (値は入れない)

    foreach ($im in [regex]::Matches($f, '(?is)<input\b[^>]*>')) {
      $tag = $im.Value
      $t = [regex]::Match($tag, '(?i)type="([^"]*)"')
      $type = if ($t.Success) { $t.Groups[1].Value.ToLower() } else { 'text' }
      $n = [regex]::Match($tag, '(?i)name="([^"]*)"')
      $v = [regex]::Match($tag, '(?i)value="([^"]*)"')
      $name = if ($n.Success) { $n.Groups[1].Value } else { '' }
      $val  = if ($v.Success) { Html-Decode $v.Groups[1].Value } else { '' }
      if ($type -eq 'reset') { continue }
      if ($type -match '^(submit|image|button)$') {
        # value はボタンの見出し (「次へ」等) で受診者の情報ではない。診断に出してよい。
        if ($name) { $submits += [pscustomobject]@{ Name = $name; Value = $val; Label = $val; Pos = $im.Index } }
        $shape += ("      submit name={0} label={1}" -f $name, $val)
        continue
      }
      if (-not $n.Success) { continue }
      # radio/checkbox は checked のものだけ採る (既定の選択を尊重する)
      if ($type -match '^(radio|checkbox)$') {
        # **ラベルを拾う。** 画面で人が読んでいる文字＝どれを押すべきかの唯一の手掛かり。
        #   ①<label for="id">文字</label> ②<label>…<input>文字</label> ③input の直後の文字
        $lbl = ''
        $idm = [regex]::Match($tag, '(?i)\bid="([^"]*)"')
        if ($idm.Success) {
          $lm = [regex]::Match($f, ('(?is)<label[^>]*\bfor="' + [regex]::Escape($idm.Groups[1].Value) + '"[^>]*>(.*?)</label>'))
          if ($lm.Success) { $lbl = $lm.Groups[1].Value }
        }
        if (-not $lbl) {
          $lm2 = [regex]::Match($f, ('(?is)<label[^>]*>(?:(?!</label>).)*?' + [regex]::Escape($tag) + '((?:(?!</label>).)*?)</label>'))
          if ($lm2.Success) { $lbl = $lm2.Groups[1].Value }
        }
        if (-not $lbl) {
          $after = $f.Substring($im.Index + $tag.Length)
          $lm3 = [regex]::Match($after, '(?s)^\s*([^<]{1,40})')
          if ($lm3.Success) { $lbl = $lm3.Groups[1].Value }
        }
        $lbl = (($lbl -replace '<[^>]+>', '') -replace '\s+', ' ').Trim()
        $radios += [pscustomobject]@{ Name = $name; Value = $val; Label = $lbl; Checked = ($tag -match '(?i)\bchecked\b') }
        $shape += ("      {0} name={1} label={2}{3}" -f $type, $name, $lbl, $(if ($tag -match '(?i)\bchecked\b') { ' [既定]' } else { '' }))
        if ($tag -notmatch '(?i)\bchecked\b') { continue }
      }
      $fields[$name] = $val
      $types[$name]  = $type
      $shape += ("      input  name={0} type={1}" -f $name, $type)
    }

    # **select を送らないと必須チェックに落ちて同じ画面が返る。**
    # 既定の選択 (selected、無ければ先頭) = ブラウザで何も触らなかったときと同じ値。
    foreach ($sm in [regex]::Matches($f, '(?is)<select\b(?<a>[^>]*)>(?<b>.*?)</select>')) {
      $n = [regex]::Match($sm.Groups['a'].Value, '(?i)name="([^"]*)"')
      if (-not $n.Success) { continue }
      $name = $n.Groups[1].Value
      $opts = @()
      foreach ($o in [regex]::Matches($sm.Groups['b'].Value, '(?is)<option\b(?<oa>[^>]*)>')) {
        $ov = [regex]::Match($o.Groups['oa'].Value, '(?i)value="([^"]*)"')
        $opts += [pscustomobject]@{
          Value = if ($ov.Success) { Html-Decode $ov.Groups[1].Value } else { '' }
          Sel   = ($o.Groups['oa'].Value -match '(?i)\bselected\b')
        }
      }
      $pick = @($opts | Where-Object { $_.Sel })
      $use  = if ($pick.Count -gt 0) { $pick[0].Value } elseif ($opts.Count -gt 0) { $opts[0].Value } else { '' }
      $fields[$name] = $use
      $types[$name]  = 'select'
      # 選択肢の**中身は出さない** (受診者一覧の可能性)。件数と、既定として送った 1 件だけ。
      $shape += ("      select name={0} options={1} 送信={2}" -f $name, $opts.Count, $use)
    }

    foreach ($tm in [regex]::Matches($f, '(?is)<textarea\b(?<a>[^>]*)>(?<b>.*?)</textarea>')) {
      $n = [regex]::Match($tm.Groups['a'].Value, '(?i)name="([^"]*)"')
      if (-not $n.Success) { continue }
      $fields[$n.Groups[1].Value] = Html-Decode $tm.Groups['b'].Value
      $types[$n.Groups[1].Value]  = 'textarea'
      $shape += ("      textarea name={0}" -f $n.Groups[1].Value)
    }

    foreach ($bm in [regex]::Matches($f, '(?is)<button\b(?<a>[^>]*)>(?<b>.*?)</button>')) {
      $attr = $bm.Groups['a'].Value
      # type 未指定の <button> は submit 扱い (HTML の既定)。
      $bt = [regex]::Match($attr, '(?i)type="([^"]*)"')
      $btype = if ($bt.Success) { $bt.Groups[1].Value.ToLower() } else { 'submit' }
      if ($btype -ne 'submit') { continue }
      $n = [regex]::Match($attr, '(?i)name="([^"]*)"')
      $v = [regex]::Match($attr, '(?i)value="([^"]*)"')
      $label = (($bm.Groups['b'].Value -replace '<[^>]+>', '') -replace '\s+', ' ').Trim()
      if ($n.Success) {
        $submits += [pscustomobject]@{
          Name = $n.Groups[1].Value
          Value = if ($v.Success) { Html-Decode $v.Groups[1].Value } else { '' }
          Label = $label
          Pos = $bm.Index
        }
      }
      $bname = if ($n.Success) { $n.Groups[1].Value } else { '(名前なし)' }
      $shape += ("      button name={0} label={1}" -f $bname, $label)
      # **押し方が分からないときはここが唯一の手掛かり。** 属性だけ (中の文字は載せない)。
      $shape += ("        └ tag: {0}" -f (($attr -replace '\s+', ' ').Trim() -replace '^(.{0,220}).*$', '$1'))
    }

    # 【本命・①v1.9 の偵察で判明 2026-09-02】`/hanyou/entry` の実行指示は
    #   **ボタンではなく hidden `submitType`** に入る (偵察レポートに
    #   `input name=submitType type=hidden` ＋ `button 確認` `button 戻る`)。
    #   = ボタンの onclick が JS で hidden に値を入れてから submit する型。
    #   hidden を既定値のまま送ると「何も指示していない」ので同じ画面が返る
    #   = v1.0 が /hanyou/entry を 4 回繰り返した理由。
    #
    # **値をコードに埋めない** (`next` 等を決め打ちしたら画面改訂で即死ぬ・CLAUDE.md)。
    #   代わりに**そのページの JS から実際に代入されている文字列を拾う**。
    #   拾えた値は「押せるボタン」と同格の候補として、下の順番で 1 つずつ試す。
    foreach ($hf in @($fields.Keys)) {
      if ($types[$hf] -ne 'hidden') { continue }
      if ($hf -match '(?i)token|verification') { continue }
      $hiddens += $hf
      $vals = Find-ActionValues $html $hf
      $i2 = 0
      foreach ($hv in $vals) {
        $i2++
        $submits += [pscustomobject]@{
          Name = $hf; Value = $hv; Label = ("hidden {0}" -f $hf); Pos = 100000 + $i2
        }
      }
      if ($vals.Count -gt 0) {
        # 値は画面操作の識別子 (next / confirm 等) で受診者の情報ではない。診断に出してよい。
        $shape += ("      hidden {0} に JS が入れる値 = [{1}]" -f $hf, ($vals -join ' | '))
      }
    }

    # **試す順番だけを決める。候補を絞りはしない** (どれが正解かは決め打ちしない)。
    #   ・原則は画面に並んでいる順
    #   ・「戻る」「取消」系は最後に回す — 先に押すと 1 段戻ってしまい、
    #     上限 (MaxHops) を無駄に食う。全部試す点は変わらない。
    #   ・見出しの無いボタンはその次 (何をするか読めないので先に押さない)
    $back = '(?i)戻|取消|キャンセル|クリア|back|cancel|reset|clear'
    $submits = @($submits | Sort-Object `
      @{ Expression = {
          if ("$($_.Label) $($_.Value)" -match $back) { 2 }
          elseif (-not "$($_.Label)$($_.Value)".Trim()) { 1 }
          else { 0 }
        } }, `
      @{ Expression = { $_.Pos } })

    $out += [pscustomobject]@{
      Action = $action; Method = $method; Fields = $fields; Types = $types
      Submits = $submits; Radios = $radios; Hiddens = $hiddens; Shape = $shape; Page = $pageUrl
    }
  }
  return $out
}

# 「同じ画面が返ってきた」を判定する指紋。**値は含めない** (日付だけ違う同一画面を別物にしない)。
function Get-FormSig($form) {
  $names = @($form.Fields.Keys | Where-Object { $_ -notmatch '(?i)token|verification' } | Sort-Object)
  $subs  = @($form.Submits | ForEach-Object { $_.Name } | Sort-Object)
  return ('{0}|{1}|{2}' -f $form.Action, ($names -join ','), ($subs -join ','))
}

# 実際に送る form を選ぶ。**先頭決め打ちにしない** — ログアウトや検索窓が先に来ていると
# 中身の無い form を押し続けることになる (v1.0 の 4 連続ループの候補原因のひとつ)。
# token 以外の入力を持つ form のうち、いちばん項目が多いものを採る。
function Select-Form($forms) {
  $real = @($forms | Where-Object {
    @($_.Fields.Keys | Where-Object { $_ -notmatch '(?i)token|verification' }).Count -gt 0
  })
  $pool = if ($real.Count -gt 0) { $real } else { $forms }
  return ($pool | Sort-Object { -$_.Fields.Count })[0]
}

function Resolve-Url([string]$action, [string]$pageUrl) {
  if ($action -match '^https?://') { return $action }
  if ($action) { return "$BaseUrl/" + $action.TrimStart('/') }
  return $pageUrl
}

$csvBytes = $null
$script:JsSeen = @{}
$pageHtml = ''
$u2raw = ''
$MaxHops  = 14   # 候補を 1 つずつ試すぶん、段数でなく試行回数の上限
# 「この指紋の画面では、次にどの実行ボタンを試すか」。同じ画面が返ったら次の候補へ進む。
$tried = @{}

try {
  $startUrl = "$BaseUrl/hanyou/start"
  $page = Invoke-WebRequest -Uri $startUrl -Certificate $cert -WebSession $session -UseBasicParsing -TimeoutSec 60
  $pageHtml = [string]$page.Content
  $forms = Get-Forms $pageHtml $startUrl
  if ($forms.Count -eq 0) { Finish 1 'fail' '汎用CSV画面に form がありません (画面が変わった可能性)' }
  $cur = Select-Form $forms

  for ($hop = 1; $hop -le $MaxHops; $hop++) {
    $sig = Get-FormSig $cur
    $idx = if ($tried.ContainsKey($sig)) { [int]$tried[$sig] } else { 0 }
    # **「何も押さない」を最初の候補にする。**
    #   v1.0 は一切押さずに `/hanyou/start` → `/hanyou/entry` へ**進めていた**
    #   (止まったのは entry から先)。押す側へ全面的に切り替えると、
    #   その通っていた 1 段目を壊しかねない。まず従来どおり送り、
    #   同じ画面が返ったときだけ押す候補へ移る。
    # 【v1.3 の実測 2026-09-02】entry / 確認画面で候補が **1 通り (押さないだけ)** になった
    #   = ボタンに name が無く、submitType に入る値も**ページ本文には書かれていない**。
    #   ASP.NET MVC は JS をバンドルした外部ファイルへ出すので、そこまで見に行く。
    #   **値はやはり埋めない。読みに行く先を増やしただけ。**
    if (@($cur.Submits).Count -eq 0 -and @($cur.Hiddens).Count -gt 0) {
      foreach ($sm in [regex]::Matches($pageHtml, '(?i)<script[^>]*\bsrc="([^"]+\.js[^"]*)"')) {
        $src = $sm.Groups[1].Value
        if ($src -match '(?i)jquery|bootstrap|popper|modernizr|respond|validat') { continue }  # 定番ライブラリは見ない
        $u2 = Resolve-Url $src $cur.Page
        if ($script:JsSeen.ContainsKey($u2)) { continue }
        $script:JsSeen[$u2] = $true
        if ($script:JsSeen.Count -gt 6) { break }   # 無制限に取りに行かない
        $js = ''
        try {
          $jr = Invoke-WebRequest -Uri $u2 -Certificate $cert -WebSession $session -UseBasicParsing -TimeoutSec 30
          $js = [string]$jr.Content
        } catch { Diag ("      js 取得不可: {0}" -f $u2); continue }
        foreach ($hf in @($cur.Hiddens)) {
          $vals = Find-ActionValues $js $hf
          if ($vals.Count -eq 0) { continue }
          Diag ("      {0} から {1} の値 = [{2}]" -f ($u2 -replace '^.*/', ''), $hf, ($vals -join ' | '))
          $i3 = 0
          foreach ($hv in $vals) {
            $i3++
            $cur.Submits += [pscustomobject]@{
              Name = $hf; Value = $hv; Label = ("hidden {0} (js)" -f $hf); Pos = 200000 + $i3
            }
          }
        }
      }
      if (@($cur.Submits).Count -eq 0) {
        Diag '      外部 js を見ても実行指示の値が見つかりません'
      }
    }

    $cands = @([pscustomobject]@{ Name = ''; Value = ''; Label = '(押さない)' }) + @($cur.Submits)
    # **成功しても失敗しても、送る直前の form の形を残す。**
    # ここが残っていれば、次の一手を決めるのに現地でもう一度回してもらう必要が無い。
    if ($idx -eq 0) { foreach ($s in $cur.Shape) { Diag $s } }

    # **同じ画面が返り続けたら、押すボタンを変えて試す。** 候補を使い切ったら
    # 黙って回り続けずに落とす (v1.0 は同じ body を 4 回送って上限で終わっていた)。
    if ($idx -ge $cands.Count) {
      Diag ("  [{0}段目] 候補 {1} 通りを全て試しましたが画面が変わりません (form action={2})" -f $hop, $cands.Count, $cur.Action)
      # **ここで骨格を回収する。** 押し方が分からない = 手元の情報が足りない、ということなので、
      # もう一度現地で回してもらう前に、判断に要るものを 1 回で持ち帰る。
      Send-Skeleton $pageHtml ("進めなくなった画面 ({0}段目 / 直前POST={1} / この画面の form action={2})" -f $hop, $u2raw, $cur.Action)
      Finish 1 'fail' ("同じ画面から進めません (候補 {0} 通りを全て試行)" -f $cands.Count)
    }

    $body = @{}
    foreach ($k in $cur.Fields.Keys) { $body[$k] = $cur.Fields[$k] }
    # **日付欄だけを差し替える。** token を含む名前には絶対に触らない
    # (①v1.9 で `(?i)to` が __RequestVerificationToken に当たった実績)。
    $dateSent = @()
    foreach ($k in @($cur.Fields.Keys)) {
      if ($k -match '(?i)token|verification') { continue }
      if ($k -notmatch '(?i)date|ymd|日付|ymdhms|kikan|期間') { continue }
      if ($k -match '(?i)from|start|開始|自')     { $body[$k] = $from.ToString('yyyy/MM/dd'); $dateSent += "$k<-from" }
      elseif ($k -match '(?i)to|end|終了|至|until') { $body[$k] = $to.ToString('yyyy/MM/dd');   $dateSent += "$k<-to" }
    }
    # 【実測 2026-09-02・操作の録画】「項目見出し」の既定は **出力しない**。
    #   取り込み側 (`elith-blood-csv.ts:221`) は **1 行目をヘッダとして列名で引く**ので、
    #   ヘッダ無しの CSV は 指図番号/性別/生年月日/採血日/結果項目数 が **1 つも引けない**
    #   = 取り込みが丸ごと壊れる。手動運用でも担当者は毎回「出力する」に変えている。
    #   → **ラベルが「出力する」の選択肢へ切り替える。** 値は画面から読む (埋めない)。
    #   ラベルが取れず切り替えられなくても、[6] のヘッダ検査が最後に止める。
    foreach ($rd in @($cur.Radios)) {
      if ($rd.Label -notmatch '出力する') { continue }
      if ($body[$rd.Name] -eq $rd.Value) { continue }
      $body[$rd.Name] = $rd.Value
      Diag ("      ラジオ {0} を『{1}』へ切替 (既定は出力しない)" -f $rd.Name, $rd.Label)
    }

    $pressed = $cands[$idx].Label
    if ($cands[$idx].Name) {
      $body[$cands[$idx].Name] = $cands[$idx].Value
      $pressed = ("{0}={1} ({2})" -f $cands[$idx].Name, $cands[$idx].Value, $cands[$idx].Label)
    }
    $tried[$sig] = $idx + 1

    $u = Resolve-Url $cur.Action $cur.Page
    $u2raw = $u
    $mth = if ($cur.Method -match '(?i)post') { 'Post' } else { 'Get' }
    $r = Invoke-WebRequest -Uri $u -Method $mth -Certificate $cert -WebSession $session `
           -Body $body -UseBasicParsing -TimeoutSec 120
    $ct = [string]$r.Headers['Content-Type']
    $cd = [string]$r.Headers['Content-Disposition']
    Say ("    [{0}段目] {1} → HTTP {2} / {3}" -f $hop, $u, [int]$r.StatusCode, $ct)
    Diag ("  [{0}段目] {1} {2} → {3} / ct={4}" -f $hop, $mth, $u, [int]$r.StatusCode, $ct)
    Diag ("      form {0}個中 項目{1} 候補{2}(今回={3}) / 押した={4} / 日付={5}" -f `
          $forms.Count, $cur.Fields.Count, $cands.Count, ($idx + 1), $pressed, (($dateSent -join ' ') -replace '^$', '(該当なし)'))

    # **CSV は content-type だけで判定しない。** 添付として返るなら中身が何であれ CSV。
    if ($ct -notmatch '(?i)text/html' -or $cd -match '(?i)attachment') { $csvBytes = $r.Content; break }

    $pageHtml = [string]$r.Content
    $forms = Get-Forms $pageHtml $u
    if ($forms.Count -eq 0) { Finish 1 'fail' ("{0} 段目の応答に form が無く CSV も返りません" -f $hop) }
    $cur = Select-Form $forms
  }
} catch { Finish 1 'fail' ("CSV 取得中に失敗: {0}" -f $_.Exception.Message) }

if (-not $csvBytes) {
  Send-Skeleton $pageHtml ("{0} 段まで辿って届かなかった最後の画面" -f $MaxHops)
  Diag ("  {0} 段まで辿っても CSV に届きませんでした" -f $MaxHops)
  Finish 1 'fail' ("画面を {0} 段辿りましたが CSV が返りませんでした" -f $MaxHops)
}

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

# **ヘッダ行が無い CSV を送らない。** 取り込み側は 1 行目を列名として引くので、
# ヘッダ無しだと列が 1 つも引けず、壊れたデータが静かに入る (それが一番まずい)。
# ここで止めれば last_to も進まないので、次回そのまま取り直せる。
if ($txt -and $txt -notmatch '指図番号') {
  Finish 1 'fail' 'CSV に見出し行がありません (「項目見出し=出力する」が効いていない)'
}

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
