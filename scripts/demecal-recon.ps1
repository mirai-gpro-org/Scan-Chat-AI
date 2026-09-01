# デメカル 血液CSV — 初回セットアップ＆偵察 (bat ①)
#
# 正本: docs/lab/demecal_unattended_spec.md
#
# 【この 1 本で「Wellfort への往復」を終わらせるのが目的】
#   本番の自動実行 (bat ②) を書くのに要る情報を **1 回の実行で全部** 取る。
#   併せて、②が使う資格情報の保存とフォルダ作成も済ませる。
#   → Wellfort 側の操作は ①と②の **ダブルクリック 2 回だけ**。
#
# 【やること】
#   [0] 保存先を作る       C:\demecal\ (OneDrive 配下なら中止)
#   [1] 証明書を選ぶ       発行者CN=demecal.net CA かつ 秘密鍵あり
#   [2] 資格情報を保存     デメカル ID/PW を DPAPI で暗号化保存 (②が再利用)
#   [3] ログイン           GET でトークン → 同一セッションで POST
#   [4] 偵察               CSV ダウンロード画面の form 構造を調べる
#   [5] ドライラン         **過去の空レンジ**で DL を試し、応答の形だけ記録
#   [6] 報告               結果を保存 ＋ (トークンがあれば) サーバへ送信
#       ※ [0]〜[2] で**中止したときも報告する** (recon-1.1)。黙って終わらない。
#
# 【やらないこと — PII を持ち出さない】
#   ・**ページ本文を保存も送信もしない。** form のメタデータ (action/method/
#     input の name と type/select の選択肢) だけを抜く。受診者一覧が載る画面が
#     あっても中身は出さない。
#   ・**本物の CSV を取らない。** [5] は結果が出ないはずの過去日付で試し、
#     記録するのは「HTTPステータス／content-type／ファイル名／ヘッダ行／行数」だけ。
#     万一データが返っても **ヘッダ行以外は捨てる**。
#   ・ID・パスワードは画面にもファイルにも出さない (保存は DPAPI 暗号化のみ)。

$ErrorActionPreference = 'Continue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$BaseUrl   = 'https://dl.demecal.net'
$LoginUrl  = "$BaseUrl/account/login"
$UploadUrl = 'https://scan-chat-ai.vercel.app/api/ops/probe-upload'
$CredUrl   = 'https://scan-chat-ai.vercel.app/api/ops/demecal-cred'
$Token     = '__PROBE_TOKEN__'
$Version   = 'recon-1.6'

$lines = New-Object System.Collections.Generic.List[string]
function Say($t) { Write-Host $t; $lines.Add($t) | Out-Null }

