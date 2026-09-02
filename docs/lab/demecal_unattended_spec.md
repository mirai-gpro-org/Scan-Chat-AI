# デメカル 血液CSV 無人定期取得 仕様書

**確定: 2026-08-31・発注者判断「最初から無人で定期実行でいく」**

この文書が**無人運用の正本**。`demecal_rpa_operation_design.md` は PAD 前提の旧設計
（§1 役割分担・§3 attended は生きているが、**§4 unattended はこの文書が上書きする**）。

段階導入案（まず手動ダブルクリック → 安定後に自動化）は**発注者判断で採らない**。
以下はすべて「初回から無人」を前提に組んである。

---

## 1. 前提（すべて実測で確定済み）

| | 出典 |
|---|---|
| 方式は **PowerShell**（PAD 不要） | `demecal_powershell_probe_guide.md`「実測結果」 |
| 証明書つき接続 **HTTP 200** ／ 証明書なし 400 | 同上 |
| 証明書 `CN=Q05-0010`（発行者 `demecal.net CA`・**期限 2028-12-12**） | 同上 |
| 証明書は **`Cert:\CurrentUser\My` にしかない**（ユーザー `info`） | 同上 |
| ログインは `POST /account/login` ＋ **antiforgery hidden** | 同上「ログインフォームの構造」 |
| デスクトップが **OneDrive 配下** | 同上 |
| 原本CSVは**個人情報を含む**・取込後に削除 | `demecal_attended_manual_guide.md:114,127` |

---

## 2. 「無人にしてよい」根拠 — `last_to` の単調前進

**この設計の安全性は、実行が毎回成功することに依存していない。**

`last_to`（前回取得済みの最終日）は **取り込み成功時にだけ前進**する
（`src/pages/api/admin/demecal-state.ts` の POST・過去日付は据置）。次回は `from = last_to + 1日`。

したがって:

- PC が落ちていた日・ログオンしていなかった日・ネットワーク障害の日に**走らなくても、取り漏れは起きない**
- 次に成功した回が、**溜まっていた範囲をまとめて回収する**

**だから「毎日走らせて、走らない日は諦める」で成立する。**
これが後述 §4.3 で「ログオン中のみ実行」を選べる理由でもある。

**逆に言うと、この性質が壊れたら無人運用も壊れる。** `last_to` を失敗時に前進させてはならない。

### ⚠ ただし「取り漏れゼロ」であって「重複ゼロ」ではない（2026-08-31 実測で判明）

初版はここに「同じ範囲を二度取っても同じ S3 キーへ上書きされるだけ（要確認）」と書いた。
**確認した結果、上書きされない。取り直すたびに別物が増える。**

`client_id` は CSV の中身ではなく **リクエスト時刻から採番**している
（`elith-blood-csv.ts:79,89` … `${idPrefix}-${jstStamp()}-${seq}` ＝ `test-202608310638-001`）。
S3 パスは `user/{client_id}/date/{採血日}/BloodTestData_…json`（`elith-blood-csv.ts:340`）なので、
**同じ範囲を取り直すと丸ごと別フォルダに複製される。**

これが効くのは **§6 の「据置」ケース**。取り込みは成功したが `last_to` の前進に失敗した、
という順序で落ちると、次回が同じ範囲を取り直して **Elith へ二重納品**になる。
ゴール「漏れなし／捏造なし／**余剰なし**」の 3 つ目に反する。

**さらに根が深い**: `client_id` は本来 **`diagnostic_user_id`**（`elith_s3_data_handoff_spec.md`）。
いまは `test-…` という**その場限りの仮 ID** で、**誰の検査結果かが Elith 側で分からない**。
CSV 側の識別子は **`指図番号`**（`scripts/blood-csv-fixtures/demecal_sample_v1.csv` の 1 列目。
氏名は無く 性別/生年月日/採血日 と併せて本人を特定する想定）だが、
**これを本人へ写像する実装が無い。**

**ただし設計は在る**（§8 の「②の扱いを訂正」）。`id_management_and_correlation_spec.md:131` が
「`external_test_id` を**受領時に `lab_tests` へ格納し内部 `diagnostic_user_id` と対応づける**」と
定めており、**カラムも実在**する。**足りないのは実装だけ。**

→ **無人化の前に潰す（§9 の 8・9）。** 人が都度確認する attended 運用では見えていた問題が、
無人化すると**気づかないまま仮 ID の重複納品が積み上がる**。

---

## 3. サーバ側（Scan-Chat-AI）の仕様

### 3.1 取り込み専用キー `LAB_INTAKE_API_KEY`【新規・要実装】

**無人化で最初に埋めるべき穴。**

現状、専用PCが叩く 2 つの API はどちらも **`ADMIN_API_KEY`**（フル権限）を要求する
（`demecal-state.ts:20` / `elith-blood-csv.ts:30` → `src/lib/api-auth.ts`）。
無人運用では**この鍵が Windows PC に置きっぱなしになる**。
`ADMIN_API_KEY` は admin API を全部開ける — 設定変更（`config`）、Elith データ削除（`elith-delete`）、
デモ用アカウント追加（`demo-accounts`）、報告書アップロード等。**専用PCに置いてよい鍵ではない。**

`LAB_INTAKE_API_KEY` は**設計文書に 6 か所出てくるが実装は無い**（`grep -rn src/` = 0 件）。実装する。

