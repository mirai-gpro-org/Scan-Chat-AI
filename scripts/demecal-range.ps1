# デメカル 取得範囲プランナ (Phase C / C-1) — **純粋関数だけを置くライブラリ**
#
# 正本: docs/lab/demecal_recovery_plan_20260902.md §7.2 C-1
# 検査: pwsh -NoProfile -File scripts/tests/demecal-range.tests.ps1
#       (npm run verify:demecal-range)
#
# 【このファイルがやること】
#   「次にデメカルへ要求する日付範囲」を決める。**それだけ。**
#
# 【このファイルがやらないこと (構造で禁じる)】
#   ネットワーク / S3 / デメカルへのログイン・ダウンロード / state の POST /
#   現在時刻の取得。**1 つも書かない。** 検査 (`demecal-range.tests.ps1`) が
#   ソースと実行時の両方で見張っていて、足すと落ちる。
#
#   とくに **現在時刻をここで取らない**。`TodayJst` は呼び出し側 (C-4 の本番 runner) が
#   渡す。そうしないと「日付をまたぐ瞬間の挙動」も「うるう年」も**テストで固定できない**
#   (実行した日によって結果が変わるテストは、通っても何も保証していない)。
#
# 【last_to の意味 — ここを取り違えると全部ずれる】
#   **結果承認日ベースで、この日までの取得範囲を完了した coverage watermark。**
#   採血日ではない。CSV 中の最大日付でもない。
#   → だから CSV の中身を見て last_to を決めてはならない (前進は取り込み成功時のみ・
#      `src/pages/api/admin/demecal-state.ts` の POST が単調前進を担保する)。
#
# 【daily-1.7 からコピーしないもの (仕様と食い違う・2026-09-03 確認)】
#   ・`$to = (Get-Date).Date`            … C-1 は **JST の昨日**。今日を含めない
#   ・`$FirstRunDays = 7` の初回 fallback … C-1 は **STATE_NOT_INITIALIZED で停止**。
#                                            直近 N 日を勝手に決めない
#   ・`$MaxRangeDays = 60` の clamp       … **根拠が repo に無い**ので実装しない (下記)
#   `scripts/demecal-daily.ps1` は凍結。参照はしても取り込まない。
#
# 【1 回の指定範囲に上限があるか = 未確定。だからここでは切らない】
#   repo 内の `MaxRangeDays = 60` は `demecal-daily.ps1:43` と、それを説明した
#   `demecal_daily_HANDOVER_20260902.md:160` / `demecal_phase_c_spec_20260903.md §6.4`
#   にしか無く、**デメカル側の制限としての出典が 1 件も無い** (実測でも先方回答でもない)。
#   逆に `demecal_auto_download_overview_spec.md §2.3` のダウンロード履歴には
#   `2025/12/01〜2026/06/11` (193 日) が実際に残っている = **60 日で切られてはいない**。
#   ただしこれは過去の手作業の記録であって「上限が無い」ことの証明にもならない。
#   → **推測で 60 を固定しない。** C-4 runner 設計時の確認事項 (§7.2 C-4)。
#      上限が確定したら、ここに clamp を足して `demecal-range.tests.ps1` の
#      「上限で切らない」テストを差し替える。**黙って足さない。**

$ErrorActionPreference = 'Stop'

<#
.SYNOPSIS
  YYYY-MM-DD 文字列を実在する暦日として読む。読めなければ $null。
.DESCRIPTION
  **完全一致**でしか受けない。`2026/09/01` / `2026-9-1` / 前後の空白 / 末尾改行 /
  `2026-09-01T00:00:00` は全部 $null。
  暦日の妥当性 (2026-02-30 / 2025-02-29 / 2100-02-29) は ParseExact が弾く
  (.NET が 4 年・100 年・400 年規則を持っている。こちらで日数表を書かない)。
  `\z` を使うのは、.NET の `$` が**末尾の改行の手前**にも一致するため。
#>
function ConvertTo-DemecalDate {
  param([AllowNull()][AllowEmptyString()][string]$Text)

  if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
  if ($Text -notmatch '^\d{4}-\d{2}-\d{2}\z') { return $null }

  $parsed = [datetime]::MinValue
  $ok = [datetime]::TryParseExact(
    $Text,
    'yyyy-MM-dd',
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::None,
    [ref]$parsed)
  if (-not $ok) { return $null }
  return $parsed.Date
}