# ── 報告 ────────────────────────────────────────────────────
#
# 【なぜ「段階ごと」に送るのか — 2 本の比較で判明 2026-09-01】
#   送信コードは接続チェック(probe)と**実質同一**(probe.ps1:168)。TLS/プロキシ等の
#   グローバル状態も一致 (どちらも ErrorActionPreference=Continue / Tls12)。
#   それでも probe は 8/31 に WELLFORT_PC から 3 回届き、recon は 0 回。
#   **差は「送信までの距離」だけ**:
#
#     probe : 入力待ち 0 回 / 通信 2 回 / 数秒で送信に到達 (190 行中 168 行目)
#     recon : Get-Credential のダイアログ 1 回 / 通信 最大 5 回 (各 30〜60 秒)
#
#   同じコードでも、**到達する前に窓を閉じられれば何も残らない**。
#   probe は閉じる隙が無いから取りこぼさなかっただけ。
#   → 距離を無くす。**段階ごとに送れば、どこで止まってもそこまでが必ず届く。**
function Send-Now([string]$stage) {
  if ($Token -eq ('__PROBE' + '_TOKEN__')) { return $false }
  try {
    $payload = @{
      report = (($lines -join "`r`n") + "`r`n`r`n---- ここまでが段階 [$stage] 時点の内容です ----")
      label  = 'demecal-recon'
      host   = $env:COMPUTERNAME
    } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri $UploadUrl -Method Post -TimeoutSec 20 `
      -Body ([Text.Encoding]::UTF8.GetBytes($payload)) `
      -ContentType 'application/json; charset=utf-8' `
      -Headers @{ 'x-probe-token' = $Token } | Out-Null
    return $true
  } catch { return $false }   # 送信は本処理の前提ではない。落ちても続ける。
}

function Finish($code) {
  $dir = if ($script:ReconDir -and (Test-Path $script:ReconDir)) { $script:ReconDir } else { $env:TEMP }
  $reportPath = Join-Path $dir 'demecal_recon_report.txt'
  try { Set-Content -Path $reportPath -Value ($lines -join "`r`n") -Encoding UTF8 } catch { }

  $ok = Send-Now 'final'
  Write-Host ''
  Write-Host '=================================================='
  Write-Host '  すべて終わりました。この画面を閉じて構いません。'
  if (-not $ok) {
    Write-Host ''
    Write-Host '  ※ 送信できませんでした。下のファイルをメールでお送りください。'
    Write-Host "     $reportPath"
  }
  Write-Host '=================================================='

  Read-Host "確認できたら Enter キーを押してください"
  exit $code
}

Say '=================================================='
Say ' デメカル 初回セットアップ＆偵察'
Say (" 実行日時 : {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Say (" PC名     : {0}" -f $env:COMPUTERNAME)
Say (" 版       : {0}" -f $Version)
Say '=================================================='
Say ''

# **窓を閉じられると全部消える**のが v1.1 までの弱点だった (上記の比較)。
# 段階ごとの送信で保険を掛けたうえで、閉じない理由を最初にはっきり伝える。
Write-Host '  ------------------------------------------------'
Write-Host '  この画面は自動では閉じません。'
Write-Host '  「すべて終わりました」と出るまで閉じないでください。'
Write-Host '  3〜5 分かかります。途中、画面が止まって見える時間が'
Write-Host '  ありますが、通信の待ち時間です。そのままお待ちください。'
Write-Host '  ------------------------------------------------'
Write-Host ''
Send-Now '起動' | Out-Null

# ── [0] 保存先 ────────────────────────────────────────────────
# デスクトップは OneDrive 同期対象 (実測)。PII を含む CSV をそこへ置かないため、
# 本番と同じ C:\demecal\ を最初に確保しておく。
Say '[0] 保存先を用意します...'
$Root = 'C:\demecal'
try {
  # **`-ErrorAction Stop` が要る。** 無いと New-Item の失敗は非終了エラーになり
  # catch が発火しない = $Root が C:\demecal のまま先へ進み、作れていないのに
  # 「OK: C:\demecal」と表示される (probe との比較で発覚 2026-09-01)。
  # C: 直下は一般ユーザー権限だと作れないことがある。
  if (-not (Test-Path $Root)) { New-Item -ItemType Directory -Path $Root -Force -ErrorAction Stop | Out-Null }
} catch {
  $Root = Join-Path $env:LOCALAPPDATA 'demecal'
  if (-not (Test-Path $Root)) { New-Item -ItemType Directory -Path $Root -Force -ErrorAction SilentlyContinue | Out-Null }
}
if (-not (Test-Path $Root)) { Say "    中止: 保存先を作れませんでした ($Root)"; Finish 1 }
if ($Root -match 'OneDrive') {
  Say "    中止: 保存先が OneDrive 配下です ($Root)。同期されるため使えません。"
  Say '    担当者へご連絡ください。'
  Finish 1
}
$SecretDir = Join-Path $Root 'secrets'
$ReconDir  = Join-Path $Root 'recon'
foreach ($d in @($SecretDir, $ReconDir)) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null } }
Say "    OK: $Root"
Say ''
Send-Now '0-保存先' | Out-Null

# ── [1] 証明書 ────────────────────────────────────────────────
# CN をベタ書きしない (証明書更新で変わりうる)。発行者と秘密鍵の有無で絞る。
Say '[1] クライアント証明書を探しています...'
$cert = $null
try {
  $cands = @(Get-ChildItem 'Cert:\CurrentUser\My' -ErrorAction Stop |
             Where-Object { $_.Issuer -match 'demecal\.net CA' -and $_.HasPrivateKey })
  if ($cands.Count -eq 0) {
    $cands = @(Get-ChildItem 'Cert:\LocalMachine\My' -ErrorAction SilentlyContinue |
               Where-Object { $_.Issuer -match 'demecal\.net CA' -and $_.HasPrivateKey })
  }
  if ($cands.Count -gt 0) {
    $cert = $cands[0]
    Say ("    OK: {0}" -f $cert.Subject)
    Say ("        有効期限 : {0}  (残り {1} 日)" -f $cert.NotAfter.ToString('yyyy-MM-dd'), [int]($cert.NotAfter - (Get-Date)).TotalDays)
  }
} catch {}
if (-not $cert) {
  Say '    見つかりません。この PC はデメカル用の専用PCでない可能性があります。'
  Say '    担当者へご連絡ください。'
  Finish 1
}
Say ''
Send-Now '1-証明書' | Out-Null

# ── [2] 資格情報 ──────────────────────────────────────────────
#
# 【担当者に入力させない — 発注者指示 2026-09-01】
#   ID/PW は事前に受領済みなので、**現地で打たせる理由が無い**。
#   v1.4 までの `Get-Credential`(GUI)、v1.5 の `Read-Host`(コンソール) は
#   どちらも「入力方式を変えただけ」で、入力させること自体が誤りだった。
#
#   実測 (WELLFORT_PC・2 回とも): 段階報告が 起動 → 0-保存先 → 1-証明書 まで
#   届き **2-資格情報 が来ない**。証明書は正常 (CN=Q05-0010・残り 833 日)。
#   停止点はこの節に限定される。接続チェック(probe)が毎回届いていたのは
#   **入力を一切求めないから**で、① を同じ形にすれば同じように届く。
#
#   → **Vercel env から実行時に取得する** (`/api/ops/demecal-cred`)。
#     認可は既に bat に埋まっている PROBE_UPLOAD_TOKEN。
#     **bat に平文で焼き込まない** — 焼き込むとデメカルのパスワードが
#     .bat のままダウンロードフォルダに残り続ける (Pマーク対応PC で避けたい)。
#     PC 上に残るのは DPAPI 暗号化された cred ファイルだけ。
#
# Export-CliXml は SecureString を DPAPI で暗号化する。
# **このユーザー・この PC でしか復号できない**ので、コピーしても他所では開けない。
# ② が再利用するのでここで必ず保存する。
$CredPath = Join-Path $SecretDir 'demecal.cred.xml'
Say '[2] デメカルのログイン情報を取得します...'

# ① はセットアップなので毎回入れ直す。前回の中断で壊れたファイルが残っていても
# 読まずに捨てる (読むと同じ場所でまた沈黙し得る)。
if (Test-Path $CredPath) {
  try { Remove-Item -Path $CredPath -Force -ErrorAction Stop } catch { }
}

$cred = $null
try {
  $c = Invoke-RestMethod -Uri ("{0}?k={1}" -f $CredUrl, $Token) -Method Get -TimeoutSec 30
  if ($c.ok -and $c.user -and $c.pass) {
    $cred = New-Object System.Management.Automation.PSCredential(
              $c.user, (ConvertTo-SecureString $c.pass -AsPlainText -Force))
    Say '    OK: 取得しました (この画面にもログにも値は出しません)'
  } else {
    # **値は絶対に出さない。** 何が未設定かだけサーバが detail で返す。
    Say ("    失敗: サーバ側の設定が未了です ({0})" -f $c.detail)
  }
} catch {
  Say ("    失敗: 取得できませんでした: {0}" -f $_.Exception.Message)
}
if (-not $cred) { Send-Now '2-資格情報(失敗)' | Out-Null; Finish 1 }

try {
  $cred | Export-Clixml $CredPath -ErrorAction Stop
  Say "    保存しました: $CredPath"
} catch {
  # 保存できなくても偵察は続ける (② が使い回せないだけで ① の目的は果たせる)。
  Say ("    保存できませんでした (偵察は続けます): {0}" -f $_.Exception.Message)
}
Say ''
Send-Now '2-資格情報' | Out-Null

# ── [3] ログイン ──────────────────────────────────────────────
# ASP.NET Core の antiforgery。GET で hidden トークンを取り、
# **同一セッション (Cookie) ＋ 同一証明書** で POST する。片方でも欠けると通らない。
Say '[3] ログインします...'
$session = $null
$loggedIn = $false
try {
  $g = Invoke-WebRequest -Uri $LoginUrl -Certificate $cert -SessionVariable session -UseBasicParsing -TimeoutSec 30
  $tok = ($g.InputFields | Where-Object { $_.name -eq '__RequestVerificationToken' } | Select-Object -First 1).value
  if (-not $tok) {
    if ($g.Content -match 'name="__RequestVerificationToken"\s+type="hidden"\s+value="([^"]+)"') { $tok = $Matches[1] }
    elseif ($g.Content -match '__RequestVerificationToken"[^>]*value="([^"]+)"') { $tok = $Matches[1] }
  }
  if (-not $tok) {
    Say '    失敗: ログイン画面に antiforgery トークンが見つかりません (画面が変わった可能性)。'
  } else {
    $body = @{
      UserID   = $cred.UserName
      Password = $cred.GetNetworkCredential().Password
      __RequestVerificationToken = $tok
    }
    $p = Invoke-WebRequest -Uri $LoginUrl -Method Post -Certificate $cert -WebSession $session `
           -Body $body -UseBasicParsing -TimeoutSec 30
    # 失敗しても 200 が返る作りなので、ステータスでは判定しない。
    # ログインフォームが消えたかで見る。
    if ($p.Content -notmatch 'name="Password"') {
      $loggedIn = $true
      Say '    OK: ログインできました。'
    } else {
      Say '    失敗: ID またはパスワードが違うようです (ログイン画面のままです)。'
      if ($p.Content -match '(?s)validation-summary[^>]*>(.*?)</div>') {
        $msg = ($Matches[1] -replace '<[^>]+>', ' ') -replace '\s+', ' '
        if ($msg.Trim()) { Say ("    メッセージ: {0}" -f $msg.Trim()) }
      }
    }
  }
} catch {
  Say ("    失敗: {0}" -f $_.Exception.Message)
}
Say ''
Send-Now '3-ログイン' | Out-Null