| | |
|---|---|
| env | `LAB_INTAKE_API_KEY`（Vercel・Scan-Chat-AI） |
| ヘッダ | `x-intake-key: <値>`（`demecal_auto_download_overview_spec.md:29` の記載に合わせる） |
| 通る口 | **`/api/admin/demecal-state`（GET/POST）・`/api/admin/elith-blood-csv`（POST）・`/api/admin/demecal-run`（§3.2）の 3 つだけ** |
| 通らない口 | **それ以外の admin API 全部**（config / elith-delete / demo-accounts / elith-report / health-age …） |
| 未設定時 | intake 認可は**無効**（＝`ADMIN_API_KEY` のみ受理）。attended 運用は影響を受けない |
| `ADMIN_API_KEY` | 従来どおり全 API で有効（wellfort-site の admin 画面用） |

実装は `src/lib/api-auth.ts` に `isIntakeAuthorized(request)` を足し、上記 3 ファイルだけ
`isAdminAuthorized(req) || isIntakeAuthorized(req)` にする。
**`api-auth.ts` 以外に認可判定を複製しない**（14 ファイルに dev 素通しを複製して本番が
無防備になった前例がある・同ファイル冒頭の経緯）。

**回帰チェックを付ける**（`verify:intake-scope` 想定）: intake キーで通ってよい口の一覧を固定し、
**他の admin API が intake キーで通ったら落とす**。ここは静かに壊れる（広がっても画面上は正常に見える）。

### 3.2 実行ログ API `/api/admin/demecal-run`【新規・要実装】

**無人運用の本体はここ。** 誰も見ていないので、**走ったか／失敗したかがサーバ側に残らないと運用できない。**

```
POST /api/admin/demecal-run   (x-intake-key)
  { started_at, finished_at, result: "ok"|"fail", stage, rows?, range?: {from,to},
    error?, diag?: string[], host, script_version, cert_expires_on, cert_days_left }
GET  /api/admin/demecal-run   (x-intake-key | ADMIN_API_KEY)
  → { ok, runs: [...直近N件], health: { last_success_at, days_since_success, cert_days_left, stale: bool } }
```

- 置き場は `{AWS_S3_PREFIX}state/demecal_runs.json`（`demecal_last_to.json` と同じ流儀）。
  **直近 N 件のリングバッファ**（N=50 程度）。無限に伸ばさない。
- **失敗も必ず記録する。** 「記録が無い＝走っていない」と「失敗した」を区別できるようにする。
- `stage` は失敗箇所を示す（`cert` / `login` / `range` / `download` / `intake` / `state` / `cleanup`）。
  これが無いと、証明書切れなのかサイト変更なのかを毎回リモートで問い合わせることになる。
- **`error` に ID・パスワード・受診者情報を入れない。** 例外メッセージをそのまま載せない
  （URL とステータスコードまで）。
- **`cert_days_left` を毎回載せる。** 証明書は 2028-12-12 に切れ、切れた瞬間に全部止まる。
  **60 日を切ったら警告**を出す（§5）。

#### `diag` — 画面遷移の**形**（v1.1 で追加・2026-09-02）

**「もう一度 bat を回してください」を無くすためのフィールド。**
v1.0 が失敗したとき手元に残ったのは URL と `HTTP 200` だけで、
原因を絞るのに現地での再実行が要った。無人運用でそれは成立しない。

載るのは **形だけ**:
段数 / メソッド / URL / HTTP 状態 / content-type /
form の項目名と型 / **select の選択肢の「件数」** / ボタンの見出し /
押したボタン / 送った日付欄の名前。

**載せないもの**: 入力値・hidden の値・select の選択肢の中身・ページ本文・CSV の中身。
サーバ側でも **1 行 200 字 × 80 行**で切る（`demecal-run.ts`）。
無制限にすると送信側の不具合でページ本文が流れ込む余地ができる＝ PII の逃げ道になる。

### 3.3 既存 API（変更なし）

| API | 用途 | 実装 |
|---|---|---|
| `GET/POST /api/admin/demecal-state` | `last_to` の読み書き（単調前進） | 実装済 |
| `POST /api/admin/elith-blood-csv` | CSV → `BloodTestData` JSON 群 → S3 | 実装済 |

**原本CSVはサーバにも S3 にも保存しない**（PII）。既存の挙動どおり。

---

## 4. 専用PC側の仕様

### 4.1 スクリプト（`demecal-fetch.ps1`）

```
1. 証明書を選ぶ        発行者CN = "demecal.net CA" かつ HasPrivateKey
                       → 0 件なら stage=cert で失敗報告して終了（CN をベタ書きしない）
2. 範囲を決める        GET /api/admin/demecal-state → from = last_to + 1日
                       to = 当日 - N日（反映遅延マージン。N は §8 未確定）
3. ログイン            GET  /account/login（証明書つき・-SessionVariable）
                       → __RequestVerificationToken 抽出
                       → POST /account/login（同一セッション・同一証明書）
                       → 成否は「302 か、ログインフォームが消えたか」で判定
                         （失敗時も 200 が返る作りなのでステータスだけで見ない）
4. CSV 取得            汎用CSV: 代理店 Q05-0010 / 販売先 000000 / 日付範囲 from〜to
                       / 検査結果=正常終了のみ / 項目見出し=出力する
                       → C:\demecal\ へ保存（§4.4）
5. 取り込み            POST /api/admin/elith-blood-csv (x-intake-key) { csvBase64, filename }
6. 前進                POST /api/admin/demecal-state (x-intake-key) { last_to: max_test_date }
                       ※ 5 が成功したときだけ
7. 後始末              原本CSVを削除（5 が成功したときだけ）
8. 報告                POST /api/admin/demecal-run  ← 成功・失敗にかかわらず必ず
```

