# デメカル血液CSV RPA — Power Automate Desktop セットアップ手順書

| 項目 | 内容 |
|---|---|
| 対象 | 専用デスクトップPC (Pマーク対応・デメカル証明書導入済) の**初回セットアップ** |
| 方式 | Power Automate Desktop (PAD)。ブラウザ自動化でDL＋PowerShellアクションでAPI連携 |
| 前提 | §6 自動アクセス承認済 / admin は Google 認証 / 鍵は Vercel 据置(PCは取り込み専用キーのみ保持) |
| 関連 | `docs/lab/demecal_rpa_operation_design.md`（設計）/ `docs/lab/demecal_pad_operation_guide.md`（運用）/ `docs/lab/demecal_auto_download_overview_spec.md` |

> 本書は**一度だけ**実施する導入手順。日々の運用は運用手順書を参照。

---

## 0. 用意するもの（事前）

- 専用PC（Windows 10/11、デメカル**クライアント証明書がOS/ブラウザ証明書ストアに導入済**）。
- デメカル: 代理店コード `Q05-0010` / ログインID / パスワード。
- 我々から受領: **取り込み専用キー**（`LAB_INTAKE_API_KEY` と同値）／ wellfort のベースURL（例 `https://www.wellfort.co.jp`）。
- Microsoft アカウント（PAD 利用に必要）。

---

## 1. Power Automate Desktop の導入

1. Microsoft Store（または公式インストーラ）から **Power Automate Desktop** をインストール。
2. 起動 → Microsoft アカウントでサインイン。
3. 初回起動時に案内される **ブラウザ拡張機能**を有効化：
   - 使用ブラウザ（Edge か Chrome）で「Microsoft Power Automate」拡張を**インストール＆有効化**。
   - ※ デメカル証明書が入っているブラウザに合わせる（証明書ストアを使う実ブラウザで自動化するため）。

---

## 2. デメカル証明書・ログインの手動確認（重要）

自動化前に、**手動で1回ログインできること**を確認する。

1. 対象ブラウザで `https://dl.demecal.net/account/login` を開く。
2. **クライアント証明書の選択ダイアログ**が出たら、`Q05-0010`（代理店）の証明書を選ぶ。
   - 出ない/入っていない場合は、証明書導入手順（`demecal.net_CA.cer`＝ルート、`<代理店>.p12`＝個人）を先に実施。
3. ID/パスワードでログイン → 「データダウンロード」→「結果DL(汎用CSV)」画面まで到達できることを確認。
4. **証明書選択を毎回省略したい場合**（無人化に必須）：ブラウザ設定で当該サイトに証明書を**自動選択**する設定を入れる（Edge/Chrome のポリシー `AutoSelectCertificateForUrls` を IT 管理下で設定）。attended運用のみなら任意。

---

## 3. ダウンロード先フォルダとブラウザDL設定

1. 取得CSVの保存先フォルダを作成：例 `C:\demecal\download\`。
2. ブラウザのダウンロード設定：
   - 「ダウンロード前に各ファイルの保存場所を確認する」を**オフ**（自動保存）。
   - 保存先を `C:\demecal\download\` に固定。
3. 作業用フォルダも作成：`C:\demecal\work\`（ログ・一時ファイル用）。

---

## 4. 秘密情報を Windows 資格情報マネージャーへ保管（鍵をコードに置かない）

PAD フローは秘密をハードコードせず、**Windows 資格情報マネージャー（汎用資格情報）**から読む。

1. 「資格情報マネージャー」→「Windows 資格情報」→「汎用資格情報の追加」で以下を登録：
   | インターネットまたはネットワークのアドレス（Target） | ユーザー名 | パスワード |
   |---|---|---|
   | `wellfort_intake_key` | `intake` | （取り込み専用キー = LAB_INTAKE_API_KEY） |
   | `demecal_login` | （デメカルID） | （デメカルパスワード） |
2. PAD/PowerShell から読むためのモジュール（初回のみ・CurrentUser）：
   ```powershell
   Install-Module CredentialManager -Scope CurrentUser -Force
   ```
   ※ IT ポリシーで Install-Module が不可なら、DPAPI 暗号化ファイル or PAD の「機密」入力変数で代替（運用手順書 付録参照）。

> フル権限の `ADMIN_API_KEY` は**PCに置かない**。PCが持つのは「取り込み専用キー」のみ（漏洩時は Vercel 側 env 差替で即無効化）。

---

## 5. wellfort 側 env（我々が Vercel に設定・確認事項）

- `LAB_INTAKE_API_KEY`（= 資格情報マネージャーに入れた値と同値）。
- 既存: `SCAN_CHAT_AI_API_KEY`（= Scan-Chat-AI `ADMIN_API_KEY`）、`AWS_*`（Scan-Chat-AI）。
- ※ これらは**Vercel 側**の設定。PCには置かない。未設定だと intake 認可が無効になり 401 になる。

---

## 6. 初回 last_to（取得開始日）の設定

自動化の「前回終了日」を初期化する。どちらかで実施：

- **admin画面**：`/admin` の「🩸 デメカルCSV 取り込み」カードで一度 attended 取り込みを行うと `last_to` が入る。
- **API直接**（PowerShell・intake-key）：
  ```powershell
  $key = (Get-StoredCredential -Target 'wellfort_intake_key').GetNetworkCredential().Password
  $base = 'https://www.wellfort.co.jp'
  Invoke-RestMethod -Method Post -Uri "$base/api/admin/demecal-state" `
    -Headers @{ 'x-intake-key'=$key; 'content-type'='application/json' } `
    -Body (@{ last_to = '2026-06-30' } | ConvertTo-Json)   # ← 運用開始の起点日
  ```

---

## 7. PAD フローの作成（雛形の取り込み）

1. PAD で新規フロー「Demecal_Blood_Import」を作成。
2. 変数（フロー冒頭「変数の設定」アクション）：
   - `BaseUrl` = `https://www.wellfort.co.jp`
   - `DlFolder` = `C:\demecal\download`
   - `MarginDays` = `3`（採取日基準の取り漏れ対策マージン。報告日基準なら 0〜1）
   - `AgentCode` = `Q05-0010`
3. 具体的なアクション列は**運用手順書 §2** の通りに配置（ブラウザ自動化＋PowerShell）。
4. 保存 → 次章の疎通確認へ。

---

## 8. 疎通・動作確認（本番前）

1. **API 疎通**（PowerShell 単体）：`demecal-state` GET が 200 で `last_to` を返すこと。
   ```powershell
   Invoke-RestMethod -Method Get -Uri "$base/api/admin/demecal-state" -Headers @{ 'x-intake-key'=$key }
   ```
2. **手動DL→取り込み**：一度手でCSVをDLし、admin画面の取り込みカードで JSON→S3 まで通ること（attended確認）。
3. **PADフロー手動実行**：フローを手動起動し、range決定→DL→POST→last_to前進 まで通ること（件数・last_to をログで確認）。
4. 問題なければ運用手順書 §4 のスケジュール登録へ。

---

## 9. セットアップ完了チェックリスト

- [ ] PAD インストール＋ブラウザ拡張 有効
- [ ] 手動でデメカルにログイン可（証明書選択OK）
- [ ] DLフォルダ固定・自動保存ON
- [ ] 資格情報マネージャーに `wellfort_intake_key` / `demecal_login` 登録
- [ ] wellfort env `LAB_INTAKE_API_KEY` 設定済（我々側）
- [ ] `last_to` 初期化済
- [ ] PADフロー手動実行で通し成功