# ── [4] 偵察 ──────────────────────────────────────────────────
# **本文は出さない。** form のメタデータだけを抜く。
# 見つけた form を後段 [5] で実行するために保持する。
$script:Forms = New-Object System.Collections.Generic.List[object]

function Get-FormMeta([string]$html, [string]$pageUrl) {
  $out = New-Object System.Collections.Generic.List[string]
  $fms = [regex]::Matches($html, '(?is)<form\b(?<attr>[^>]*)>(?<body>.*?)</form>')
  if ($fms.Count -eq 0) { $out.Add('      (form なし)') | Out-Null; return $out }
  $i = 0
  foreach ($f in $fms) {
    $i++
    $attr = $f.Groups['attr'].Value
    $act = if ($attr -match 'action\s*=\s*"([^"]*)"') { $Matches[1] } else { '(なし)' }
    $mth = if ($attr -match 'method\s*=\s*"([^"]*)"') { $Matches[1] } else { 'get' }
    $out.Add("      form#${i}: method=$mth action=$act") | Out-Null
    $fields = @{}
    foreach ($m in [regex]::Matches($f.Groups['body'].Value, '(?is)<input\b[^>]*>')) {
      $t = $m.Value
      $n = if ($t -match 'name\s*=\s*"([^"]*)"') { $Matches[1] } else { '(name無)' }
      $ty = if ($t -match 'type\s*=\s*"([^"]*)"') { $Matches[1] } else { 'text' }
      $v = if ($t -match 'value\s*=\s*"([^"]*)"') { $Matches[1] } else { '' }
      if ($n -ne '(name無)') { $fields[$n] = $v }
      # **hidden の value は出さない** (トークン等が入るため)。存在だけ示す。
      $out.Add("        input  name=$n type=$ty") | Out-Null
    }
    foreach ($m in [regex]::Matches($f.Groups['body'].Value, '(?is)<select\b(?<a>[^>]*)>(?<b>.*?)</select>')) {
      $n = if ($m.Groups['a'].Value -match 'name\s*=\s*"([^"]*)"') { $Matches[1] } else { '(name無)' }
      $opts = @()
      foreach ($o in [regex]::Matches($m.Groups['b'].Value, '(?is)<option\b[^>]*value\s*=\s*"([^"]*)"[^>]*>(.*?)</option>')) {
        $label = ($o.Groups[2].Value -replace '<[^>]+>', '') -replace '\s+', ' '
        $opts += ('{0}={1}' -f $o.Groups[1].Value, $label.Trim())
      }
      $out.Add(("        select name=$n options=[{0}]" -f ($opts -join ' | '))) | Out-Null
    }
    foreach ($m in [regex]::Matches($f.Groups['body'].Value, '(?is)<button\b[^>]*>(.*?)</button>')) {
      $label = ($m.Groups[1].Value -replace '<[^>]+>', '') -replace '\s+', ' '
      $out.Add(("        button {0}" -f $label.Trim())) | Out-Null
    }
    $script:Forms.Add([pscustomobject]@{
      Page = $pageUrl; Action = $act; Method = $mth; Fields = $fields; Raw = $f.Value
    }) | Out-Null
  }
  return $out
}