- `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12`
  （PS 5.1 は既定で TLS1.2 でない。プローブと同じ）
- **証明書は全リクエストに付ける**（GET も POST も CSV 取得も）
- **0 件は成功**として扱い `last_to` を前進させる（検査が無い週は普通にある）
- `script_version` を持ち、実行ログに載せる（どの版が動いているか分からなくなるため）

### 4.2 秘密の保管

置くのは **デメカル ID / PW** と **`LAB_INTAKE_API_KEY`** の 3 つ。**`ADMIN_API_KEY` は置かない**（§3.1）。

| | |
|---|---|
| 方式 | PowerShell 標準の **`Export-CliXml`（DPAPI 暗号化）** |
| 置き場 | `C:\demecal\secrets\demecal.cred.xml` / `intake.cred.xml` |
| 性質 | **ユーザー `info` かつ その PC でしか復号できない**。コピーしても他所では開かない |
| 追加インストール | **不要**（PS 5.1 組み込み） |

**Windows 資格情報マネージャーを使わない理由**: PowerShell から扱うには `CredentialManager`
モジュール（PSGallery）の導入が要る。ロックダウンされた業務 PC に外部モジュールを入れるより、
組み込みの DPAPI で足りる。

**スクリプト本体・bat・リポジトリに秘密を書かない。** 変更（ローテーション）はセットアップの再実行。

### 4.3 タスク登録

| 設定 | 値 | 理由 |
|---|---|---|
| 実行ユーザー | `info` | 証明書がこのユーザーのストアにしかない |
| 実行条件 | **ログオン中のみ実行** | 対話セッションなので証明書が確実に見える。**パスワード保存が不要** |
| トリガー | **ログオン時** ＋ **毎日 HH:MM** | 片方だと取りこぼす |
| 設定 | **「開始時刻を過ぎた場合はすぐに開始」ON** | 落ちていた日も次のログオンで回収 |
| 多重起動 | **禁止**（前回が動いていたらスキップ） | 二重取り込みを避ける |
| 実行時間 | 上限 30 分で強制終了 | ぶら下がり防止 |

登録は**セットアップ bat が XML を流し込む**。**タスクスケジューラの画面は開かせない。**

#### 「②を実行したあと、電源を入れれば自動で走るのか？」— **走らない。ログオンが要る。**

| 問い | 答え |
|---|---|
| 電源を入れただけで走る？ | **走らない。** Windows にログオンするまで動かない |
| ログオンしたら？ | **その場で走る**（ログオン時トリガー）。前日ぶんを取りこぼしていてもまとめて回収する |
| 画面ロック中は？ | **走る。** ロック ≠ ログオフ。セッションは生きている |
| サインアウト／再起動して放置したら？ | **止まる。** 次に誰かがログオンした時点で再開 |
| その間のデータは？ | **失われない。** `last_to` は成功時しか進まないので、次の成功回がまとめて取る（§2） |

**つまり「専用PCを普段ログオンしたままにしておく」だけが運用条件。**
毎朝誰かがその PC を使う運用なら、実質毎日走る。

**なぜログオンを要求する形にしたか** — 証明書が `Cert:\CurrentUser\My`（ユーザー `info`）に
しか無いため。対話セッションなら確実に見えるうえ、**Windows のパスワードを保存せずに済む**。

**本当に「電源だけ」にしたい場合の選択肢**（いま採っていない）:

| | 方式 | 電源だけで走る | 代償 | 状態 |
|---|---|---|---|---|
| **A** | **ログオン中のみ実行**（現行） | ✗ | 無し | **採用** |
| B | 「ログオンしているかどうかにかかわらず実行」 | ○ | **Windows アカウントのパスワードを OS に保存**する | **未確認** — この方式で `CurrentUser` の証明書と秘密鍵が使えるかを実機で確かめていない |
| C | 自動ログオン | ○ | パスワードをレジストリに保存。物理アクセスがあれば誰でも操作できる状態になる | セキュリティ判断（発注者マター） |

**B は「たぶん動く」で採らない。** 動く見込みはあるが（資格情報つきのバッチログオンなら
ユーザープロファイルが読み込まれる）、**確かめていないことを前提に無人運用を組まない。**
必要になったら **②に検証を仕込んで 1 回で判定する**（また Wellfort に頼まなくて済む）。

**§2 の `last_to` 単調前進があるので、A の「走らない日がある」は取り漏れにならない。**
リスクを取る理由が無い、というのがこの選択の根拠。

> **完全な 24 時間ヘッドレスにはしない（この仕様の意識的な選択）。**
> そうするには ①自動ログオン（パスワードを OS に保存）か ②証明書を LocalMachine へ移設
> （管理者権限＋秘密鍵入り pfx。**そもそもエクスポート可否が未確認**）のどちらかが要る。
> **§2 の `last_to` 単調前進により、走らない日があっても取り漏れは起きない**ので、
> リスクを取る理由が無い。**運用条件は「専用PCは通常ログオンしたままにする」の 1 行だけ。**
> これが満たせない事情が出たら再検討する（§8）。

