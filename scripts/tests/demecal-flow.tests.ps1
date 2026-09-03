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
#   `RawContentStream` から取ること自体は静的検査で固定する。
#
# 【verify-only の意味】
#   「一切書かない」ではなく **業務データの write を禁止する**。
#   非PII の診断 POST (`/api/admin/demecal-run`・失敗時のみ `/api/ops/probe-upload`) は
#   **在るべきもの**なので、消えていないことも検査する。

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
function Read-Html([string]$n) { return (Get-Content -Path (Join-Path $FixDir $n) -Raw -Encoding UTF8) }
# 期待状態で選ぶ (本番経路と同じ選び方)。
function Form-Exp([string]$html, [string]$expect) {
  $r = Select-ExpectedForm (Get-Forms $html) $expect
  if (-not $r.Ok) { return $null }
  return $r.Form
}
# 状態判定そのものを試す単体テスト用 (選び方を挟まない)。
function Form-Raw([string]$html) { return (Get-Forms $html)[0] }

Write-Host ''
Write-Host '── 状態判定 ────────────────────────────────────────'

$htmlBD = Read-Html 'state-b-decoy.html'
$htmlCH = Read-Html 'state-c-hidden-seller.html'

$fa = Form-Exp $htmlA 'A'
$fb = Form-Exp $htmlB 'B'
$fc = Form-Exp $htmlC 'C'

Check 'T01 state-a を A と判定' ((Get-StateOf $fa) -eq 'A') ("判定={0}" -f (Get-StateOf $fa))
Check 'T02 state-b を B と判定' ((Get-StateOf $fb) -eq 'B') ("判定={0}" -f (Get-StateOf $fb))
Check 'T03 state-c を C と判定 (URL が B と同じでも)' ((Get-StateOf $fc) -eq 'C') ("判定={0}" -f (Get-StateOf $fc))
# 想定外の画面は即 UNKNOWN (別の操作を試さない)
$htmlX = '<html><body><form method="post" action="/x"><input type="text" name="Keyword" value=""/><button type="submit">検索</button></form></body></html>'
Check 'T04 想定外の画面は UNKNOWN' ((Get-StateOf (Form-Raw $htmlX)) -eq 'UNKNOWN') ("判定={0}" -f (Get-StateOf (Form-Raw $htmlX)))
Check 'T05 ログアウト form を掴まない' ($fa.Action -eq '/hanyou/start') ("action={0}" -f $fa.Action)

# 【レビュー指摘 2026-09-02】確認画面が HanbaitenCode を hidden で持ち回り、
# 日付を持たない形。判定順が A 優先だと A と誤判定して 1 段目へ戻ろうとする。
$fch = Form-Raw $htmlCH
Check 'T05a HanbaitenCode hidden + ダウンロード + 日付なし を C と判定 (A に誤判定しない)' `
  ((Get-StateOf $fch) -eq 'C') ("判定={0}" -f (Get-StateOf $fch))
$rch = New-StateCRequest $fch
Check 'T05b その C からダウンロードへ進める' ($rch.Ok -and $rch.Body['submitType'] -eq 'download') ("code={0}" -f $rch.Code)

# 【レビュー指摘 2026-09-02】decoy (検索 form 11 項目) が対象 (9 項目) より多い。
$pickBD = Select-ExpectedForm (Get-Forms $htmlBD) 'B'
Check 'T05c decoy の方が項目数が多くても条件入力 form を選ぶ' `
  ($pickBD.Ok -and $pickBD.Form.Action -eq '/hanyou/entry') ("ok={0} action={1}" -f $pickBD.Ok, $pickBD.Form.Action)
$decoyOnly = @(Get-Forms $htmlBD | Where-Object { $_.Action -eq '/search' })
Check 'T05d decoy はそもそも項目数で勝っている (テストが意味を持つことの確認)' `
  ($decoyOnly.Count -eq 1 -and $decoyOnly[0].Fields.Count -gt $pickBD.Form.Fields.Count) `
  ("decoy={0} / 対象={1}" -f $decoyOnly[0].Fields.Count, $pickBD.Form.Fields.Count)