Say '[4] CSV ダウンロード画面を探します...'
$visited = @{}
$targets = New-Object System.Collections.Generic.List[string]
if ($loggedIn) {
  try {
    $top = Invoke-WebRequest -Uri $BaseUrl -Certificate $cert -WebSession $session -UseBasicParsing -TimeoutSec 30
    # リンクの href とテキストを列挙 (PII は含まない=メニュー名のみ)
    Say '    メニューのリンク:'
    foreach ($m in [regex]::Matches($top.Content, '(?is)<a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>(.*?)</a>')) {
      $href = $m.Groups[1].Value
      $txt  = (($m.Groups[2].Value -replace '<[^>]+>', '') -replace '\s+', ' ').Trim()
      if (-not $href -or $href -match '^(#|javascript:)') { continue }
      if ($visited.ContainsKey($href)) { continue }
      $visited[$href] = $true
      Say ("      {0}  <- {1}" -f $href, $txt)
      if ($txt -match 'ダウンロード|結果|CSV' -or $href -match 'download|result|csv') { $targets.Add($href) | Out-Null }
    }
    if ($targets.Count -eq 0) {
      Say '    それらしいリンクが見つかりませんでした。上の一覧を担当者へお送りください。'
    }
    foreach ($t in $targets) {
      $u = if ($t -match '^https?://') { $t } else { "$BaseUrl/" + $t.TrimStart('/') }
      Say ''
      Say ("    ページ: {0}" -f $u)
      try {
        $pg = Invoke-WebRequest -Uri $u -Certificate $cert -WebSession $session -UseBasicParsing -TimeoutSec 30
        foreach ($l in (Get-FormMeta $pg.Content $u)) { Say $l }
        # このページからさらに辿れるリンク (汎用CSV の下位メニュー等)
        foreach ($m in [regex]::Matches($pg.Content, '(?is)<a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>(.*?)</a>')) {
          $href = $m.Groups[1].Value
          $txt  = (($m.Groups[2].Value -replace '<[^>]+>', '') -replace '\s+', ' ').Trim()
          if ($txt -match '汎用|CSV|結果') { Say ("      (下位リンク) {0}  <- {1}" -f $href, $txt) }
        }
      } catch {
        Say ("      取得できません: {0}" -f $_.Exception.Message)
      }
    }
  } catch {
    Say ("    失敗: {0}" -f $_.Exception.Message)
  }
} else {
  Say '    ログインできていないので飛ばします。'
}
Say ''
# **ここが本命。** form の action/name が取れていれば、以降で止まっても②が書ける。
Send-Now '4-form採取' | Out-Null

