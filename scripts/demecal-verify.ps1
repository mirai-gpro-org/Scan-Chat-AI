# デメカル 汎用CSV — **verify-only** の疎通確認 (Phase B 用)
#
# 正本: docs/lab/demecal_recovery_plan_20260902.md
#
# 【これは何か】
#   `STATE A → STATE B → STATE C → CSV` を**決定論**で 1 回だけ辿り、
#   契約どおりかを確かめて**報告するだけ**のスクリプト。
#
# 【daily-1.7 との違い — ここが立て直しの本体】
#   daily-1.7 は「押さない → 候補1 → 候補2 → 戻る/cancel → MaxHops まで反復」という
#   **汎用探索器**だった。業務サイトで総当たりするのは fail-closed ではないし、
#   泥沼化の主因でもあった (計画 §3)。**探索を全部やめる**:
#     ・段数は 3 で固定。ホップ上限も候補総当たりも無い
#     ・各段で**期待する状態かを機械判定**し、違えば**即 STOP** (別の操作を試さない)
#     ・「戻る」「cancel」は**押さない** (候補にすら入れない)
#     ・Unknown な操作値を外部 .js から探して総当たりしない
#
# 【verify-only — **業務データの write を禁止する**】(計画 §5.2 A-6 / §6.3)
#   「一切書かない」ではない。**業務データに触れないこと**が条件で、
#   非PII の診断用 POST は**むしろ必要**(黙って失敗する運用にしないため)。
#
#   **禁止 (業務データ)**
#     ・`/api/admin/elith-blood-csv` を呼ばない
#     ・BloodTestData / S3 への本番投入をしない
#     ・`/api/admin/demecal-state` (`last_to`) を読まない・更新しない
#     ・CSV をディスクへ保存しない (**ファイルを 1 つも作らない**)
#     ・CSV 本文をログにも probe にも送らない (メモリ内で捨てる)
#
#   **許可 (非PII の診断)**
#     ・`/api/admin/demecal-run` … 実行ログ。状態遷移 / HTTP / content-type /
#       content-disposition / ファイル名 / バイト数 / 行数 / SHA-256 /
#       必須ヘッダ検査の結果 だけを送る
#     ・`/api/ops/probe-upload` … **失敗したときだけ**画面の骨格 (タグと script)
#
#   **これは `scripts/tests/demecal-flow.tests.ps1` が静的検査で機械保証する**
#   (禁止語が無いこと ＋ 診断 POST が残っていること ＋ probe が失敗経路だけであること)。
#
# 【Unknown を推測で埋めない】(計画 §4.3)
#   押し方が確定できない画面では、別の値を試さずに
#   `STATE_B_CONFIRM_ACTION_UNKNOWN` / `STATE_C_DOWNLOAD_ACTION_UNKNOWN` で止まり、
#   画面の骨格 (タグと script のみ・本文テキストは載せない) を 1 回だけ持ち帰る。
#
# 【-LibOnly】関数だけ読み込んで何も実行しない (fixture テスト用)。

param([switch]$LibOnly)

$ErrorActionPreference = 'Continue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
# Shift_JIS は .NET Core で既定登録されていない。5.1 では型が無いので catch される。
try { [Text.Encoding]::RegisterProvider([Text.CodePagesEncodingProvider]::Instance) } catch {}

$Version    = 'verify-1.0'
$BaseUrl    = 'https://dl.demecal.net'
$LoginUrl   = "$BaseUrl/account/login"
$StartUrl   = "$BaseUrl/hanyou/start"
$ApiBase    = 'https://scan-chat-ai.vercel.app'
$IntakeKey  = '__LAB_INTAKE_KEY__'
$ProbeToken = '__PROBE_TOKEN__'

# ① (recon) が DPAPI で保存した場所。**Join-Path を使わない** —
# 手続き部より前で C: ドライブを触ると、Windows 以外では読み込み自体が落ちる
# (fixture テストが dot-source するため)。
$CredPath = 'C:\demecal\secrets\demecal.cred.xml'

# ── 業務値の明示契約 (計画 §5.2 A-2) ──────────────────────────
# **値は画面の option/radio から取得する。無ければ FAIL。代替値を選ばない。**
$ExpectedDealerCode = 'Q05-0010'
$ExpectedSellerCode = '000000'
$ExpectedDataType   = '正常終了のみ'
$ExpectedHeader     = '出力する'
$RequiredCsvHeaders = @('指図番号', '結果承認日', '結果項目数')