# 0 件・複数件は fail-closed (別の form を試して前進しない)
$noB = Select-ExpectedForm (Get-Forms $htmlA) 'B'
Check 'T05e 期待状態の form が 0 件なら FAIL' `
  ((-not $noB.Ok) -and $noB.Code -eq 'STATE_B_EXPECTATION_FAILED' -and $noB.Count -eq 0) ("code={0}" -f $noB.Code)
$twoC = Select-ExpectedForm (Get-Forms ($htmlC + $htmlCH)) 'C'
Check 'T05f 期待状態の form が複数件なら FAIL (どちらかを選ばない)' `
  ((-not $twoC.Ok) -and $twoC.Code -eq 'STATE_C_EXPECTATION_FAILED' -and $twoC.Count -eq 2) `
  ("code={0} count={1}" -f $twoC.Code, $twoC.Count)

Write-Host ''
Write-Host '── HTML 実体参照のデコード ─────────────────────────'

# 実 STATE A の DairitenName は **1 重** の実体参照 (`&#x682A;…`)。
# 1 回だけデコードすれば「株式会社」になる。2 回掛けても 1 重には戻らないので、
# ここで「1 回だけ」を固定できるのは値が一致することそのもの。
Check 'T06 1 重の実体参照が 1 回だけデコードされる' `
  ($fa.Fields['DairitenName'] -eq '株式会社') ("値={0}" -f $fa.Fields['DairitenName'])
Check 'T07 二重デコードしない (&amp;amp; → &amp;)' ((Html-Decode '&amp;amp;') -eq '&amp;') ("値={0}" -f (Html-Decode '&amp;amp;'))

Write-Host ''
Write-Host '── STATE A (実測構造・2026-09-03 Phase B) ──────────'

# fixture は実測どおり select/option/radio を 1 つも持たない。
$faTags = ([regex]::Matches($htmlA, '(?i)<select|<option|type="radio"')).Count
Check 'T08a fixture に select/option/radio が 0 個 (実測どおり)' ($faTags -eq 0) ("出現={0}" -f $faTags)
Check 'T08b それでも A と判定できる' ((Get-StateOf $fa) -eq 'A') ("判定={0}" -f (Get-StateOf $fa))
Check 'T08c HanbaitenCode / HanbaitenName は空の readonly text' `
  ($fa.Fields['HanbaitenCode'] -eq '' -and $fa.Fields['HanbaitenName'] -eq '' `
   -and $fa.Types['HanbaitenCode'] -eq 'text') ("type={0}" -f $fa.Types['HanbaitenCode'])
Check 'T08d button は 3 個 (dropdown / clear / submit)' (@($fa.Buttons).Count -eq 3) ("button={0}" -f @($fa.Buttons).Count)

$dealer = Test-DealerCode $fa
Check 'T08e 代理店が契約値と一致' ($dealer.Ok -and $dealer.DealerCode -eq 'Q05-0010') ("code={0}" -f $dealer.Code)

# ── 販売先一覧 (JSON) からの解決 ────────────────────────────
$hb = @((Read-Html 'hanbaiten.json') | ConvertFrom-Json)
$sel = Select-Hanbaiten $hb
Check 'T08f JSON から 000000 を正確に 1 件選ぶ' `
  ($sel.Ok -and $sel.SellerCode -eq '000000' -and $sel.Matched -eq 1) `
  ("ok={0} code={1} matched={2}" -f $sel.Ok, $sel.SellerCode, $sel.Matched)
# **name はコードに埋めない。** JSON が返した文字列がそのまま出ること。
$expectName = (@($hb | Where-Object { $_.code -eq '000000' })[0]).name
Check 'T08g name は JSON の値をそのまま使う (ハードコードしない)' `
  ($sel.SellerName -eq $expectName -and $sel.SellerName -ne '') ("name={0}" -f $sel.SellerName)

$ra = New-StateARequest $fa $sel.SellerCode $sel.SellerName
Check 'T08 A で販売先 000000 を body へ入れる' ($ra.Ok -and $ra.Body['HanbaitenCode'] -eq '000000') ("code={0}" -f $ra.Code)
Check 'T08h HanbaitenName も JSON 由来の値が入る' `
  ($ra.Ok -and $ra.Body['HanbaitenName'] -eq $expectName) ("name={0}" -f $ra.Body['HanbaitenName'])
Check 'T09 A の押し方 = 何も押さずそのまま送る (button 3 個でも)' `
  ($ra.Ok -and $ra.Press.Kind -eq 'plain') ("kind={0}" -f $ra.Press.Kind)
Check 'T10 A で送る body に押しボタン名が混ざらない' ($ra.Ok -and -not $ra.Body.ContainsKey('btnSubmit')) ''
Check 'T10a dropdown / クリアを絶対に押さない' `
  ($ra.Ok -and -not $ra.Body.ContainsKey('btnClearHanbaiten') `
   -and $ra.Press.Label -notmatch 'クリア|選択') ("label={0}" -f $ra.Press.Label)