# ── [5] ドライラン ────────────────────────────────────────────
# **結果が出ないはずの過去日付**で叩き、応答の形だけを見る。
# 本物のデータは取らない (取れてもヘッダ行以外は捨てる)。
Say '[5] ためし取得 (過去日付・データは取りません)...'
# **[4] で見つけた form をその場で実行する。** ここまでやらないと「もう一度実行してください」に
# なってしまい、Wellfort への往復が減らない。安全のため:
#   ・**結果が出ないはずの過去日付**を入れる (2000 年)
#   ・**本文は保存も送信もしない**。記録するのは 状態/種別/ファイル名/ヘッダ行/行数 だけ
#   ・日付らしき欄を持つ form だけを対象にする (無関係な form を叩かない)
function Invoke-Recon([object]$form, [hashtable]$override) {
  $body = @{}
  foreach ($k in $form.Fields.Keys) { $body[$k] = $form.Fields[$k] }
  foreach ($k in $override.Keys) { $body[$k] = $override[$k] }
  $u = if ($form.Action -match '^https?://') { $form.Action }
       elseif ($form.Action -and $form.Action -ne '(なし)') { "$BaseUrl/" + $form.Action.TrimStart('/') }
       else { $form.Page }
  $mth = if ($form.Method -match '(?i)post') { 'Post' } else { 'Get' }
  return Invoke-WebRequest -Uri $u -Method $mth -Certificate $cert -WebSession $session `
           -Body $body -UseBasicParsing -TimeoutSec 60
}

if ($loggedIn -and $script:Forms.Count -gt 0) {
  # 日付欄を持つ form を探す (汎用CSVのダウンロード画面のはず)
  $cand = $script:Forms | Where-Object {
    ($_.Fields.Keys -join ' ') -match '(?i)date|ymd|from|to|開始|終了'
  } | Select-Object -First 1
  if (-not $cand) {
    Say '    日付欄のある form が見つかりませんでした。上の form 一覧を担当者へお送りください。'
  } else {
    Say ("    対象 form: {0} (action={1})" -f $cand.Page, $cand.Action)
    # 日付らしき欄に 2000 年を入れる (データが無い前提)
    $ov = @{}
    foreach ($k in $cand.Fields.Keys) {
      if ($k -match '(?i)from|start|開始') { $ov[$k] = '2000/01/01' }
      elseif ($k -match '(?i)to|end|終了') { $ov[$k] = '2000/01/02' }
    }
    Say ("    差し替えた欄: {0}" -f (($ov.Keys | Sort-Object) -join ', '))
    try {
      $r = Invoke-Recon $cand $ov
      $ct = $r.Headers['Content-Type']
      $cd = $r.Headers['Content-Disposition']
      Say ("    HTTP {0} / Content-Type: {1}" -f [int]$r.StatusCode, $ct)
      if ($cd) { Say ("    Content-Disposition: {0}" -f $cd) }
      if ($ct -match '(?i)text/html') {
        # 確認画面が挟まる作り (attended 手順の「確認 → ダウンロード」)。その form も記録する。
        Say '    → HTML が返りました (確認画面と思われます)。その form を記録します:'
        $before = $script:Forms.Count
        foreach ($l in (Get-FormMeta $r.Content ($cand.Page + ' [確認画面]'))) { Say $l }
        if ($script:Forms.Count -gt $before) {
          $conf = $script:Forms[$script:Forms.Count - 1]
          try {
            $r2 = Invoke-Recon $conf @{}
            $ct2 = $r2.Headers['Content-Type']
            Say ("    確認画面から実行: HTTP {0} / Content-Type: {1}" -f [int]$r2.StatusCode, $ct2)
            if ($r2.Headers['Content-Disposition']) { Say ("    Content-Disposition: {0}" -f $r2.Headers['Content-Disposition']) }
            $r = $r2
            $ct = $ct2
          } catch { Say ("    確認画面からの実行に失敗: {0}" -f $_.Exception.Message) }
        }
      }
      if ($ct -notmatch '(?i)text/html') {
        # CSV が返った。**ヘッダ行と行数だけ**を記録して本文は捨てる。
        $txt = ''
        try { $txt = [Text.Encoding]::GetEncoding('shift_jis').GetString($r.Content) } catch { $txt = '' }
        $rows = @($txt -split "`r?`n" | Where-Object { $_ -ne '' })
        Say ("    行数: {0} (ヘッダ含む)" -f $rows.Count)
        if ($rows.Count -gt 0) { Say ("    ヘッダ行: {0}" -f $rows[0]) }
        if ($rows.Count -gt 1) {
          Say '    ※ 過去日付なのにデータ行がありました。**本文は保存も送信もしていません。**'
        }
      }
    } catch {
      Say ("    失敗: {0}" -f $_.Exception.Message)
    }
  }
} else {
  Say '    飛ばしました (ログイン未成立、または form が見つかりません)。'
}
Say ''

# ── [6] 報告 ──────────────────────────────────────────────────
Say '=================================================='
if ($loggedIn) {
  Say ' 判定: ○ ログインまで到達しました'
} else {
  Say ' 判定: × ログインできませんでした'
}
Say '=================================================='
Say ''

Finish 0
