# デメカルRPA — PADフロー雛形（画面非依存部分・UNFIX構築用）

| 項目 | 内容 |
|---|---|
| 対象 | UNFIX技術担当者が Power Automate Desktop でフローを組む際の**雛形**（案A：UNFIX構築・納品・保守） |
| 範囲 | **デメカル画面に依存しない部分**（状態取得・範囲決定・取り込みAPI・状態前進・ログ/通知）を先に完成させる。DL部分はフェーズ2の画面情報で後から埋める |
| 前提 | 既存API稼働（`/api/admin/demecal-state`・`/api/admin/elith-blood-csv`）／認可＝`x-intake-key` |
| 関連 | `demecal_pad_operation_guide.md`（運用）／`demecal_pad_setup_guide.md`（導入）／`demecal_rpa_operation_design.md`（設計） |

> Pマーク準拠：UNFIXは専用PCを遠隔操作しない。DL画面の作り込みはフェーズ2でWellfort提供のスクショ/録画/HTMLを使う。

---

## 1. フロー全体像（アクション順）

```
[A] PowerShell: 秘密取得＋状態取得＋範囲決定        ← 画面非依存（本書で完成）
      ↓ 出力: IntakeKey / DemeId / DemePw / FromStr / ToStr / HasRange
[B] 条件: HasRange=false なら「取得なし」で正常終了
[C] ブラウザ操作: デメカルにログイン→汎用CSV DL     ← フェーズ2で実装（プレースホルダ）
      ↓ 保存された最新CSVのパス: CsvPath
[D] PowerShell: CSV取り込み(API)＋状態前進          ← 画面非依存（本書で完成）
      ↓ 出力: ImportCount / MaxTestDate
[E] PowerShell: ログ記録
[全体] Try/Catch: 失敗時はメール/Teams通知（last_toは前進させない）
```

## 2. フロー変数（PAD「変数の設定」）

| 変数 | 例 | 説明 |
|---|---|---|
| `BaseUrl` | `https://www.wellfort.co.jp` | wellfort 管理APIのベースURL |
| `DlFolder` | `C:\demecal\download` | CSVの保存先（自動保存先と一致させる） |
| `MarginDays` | `3` | 取得終端のマージン（採取日基準の遅延対策。報告日基準なら 0〜1） |
| `AgentCode` | `Q05-0010` | 代理店コード（DL画面で使用） |
| `LogFile` | `C:\demecal\work\log.txt` | 実行ログ |

秘密は変数に直書きせず、Windows 資格情報マネージャーから取得（下記 [A]）。

---

## 3. アクション [A] 秘密取得＋状態取得＋範囲決定（PowerShell）

PAD「PowerShell スクリプトの実行」に貼り付け。出力（最終行のJSON）を PAD 変数へパースする。

```powershell
$ErrorActionPreference = 'Stop'
# 秘密（資格情報マネージャー）。CredentialManager モジュールが無い場合は付録参照。
$intake = (Get-StoredCredential -Target 'wellfort_intake_key').GetNetworkCredential().Password
$dc     = Get-StoredCredential -Target 'demecal_login'
$demeId = $dc.UserName
$demePw = $dc.GetNetworkCredential().Password

$base = '%BaseUrl%'
# 前回終了日 last_to を取得（未設定なら1ヶ月前を起点）
$st = Invoke-RestMethod -Method Get -Uri "$base/api/admin/demecal-state" -Headers @{ 'x-intake-key' = $intake }
$last = if ($st.last_to) { [datetime]$st.last_to } else { (Get-Date).AddMonths(-1) }
$from = $last.AddDays(1)
$to   = (Get-Date).AddDays(-[int]'%MarginDays%')
$hasRange = ($from -le $to)

# デメカル画面の日付書式に合わせる（フェーズ2で確定。例 yyyy/MM/dd）
$fmt = 'yyyy/MM/dd'
$out = [ordered]@{
  IntakeKey = $intake; DemeId = $demeId; DemePw = $demePw
  FromStr = $from.ToString($fmt); ToStr = $to.ToString($fmt); HasRange = $hasRange
}
$out | ConvertTo-Json -Compress
```
PAD 側：ScriptOutput を「JSON をカスタムオブジェクトに変換」→ `IntakeKey`/`DemeId`/`DemePw`/`FromStr`/`ToStr`/`HasRange` を取り出す。IntakeKey/DemePw は**機密変数**として扱う。

