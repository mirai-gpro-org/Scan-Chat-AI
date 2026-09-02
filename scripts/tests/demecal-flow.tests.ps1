# デメカル 3-state フローの fixture / negative テスト (Phase A)
#
# 正本: docs/lab/demecal_recovery_plan_20260902.md §5.2 A-7
# 実行: pwsh -NoProfile -File scripts/tests/demecal-flow.tests.ps1
#       (npm run verify:demecal-flow)
#
# 【なぜ PowerShell で書くか】
#   検査対象は**実際に配布される .ps1 そのもの**でなければ意味が無い。
#   同じロジックを TypeScript へ移植して検査しても、専用PC で動くコードは検査されない。
#   → `demecal-verify.ps1` を **-LibOnly で dot-source** し、関数を直接呼ぶ。
#
# 【ネットワークを踏んだら落とす】
#   dot-source の前に `Invoke-WebRequest` / `Invoke-RestMethod` を**必ず投げる関数**で
#   覆う。純粋関数のテスト中に 1 回でも通信しようとしたらその場で失敗する。
#
# 【Windows PowerShell 5.1 との差】
#   ここは pwsh 7 で走る。5.1 でしか出ない差 (`$r.Content` の型など) は
#   このテストでは踏めないので、**バイト列は byte[] を直接渡して**検査する。
#   `RawContentStream` から取ること自体は静的検査 (下記 T22) で固定する。

$ErrorActionPreference = 'Stop'

$Root       = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$ScriptPath = Join-Path $Root 'scripts/demecal-verify.ps1'
$FixDir     = Join-Path $PSScriptRoot 'fixtures/demecal'

$script:Pass = 0
$script:Fail = New-Object System.Collections.Generic.List[string]

function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { $script:Pass++; Write-Host ("  OK   {0}" -f $name) }
  else {
    $script:Fail.Add(("{0}{1}" -f $name, $(if ($detail) { " — $detail" } else { '' }))) | Out-Null
    Write-Host ("  NG   {0} — {1}" -f $name, $detail)
  }
}

# ── 通信を封じる ──────────────────────────────────────────────
function Invoke-WebRequest { throw 'テスト中に Invoke-WebRequest が呼ばれました (純粋関数が通信している)' }
function Invoke-RestMethod { throw 'テスト中に Invoke-RestMethod が呼ばれました (純粋関数が通信している)' }

if (-not (Test-Path $ScriptPath)) { Write-Error "対象が見つかりません: $ScriptPath"; exit 1 }
. $ScriptPath -LibOnly

$src   = Get-Content -Path $ScriptPath -Raw -Encoding UTF8
$htmlA = Get-Content -Path (Join-Path $FixDir 'state-a.html') -Raw -Encoding UTF8
$htmlB = Get-Content -Path (Join-Path $FixDir 'state-b.html') -Raw -Encoding UTF8
$htmlC = Get-Content -Path (Join-Path $FixDir 'state-c.html') -Raw -Encoding UTF8

function Read-Bytes([string]$n) { return [IO.File]::ReadAllBytes((Join-Path $FixDir $n)) }
function Form-Of([string]$html) { return (Select-Form (Get-Forms $html)) }

Write-Host ''
Write-Host '── 状態判定 ────────────────────────────────────────'

$fa = Form-Of $htmlA
$fb = Form-Of $htmlB
$fc = Form-Of $htmlC

Check 'T01 state-a を A と判定' ((Get-StateOf $fa) -eq 'A') ("判定={0}" -f (Get-StateOf $fa))
Check 'T02 state-b を B と判定' ((Get-StateOf $fb) -eq 'B') ("判定={0}" -f (Get-StateOf $fb))
Check 'T03 state-c を C と判定 (URL が B と同じでも)' ((Get-StateOf $fc) -eq 'C') ("判定={0}" -f (Get-StateOf $fc))
# 想定外の画面は即 UNKNOWN (別の操作を試さない)
$htmlX = '<html><body><form method="post" action="/x"><input type="text" name="Keyword" value=""/><button type="submit">検索</button></form></body></html>'
Check 'T04 想定外の画面は UNKNOWN' ((Get-StateOf (Form-Of $htmlX)) -eq 'UNKNOWN') ("判定={0}" -f (Get-StateOf (Form-Of $htmlX)))
Check 'T05 ログアウト form を掴まない' ($fa.Action -eq '/hanyou/start') ("action={0}" -f $fa.Action)