### 4.4 ファイルの置き場と削除（PII）

| | |
|---|---|
| 保存先 | **`C:\demecal\`** に固定。作れなければ `%LOCALAPPDATA%\demecal` |
| 禁止 | 解決したパスに **`OneDrive` が含まれていたら書かずに中止**（stage=`cleanup` で失敗報告） |
| 削除 | **取り込み成功後に即削除** |
| 取り残し | 失敗時は再試行のため残す。ただし**毎回の実行開始時に、7 日より古い CSV を削除**する |
| ログ | `C:\demecal\logs\` にテキストで残す（**値は書かない**・件数とステージのみ）。30 日で削除 |

**PII を無期限に PC へ溜めない。** 失敗が続いた場合に古い CSV が残り続けるのを防ぐため、
「成功時に削除」だけでなく「古いものは無条件に削除」を入れる。

---

## 5. 監視 — 無人運用の必須条件

**無人化とは「人が見なくなる」こと。** したがって**失敗が人に届く経路**が無ければ無人にしてはいけない。

現状、このリポジトリにメール／Teams／Slack の通知基盤は**無い**（`grep` 0 件）。作らずに済ませる。

### 5.1 表示（pull）

wellfort-site の admin「🩸 デメカルCSV 取り込み」画面に**自動取得の状態**を出す。
`GET /api/admin/demecal-run` の `health` をそのまま表示:

- 最終成功日時 / 直近の失敗と `stage`
- **`days_since_success`** — これが主指標
- **証明書の残日数**（60 日未満で警告表示）

### 5.2 通知（push）— GitHub Actions を見張り役にする

**既存の仕組みだけで push 通知が作れる。** wellfort-site には既に日次 cron のワークフローがある
（`.github/workflows/charge-subscriptions-cron.yml`・毎日 JST 10:00）。同じ形で見張りを 1 本足す。

```
毎日 1 回 GET /api/admin/demecal-run
  days_since_success > しきい値  → ジョブを exit 1 で失敗させる
  cert_days_left < 60           → 同上
