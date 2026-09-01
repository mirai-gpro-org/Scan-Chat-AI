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
$Token     = '__PROBE_TOKEN__'
$Version   = 'recon-1.3'

$lines = New-Object System.Collections.Generic.List[string]
function Say($t) { Write-Host $t; $lines.Add($t) | Out-Null }

# ── 報告 (どんな終わり方でも必ずここを通る) ─────────────────────
#
# 【経緯 2026-09-01】recon は v1.0・v1.1 とも実行の連絡を受けたのに実行ログに 0 件だった。
#   v1.1 を別 PC で実走させて **構文は正常・中止時の報告も届く**ことを実証済み。
#   それでも専用PCからは届かないので、**残る沈黙経路を全部塞ぐ**のが v1.3 の目的。
#     ① 想定外の terminating error で Finish に来ない  → trap で受ける
#     ② Get-Credential が例外を投げる                  → try/catch
#     ③ 送信が 1 回失敗しただけで諦める                → 3 回 + 別方式で再試行
#     ④ 送信が落ちても理由が残らない                   → 例外文を画面と報告に出す
#     ⑤ 保存先 C:\demecal\recon\ を見つけられない       → **デスクトップにも置く**
#        (接続チェックはデスクトップ出力で実際に回収できている。報告は PII 非含有)