$keys = (@($ra.Body.Keys) | Sort-Object) -join ','
Check 'T10b POST する field は実測の 7 つだけ' `
  ($keys -eq '__RequestVerificationToken,DairitenCode,DairitenName,HanbaitenCode,HanbaitenName,ID,OutputHeader') $keys

# ── 販売先解決の負のケース (すべて fail-closed) ─────────────
$r1 = Select-Hanbaiten @('[{"code":"111111","name":"架空サンプル商会"}]' | ConvertFrom-Json)
Check 'T11 000000 が無ければ FAIL (別の販売先を選ばない)' `
  ((-not $r1.Ok) -and $r1.Code -eq 'STATE_A_SELLER_000000_NOT_FOUND' -and $r1.SellerCode -eq '') ("code={0}" -f $r1.Code)

$r2 = Select-Hanbaiten @('[{"code":"000000","name":"架空A"},{"code":"000000","name":"架空B"}]' | ConvertFrom-Json)
Check 'T11a 000000 が重複していたら FAIL (どちらも選ばない)' `
  ((-not $r2.Ok) -and $r2.Matched -eq 2 -and $r2.SellerCode -eq '') ("matched={0}" -f $r2.Matched)

$r3 = Select-Hanbaiten @('[{"code":"000000","name":""}]' | ConvertFrom-Json)
Check 'T11b name が空なら FAIL' ((-not $r3.Ok) -and $r3.Code -eq 'STATE_A_SELLER_000000_NOT_FOUND') ("code={0}" -f $r3.Code)

$r3b = Select-Hanbaiten @('[{"code":"000000"}]' | ConvertFrom-Json)
Check 'T11c name が無ければ FAIL' (-not $r3b.Ok) ("ok={0}" -f $r3b.Ok)

$r4 = Select-Hanbaiten @()
Check 'T11d 空の一覧なら FAIL' ((-not $r4.Ok) -and $r4.Total -eq 0) ("total={0}" -f $r4.Total)

$malformedThrew = $false
try { $null = ('{"code":' | ConvertFrom-Json) } catch { $malformedThrew = $true }
Check 'T11e 壊れた JSON は解析時点で落ちる (取得側で fail-closed)' $malformedThrew ''

$r5 = Select-Hanbaiten @('[{"code":"0000001","name":"架空"},{"code":"00000","name":"架空"}]' | ConvertFrom-Json)
Check 'T11f 部分一致 (0000001 / 00000) を拾わない' ((-not $r5.Ok) -and $r5.Matched -eq 0) ("matched={0}" -f $r5.Matched)

$d3 = Test-DealerCode (Form-Raw ($htmlA -replace 'value="Q05-0010"', 'value="Q99-9999"'))
Check 'T12 代理店が契約値と違えば FAIL' `
  ((-not $d3.Ok) -and $d3.Code -eq 'STATE_A_EXPECTATION_FAILED') ("code={0}" -f $d3.Code)

# ── 「次へ」の plain 判定 ───────────────────────────────────
# onclick から submit() を消すと、何をするボタンか読めないので STOP (plain 扱いしない)。
$fa4 = Form-Raw ($htmlA.Replace('; submit();', ';'))
Check 'T12a 次へ の onclick から submit() を消すと押し方を特定できない' `
  ($null -eq (Resolve-Press $fa4 '次へ')) ("onclick={0}" -f $fa4.Buttons[2].Onclick)
$r6 = New-StateARequest $fa4 '000000' '架空テスト販売先'
Check 'T12b その改変で STATE A が FAIL する' `
  ((-not $r6.Ok) -and $r6.Code -eq 'STATE_A_EXPECTATION_FAILED') ("code={0}" -f $r6.Code)

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
$rb2 = New-StateBRequest (Form-Raw $htmlB2) $from $to
Check 'T17 「正常終了のみ」が無ければ FAIL' `
  ((-not $rb2.Ok) -and $rb2.Code -eq 'STATE_B_DATATYPE_NOT_FOUND') ("code={0}" -f $rb2.Code)

$htmlB3 = $htmlB -replace '<label for="OutputHeader2">出力する</label>', '<label for="OutputHeader2">なし</label>'
$rb3 = New-StateBRequest (Form-Raw $htmlB3) $from $to
Check 'T18 「出力する」が無ければ FAIL' `
  ((-not $rb3.Ok) -and $rb3.Code -eq 'STATE_B_OUTPUTHEADER_NOT_FOUND') ("code={0}" -f $rb3.Code)

