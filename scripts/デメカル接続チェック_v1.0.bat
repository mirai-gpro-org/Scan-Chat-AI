@echo off
chcp 65001 >nul
title Demecal connection check
set "ERRLOG=%TEMP%\demecal_error.txt"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=Get-Content -LiteralPath '%~f0' -Encoding UTF8; Invoke-Expression (($s[11..($s.Count-1)]) -join [Environment]::NewLine)" 2> "%ERRLOG%"
echo.
echo ---- error log (empty is normal): %ERRLOG%
type "%ERRLOG%"
echo.
pause
exit /b
# =====================================================================
#  デメカル PowerShell 方式 実現性チェック
#  ---------------------------------------------------------------
#  目的 : ブラウザ自動化(PAD)を使わず PowerShell だけで
#         デメカルへ接続できるか(=クライアント証明書が使えるか)を判定する。
#
#  ★ このスクリプトは「見るだけ」です ★
#     ・ログインしません（ID・パスワードは一切使いません・聞きません）
#     ・CSV のダウンロードもしません
#     ・デメカル側のデータを変更する操作は一切ありません
#     ・個人情報は扱いません
#     ・結果（下記2ファイルと同じ内容）を Wellfort のサーバへ送信します
#       ※送信に失敗しても処理は続きます。ファイルは必ず手元に残ります
#
#  実行後、デスクトップに 2 つのファイルができます。これを送ってください。
#     demecal_probe_report.txt   … 判定結果
#     demecal_login_page.html    … ログイン画面の HTML（画面の作りを見るため）
#
#  正本: docs/lab/demecal_powershell_probe_guide.md
# =====================================================================

$ErrorActionPreference = 'Continue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$LoginUrl  = 'https://dl.demecal.net/account/login'
$Desktop   = [Environment]::GetFolderPath('Desktop')
$ReportPath = Join-Path $Desktop 'demecal_probe_report.txt'
$HtmlPath   = Join-Path $Desktop 'demecal_login_page.html'

# 配布ファイル名にも入る版番号 (`src/lib/probe-bat.ts` の readScriptVersion が読む)。
# **中身を直したら必ず上げる。** 上げないと Wellfort 側は同名のファイルを受け取り、
# 新旧どちらを実行したのか判別できなくなる (実測 2026-09-01)。
$Version   = 'probe-1.0'

$lines = New-Object System.Collections.ArrayList
function Say($m) { [void]$lines.Add($m); Write-Host $m }

Say "=================================================="
Say " デメカル PowerShell 接続チェック"
Say " 実行日時 : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Say " PC名     : $env:COMPUTERNAME"
Say " PSバージョン : $($PSVersionTable.PSVersion)"
Say " 版       : $Version"
Say "=================================================="

# ---------------------------------------------------------------
# [1] この PC に入っているクライアント証明書を調べる
# ---------------------------------------------------------------
Say ""
Say "[1] クライアント証明書を探しています..."
$found = @()
foreach ($store in 'Cert:\CurrentUser\My', 'Cert:\LocalMachine\My') {
  try {
    foreach ($c in (Get-ChildItem $store -ErrorAction Stop)) {
      $found += [pscustomobject]@{ Store = $store; Cert = $c }
    }
  } catch {
    Say "    $store は読み取れませんでした ($($_.Exception.Message))"
  }
}

if ($found.Count -eq 0) {
  Say "    見つかりません。"
  Say "    → この PC は専用PCではない可能性があります。専用PCで実行してください。"
} else {
  Say "    $($found.Count) 件見つかりました:"
  $n = 0
  foreach ($f in $found) {
    $n++
    Say ("      {0}. {1}" -f $n, $f.Cert.Subject)
    Say ("         発行者   : {0}" -f $f.Cert.Issuer)
    Say ("         有効期限 : {0}" -f $f.Cert.NotAfter.ToString('yyyy-MM-dd'))
    Say ("         秘密鍵   : {0}   置き場所: {1}" -f $f.Cert.HasPrivateKey, $f.Store)
  }
}

# ---------------------------------------------------------------
# [2] 証明書を付けずに接続してみる（比較用）
# ---------------------------------------------------------------
Say ""
Say "[2] 証明書なしで接続してみます..."
$plainRes = $null
try {
  $plainRes = Invoke-WebRequest -Uri $LoginUrl -UseBasicParsing -TimeoutSec 30
  Say "    到達しました (HTTP $($plainRes.StatusCode))"
} catch {
  Say "    到達できません — $($_.Exception.Message)"
}