# 送信は 2 方式・3 回まで試す。**「送れませんでした」で終わらせない。**
# 方式を 2 つ持つのは、cmdlet 固有の問題 (プロキシ・TLS・シリアライズ) を切り分けるため。
function Send-Report([string]$json) {
  $errs = New-Object System.Collections.Generic.List[string]
  for ($i = 1; $i -le 3; $i++) {
    try {
      Invoke-RestMethod -Uri $UploadUrl -Method Post -TimeoutSec 60 `
        -Body ([Text.Encoding]::UTF8.GetBytes($json)) `
        -ContentType 'application/json; charset=utf-8' `
        -Headers @{ 'x-probe-token' = $Token } | Out-Null
      return "ok (Invoke-RestMethod / {0} 回目)" -f $i
    } catch { $errs.Add(("IRM#{0}: {1}" -f $i, $_.Exception.Message)) | Out-Null }

    try {
      $req = [Net.HttpWebRequest]::Create($UploadUrl)
      $req.Method = 'POST'
      $req.ContentType = 'application/json; charset=utf-8'
      $req.Timeout = 60000
      $req.Headers.Add('x-probe-token', $Token)
      $b = [Text.Encoding]::UTF8.GetBytes($json)
      $req.ContentLength = $b.Length
      $st = $req.GetRequestStream(); $st.Write($b, 0, $b.Length); $st.Close()
      $res = $req.GetResponse(); $res.Close()
      return "ok (HttpWebRequest / {0} 回目)" -f $i
    } catch { $errs.Add(("HWR#{0}: {1}" -f $i, $_.Exception.Message)) | Out-Null }

    if ($i -lt 3) { Start-Sleep -Seconds 3 }
  }
  return "ng: " + ($errs -join ' | ')
}

function Finish($code) {
  $report = ($lines -join "`r`n")

  # 置き場は 2 つ。**デスクトップを必ず含める。**
  #   C:\demecal\recon\ は今回初めて使うフォルダで「どこ？」になりやすい。
  #   接続チェックはデスクトップに出していて実際に回収できている実績がある。
  #   報告に PII は入らない (ページ本文・hidden 値・CSV データ行を出さない設計)。
  $paths = New-Object System.Collections.Generic.List[string]
  $dirs  = New-Object System.Collections.Generic.List[string]
  if ($script:ReconDir -and (Test-Path $script:ReconDir)) { $dirs.Add($script:ReconDir) | Out-Null }
  try { $d = [Environment]::GetFolderPath('Desktop'); if ($d) { $dirs.Add($d) | Out-Null } } catch {}
  if ($dirs.Count -eq 0) { $dirs.Add($env:TEMP) | Out-Null }
  foreach ($d in $dirs) {
    try {
      $f = Join-Path $d 'demecal_recon_report.txt'
      Set-Content -Path $f -Value $report -Encoding UTF8
      $paths.Add($f) | Out-Null
    } catch { }
  }

  $sent = if ($Token -ne ('__PROBE' + '_TOKEN__')) {
    Write-Host ''
    Write-Host '結果を送信しています... (最大 3 回試します)'
    Send-Report (@{ report = $report; label = 'demecal-recon'; host = $env:COMPUTERNAME } | ConvertTo-Json -Compress)
  } else { 'ng: 自動送信が無効な版です' }

  Write-Host ''
  Write-Host '=================================================='
  if ($sent -like 'ok*') {
    Write-Host " 送信できました。 [$sent]"
    Write-Host ' 担当者側で確認できます。このまま閉じて構いません。'
  } else {
    # **失敗の理由を必ず残す。** 「送れませんでした」だけだと次に何を調べるか決められない。
    Write-Host ' 送信できませんでした。お手数ですが下のファイルをメールでお送りください。'
    Write-Host ''
    foreach ($f in $paths) { Write-Host "   $f" }
    Write-Host ''
    Write-Host ' --- 担当者向け (送信エラーの内容) ---'
    Write-Host " $sent"
  }
  Write-Host '=================================================='

  Read-Host "確認できたら Enter キーを押してください"
  exit $code
}

# 想定外の terminating error を受け止める。**ここが無いと Finish に来ないまま死ぬ。**
# [4] の form 解析・[5] のドライランは個別 try/catch を持つが、
# 「持たせ忘れた 1 箇所」で全部が沈黙するのは今回の件で懲りたので網を張る。
trap {
  Say ''
  Say ("予期しないエラーで中断しました: {0}" -f $_.Exception.Message)
  Say ("  発生位置: {0}" -f $_.InvocationInfo.PositionMessage)
  Finish 9
}

# ── 起動の合図 ────────────────────────────────────────────────
# **「走ったこと」だけを先に送る。**
#
# 【なぜ要るか — 実測 2026-09-01】recon は v1.0・v1.1 とも実行の連絡を受けたのに
#   実行ログAPI に 1 件も届かなかった。届かない理由が
#     ①そもそも起動していない ②起動したが途中で落ちた ③送信だけ失敗した
#   のどれなのかを区別できず、毎回 Wellfort に確認することになる。
#   → **最初に 1 回だけ合図を送る**ことで、少なくとも ① と ②③ を分ける。
#   これが届いて本報告が届かなければ「起動はした・途中で落ちた」と確定する。
#
# 失敗しても**絶対に止めない** (合図は診断用で、本処理の前提ではない)。
if ($Token -ne ('__PROBE' + '_TOKEN__')) {
  try {
    $hello = @{
      report = ("起動しました`r`n 版: {0}`r`n PC名: {1}`r`n 時刻: {2}" -f `
                $Version, $env:COMPUTERNAME, (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
      label  = 'demecal-recon-start'
      host   = $env:COMPUTERNAME
    } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri $UploadUrl -Method Post -TimeoutSec 30 `
      -Body ([Text.Encoding]::UTF8.GetBytes($hello)) `
      -ContentType 'application/json; charset=utf-8' -Headers @{ 'x-probe-token' = $Token } | Out-Null
  } catch {}
}

# ── [0] 保存先 ────────────────────────────────────────────────
# デスクトップは OneDrive 同期対象 (実測)。PII を含む CSV をそこへ置かないため、
# 本番と同じ C:\demecal\ を最初に確保しておく。
Say '[0] 保存先を用意します...'
$Root = 'C:\demecal'
try {
  if (-not (Test-Path $Root)) { New-Item -ItemType Directory -Path $Root -Force | Out-Null }
} catch {
  $Root = Join-Path $env:LOCALAPPDATA 'demecal'
  if (-not (Test-Path $Root)) { New-Item -ItemType Directory -Path $Root -Force | Out-Null }
}
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

# ── [2] 資格情報 ──────────────────────────────────────────────
# Export-CliXml は SecureString を DPAPI で暗号化する。
# **このユーザー・この PC でしか復号できない**ので、コピーしても他所では開けない。
$CredPath = Join-Path $SecretDir 'demecal.cred.xml'
Say '[2] デメカルのログイン情報'
if (Test-Path $CredPath) {
  Say '    保存済みのものを使います。(入れ直すときはこのファイルを削除して再実行)'
  Say "    $CredPath"
  $cred = Import-Clixml $CredPath
} else {
  Say '    初回のみ入力をお願いします。入力した内容は暗号化して保存され、'
  Say '    画面にもログにも残りません。'
  # ダイアログが出せない環境で例外になり得る。**投げっぱなしにしない。**
  $cred = $null
  try { $cred = Get-Credential -Message 'デメカル (dl.demecal.net) のユーザーID とパスワード' }
  catch { Say ("    入力画面を出せませんでした: {0}" -f $_.Exception.Message); Finish 1 }
  if (-not $cred) { Say '    入力がキャンセルされました。'; Finish 1 }
  $cred | Export-Clixml $CredPath
  Say "    保存しました: $CredPath"
}
Say ''

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