# verify-only なので `last_to` は読まない。固定幅で引く。
# `to` は**前日** — 動画の UI に「出力日より前を指定」の表示がある (計画 §8)。
# 正式な watermark の定義は Phase C で ChatGPT が統一する。
$VerifyRangeDays = 60

# ── ログ ──────────────────────────────────────────────────────
$script:StartedAt = (Get-Date).ToString('o')
$script:Stage     = 'start'
$script:Rows      = $null
$script:RangeFrom = $null
$script:RangeTo   = $null
$script:CertOn    = $null
$script:CertDays  = $null
$script:Diag      = New-Object System.Collections.Generic.List[string]

function Say($t) { Write-Host $t }
function Diag($t) { if ($script:Diag.Count -lt 70) { $script:Diag.Add($t) | Out-Null } }

# ── HTML 属性値のデコード (実障害 2026-09-02) ─────────────────
# 属性値は実体参照で書かれている。**デコードせずに送り返すと 1 POST ごとに
# 1 段ずつ多重エスケープされ**、サーバに 1 段目へ突き返される。
# ブラウザと同じ**1 回だけ**デコードする (2 回やると別の壊し方になる)。
function Html-Decode([string]$v) {
  if (-not $v) { return $v }
  try { return [System.Net.WebUtility]::HtmlDecode($v) } catch {}
  $v = $v -replace '&lt;', '<' -replace '&gt;', '>' -replace '&quot;', '"' -replace '&#39;', "'"
  return ($v -replace '&amp;', '&')
}