Write-Host ''
Write-Host '── HTML 実体参照のデコード ─────────────────────────'

Check 'T06 属性値は 1 回だけデコードされる' ($fa.Fields['DairitenName'] -eq '&#x682A;&#x5F0F;') ("値={0}" -f $fa.Fields['DairitenName'])
Check 'T07 二重デコードしない (&amp;amp; → &amp;)' ((Html-Decode '&amp;amp;') -eq '&amp;') ("値={0}" -f (Html-Decode '&amp;amp;'))

Write-Host ''
Write-Host '── STATE A ─────────────────────────────────────────'

$ra = New-StateARequest $fa
Check 'T08 A で販売先 000000 を選べる' ($ra.Ok -and $ra.Body['HanbaitenCode'] -eq '000000') ("code={0}" -f $ra.Code)
Check 'T09 A の押し方 = 何も押さずそのまま送る' ($ra.Ok -and $ra.Press.Kind -eq 'plain') ("kind={0}" -f $ra.Press.Kind)
Check 'T10 A で送る body に押しボタン名が混ざらない' ($ra.Ok -and -not $ra.Body.ContainsKey('btnSubmit')) ''

# 000000 が選択肢に無ければ FAIL (代替値を選ばない)
$htmlA2 = $htmlA -replace '<option value="000000">000000</option>', ''
$ra2 = New-StateARequest (Form-Of $htmlA2)
Check 'T11 000000 が無ければ FAIL (別の販売先を選ばない)' `
  ((-not $ra2.Ok) -and $ra2.Code -eq 'STATE_A_SELLER_000000_NOT_FOUND') ("code={0}" -f $ra2.Code)

$htmlA3 = $htmlA -replace 'value="Q05-0010"', 'value="Q99-9999"'
$ra3 = New-StateARequest (Form-Of $htmlA3)
Check 'T12 代理店が契約値と違えば FAIL' `
  ((-not $ra3.Ok) -and $ra3.Code -eq 'STATE_A_EXPECTATION_FAILED') ("code={0}" -f $ra3.Code)

Write-Host ''
Write-Host '── STATE B ─────────────────────────────────────────'

$from = [datetime]'2026-07-01'
$to   = [datetime]'2026-07-31'
$rb = New-StateBRequest $fb $from $to
Check 'T13 B で日付を yyyy/MM/dd で設定' `
  ($rb.Ok -and $rb.Body['DateFrom'] -eq '2026/07/01' -and $rb.Body['DateTo'] -eq '2026/07/31') `
  ("from={0} to={1}" -f $rb.Body['DateFrom'], $rb.Body['DateTo'])
Check 'T14 B で「正常終了のみ」を明示選択 (既定のままにしない)' `
  ($rb.Ok -and $rb.Body['DataType'] -eq '1') ("DataType={0}" -f $rb.Body['DataType'])
Check 'T15 B で「出力する」を明示選択 (既定は出力しない)' `
  ($rb.Ok -and $rb.Body['OutputHeader'] -eq 'True') ("OutputHeader={0}" -f $rb.Body['OutputHeader'])
Check 'T16 B は「確認」を押す。「戻る」を押さない' `
  ($rb.Ok -and $rb.Body['submitType'] -eq 'confirm') ("submitType={0}" -f $rb.Body['submitType'])

$htmlB2 = $htmlB -replace '<label for="DataType2">正常終了のみ</label>', '<label for="DataType2">エラーのみ</label>'
$rb2 = New-StateBRequest (Form-Of $htmlB2) $from $to
Check 'T17 「正常終了のみ」が無ければ FAIL' `
  ((-not $rb2.Ok) -and $rb2.Code -eq 'STATE_B_DATATYPE_NOT_FOUND') ("code={0}" -f $rb2.Code)