# ---------------------------------------------------------------
# [3] 証明書を付けて接続してみる（本題）
# ---------------------------------------------------------------
Say ""
Say "[3] 証明書を付けて接続してみます（ここが本題）..."
$certRes = $null
$okCert  = $null
$withKey = @($found | Where-Object { $_.Cert.HasPrivateKey })
if ($withKey.Count -eq 0) {
  Say "    秘密鍵つきの証明書が無いため試せません。"
} else {
  foreach ($f in $withKey) {
    try {
      $r = Invoke-WebRequest -Uri $LoginUrl -Certificate $f.Cert -UseBasicParsing -TimeoutSec 30
      Say ("    成功 (HTTP {0})  ← {1}" -f $r.StatusCode, $f.Cert.Subject)
      if (-not $certRes) { $certRes = $r; $okCert = $f.Cert }
    } catch {
      Say ("    失敗 : {0}" -f $f.Cert.Subject)
      Say ("           {0}" -f $_.Exception.Message)
    }
  }
}

# ---------------------------------------------------------------
# [4] ログイン画面の作りを調べる（HTMLフォームか、JavaScript主体か）
# ---------------------------------------------------------------
Say ""
Say "[4] ログイン画面の作りを調べます..."
$page = if ($certRes) { $certRes } elseif ($plainRes) { $plainRes } else { $null }
if (-not $page) {
  Say "    ページを取得できなかったため判定できません。"
} else {
  $body = $page.Content
  try { $body | Out-File -FilePath $HtmlPath -Encoding UTF8; Say "    HTML を保存しました: $HtmlPath" } catch { Say "    HTML の保存に失敗: $($_.Exception.Message)" }
  $formCount   = ([regex]::Matches($body, '(?i)<form')).Count
  $inputCount  = ([regex]::Matches($body, '(?i)<input')).Count
  $scriptCount = ([regex]::Matches($body, '(?i)<script')).Count
  Say ("    <form> {0} 個 / <input> {1} 個 / <script> {2} 個 / 全体 {3} 文字" -f $formCount, $inputCount, $scriptCount, $body.Length)
  if ($formCount -ge 1 -and $inputCount -ge 2) {
    Say "    → 通常の HTML フォームに見えます（PowerShell 方式が使える見込みあり）"
  } else {
    Say "    → フォームが見当たりません（JavaScript 主体の可能性。PAD 方式が必要かも）"
  }
}

# ---------------------------------------------------------------
# 判定
# ---------------------------------------------------------------
Say ""
Say "=================================================="
if ($certRes)      { Say " 判定: ○ 証明書つきで接続できました" }
elseif ($plainRes) { Say " 判定: △ 接続はできましたが、証明書つきでは失敗しました" }
else               { Say " 判定: × 接続できませんでした" }
Say "=================================================="
Say ""
Say "このファイルと demecal_login_page.html を担当者へ送ってください。"
Say "（どちらにも ID・パスワード・個人情報は含まれていません）"


# ---------------------------------------------------------------
# [5] 結果を Wellfort のサーバへ送る（任意・失敗しても問題なし）
#     送るのは上のレポートとログイン画面のHTMLだけ。
#     ID・パスワード・受診者情報は含まれません。
# ---------------------------------------------------------------
$UploadUrl   = 'https://scan-chat-ai.vercel.app/api/ops/probe-upload'
$UploadToken = '__PROBE_TOKEN__'

if ($UploadToken -and $UploadToken -notmatch '^__') {
  Say ""
  Say "[5] 結果を送信しています..."
  try {
    $payload = @{
      label  = 'demecal-probe'
      host   = $env:COMPUTERNAME
      report = ($lines -join [Environment]::NewLine)
      page   = $(if ($page) { $page.Content } else { '' })
    } | ConvertTo-Json -Depth 3 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $res = Invoke-RestMethod -Uri $UploadUrl -Method Post -Body $bytes -TimeoutSec 60 `
             -ContentType 'application/json; charset=utf-8' `
             -Headers @{ 'x-probe-token' = $UploadToken }
    if ($res.ok) { Say "    送信しました（担当者側で確認できます）" }
    else         { Say "    送信できませんでした: $($res.error)" }
  } catch {
    Say "    送信できませんでした — $($_.Exception.Message)"
    Say "    （問題ありません。デスクトップのファイルをメールでお送りください）"
  }
} else {
  Say ""
  Say "[5] 自動送信は無効です。デスクトップのファイルをお送りください。"
}

try {
  $lines | Out-File -FilePath $ReportPath -Encoding UTF8
  Write-Host ""
  Write-Host "レポートを保存しました: $ReportPath" -ForegroundColor Green
} catch {
  Write-Host "レポートの保存に失敗しました: $($_.Exception.Message)" -ForegroundColor Red
}
Write-Host ""