```

**GitHub Actions はワークフローが失敗するとリポジトリの購読者へ自動でメールを送る。**
新しい通知基盤を作らずに「失敗が人に届く」を満たせる。

- しきい値は**検査の実施間隔より短く**する（血液検査は年3回だが、取得は日次なので
  「7 日成功なし」程度から。運用開始後に調整）
- **0 件成功も成功**として扱うので、「検査が無かった週」で誤報しない

### 5.3 サイト変更の検知

デメカル側の画面が変わると黙って壊れる。スクリプトが以下を**失敗として報告**する:

- `__RequestVerificationToken` が見つからない → `stage=login` / `error=token_not_found`
- ログイン後にフォームが残っている → `stage=login` / `error=login_rejected`
- CSV が 0 バイト／想定のヘッダでない → `stage=download`

**「取れなかった」を成功として通さない。** ここを緩めると `last_to` が進んで取り漏れになる。

---

## 6. 失敗時の挙動（まとめ）

| 事象 | `last_to` | 原本CSV | 報告 |
|---|---|---|---|
| 正常（1 件以上） | **前進** | 削除 | ok |
| 正常（0 件） | **前進** | — | ok |
| 証明書が無い/期限切れ | 据置 | — | fail / `cert` |
| ログイン失敗 | 据置 | — | fail / `login` |
| CSV 取得失敗 | 据置 | — | fail / `download` |
| 取り込み API 失敗 | **据置** | **残す**（7日で削除） | fail / `intake` |
| `last_to` 更新失敗 | 据置 | 残す | fail / `state` |
| 保存先が OneDrive 配下 | 据置 | **書かない** | fail / `cleanup` |
| PC が落ちていた | 据置 | — | **記録なし**（§5.1 の `days_since_success` で検知） |

**「据置」＝次回が同じ範囲から取り直す＝取り漏れゼロ。**

---

## 7. Wellfort にお願いすること — **bat は 2 本だけ**

**発注者指示（2026-08-31）: 「何度も Wellfort 側に bat の実行を依頼するのは避けたい」。**
→ **① 偵察・初回テスト用 ／ ② 本番の自動実行用 の 2 本立て**にする。
**Wellfort 側の操作はダブルクリック 2 回で終わり。**

| | bat | 目的 | Wellfort の操作 |
|---|---|---|---|
| **①** | `デメカル初回セットアップ_v1.3.bat`<br>（**ファイル名に版が入る**＝担当者が最新版かを目で確認できる。実行時も画面と report.txt に「版 : recon-1.3」が出る） | **本番 bat を書くのに要る情報を 1 回で全部取る**＋②が使う資格情報の保存 | ダブルクリック → **ID/PW を 1 回入力** → 結果を返送 |
| **②** | `デメカル自動取得セットアップ.bat` | 本番スクリプトの設置＋タスク登録＋その場で 1 回試験実行 | ダブルクリック → ○/× を確認 |

**①で取り切るものを増やしてでも、往復を増やさない。** これが 2 本立ての眼目。

### ① 偵察・初回テスト（`scripts/demecal-recon.ps1`・実装済み）

配布は既存の口を流用する（新しい仕組みを作らない）:
`GET /api/ops/probe-bat?k=<PROBE_UPLOAD_TOKEN>&script=recon`
回収も既存の `POST /api/ops/probe-upload`。**サーバ側の新規実装なしで今日渡せる。**

| # | やること | 意図 |
|---|---|---|
| [0] | `C:\demecal\` を作る。**`OneDrive` を含むパスなら中止** | 本番と同じ置き場を先に確保（§4.4） |
| [1] | 証明書を **発行者CN=`demecal.net CA` かつ秘密鍵あり**で 1 枚に絞る | CN のベタ書きをしない（更新で変わる） |
| [2] | デメカル ID/PW を **DPAPI で暗号化保存**（`secrets\demecal.cred.xml`） | **②が再利用する**＝②で入力を求めない |
| [3] | `GET → __RequestVerificationToken → POST` でログイン | antiforgery の実地確認。失敗も 200 なので**フォーム消失**で判定 |
| [4] | ログイン後のリンクを列挙 → CSV ダウンロード画面の **form 構造**を採取 | **これが本命**。`action` / `method` / `input` の `name`・`type` / `select` の選択肢 |
| [5] | **[4] で見つけた form をその場で実行**（日付欄に **2000 年**を入れる） | 「もう一度実行してください」を無くす。確認画面が挟まる作りなら**その form も辿る** |
| [6] | 結果を `C:\demecal\recon\` に保存＋サーバへ送信 | メール返送でも可（送信失敗しても手元に残る） |

> **【recon-1.7 で確定 2026-09-01】① は担当者に何も入力させない。ID/PW は bat に焼き込む。**
>
> **停止点は段階報告で確定した**（WELLFORT_PC・2 回とも同一）:
> `起動` ✅ → `0-保存先` ✅ → `1-証明書` ✅（`CN=Q05-0010`・残り 833 日）→ **`2-資格情報` ❌**。
> キャンセルなら `Finish 1` が走り「すべて終わりました」が出るはずだが出ていないので、
> キャンセルでもない。原因は **`Get-Credential` が GUI のモーダルダイアログを開くこと**で、
> 黒い画面の背面に出ると担当者には「固まった」ようにしか見えない。
> 接続チェック(probe)が毎回届いていたのは**入力を一切求めないから**だった。
>
> **【発注者指示①】「ユーザーに入力してもらうのは無し。事前に ID/PW を渡してもらった意味がない」**
> — v1.5 で `Get-Credential`→`Read-Host` に変えたのは**入力方式を変えただけ**で、
> 入力させること自体が誤りだった。
>
> **【発注者判断②】「bat に平文で今回は構わない。専用PCで、PC に証明書が入っているので、
> bat 漏洩しても大きな問題じゃない」** — 実行時取得案（`/api/ops/demecal-cred`）は**撤回・削除**。
> 焼き込みのほうが **failure point が 1 つ少ない**（専用PC 側でのネットワーク取得が不要）。
>
> | | |
> |---|---|
> | 値の在処 | **Vercel env `DEMECAL_USER_ID` / `DEMECAL_PASSWORD`**。`.ps1` はプレースホルダのまま commit |
> | 注入 | 配布口 `/api/ops/probe-bat` が `buildProbeBat` で差し込む（トークンと同じ仕組み） |
> | 未設定時 | **配布が 500 で落ちる**（`build_failed`）。**動かない bat を配らない** — 差し込み漏れのまま配ると専用PC でまた `[2]` を通過できず 1 往復増える |
> | `'` を含む値 | `''` へエスケープ（`psQuote`）。TS 版・Python 版で同じ規律 |
> | 配布 bat の対話 | **0 件**（probe と同じ形） |
>
> **後始末**: 用が済んだら `PROBE_UPLOAD_TOKEN` と併せて
> `DEMECAL_USER_ID` / `DEMECAL_PASSWORD` も Vercel から消す（配布・回収・注入が同時に閉まる）。
>
> **【recon-1.3 で追加 2026-09-01】残る沈黙経路を全部塞ぐ。**
>
> v1.1 を**別 PC (証明書なし) で実走**させ、`[0]`→`[1]`→中止→**報告が届く**ことを実測。
> bat は自身を `Invoke-Expression` で丸ごとコンパイルしてから実行するので、
> **`[0]` が表示された時点でスクリプト全行の構文は正常**と確定した (構文エラー説は否定)。
> 受け口も 15KB の payload で HTTP 200 を実測 (サーバ側の拒否も否定)。
> それでも専用PCから届かないので、**残る経路を潰す**:
>
> | # | 沈黙経路 | 対処 |
> |---|---|---|
> | ① | 想定外の terminating error で `Finish` に来ない | **script scope の `trap`** で受けて `Finish 9` |
> | ② | `Get-Credential` が例外を投げる | try/catch で受けて `Finish 1` |
> | ③ | 送信が 1 回失敗しただけで諦める | **3 回 × 2 方式**(`Invoke-RestMethod` / 素の `HttpWebRequest`) |
> | ④ | 送信が落ちても理由が残らない | 例外文を**画面に出す**(担当者向けの枠として明示) |
> | ⑤ | 保存先 `C:\demecal\recon\` を見つけられない | **デスクトップにも置く** |
>
> ⑤ は運用上いちばん効く。接続チェックは**デスクトップ出力で実際に回収できている**実績があり、
> `C:\demecal\recon\` は今回初めて使うフォルダで「どこ？」になりやすい。
> 報告は PII 非含有 (ページ本文・hidden 値・CSV データ行を出さない設計) なので、
> §4.4 の「接続チェックがデスクトップに出すのは意図どおり」と同じ扱いでよい。
> **CSV 原本をデスクトップに置かない**という制約は変えていない。
>
> **【recon-1.2 で追加 2026-09-01】起動の合図を先に送る。**
>
> v1.1 でも実行の連絡を受けたのに実行ログAPI に **1 件も届かなかった**
> (`demecal-recon` 0 件・届いていたのは接続チェック 4 件のみ)。届かない理由が
> **①そもそも起動していない ②起動したが途中で落ちた ③送信だけ失敗した**
> のどれか区別できず、毎回 Wellfort に確認することになる。
> → **本処理の前に「起動しました」だけを 1 回送る** (`label=demecal-recon-start`)。
> 合図が届いて本報告が届かなければ **②③に確定**。合図も届かなければ **①**。
> 合図の送信は失敗しても本処理を止めない (診断用であって前提ではない)。
>
> 併せて **bat 側で PowerShell の stderr を `%TEMP%\demecal_error.txt` へ落とす**
> (`src/lib/probe-bat.ts` / `scripts/build-demecal-probe-bat.py` の head)。
> **構文エラーはスクリプトが 1 行も動かないので、スクリプト内では絶対に捕まえられない。**
> cmd 側で拾うしかない。stdout は触らないので画面表示は従来どおり。
>
> **【recon-1.1 で修正 2026-09-01】中止したときも必ず報告する。**
> recon-1.0 は [0]〜[2] の中止が `exit 1` で、**保存も送信もその手前**にあった。
> 実際に Wellfort が実行した後、実行ログAPI に recon の実行が **0 件**で、
> 「中止したのか／別の bat を実行したのか／送信だけ失敗したのか」を切り分けられなかった。
> → 全ての終了を `Finish` 関数に集約し、**どこで止まっても保存＋送信してから終わる**。
> 保存先が決まる前（[0] の中止）は `%TEMP%` へ逃がす。
> **往復を減らすのがこの bat の目的なので、沈黙で終わらせてはいけない。**

**PII を持ち出さない作りにしてある（重要）**

- **ページ本文を保存も送信もしない。** 抜くのは form のメタデータだけ。
  受診者一覧が載る画面があっても中身は出さない
- **hidden の値は出さない**（antiforgery トークン等が入るため）。存在だけ記録
- [5] は**結果が出ないはずの過去日付**で叩く。記録するのは
  **HTTPステータス／Content-Type／ファイル名／ヘッダ行／行数**だけ。
  **万一データ行が返ってもヘッダ行以外は捨てる**
- ID・パスワードは画面にもログにも出さない（保存は DPAPI 暗号化のみ）

### ②-0 v1.0 の実測 → ①の偵察レポートで真因確定（2026-09-02）

**実装は `scripts/demecal-daily.ps1`**（この節の旧名 `demecal-fetch.ps1` は同じもの）。

#### 症状（専用PC・v1.0・`WELLFORT_PC` 12:16）

```
[1] 証明書 OK（2028-12-12・残 832 日）　[2] 資格情報 OK　[3] ログイン OK
[4] 取得範囲 2026-08-29 〜 2026-09-02
    [1段目] /hanyou/start → 200 text/html
    [2段目] /hanyou/entry → 200 text/html
    [3段目] /hanyou/entry → 200 text/html      ← 以降おなじ
    [4段目] /hanyou/entry → 200 text/html
    [5段目] /hanyou/entry → 200 text/html