## 4. アクション [B] 取得なしの早期終了

PAD「If `%HasRange%` = False」→ ログに「取得なし」を書いて**正常終了**（フロー終了）。

## 5. アクション [C] デメカルからDL（プレースホルダ・フェーズ2で実装）

> フェーズ2でWellfort提供の画面情報を使って作り込む。ここでは受け渡し仕様だけ固定。
- 入力：`%DemeId%` `%DemePw%` `%FromStr%` `%ToStr%` `%AgentCode%`
- 使うアクション（想定）：新しいEdge/Chromeを起動 → ログイン欄に入力 → ボタン押下 → データDL→汎用CSV画面へ移動 → 代理店/日付/「正常終了のみ」/「項目見出し 出力する」設定 → 確認 → ダウンロード → 「ダウンロードを待機」→「フォルダー内のファイルを取得」で `%DlFolder%` の最新 `.csv` を `%CsvPath%` に。
- 出力：`%CsvPath%`（保存された最新CSVのフルパス）

## 6. アクション [D] CSV取り込み＋状態前進（PowerShell）

```powershell
$ErrorActionPreference = 'Stop'
$path = '%CsvPath%'
$base = '%BaseUrl%'
$intake = '%IntakeKey%'

$b64  = [Convert]::ToBase64String([IO.File]::ReadAllBytes($path))
$name = Split-Path $path -Leaf
$body = @{ csvBase64 = $b64; filename = $name; idPrefix = 'prod' } | ConvertTo-Json
$res  = Invoke-RestMethod -Method Post -Uri "$base/api/admin/elith-blood-csv" `
        -Headers @{ 'x-intake-key' = $intake; 'content-type' = 'application/json' } -Body $body
if (-not $res.ok) { throw "import-failed: $($res.error) $($res.detail)" }

# 取り込み成功後にのみ last_to を前進（失敗時は前進させない＝次回リトライで欠損防止）
if ($res.max_test_date) {
  Invoke-RestMethod -Method Post -Uri "$base/api/admin/demecal-state" `
    -Headers @{ 'x-intake-key' = $intake; 'content-type' = 'application/json' } `
    -Body (@{ last_to = $res.max_test_date } | ConvertTo-Json) | Out-Null
}
@{ ImportCount = $res.count; MaxTestDate = $res.max_test_date } | ConvertTo-Json -Compress
```
PAD 側：出力を `ImportCount`/`MaxTestDate` に。

## 7. アクション [E] ログ／[全体] エラー通知

- 「テキストをファイルに書き込み」→ `%LogFile%` に `日時 / FromStr-ToStr / ImportCount / MaxTestDate / OK`。
- フロー全体を「エラー時（On block error）」で囲み、失敗時に PAD「メールの送信」or Teams コネクタで通知。**last_to は前進しない**ため、次回実行で自動リトライ。

---

## 8. 設定箇所リスト（納品時に添付・環境依存の数項目のみ）

- `BaseUrl`（本番URL）／`DlFolder`（保存先）／`MarginDays`（0〜3）／`LogFile`／`AgentCode`。
- 資格情報名：`wellfort_intake_key`（intake-key）／`demecal_login`（デメカルID/PW）。
- 通知先メール/Teams。

## 9. テスト（画面非依存部分・DL前に実施可）

1. `[A]` 単体：`demecal-state` GET が返り、`FromStr/ToStr/HasRange` が妥当か。
2. `[D]` 単体：**ダミーの正しい様式CSV**を `CsvPath` に置いて実行 → `/elith-blood-csv` が `ok:true`＋`max_test_date` を返し、`demecal-state` が前進するか（dev環境 or テスト prefix 推奨）。
3. `[C]` は フェーズ2 で画面情報を得てから実装・結合。

## 付録：資格情報の取得（CredentialManager 不可の場合）
- DPAPI：`ConvertFrom-SecureString`（ユーザー/マシンスコープ）で暗号化保存 → 実行時 `ConvertTo-SecureString` で復号（当該ユーザーのみ復号可）。
- もしくは PAD の「機密」入力変数。無人起動時の引数渡しに注意。