# ── HTML → form の構造 ────────────────────────────────────────
#
# 診断と契約判定のためだけに読む。**未知の状態から前進するためには使わない** (計画 §3)。
function Get-Forms([string]$html) {
  $out = @()
  if (-not $html) { return $out }
  foreach ($fm in [regex]::Matches($html, '(?is)<form\b[^>]*>.*?</form>')) {
    $f = $fm.Value
    $action = ''
    $ma = [regex]::Match($f, '(?i)action="([^"]*)"'); if ($ma.Success) { $action = Html-Decode $ma.Groups[1].Value }
    $method = 'get'
    $mm = [regex]::Match($f, '(?i)method="([^"]*)"'); if ($mm.Success) { $method = $mm.Groups[1].Value }

    $fields  = @{}   # 送る名前 → 値
    $types   = @{}   # 名前 → text/hidden/radio/checkbox/select/textarea
    $radios  = @()   # radio/checkbox の全選択肢 (既定でない側も持つ)
    $options = @{}   # select 名 → 選択肢
    $buttons = @()   # <button> と <input type=submit|image|button> の全部
    $shape   = @()   # 診断用の形 (値は入れない)

    foreach ($im in [regex]::Matches($f, '(?is)<input\b[^>]*>')) {
      $tag = $im.Value
      $t = [regex]::Match($tag, '(?i)type="([^"]*)"')
      $type = 'text'; if ($t.Success) { $type = $t.Groups[1].Value.ToLower() }
      $n = [regex]::Match($tag, '(?i)name="([^"]*)"')
      $v = [regex]::Match($tag, '(?i)value="([^"]*)"')
      $name = ''; if ($n.Success) { $name = $n.Groups[1].Value }
      $val  = ''; if ($v.Success) { $val = Html-Decode $v.Groups[1].Value }
      if ($type -eq 'reset') { continue }
      if ($type -match '^(submit|image|button)$') {
        $buttons += [pscustomobject]@{ Name = $name; Value = $val; Label = $val; Type = $type; Onclick = '' }
        $shape += ("      button(input) name={0} label={1}" -f $name, $val)
        continue
      }
      if (-not $n.Success) { continue }
      if ($type -match '^(radio|checkbox)$') {
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
        $checked = ($tag -match '(?i)\bchecked\b')
        $radios += [pscustomobject]@{ Name = $name; Value = $val; Label = $lbl; Checked = $checked }
        $mark = ''; if ($checked) { $mark = ' [既定]' }
        $shape += ("      {0} name={1} label={2}{3}" -f $type, $name, $lbl, $mark)
        $types[$name] = $type
        if (-not $checked) { continue }
        $fields[$name] = $val
        continue
      }
      $fields[$name] = $val
      $types[$name]  = $type
      $shape += ("      input  name={0} type={1}" -f $name, $type)
    }

    foreach ($sm in [regex]::Matches($f, '(?is)<select\b(?<a>[^>]*)>(?<b>.*?)</select>')) {
      $n = [regex]::Match($sm.Groups['a'].Value, '(?i)name="([^"]*)"')
      if (-not $n.Success) { continue }
      $name = $n.Groups[1].Value
      $opts = @()
      foreach ($o in [regex]::Matches($sm.Groups['b'].Value, '(?is)<option\b(?<oa>[^>]*)>')) {
        $ov = [regex]::Match($o.Groups['oa'].Value, '(?i)value="([^"]*)"')
        $oval = ''; if ($ov.Success) { $oval = Html-Decode $ov.Groups[1].Value }
        $opts += [pscustomobject]@{ Value = $oval; Sel = ($o.Groups['oa'].Value -match '(?i)\bselected\b') }
      }
      $options[$name] = $opts
      $pick = @($opts | Where-Object { $_.Sel })
      $use = ''
      if ($pick.Count -gt 0) { $use = $pick[0].Value } elseif ($opts.Count -gt 0) { $use = $opts[0].Value }
      $fields[$name] = $use
      $types[$name]  = 'select'
      # **選択肢の中身は診断に出さない** (販売先一覧が入り得る)。件数だけ。
      $shape += ("      select name={0} options={1}" -f $name, $opts.Count)
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
      $bt = [regex]::Match($attr, '(?i)type="([^"]*)"')
      $btype = 'submit'; if ($bt.Success) { $btype = $bt.Groups[1].Value.ToLower() }
      if ($btype -eq 'reset') { continue }
      $n = [regex]::Match($attr, '(?i)name="([^"]*)"')
      $v = [regex]::Match($attr, '(?i)value="([^"]*)"')
      $oc = [regex]::Match($attr, '(?i)onclick="([^"]*)"')
      $label = (($bm.Groups['b'].Value -replace '<[^>]+>', '') -replace '\s+', ' ').Trim()
      $bname = ''; if ($n.Success) { $bname = $n.Groups[1].Value }
      $bval  = ''; if ($v.Success) { $bval = Html-Decode $v.Groups[1].Value }
      $bonc  = ''; if ($oc.Success) { $bonc = Html-Decode $oc.Groups[1].Value }
      $buttons += [pscustomobject]@{ Name = $bname; Value = $bval; Label = $label; Type = $btype; Onclick = $bonc }
      $shape += ("      button name={0} type={1} label={2} onclick={3}" -f `
                 $bname, $btype, $label, ($bonc -replace '^(.{0,120}).*$', '$1'))
    }

    $out += [pscustomobject]@{
      Action = $action; Method = $method; Fields = $fields; Types = $types
      Radios = $radios; Options = $options; Buttons = $buttons; Shape = $shape
    }
  }
  return $out
}

# ── 状態判定 (計画 §5.2 A-1) ──────────────────────────────────
#
# **URL では判定しない。** STATE B と C は同じ URL (`/hanyou/entry`) になり得る
# (動画で実測)。field の集合と型で見る。
function Get-StateOf($form) {
  if (-not $form) { return 'NONE' }
  $names = @($form.Fields.Keys) + @($form.Radios | ForEach-Object { $_.Name })
  $has = { param($n) return (@($names | Where-Object { $_ -eq $n }).Count -gt 0) }

  $hasDates  = ((& $has 'DateFrom') -and (& $has 'DateTo'))
  $hasSeller = (& $has 'HanbaitenCode')
  # 条件入力は **DataType が radio で在る**ことで確定する
  # (確認画面が同じ名前を hidden で持ち回る可能性があるため、名前だけでは足りない)。
  $dataTypeRadio = (@($form.Radios | Where-Object { $_.Name -eq 'DataType' }).Count -gt 0)

  $hasDownload = (@($form.Buttons | Where-Object { $_.Label -match 'ダウンロード' }).Count -gt 0)

  # **判定順は B → C → A。** A を先に見ると、確認画面が `HanbaitenCode` を
  # hidden で持ち回り かつ 日付を持たない形のときに **C を A と誤判定**して
  # 1 段目へ戻ろうとする (レビュー指摘 2026-09-02)。
  # 「ダウンロードの押しどころが在る」は C にしか無い特徴なので、A より先に見る。
  if ($hasDates -and $dataTypeRadio) { return 'B' }
  if ($hasDownload) { return 'C' }
  if ((-not $hasDates) -and $hasSeller) { return 'A' }
  return 'UNKNOWN'
}

# 期待する状態の form を選ぶ。**「項目数が多いものを採る」は廃止した** —
# 検索窓のような decoy が対象より項目を多く持てば、そちらを掴んでしまう
# (レビュー指摘 2026-09-02)。
#
# **全 form を判定し、期待状態に一致するものが「ちょうど 1 件」のときだけ採る。**
# 0 件でも複数件でも fail-closed (別の form を試して前進しない)。
function Select-ExpectedForm($forms, [string]$expect) {
  $all  = @($forms)
  $hits = @($all | Where-Object { (Get-StateOf $_) -eq $expect })
  $code = ("STATE_{0}_EXPECTATION_FAILED" -f $expect)
  if ($hits.Count -eq 1) {
    return [pscustomobject]@{ Ok = $true; Form = $hits[0]; Count = 1; Code = ''; Detail = '' }
  }
  if ($hits.Count -eq 0) {
    $seen = ((@($all | ForEach-Object { Get-StateOf $_ })) -join ',')
    return [pscustomobject]@{
      Ok = $false; Form = $null; Count = 0; Code = $code
      Detail = ("期待した状態 {0} の form がありません (form {1}個 / 判定=[{2}])" -f $expect, $all.Count, $seen)
    }
  }
  return [pscustomobject]@{
    Ok = $false; Form = $null; Count = $hits.Count; Code = $code
    Detail = ("期待した状態 {0} の form が {1} 件あり 1 つに絞れません" -f $expect, $hits.Count)
  }
}

# ── 押し方の決定 ──────────────────────────────────────────────
#
# **候補を並べて総当たりしない。** 押すべきボタンを見出しで 1 つに決め、
# そのボタン自身の `onclick` だけを読む (外部 .js は見ない)。
# 決まらなければ `$null` を返し、呼び出し側が STOP する。
function Resolve-Press($form, [string]$labelPattern) {
  $hit = @($form.Buttons | Where-Object { $_.Label -match $labelPattern })
  if ($hit.Count -eq 1) {
    $b = $hit[0]
    # ① name を持つ submit ボタン = ブラウザは「押した 1 個」を送る。
    if ($b.Name -and $b.Type -eq 'submit') {
      return [pscustomobject]@{ Kind = 'named'; Name = $b.Name; Value = $b.Value; Label = $b.Label }
    }
    # ② そのボタンの onclick が hidden に値を入れる型。**そのボタンの属性だけ**を読む。
    if ($b.Onclick) {
      $found = @()
      foreach ($m in [regex]::Matches($b.Onclick, '(?i)([A-Za-z_][\w]*)["\x27\]]{0,3}\s*\)?\s*\.\s*(?:value|val)\s*(?:=|\(\s*)\s*["\x27]([^"\x27]{1,40})["\x27]')) {
        $fn = $m.Groups[1].Value
        if ($fn -match '(?i)token|verification') { continue }
        if (-not $form.Types.ContainsKey($fn)) { continue }
        if ($form.Types[$fn] -ne 'hidden') { continue }
        $found += [pscustomobject]@{ Name = $fn; Value = $m.Groups[2].Value }
      }
      # **1 つに決まるときだけ採る。** 複数なら不明として止める (推測しない)。
      if ($found.Count -eq 1) {
        return [pscustomobject]@{ Kind = 'hidden'; Name = $found[0].Name; Value = $found[0].Value; Label = $b.Label }
      }
      if ($found.Count -gt 1) { return $null }
    }
    # ③ 見出しが一致する押しどころが 1 つだけで、値を入れる先も無い
    #    = ブラウザは form をそのまま送る (実測: /hanyou/start の btnSubmit)。
    if (@($form.Buttons).Count -eq 1) {
      return [pscustomobject]@{ Kind = 'plain'; Name = ''; Value = ''; Label = $b.Label }
    }
    return $null
  }
  # **見出しで 1 つに絞れなければ、そこで止める。**
  # 「押しどころが 1 つしか無いならそれを押す」という逃げ道は作らない —
  # 「ダウンロード」が消えて「戻る」だけが残った画面で、戻るを押してしまう
  # (fixture テスト T22 で実際に踏んだ)。
  return $null
}

# 送信 body を作る (form の現在値をそのまま引き継ぐ)。
function New-BaseBody($form) {
  $body = @{}
  foreach ($k in $form.Fields.Keys) { $body[$k] = $form.Fields[$k] }
  return $body
}

function New-Fail([string]$code, [string]$detail) {
  return [pscustomobject]@{ Ok = $false; Code = $code; Detail = $detail; Body = $null; Press = $null }
}

# ── STATE A: 販売先を明示選択して「次へ」 ─────────────────────
function New-StateARequest($form) {
  $body = New-BaseBody $form

  # 代理店の確認 (**契約値と違えば止める** = 別アカウントで走っている)。
  if (-not $form.Fields.ContainsKey('DairitenCode')) {
    return (New-Fail 'STATE_A_EXPECTATION_FAILED' 'DairitenCode がありません')
  }
  if ($form.Fields['DairitenCode'] -ne $ExpectedDealerCode) {
    return (New-Fail 'STATE_A_EXPECTATION_FAILED' ("代理店が契約値と違います (期待 {0})" -f $ExpectedDealerCode))
  }

  # 販売先 000000 を**画面の選択肢から**選ぶ。無ければ FAIL (代替値を選ばない)。
  $sellerOk = $false
  if ($form.Options.ContainsKey('HanbaitenCode')) {
    if (@($form.Options['HanbaitenCode'] | Where-Object { $_.Value -eq $ExpectedSellerCode }).Count -gt 0) {
      $body['HanbaitenCode'] = $ExpectedSellerCode
      $sellerOk = $true
    }
  }
  if (-not $sellerOk) {
    if (@($form.Radios | Where-Object { $_.Name -eq 'HanbaitenCode' -and $_.Value -eq $ExpectedSellerCode }).Count -gt 0) {
      $body['HanbaitenCode'] = $ExpectedSellerCode
      $sellerOk = $true
    }
  }
  # 既にその値が入っているなら選び直す必要が無い (新しい値を作っていない)。
  if (-not $sellerOk -and $form.Fields.ContainsKey('HanbaitenCode') -and $form.Fields['HanbaitenCode'] -eq $ExpectedSellerCode) {
    $sellerOk = $true
  }
  if (-not $sellerOk) {
    return (New-Fail 'STATE_A_SELLER_000000_NOT_FOUND' ("販売先 {0} が選択肢にありません" -f $ExpectedSellerCode))
  }

  $press = Resolve-Press $form '次へ'
  if (-not $press) { return (New-Fail 'STATE_A_EXPECTATION_FAILED' '「次へ」の押し方を特定できません') }
  if ($press.Kind -eq 'named' -or $press.Kind -eq 'hidden') { $body[$press.Name] = $press.Value }
  return [pscustomobject]@{ Ok = $true; Code = ''; Detail = ''; Body = $body; Press = $press }
}

# ── STATE B: 日付・検査結果・項目見出しを明示して「確認」 ─────
function New-StateBRequest($form, [datetime]$from, [datetime]$to) {
  $body = New-BaseBody $form
  $body['DateFrom'] = $from.ToString('yyyy/MM/dd')
  $body['DateTo']   = $to.ToString('yyyy/MM/dd')

  # **「現在 checked だからそのまま」は不可** (計画 §2 STATE B)。ラベルから値を取る。
  $dt = @($form.Radios | Where-Object { $_.Name -eq 'DataType' -and $_.Label -match $ExpectedDataType })
  if ($dt.Count -eq 0) {
    return (New-Fail 'STATE_B_DATATYPE_NOT_FOUND' ("検査結果『{0}』の選択肢がありません" -f $ExpectedDataType))
  }
  $body['DataType'] = $dt[0].Value

  $oh = @($form.Radios | Where-Object { $_.Name -eq 'OutputHeader' -and $_.Label -match $ExpectedHeader })
  if ($oh.Count -eq 0) {
    return (New-Fail 'STATE_B_OUTPUTHEADER_NOT_FOUND' ("項目見出し『{0}』の選択肢がありません" -f $ExpectedHeader))
  }
  $body['OutputHeader'] = $oh[0].Value

  $press = Resolve-Press $form '確認'
  if (-not $press) { return (New-Fail 'STATE_B_CONFIRM_ACTION_UNKNOWN' '「確認」の押し方を特定できません') }
  if ($press.Kind -eq 'named' -or $press.Kind -eq 'hidden') { $body[$press.Name] = $press.Value }
  return [pscustomobject]@{ Ok = $true; Code = ''; Detail = ''; Body = $body; Press = $press }
}

# ── STATE C: 「ダウンロード」だけ ─────────────────────────────
function New-StateCRequest($form) {
  $body = New-BaseBody $form
  $press = Resolve-Press $form 'ダウンロード'
  if (-not $press) { return (New-Fail 'STATE_C_DOWNLOAD_ACTION_UNKNOWN' '「ダウンロード」の押し方を特定できません') }
  if ($press.Kind -eq 'named' -or $press.Kind -eq 'hidden') { $body[$press.Name] = $press.Value }
  return [pscustomobject]@{ Ok = $true; Code = ''; Detail = ''; Body = $body; Press = $press }
}

# ── CSV の厳格判定 (計画 §5.2 A-4 / A-5) ──────────────────────
#
# 「text/html でないから CSV」では成功にしない。
# バイト列は **`RawContentStream` から取る** — Windows PowerShell 5.1 の
# `$r.Content` は文字列で、byte[] として扱うと壊れる。
function Test-CsvResponse([byte[]]$bytes, [string]$contentType, [string]$disposition) {
  $res = [pscustomobject]@{
    Ok = $false; Code = ''; Detail = ''
    ContentType = $contentType; Disposition = $disposition
    Filename = ''; FilenameOk = $false
    Bytes = 0; Rows = $null; Sha256 = ''; HeaderOk = $false; MissingHeaders = @()
  }

  $isAttachment = ($disposition -match '(?i)attachment')
  if (($contentType -match '(?i)text/html') -and (-not $isAttachment)) {
    $res.Code = 'CSV_RESPONSE_INVALID'; $res.Detail = 'HTML が返りました'; return $res
  }
  if (-not $bytes -or $bytes.Length -eq 0) {
    $res.Code = 'CSV_BYTES_INVALID'; $res.Detail = '応答が空です'; return $res
  }
  $res.Bytes = $bytes.Length

  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    $res.Sha256 = ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLower()
  } catch {}

  $m = [regex]::Match($disposition, '(?i)filename\*?=(?:UTF-8''''|)"?([^";]+)"?')
  if ($m.Success) {
    $res.Filename = $m.Groups[1].Value.Trim()
    # 実測例: Q05-0010-000000result_20260701_18.csv
    $pat = ('^' + [regex]::Escape($ExpectedDealerCode) + '-' + [regex]::Escape($ExpectedSellerCode) + 'result_\d{8}_\d+\.csv$')
    $res.FilenameOk = ($res.Filename -match $pat)
    if (-not $res.FilenameOk) {
      $res.Code = 'CSV_RESPONSE_INVALID'; $res.Detail = ('ファイル名が規則に合いません: {0}' -f $res.Filename); return $res
    }
  }

  $txt = $null
  try { $txt = [Text.Encoding]::GetEncoding('shift_jis').GetString($bytes) } catch {}
  if (-not $txt) {
    $res.Code = 'CSV_BYTES_INVALID'; $res.Detail = 'Shift_JIS として読めません'; return $res
  }

  $lines = @($txt -split "`r?`n" | Where-Object { $_ -ne '' })
  if ($lines.Count -eq 0) {
    $res.Code = 'CSV_HEADER_INVALID'; $res.Detail = '行がありません'; return $res
  }
  $header = $lines[0]
  $missing = @()
  foreach ($h in $RequiredCsvHeaders) { if ($header -notmatch [regex]::Escape($h)) { $missing += $h } }
  $res.MissingHeaders = $missing
  if ($missing.Count -gt 0) {
    $res.Code = 'CSV_HEADER_INVALID'
    $res.Detail = ('必須ヘッダが足りません: {0}' -f ($missing -join ' '))
    return $res
  }
  $res.HeaderOk = $true
  # **データ 0 件は正常** (計画 §7 C-4)。ヘッダが正しければ ok。
  $res.Rows = $lines.Count - 1
  $res.Ok = $true
  return $res
}

# ── 骨格の回収 (失敗したときだけ・本文テキストは載せない) ─────
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
    Invoke-RestMethod -Uri "$ApiBase/api/ops/probe-upload" -Method Post -TimeoutSec 30 `
      -Body ([Text.Encoding]::UTF8.GetBytes($payload)) `
      -ContentType 'application/json; charset=utf-8' `
      -Headers @{ 'x-probe-token' = $ProbeToken } | Out-Null
    Say '    ※ 解析用に画面の骨格 (タグと script のみ) を送信しました'
  } catch {}
}

# ── 実行ログ (verify-only でも必ず 1 回送る) ──────────────────
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

function Finish([int]$code, [string]$result, [string]$errCode, [string]$detail) {
  $err = $errCode
  if ($detail) { $err = ("{0}: {1}" -f $errCode, $detail) }
  if ($err) { Say ("失敗コード: {0}" -f $err) }
  $sent = Report-Run $result $err
  Say ''
  Say '=================================================='
  if ($result -eq 'ok') { Say ' 結果: ○ 3 状態を辿り CSV の検査まで通りました' }
  else { Say ' 結果: × 期待した状態と違いました (業務データは書いていません)' }
  Say ' ※ これは疎通確認です。取り込みも last_to の更新もしていません。'
  if (-not $sent) { Say ' ※ 実行ログをサーバへ送れませんでした' }
  Say '=================================================='
  exit $code
}

# ── ここから下は手続き部。-LibOnly なら実行しない ─────────────
if ($LibOnly) { return }

Say '=================================================='
Say ' デメカル 汎用CSV 疎通確認 (verify-only)'
Say (" 実行日時 : {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Say (" PC名     : {0} / ログオン : {1}" -f $env:COMPUTERNAME, $env:USERNAME)
Say (" 版       : {0}" -f $Version)
Say ' 書き込み : 業務データには書きません (取り込み・last_to・ファイル保存は無し)'
Say '=================================================='

# [1] 証明書
$script:Stage = 'cert'
$cert = $null
try {
  $cands = @(Get-ChildItem 'Cert:\CurrentUser\My' -ErrorAction Stop |
             Where-Object { $_.Issuer -match 'demecal\.net CA' -and $_.HasPrivateKey })
  if ($cands.Count -gt 0) { $cert = $cands[0] }
} catch {}
if (-not $cert) { Finish 1 'fail' 'CERT_NOT_FOUND' '証明書が見つかりません (ログオンユーザーが違う可能性)' }
$script:CertOn   = $cert.NotAfter.ToString('yyyy-MM-dd')
$script:CertDays = [int]($cert.NotAfter - (Get-Date)).TotalDays
Say ("[1] 証明書 OK (期限 {0} / 残り {1} 日)" -f $script:CertOn, $script:CertDays)

# [2] 資格情報 (① が DPAPI で保存したもの)
$script:Stage = 'cred'
if (-not (Test-Path $CredPath)) { Finish 1 'fail' 'CRED_NOT_FOUND' "資格情報がありません ($CredPath)。① を先に実行してください" }
$cred = $null
try { $cred = Import-Clixml -Path $CredPath -ErrorAction Stop } catch {}
if (-not $cred) { Finish 1 'fail' 'CRED_NOT_FOUND' '資格情報を復号できません (別ユーザー/別PCで保存された可能性)' }
Say '[2] 資格情報 OK'

# [3] ログイン (GET でトークン → 同一セッションで POST)
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
  # 失敗しても 200 が返る作り。フォームが消えたかで判定する。
  if ($p.Content -match 'name="Password"') { Finish 1 'fail' 'LOGIN_FAILED' 'ログインできませんでした (ID/PW を確認)' }
} catch { Finish 1 'fail' 'LOGIN_FAILED' $_.Exception.Message }
Say '[3] ログイン OK'

# [4] 取得範囲 (verify-only なので last_to は読まない)
$to   = (Get-Date).Date.AddDays(-1)
$from = $to.AddDays(-$VerifyRangeDays)
$script:RangeFrom = $from.ToString('yyyy-MM-dd')
$script:RangeTo   = $to.ToString('yyyy-MM-dd')
Say ("[4] 取得範囲 {0} 〜 {1} (結果承認日・last_to は触っていません)" -f $script:RangeFrom, $script:RangeTo)

# [5] STATE A → B → C → CSV。**段数は 3 で固定。探索しない。**
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

  foreach ($st in $steps) {
    $script:Stage = $st.Stage
    $forms = Get-Forms $pageHtml
    $seen = ((@($forms | ForEach-Object { Get-StateOf $_ })) -join ',')
    Diag ("  [{0}] form {1}個 / 判定=[{2}] (期待={3})" -f $st.Stage, @($forms).Count, $seen, $st.Expect)

    # **期待状態の form がちょうど 1 件のときだけ進む** (項目数で選ばない)。
    $pick = Select-ExpectedForm $forms $st.Expect
    if (-not $pick.Ok) {
      Send-Skeleton $pageHtml ("{0}: {1}" -f $st.Stage, $pick.Detail)
      Finish 1 'fail' $pick.Code $pick.Detail
    }
    $cur = $pick.Form
    foreach ($s in $cur.Shape) { Diag $s }

    $req = $null
    if ($st.Expect -eq 'A') { $req = New-StateARequest $cur }
    elseif ($st.Expect -eq 'B') { $req = New-StateBRequest $cur $from $to }
    else { $req = New-StateCRequest $cur }

    if (-not $req.Ok) {
      Send-Skeleton $pageHtml ("{0} で契約を満たせない" -f $st.Stage)
      Finish 1 'fail' $req.Code $req.Detail
    }
    Diag ("      押す = {0} {1}" -f $req.Press.Kind, $req.Press.Label)

    $u = $cur.Action
    if ($u -notmatch '^https?://') { $u = "$BaseUrl/" + $u.TrimStart('/') }
    $mth = 'Get'; if ($cur.Method -match '(?i)post') { $mth = 'Post' }
    $r = Invoke-WebRequest -Uri $u -Method $mth -Certificate $cert -WebSession $session `
           -Body $req.Body -UseBasicParsing -TimeoutSec 120
    $respCt = [string]$r.Headers['Content-Type']
    $respCd = [string]$r.Headers['Content-Disposition']
    Say ("    [{0}] {1} → HTTP {2} / {3}" -f $st.Stage, $u, [int]$r.StatusCode, $respCt)
    Diag ("      → HTTP {0} / ct={1} / cd={2}" -f [int]$r.StatusCode, $respCt, ($respCd -replace '^(.{0,80}).*$', '$1'))

    if ($st.Expect -eq 'C') {
      # **バイト列は RawContentStream から取る** (5.1 の $r.Content は文字列)。
      try { if ($r.RawContentStream) { $csvBytes = $r.RawContentStream.ToArray() } } catch {}
      break
    }
    $pageHtml = [string]$r.Content
  }
} catch { Finish 1 'fail' 'STATE_TRANSITION_ERROR' $_.Exception.Message }

# [6] CSV の検査 (**メモリ内だけ。保存も送信もしない**)
$script:Stage = 'csv'
$chk = Test-CsvResponse $csvBytes $respCt $respCd
$script:Rows = $chk.Rows
Diag ("  csv bytes={0} rows={1} header={2} filename={3} sha256={4}" -f `
      $chk.Bytes, $chk.Rows, $chk.HeaderOk, $chk.Filename, $chk.Sha256)
Say ("[6] CSV 検査: bytes={0} / rows={1} / 必須ヘッダ={2} / filename={3}" -f `
     $chk.Bytes, $chk.Rows, $chk.HeaderOk, $chk.Filename)
Say ("    SHA-256 : {0}" -f $chk.Sha256)
if (-not $chk.Ok) { Finish 1 'fail' $chk.Code $chk.Detail }

$script:Stage = 'done'
Finish 0 'ok' '' ''
