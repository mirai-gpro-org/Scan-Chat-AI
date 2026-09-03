> ## ⚠ 不採用（2026-08-31）。この文書のとおりに作らないこと。
>
> 血液CSVの自動取得は **PowerShell 方式**に確定した（専用PC 実測で証明書つき接続 HTTP 200・
> ログイン画面は素の HTML フォーム）。**PAD もサーバ側 Playwright も不要**になった。
>
> - 無人運用の正本 … `docs/lab/demecal_unattended_spec.md`
> - 方式決定の実測 … `docs/lab/demecal_powershell_probe_guide.md`
> - 手動運用（稼働中）… `docs/lab/demecal_attended_manual_guide.md`
>
> 残しているのは経緯の記録のため。**実装・運用の根拠にしない。**

# デメカル血液CSV RPA — Power Automate Desktop 運用手順書

| 項目 | 内容 |
|---|---|
| 対象 | セットアップ済み専用PCでの**日々/週次の運用**とフロー詳細・監視・障害対応 |
| 前提 | `docs/lab/demecal_pad_setup_guide.md` 完了済み |
| 認可 | 取り込み専用キー `x-intake-key`（資格情報マネージャー `wellfort_intake_key`） |
| API | `{BaseUrl}/api/admin/demecal-state`（GET/POST）/ `{BaseUrl}/api/admin/elith-blood-csv`（POST） |

---

## 1. 運用モードの選択

| モード | 起動 | 認可 | PC条件 |
|---|---|---|---|
| **attended（推奨・まずこれ）** | 担当者がPADフロー or admin画面から手動実行 | Google認証(admin画面) or intake-key(PAD) | 担当者ログイン中 |
| **unattended（無人・週次）** | タスクスケジューラが自動起動（§4） | intake-key | PC起動・当該ユーザーセッション維持 |

> まず attended で1〜2回まわして安定を確認 → 無人化。無人でも失敗時は attended で手当てできる（§6）。

---

## 2. PAD フロー詳細（アクション列）

ブラウザが必要な「DL」だけ Web オートメーション、それ以外（API/base64/日付/秘密）は **PowerShell スクリプトの実行**アクションで堅牢に行う。

### 2-1. 秘密の取得（PowerShell スクリプトの実行）
```powershell
$intake = (Get-StoredCredential -Target 'wellfort_intake_key').GetNetworkCredential().Password
$dc     = Get-StoredCredential -Target 'demecal_login'
$demeId = $dc.UserName
$demePw = $dc.GetNetworkCredential().Password
# PAD 出力変数へ: %IntakeKey% %DemeId% %DemePw%
Write-Output $intake; Write-Output $demeId; Write-Output $demePw
```
→ PADの「生成された変数」を `IntakeKey`/`DemeId`/`DemePw` に割当（または PowerShell を3分割）。機密変数として扱う。

### 2-2. 状態取得と範囲決定（PowerShell スクリプトの実行）
```powershell
$base = '%BaseUrl%'
$r = Invoke-RestMethod -Method Get -Uri "$base/api/admin/demecal-state" -Headers @{ 'x-intake-key'='%IntakeKey%' }
$last = if ($r.last_to) { [datetime]$r.last_to } else { (Get-Date).AddMonths(-1) }
$from = $last.AddDays(1)
$to   = (Get-Date).AddDays(-[int]'%MarginDays%')
# デメカル画面の日付書式に合わせる（例 yyyy/MM/dd）
$FromStr = $from.ToString('yyyy/MM/dd')
$ToStr   = $to.ToString('yyyy/MM/dd')
if ($from -gt $to) { throw 'no-new-range' }   # 取得対象なし → フロー終了
Write-Output $FromStr; Write-Output $ToStr
```
→ 出力を `FromStr`/`ToStr` に割当。`no-new-range` 例外は「今回は取得なし」として正常終了扱い。

### 2-3. デメカルへログイン〜汎用CSV DL（Web オートメーション）
1. 「新しい Microsoft Edge（または Chrome）を起動」→ URL `https://dl.demecal.net/account/login`。
   - 証明書選択ダイアログは、セットアップ §2-4 の自動選択設定で省略（未設定なら attended で手動選択）。
2. 「Web ページ内のテキスト フィールドに入力」→ ID欄に `%DemeId%`、パスワード欄に `%DemePw%`。
3. 「Web ページのボタンを押します」→ ログイン。
4. 「Web ページに移動します」→ メニュー「データダウンロード」→「結果DL(汎用CSV)」。
5. 汎用CSVダウンロード画面で各項目を設定：
   - 代理店 `%AgentCode%`（Q05-0010）/ 販売先 `000000`
   - 日付範囲 from=`%FromStr%` / to=`%ToStr%`
   - 検査結果=「正常終了のみ」、項目見出し=「出力する」
6. 「確認」→ 確認画面 →「ダウンロード」。
7. 「ダウンロードを待機」：`%DlFolder%` に新規CSV（`Q05-0010-000000result_*.csv`）が現れるまで待つ。
   - 「フォルダー内のファイルを取得」→ 最新の `.csv` を `%CsvPath%` に。

### 2-4. CSV を取り込み（PowerShell スクリプトの実行）
```powershell
$path = '%CsvPath%'
$b64  = [Convert]::ToBase64String([IO.File]::ReadAllBytes($path))
$name = Split-Path $path -Leaf
$body = @{ csvBase64 = $b64; filename = $name; idPrefix = 'prod' } | ConvertTo-Json
$res  = Invoke-RestMethod -Method Post -Uri "%BaseUrl%/api/admin/elith-blood-csv" `
        -Headers @{ 'x-intake-key'='%IntakeKey%'; 'content-type'='application/json' } -Body $body