function Format-DemecalDate {
  param([Parameter(Mandatory)][datetime]$Date)
  return $Date.ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
}

function New-DemecalRangeResult {
  param(
    [Parameter(Mandatory)][string]$Status,
    [string]$Code   = '',
    [string]$From   = '',
    [string]$To     = '',
    [string]$Detail = ''
  )
  return [pscustomobject]@{
    Status = $Status   # ready | noop | not_initialized | invalid_state
    Code   = $Code
    From   = $From     # ready のときだけ入る
    To     = $To       # ready のときだけ入る
    Detail = $Detail
  }
}

<#
.SYNOPSIS
  次に要求する取得範囲を決める (C-1)。
.DESCRIPTION
  to   = JST の昨日      (= TodayJst - 1日)
  from = last_to + 1日
  → **overlap しない。** from は必ず last_to より後、to は必ず TodayJst より前。

  返り値の Status:
    ready           … From / To が入る。**ここだけ**が「取りに行ってよい」
    noop            … 新しい範囲が無い (from > to)。C-4 の実行結果は `ok_noop`。
                      **この状態でデメカルへ login / download しない**
    not_initialized … last_to が無い。Code=STATE_NOT_INITIALIZED。
                      **直近 7 日などを自動設定しない** (勝手に範囲を作らない)
    invalid_state   … 入力が壊れている。fail-closed で停止する

  **From / To は ready のときだけ入れる** (noop / invalid_state では空文字)。
  呼び出し側が Status を見ずに .From/.To を読んでも、壊れた範囲でダウンロードに
  進めないようにするため。
.PARAMETER LastTo
  取得済みの watermark (結果承認日ベース・YYYY-MM-DD)。未初期化なら $null / 空。
.PARAMETER TodayJst
  JST の今日 (YYYY-MM-DD)。**呼び出し側が渡す。** ここで現在時刻を取らない。
#>
function Resolve-DemecalAcquisitionRange {
  param(
    [AllowNull()][AllowEmptyString()][string]$LastTo,
    [AllowNull()][AllowEmptyString()][string]$TodayJst
  )

  # 1. 注入された「今日」を先に検める。これが壊れていると以降は全部信用できない。
  $today = ConvertTo-DemecalDate $TodayJst
  if ($null -eq $today) {
    return (New-DemecalRangeResult 'invalid_state' 'TODAY_JST_INVALID' '' '' `
      'today_jst が YYYY-MM-DD の実在する暦日でない')
  }

  # 2. watermark が無ければ**そこで止まる**。範囲をこちらで作らない。
  if ([string]::IsNullOrWhiteSpace($LastTo)) {
    return (New-DemecalRangeResult 'not_initialized' 'STATE_NOT_INITIALIZED' '' '' `
      'last_to が未初期化。初回の範囲は運用で明示的に決める (直近N日を自動設定しない)')
  }

  $last = ConvertTo-DemecalDate $LastTo
  if ($null -eq $last) {
    return (New-DemecalRangeResult 'invalid_state' 'STATE_LAST_TO_INVALID' '' '' `
      'last_to が YYYY-MM-DD の実在する暦日でない')
  }

  # 3. 日付の足し引き。DateTime の端 (0001-01-01 / 9999-12-31) で溢れるので囲う。
  try {
    $to   = $today.AddDays(-1)
    $from = $last.AddDays(1)
  } catch {
    return (New-DemecalRangeResult 'invalid_state' 'DATE_OUT_OF_RANGE' '' '' `
      '日付が扱える範囲の端を越えた')
  }

  # 4. 追いついていれば何もしない。**ここで login / download へ進ませない。**
  if ($from -gt $to) {
    return (New-DemecalRangeResult 'noop' 'OK_NOOP' '' '' `
      ('新しい範囲が無い (from={0} > to={1})' -f (Format-DemecalDate $from), (Format-DemecalDate $to)))
  }

  return (New-DemecalRangeResult 'ready' '' (Format-DemecalDate $from) (Format-DemecalDate $to) '')
}