$htmlB3 = $htmlB -replace '<label for="OutputHeader2">出力する</label>', '<label for="OutputHeader2">なし</label>'
$rb3 = New-StateBRequest (Form-Of $htmlB3) $from $to
Check 'T18 「出力する」が無ければ FAIL' `
  ((-not $rb3.Ok) -and $rb3.Code -eq 'STATE_B_OUTPUTHEADER_NOT_FOUND') ("code={0}" -f $rb3.Code)

# 押し方が読めない画面では**別の値を試さず**止まる (Unknown を埋めない)
$htmlB4 = $htmlB -replace 'onclick="submitType\.value=''confirm''; submit\(\);"', ''
$rb4 = New-StateBRequest (Form-Of $htmlB4) $from $to
Check 'T19 確認の押し方が読めなければ STATE_B_CONFIRM_ACTION_UNKNOWN' `
  ((-not $rb4.Ok) -and $rb4.Code -eq 'STATE_B_CONFIRM_ACTION_UNKNOWN') ("code={0}" -f $rb4.Code)

Write-Host ''
Write-Host '── STATE C ─────────────────────────────────────────'

$rc = New-StateCRequest $fc
Check 'T20 C は「ダウンロード」だけを押す' `
  ($rc.Ok -and $rc.Body['submitType'] -eq 'download') ("submitType={0}" -f $rc.Body['submitType'])

$htmlC2 = $htmlC -replace 'onclick="submitType\.value=''download''; submit\(\);"', ''
$rc2 = New-StateCRequest (Form-Of $htmlC2)
Check 'T21 ダウンロードの押し方が読めなければ STATE_C_DOWNLOAD_ACTION_UNKNOWN' `
  ((-not $rc2.Ok) -and $rc2.Code -eq 'STATE_C_DOWNLOAD_ACTION_UNKNOWN') ("code={0}" -f $rc2.Code)

# 「戻る」だけの画面で、戻るを押してしまわないこと
$htmlC3 = $htmlC -replace '(?s)<button id="btnDownload".*?</button>', ''
$rc3 = New-StateCRequest (Form-Of $htmlC3)
Check 'T22 ダウンロードが無い画面で「戻る」を押さない' `
  ((-not $rc3.Ok) -and $rc3.Code -eq 'STATE_C_DOWNLOAD_ACTION_UNKNOWN') ("code={0}" -f $rc3.Code)

Write-Host ''
Write-Host '── CSV の判定 ──────────────────────────────────────'

$cd = 'attachment; filename="Q05-0010-000000result_20260701_2.csv"'
$b1 = Read-Bytes 'sample.csv'
$c1 = Test-CsvResponse $b1 'text/csv' $cd
Check 'T23 正しい CSV は PASS' ($c1.Ok) ("code={0} detail={1}" -f $c1.Code, $c1.Detail)
Check 'T24 行数はヘッダを除いた件数' ($c1.Rows -eq 2) ("rows={0}" -f $c1.Rows)
Check 'T25 バイト数を壊さない' ($c1.Bytes -eq $b1.Length) ("bytes={0} / 実際={1}" -f $c1.Bytes, $b1.Length)
$sha = ([BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash($b1)) -replace '-', '').ToLower()
Check 'T26 SHA-256 が一致' ($c1.Sha256 -eq $sha) ("sha={0}" -f $c1.Sha256)
Check 'T27 Shift_JIS の必須ヘッダを検出' ($c1.HeaderOk) ("missing={0}" -f ($c1.MissingHeaders -join ' '))

$c2 = Test-CsvResponse (Read-Bytes 'sample-noheader.csv') 'text/csv' $cd
Check 'T28 見出し行が無ければ CSV_HEADER_INVALID' `
  ((-not $c2.Ok) -and $c2.Code -eq 'CSV_HEADER_INVALID') ("code={0}" -f $c2.Code)