# 押し方が読めない画面では**別の値を試さず**止まる (Unknown を埋めない)
$htmlB4 = $htmlB -replace 'onclick="submitType\.value=''confirm''; submit\(\);"', ''
$rb4 = New-StateBRequest (Form-Raw $htmlB4) $from $to
Check 'T19 確認の押し方が読めなければ STATE_B_CONFIRM_ACTION_UNKNOWN' `
  ((-not $rb4.Ok) -and $rb4.Code -eq 'STATE_B_CONFIRM_ACTION_UNKNOWN') ("code={0}" -f $rb4.Code)

Write-Host ''
Write-Host '── STATE C ─────────────────────────────────────────'

$rc = New-StateCRequest $fc
Check 'T20 C は「ダウンロード」だけを押す' `
  ($rc.Ok -and $rc.Body['submitType'] -eq 'download') ("submitType={0}" -f $rc.Body['submitType'])

$htmlC2 = $htmlC -replace 'onclick="submitType\.value=''download''; submit\(\);"', ''
$rc2 = New-StateCRequest (Form-Raw $htmlC2)
Check 'T21 ダウンロードの押し方が読めなければ STATE_C_DOWNLOAD_ACTION_UNKNOWN' `
  ((-not $rc2.Ok) -and $rc2.Code -eq 'STATE_C_DOWNLOAD_ACTION_UNKNOWN') ("code={0}" -f $rc2.Code)

# 「戻る」だけの画面で、戻るを押してしまわないこと
$htmlC3 = $htmlC -replace '(?s)<button id="btnDownload".*?</button>', ''
$rc3 = New-StateCRequest (Form-Raw $htmlC3)
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
Write-Host '── verify-only (業務データ write 禁止) の静的検査 ──'

# コメントを落としてから見る (コメントで語に触れるのは禁じない)。
$code = (($src -split "`r?`n") | ForEach-Object { $_ -replace '(^|\s)#.*$', '$1' }) -join "`n"

$banned = @(
  @{ t = 'elith-blood-csv';     why = '取り込み API (BloodTestData/S3 本番投入) を呼んではいけない' },
  @{ t = 'demecal-state';       why = 'last_to (業務の watermark) を読み書きしてはいけない' },
  @{ t = 'csvBase64';           why = 'CSV 本文を送ってはいけない' },
  @{ t = 'WriteAllBytes';       why = 'CSV をディスクへ保存してはいけない' },
  @{ t = 'Set-Content';         why = 'ファイルを作ってはいけない' },
  @{ t = 'Out-File';            why = 'ファイルを作ってはいけない' },
  @{ t = 'New-Item';            why = 'ファイル・フォルダを作ってはいけない' },
  @{ t = 'Remove-Item';         why = 'ファイルを消す処理を持たない' },
  @{ t = 'MaxHops';             why = '探索 (ホップ上限) を持たない' },
  @{ t = 'Find-ActionValues';   why = '外部 JS からの値の総当たりを持たない' },
  @{ t = 'Select-Form';         why = '項目数で form を選ぶヒューリスティックを持たない' }
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

# **禁止されているのは業務データの write。診断用の POST は在るべきもの** なので、
# 「消えていないこと」も固定する (静かに失敗が見えなくなるのを防ぐ)。
Check 'T38 非PII の実行ログ POST が残っている (/api/admin/demecal-run)' `
  ($code -match '/api/admin/demecal-run') ''
Check 'T39 骨格の回収口が残っている (/api/ops/probe-upload)' `
  ($code -match '/api/ops/probe-upload') ''

# probe-upload は**失敗時だけ**。Send-Skeleton の呼び出しは全て直後に Finish 1 が続く。
$sendLines = @([regex]::Matches($proc, '(?m)^\s*Send-Skeleton .*$'))
$procLines = $proc -split "`n"
$badSend = 0
foreach ($i in 0..($procLines.Count - 1)) {
  if ($procLines[$i] -notmatch '^\s*Send-Skeleton ') { continue }
  if ($i + 1 -ge $procLines.Count) { $badSend++; continue }
  if ($procLines[$i + 1] -notmatch '^\s*Finish 1 ') { $badSend++ }
}
Check 'T40 骨格の送信は失敗経路だけ (直後が必ず Finish 1)' `
  ($sendLines.Count -ge 1 -and $badSend -eq 0) ("Send-Skeleton={0} / 失敗経路でない={1}" -f $sendLines.Count, $badSend)

Write-Host ''
Write-Host ('=' * 52)
if ($script:Fail.Count -gt 0) {
  Write-Host ("✗ {0} 件 失敗 / {1} 件 成功" -f $script:Fail.Count, $script:Pass)
  foreach ($f in $script:Fail) { Write-Host ("  - {0}" -f $f) }
  exit 1
}
Write-Host ("✓ 全 {0} 件 PASS" -f $script:Pass)
exit 0