if (-not $res.ok) { throw "import-failed: $($res.error)" }
Write-Output $res.count
Write-Output $res.max_test_date
```
→ 出力を `ImportCount`/`MaxTestDate` に割当。`ok=false` は例外にしてフロー失敗（last_to は前進させない）。

### 2-5. 状態を前進（PowerShell スクリプトの実行）
```powershell
if ('%MaxTestDate%') {
  Invoke-RestMethod -Method Post -Uri "%BaseUrl%/api/admin/demecal-state" `
    -Headers @{ 'x-intake-key'='%IntakeKey%'; 'content-type'='application/json' } `
    -Body (@{ last_to = '%MaxTestDate%' } | ConvertTo-Json) | Out-Null
}
```
> **順序が重要**：必ず「取り込み成功（2-4）」を確認してから last_to を更新。失敗時は更新しない＝次回リトライで欠損防止（冪等・単調前進）。

### 2-6. ログ／通知
- 「テキストをファイルに書き込み」→ `C:\demecal\work\log.txt` に `日時 / from-to / 件数 / max_test_date / 結果`。
- フロー全体を Try/Catch（「エラー時」ブロック）で囲み、失敗時に **メール送信**（PAD「メールの送信」）or Teams 通知。

---

## 3. 1回の実行フロー（要約）
```
秘密取得 → last_to取得 → from=last_to+1 / to=今日-MarginDays
  → (from>to なら「取得なし」で正常終了)
  → ブラウザでログイン → 汎用CSVをDL
  → CSVをbase64化して /elith-blood-csv にPOST(JSON化→S3)
  → 成功なら max_test_date で /demecal-state をPOST(last_to前進)
  → ログ記録 / 失敗時は通知(last_to据置)
```

---

## 4. スケジュール登録（無人・週次）

1. PAD フローを保存。デスクトップ版は **Windows タスクスケジューラ**から起動する：
   - 「基本タスクの作成」→ トリガー「毎週」→ 例：**毎週月曜 06:00**。
   - 操作「プログラムの開始」→ `PAD.Console.Host.exe`（PADのCLIランナー）にフローを渡す形。
     ※ 正確な起動コマンドは PAD のバージョンに依存。GUI起動でよければ PAD 内スケジュールでも可。
2. 実行ユーザー＝**証明書を持つユーザー**、「ユーザーがログオンしているときのみ実行」を選ぶ（個人ストア証明書のため）。
3. 完全無人（ログオフ実行）にする場合はセットアップ手順書 §2-4＋証明書を LocalMachine へ移設＋PAD無人モード（要ライセンス）。

> 週次のため、祝日・PC停止でスキップしても次回は `last_to` から継続＝取り漏れなし。

---

## 5. 監視・点検

- **毎回**：ログ（件数・last_to前進）を確認。失敗通知が来たら §6。
- **週次**：admin画面「🩸 デメカルCSV 取り込み」の `last_to` 表示が前進しているか。
- **月次**：証明書有効期限、DLフォルダの肥大（古いCSVの整理）、intake-key の健全性。

---

## 6. 障害対応（よくある失敗）

| 症状 | 原因 | 対応 |
|---|---|---|
| ログイン画面で止まる/証明書ダイアログ | 証明書未選択・自動選択未設定・証明書失効 | attendedで手動選択して確認 → 失効なら再発行・再導入。自動選択ポリシー確認 |
| DLボタン押下後にファイルが出ない | 画面変更・0件・タイムアウト | 手動で同手順を確認。画面変更ならセレクタ更新。0件は「取得なし」で正常 |
| `/elith-blood-csv` が 401 | intake-key 不一致 / env 未設定 | 資格情報の値と Vercel `LAB_INTAKE_API_KEY` の一致を確認 |
| `/elith-blood-csv` が ok=false | CSV様式不一致・S3未設定 | 応答 error/detail を確認。CSV様式変更ならパーサ側の対応が必要 |
| last_to が前進しない | 取り込み失敗・max_test_date が null | ログ確認。失敗時は据置が正しい（次回リトライ）。恒常的なら原因除去 |
| 取り漏れ（採取日基準の遅延反映） | 報告遅延 | `MarginDays` を増やす / 直近数週間を再取得（重複はサーバ側の同一キー上書きで吸収） |

**フォールバック（RPAが直らない時）**：担当者が手動でデメカルからDL → admin画面「🩸 デメカルCSV 取り込み」で取り込み（attended・鍵不要）。last_to も自動前進する。

---

## 7. 証明書更新時の対応
1. 新しい `<代理店>.p12` を個人ストアへ、CA更新があればルートへ再導入。
2. attendedで手動ログイン確認 → 自動選択ポリシー再設定（無人時）。
3. PADフローを1回手動実行して疎通確認。

---

## 付録: 秘密の保管代替（Install-Module 不可の場合）
- **PAD の機密入力変数**：フローの入力変数を「機密」で定義し、値はフロー編集時にのみ保持（PADが暗号化）。無人起動時は引数渡しに注意。
- **DPAPI 暗号化ファイル**：`ConvertFrom-SecureString`（ユーザー/マシンスコープ）でキーを暗号化保存し、実行時に `ConvertTo-SecureString` で復号。ファイルは当該ユーザーのみ復号可。