エラー: 画面を辿りましたが CSV が返りませんでした
```

**[1]〜[4] は全部通っている。** mTLS も antiforgery のログインも状態管理も動いた。
**1 段目 `/hanyou/start` も通っている**（応答に `action=/hanyou/entry` の form が在った＝進んだ）。
止まったのは **`/hanyou/entry` から先だけ**。`last_to` は前進していない（仕様どおり）。

#### 真因（①v1.9 の偵察レポートで確定・推測ではない）

`ops/probe/2026-09-02/demecal-recon~WELLFORT_PC~3a540e52…/report.txt` が
`/hanyou/entry` の form をこう記録している:

```
form#1: method=post action=/hanyou/entry
  input name=ID / DairitenCode / DairitenName / HanbaitenCode / HanbaitenName
  input name=DateFrom type=text        ← 日付はここ（start 側には無い）
  input name=DateTo   type=text
  input name=DataType     type=radio ×2
  input name=OutputHeader type=radio ×2
  input name=submitType type=hidden    ← ★これ
  input name=__RequestVerificationToken type=hidden
  button 確認
  button 戻る
```

**実行の指示は「ボタン」ではなく hidden `submitType` に入る。**
`確認`/`戻る` が `<button>` で、その onclick が JS で `submitType` に値を入れてから
submit する型（ASP.NET MVC でよくある作り）。
v1.0 は `submitType` を **HTML に書かれた既定値のまま**送っていた
＝ サーバから見て「何も指示していない」ので同じ画面が返る。**これが 4 回連続の正体。**

**先に立てた「`<select>`/`<button>` を読んでいないのが原因」は外れ**（R5・撤回）:

- `/hanyou/entry` に `<select>` は **1 つも無い**（選択は radio で、v1.0 も `checked` を送っていた）
- `確認`/`戻る` に `name` があるかは**この報告からは分からない**
  — ①の `Get-FormMeta` は `button` の**ラベルしか出力しない**（`demecal-recon.ps1:302`）。
  名前が無ければ、ボタンを送れるようにしただけでは**やはり進まなかった**
- 日付欄 `DateFrom`/`DateTo` は v1.0 の判定 `(?i)date|ymd|日付` に**当たっていた**＝送れていた

パーサの穴（`<select>`/`<button>`/`<textarea>` を読まない・`demecal-daily.ps1:186`）は
**①②で実装が食い違っていた実在の欠陥**なので直したが、**今回の停止の原因ではない。**

#### v1.1 / v1.2 での対処

**v1.2（本命）— hidden に入る値を「画面から読む」**

`next` 等をコードに埋めない（画面改訂で即死ぬ・CLAUDE.md）。代わりに
**そのページの JS が実際に代入している文字列**を拾い、押せるボタンと同格の候補として試す:

```
submitType.value='X' / .value = "X" / ["submitType"].value='X' / $('#submitType').val('X')
```

拾った値は `diag` に **`hidden submitType に JS が入れる値 = [back | confirm]`** の形で残す
（値は画面操作の識別子で受診者の情報ではない）。**拾えなければ拾えないと報告して止まる。**

**v1.1（併せて直した土台）**

- `Get-Forms` を①と同等に（`<select>` は selected／無ければ先頭、`<textarea>`、`<button>`、
  `<input type=submit|image>`）。**submit 系は `Fields` と分けて持つ**
- **同じ画面が返ったら次の候補で送り直す**（`Get-FormSig` の指紋）。
  使い切ったら「全部試したが進まない」と明示して落とす。**黙って回らない**
- **最初の候補は「何も押さない」**。v1.0 はそれで 1 段目を通っていたので、
  押す側へ全面的に切り替えて**通っていた段を壊さない**ため
- 試す順は 画面の並び順 →（見出しの無いボタン）→（戻る／取消系）。**候補は絞らない＝全部試す**
- 送る form を**先頭決め打ちにしない**（`Select-Form`）。ログアウト form を押し続けない
- CSV 判定に **`Content-Disposition: attachment`** を追加
- 上限 5 → **14**（候補を 1 つずつ試すぶん。段数でなく試行回数の上限）
- **`diag` を実行ログAPIへ送る**（§3.2）

#### 残る未確認（v1.2 を回せば `diag` に出る）

- `確認`/`戻る` に `name` があるか（①はラベルしか出さないので不明）
- `DataType` / `OutputHeader` の radio に `checked` が付いているか
  — 付いていなければブラウザ同様「送らない」ので、必須なら検証に落ちる。
  `diag` に `radio name=DataType (未チェック)` と出るので判別できる
- `確認` の次にもう 1 段（実行）があるか — recon は「確認画面から実行: 200 text/html」で終わっている

#### 検証（実サイトは未確認・証明書が専用PCにしか無い）

`[Parser]::ParseFile` 構文 OK ／ ①が記録した `/hanyou/entry` と同じ形の合成 HTML で
**`submitType` の候補 `confirm`/`back` を JS から抽出し、`confirm` を先に試す順に並べる**ことを実測 ／
radio は `checked` のものだけ送る ／ ログアウト form を選ばない ／
`astro check` 0 errors ／ `verify:intake-scope` OK ／ bat 生成 OK。

### ② 本番の自動実行（`demecal-fetch.ps1` ＋ セットアップ bat・未実装）

**①の結果を見てから作る**（form の `action`/`name` が確定するため）。

1. `demecal-fetch.ps1` を `C:\demecal\` へ設置
2. タスクを **XML で流し込み**（§4.3）。**タスクスケジューラの画面は開かせない**
3. **その場で 1 回実行して ○/× を表示**（黙って失敗すると数週間気づけない）
4. 資格情報は**①が保存済み**なので再入力なし。`LAB_INTAKE_API_KEY` は bat に注入して配布

**× のときに何が悪いかまで画面に出す**（証明書／ログイン／ネットワーク／保存先）。

---

## 8. 未確定（着手前に潰す）

| # | 事項 | 誰に |
|---|---|---|
| 1 | **ログイン後の CSV 一覧 URL とダウンロードの form/パラメータ**（HTML レベルの `action` / `name`） | **誰にも聞かない。スクリプトの初回実行が自分で報告する**（下記「①の扱いを訂正」） |
| 2 | 日付範囲が**報告日基準か採取日基準か**、反映遅延の日数（= `to = 当日 - N日` の N） | デメカル（先方確認） |
| 3 | デメカルの **ID / パスワード**の受け渡し方法 | Wellfort |
| 4 | 実行時刻（毎日 HH:MM）と `days_since_success` のしきい値 | Wellfort |
| 5 | **専用PCを常時ログオンのままにできるか**（できない場合のみ §4.3 の注記を再検討） | Wellfort |
| 6 | レート制限・アクセス時間帯・IP 制限 | デメカル（`demecal_auto_download_overview_spec.md §6`） |
| 7 | **`external_test_id`（＝`指図番号`）の採番タイミング・スキャン工程・突合ルール** | **設計は既にある**（下記「②の扱いを訂正」）。残るのは `id_management_and_correlation_spec.md §145` が自ら「未確定」と書いている 1 点だけ |

### ①の扱いを訂正（2026-08-31）

初版はこれを「専用PCで 1 回取得してもらう」＝**Wellfort への往復**として書いた。**過剰だった。**

- **画面手順はもう分かっている** … `demecal_attended_manual_guide.md` ステップ② ／
  `demecal_auto_download_overview_spec.md §2.1`
  （メニュー「データダウンロード」→「結果DL（汎用CSV）」→ 代理店 `Q05-0010` / 販売先 `000000` /
  日付範囲 / 検査結果=正常終了のみ / 項目見出し=出力する → 確認 → ダウンロード）。
  **足りないのは HTML レベルの `action` と `name` だけ。**
- **接続チェックの bat では取れない**のは事実（**設計上ログインしない**ため。
  取得できたのは `/account/login` のログイン**前**ページだけ）。
- **しかし人手で取り直す必要は無い。** ログインはスクリプトが行うので、
  **初回実行に「偵察モード」を持たせ、辿ったページの form 構造を実行ログAPIへ報告させる**
  （PII を含む CSV は取得しない）。次の実行から本番動作に入る。
- したがって **①はブロッカーではない。§9 の 6（スクリプト本体）に着手してよい。**

### ②の扱いを訂正（2026-08-31・発注者指摘）

初版は「`指図番号` から本人を特定する経路」を**未確定＝Wellfort／デメカルへ確認**として書いた。**誤り。**
**ID 連携の設計は既に存在する。**

| | 出典 |
|---|---|
| `指図番号` は **③検査会社の独自ID**。受け皿は **`lab_tests.external_test_id`**（`unique (lab_company_id, external_test_id)`） | `lab_data_reception_overview.md §5.1/§5.2` |
| **「受領時に `lab_tests` へ格納し内部 `id`/`diagnostic_user_id` と対応づける」**（照合・突合に使用） | `id_management_and_correlation_spec.md:131` |
| 会社ごとの様式差は `lab_companies.external_id_label` / `external_id_pattern`（regex）で吸収 | 同 :131 |
| **原則**: 内部 `diagnostic_user_id` を軸に、外部IDは**補助照合キー**。②③を軸にしない | 同 / 受取総合仕様 §5.1 |
| 想定フロー（将来）: 出荷時に `external_barcode` を印字/貼付 → 受取/返送でスキャン → 検査会社が `external_test_id` を採番 → **結果受領時に両IDを `lab_tests` に確定** | 同 :135 |

**つまり足りないのは実装であって仕様ではない。**
`external_test_id` の受領時格納が未実装（`lab_data_reception_overview.md §5.4` の #3・実測）。

**本当に未確定なのは 1 点だけ**で、それも ID 正本が自分で挙げている:
> 「`external_test_id`/`external_barcode` の**採番タイミング・スキャン工程・突合ルール**
> （キット個体IDの印字/貼付方式＝POS仕様）」 — `id_management_and_correlation_spec.md:145`

デメカルに即して言えば、**受領した `指図番号` を誰の行に結び付けるか**の一点。
出荷時に対応が取れていれば突合するだけ、取れていなければ
`kit_shipments` の回（`subscription_year/seq`）＋ CSV の 性別/生年月日/採血日 で照合することになる。
**ここは設計判断であって先方確認ではない。**

---

**着手順の結論**: **1〜5 に加えて 6 も着手できる**（①がブロッカーでなくなったため）。
9（本人写像）は **ID 正本の設計に沿って実装する**もので、
先方回答を待つ必要は無い（突合ルールの決めだけ社内で確定させる）。

---

## 9. 実装 TODO（こちら側）

| # | 内容 | 状態 |
|---|---|---|
| 1 | `LAB_INTAKE_API_KEY` の認可を `api-auth.ts` に実装し、3 つの口だけに通す（§3.1） | **未** |
| 2 | intake キーのスコープ回帰チェック（他の admin API が通ったら落とす） | **未** |
| 3 | `/api/admin/demecal-run`（実行ログ・GET/POST）（§3.2） | **未** |
| 4 | wellfort-site admin に自動取得の状態表示（§5.1） | **未** |
| 5 | wellfort-site に見張り用 GitHub Actions（§5.2） | **未** |
| 6 | `demecal-fetch.ps1` 本体（§4.1）＋**初回の偵察モード**（form 構造を実行ログへ報告） | **未** |
| 7 | **① 偵察 bat**（`scripts/demecal-recon.ps1` ＋ `?script=recon` 配布） | **実装済** |
| 7b | **② 本番セットアップ bat**（`demecal-fetch.ps1` 設置＋タスク登録＋試験実行）※①の結果を見てから | **未** |
| 8 | ~~同一範囲の再取得が S3 上で上書きになることの確認~~ → **確認済み: 上書きされない**（§2 の ⚠）。再取得で Elith へ二重納品になるので**冪等にする**（`client_id` を時刻採番から本人 ID へ、または取り込み済み範囲の重複排除） | **未** |
| 9 | **`external_test_id`（＝`指図番号`）の受領時格納と本人への対応づけ**。**設計は `id_management_and_correlation_spec.md:131,135` に既にある**（受け皿カラムも実在）。いまは `test-<時刻>-<連番>` の仮 ID で Elith へ出ている | **未** |

**1〜6 は着手できる**（#1 はスクリプト自身が解決する）。7 は 6 の後。

**8・9 は無人化の前提**（§2 の ⚠）。attended なら人が都度見ているので気づけるが、
**無人だと仮 ID の重複納品が黙って積み上がる**。順序としては **9 → 8 → 6/7** が自然
（本人 ID が決まれば S3 キーが安定し、8 の冪等性も自然に満たせる）。