$c3 = Test-CsvResponse (Read-Bytes 'sample-empty.csv') 'text/csv' 'attachment; filename="Q05-0010-000000result_20260701_0.csv"'
Check 'T29 データ 0 件でヘッダが正しければ成功・rows=0' ($c3.Ok -and $c3.Rows -eq 0) ("ok={0} rows={1}" -f $c3.Ok, $c3.Rows)

$c4 = Test-CsvResponse ([Text.Encoding]::UTF8.GetBytes('<html>error</html>')) 'text/html; charset=utf-8' ''
Check 'T30 HTML が返ったら CSV_RESPONSE_INVALID' `
  ((-not $c4.Ok) -and $c4.Code -eq 'CSV_RESPONSE_INVALID') ("code={0}" -f $c4.Code)

$c5 = Test-CsvResponse (New-Object byte[] 0) 'text/csv' $cd
Check 'T31 空の応答は CSV_BYTES_INVALID' `
  ((-not $c5.Ok) -and $c5.Code -eq 'CSV_BYTES_INVALID') ("code={0}" -f $c5.Code)

$c6 = Test-CsvResponse $b1 'text/csv' 'attachment; filename="something_else.csv"'
Check 'T32 ファイル名が規則に合わなければ FAIL' `
  ((-not $c6.Ok) -and $c6.Code -eq 'CSV_RESPONSE_INVALID') ("code={0}" -f $c6.Code)

$c7 = Test-CsvResponse $b1 'application/octet-stream' ''
Check 'T33 content-disposition が無くても中身で判定できる' ($c7.Ok) ("code={0}" -f $c7.Code)

Write-Host ''
Write-Host '── verify-only であることの静的検査 ────────────────'

# コメントを落としてから見る (コメントで語に触れるのは禁じない)。
$code = (($src -split "`r?`n") | ForEach-Object { $_ -replace '(^|\s)#.*$', '$1' }) -join "`n"

$banned = @(
  @{ t = 'elith-blood-csv';     why = '取り込み API を呼んではいけない' },
  @{ t = 'demecal-state';       why = 'last_to を読み書きしてはいけない' },
  @{ t = 'csvBase64';           why = 'CSV 本文を送ってはいけない' },
  @{ t = 'WriteAllBytes';       why = 'CSV をディスクへ保存してはいけない' },
  @{ t = 'Set-Content';         why = 'ファイルを作ってはいけない' },
  @{ t = 'Out-File';            why = 'ファイルを作ってはいけない' },
  @{ t = 'New-Item';            why = 'ファイル・フォルダを作ってはいけない' },
  @{ t = 'Remove-Item';         why = 'ファイルを消す処理を持たない' },
  @{ t = 'MaxHops';             why = '探索 (ホップ上限) を持たない' },
  @{ t = 'Find-ActionValues';   why = '外部 JS からの値の総当たりを持たない' }
)
foreach ($b in $banned) {
  Check ("T34 禁止語なし: {0}" -f $b.t) ($code -notmatch [regex]::Escape($b.t)) $b.why
}

Check 'T35 CSV は RawContentStream から取る (5.1 の $r.Content は文字列)' `
  ($code -match 'RawContentStream') ''
Check 'T36 -LibOnly のガードが手続き部の前にある' `
  ($code -match '(?m)^if \(\$LibOnly\) \{ return \}') ''

# 手続き部 (ガードより後) に書き込み系が無いこと・段数が固定であること
$idx = $code.IndexOf('if ($LibOnly) { return }')
$proc = $code.Substring($idx)
$stepCount = @([regex]::Matches($proc, "Fail = 'STATE_")).Count
Check 'T37 段は 3 つ固定 (候補総当たり・ホップ反復が無い)' ($stepCount -eq 3) ("段の数={0}" -f $stepCount)

Write-Host ''
Write-Host ('=' * 52)
if ($script:Fail.Count -gt 0) {
  Write-Host ("✗ {0} 件 失敗 / {1} 件 成功" -f $script:Fail.Count, $script:Pass)
  foreach ($f in $script:Fail) { Write-Host ("  - {0}" -f $f) }
  exit 1
}
Write-Host ("✓ 全 {0} 件 PASS" -f $script:Pass)
exit 0
