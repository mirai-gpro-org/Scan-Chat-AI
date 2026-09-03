# デメカル 血液CSV 無人定期取得 仕様書

**確定: 2026-08-31・発注者判断「最初から無人で定期実行でいく」**

この文書が**無人運用の正本**。`demecal_rpa_operation_design.md` は PAD 前提の旧設計
（§1 役割分担・§3 attended は生きているが、**§4 unattended はこの文書が上書きする**）。

段階導入案（まず手動ダブルクリック → 安定後に自動化）は**発注者判断で採らない**。
以下はすべて「初回から無人」を前提に組んである。

---

## ⚠ 2026-09-03 scope correction（発注者指示）— この文書の有効範囲

> この文書のうち Demecal acquisition の正本として現在有効なのは、
> CSV取得・取得範囲・last_to・0件・scheduler・monitoring・fail-closed・PII取扱いのみ。
>
> 本人紐付け / diagnostic_user_id / mapping / DB / Elith JSON /
> Elith S3 / 後段の冪等性は別セクションへ移管済み。
>
> 最新のPhase C定義は demecal_recovery_plan_20260902.md §7 を優先する。

**この文書は「無人運用の正本」と冒頭に書いてあるため、旧スコープの active な指示が残っていると
今後の実装者を誤誘導する。** そこで、移管済みの範囲を指している記述には以下の注記を入れてある
（§2 / §3.1・§3.3 / ②-6 / §8）。

**実測履歴・過去の調査記録は削除しない。** 移管された論点も「そのとき何を根拠にそう考えたか」の
記録として価値があるので、消さずに注記だけを添える。ただし**それらを取得 Phase C の
完成条件・ブロッカーとして読まないこと。**

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

> **【2026-09-03 scope correction】この ⚠ ブロックのうち、本人紐付け（`指図番号` → `diagnostic_user_id`）と
> Elith への二重納品を「無人化の前に潰す」としている部分は、歴史的記録。取得 Phase C の blocker ではない。
> 別セクションへ移管済み**（`demecal_recovery_plan_20260902.md` §7.0）。
> ここで有効なのは **`last_to` の単調前進**（取り込み成功時にだけ前進・失敗時に前進させない）だけで、
> それが取得 Phase C の C-1 になる。

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

> **【2026-09-03 scope correction】この表の「通る口」に挙がっている `/api/admin/elith-blood-csv`
> （＝`elith-blood-csv.ts`）は、後段インターフェースの旧設計。新しい取得 runner の完成条件には含めない。**
> `LAB_INTAKE_API_KEY` 自体は取得スコープで有効（専用PC に `ADMIN_API_KEY` を置かないため必須）だが、
> **どの口に通すかは後段の設計が決まってから確定する**。取得スコープで確実に要るのは
> `demecal-state`（`last_to`）と `demecal-run`（実行ログ）の 2 つ。

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

> **【2026-09-03 scope correction】この表の `POST /api/admin/elith-blood-csv`（CSV → `BloodTestData` JSON 群 → S3）は、
> 後段インターフェースの旧設計。新しい取得 runner の完成条件には含めない**
> （Elith JSON / Elith S3 は別セクションへ移管済み・`demecal_recovery_plan_20260902.md` §7.0）。
> **取得スコープで有効なのは `GET/POST /api/admin/demecal-state`（`last_to` の単調前進）だけ。**
> 「原本CSVはサーバにも S3 にも保存しない（PII）」は取得スコープでもそのまま有効。

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

#### 操作の録画で確定したこと（2026-09-02・Wellfort 提供の画面録画 2分50秒）

**推測が要らなくなった部分。以下はすべて映像からの実測。**

**画面は 3 段**（recon の記録とも一致）:

| 段 | URL | 中身 | 押すもの |
|---|---|---|---|
| 1 | `/hanyou/start` | 代理店 `Q05-0010`（読み取り専用）／販売先 `000000` — **どちらも入力済み** | **次へ** |
| 2 | `/hanyou/entry` | **日付範囲（必須・初期は空）**／検査結果／項目見出し ＋ ダウンロード履歴 | **確認** |
| 3 | `/hanyou/entry`（同じ URL） | 条件のサマリと **件数 18 件** の確認画面 | **ダウンロード** |

**3 段目も URL は `/hanyou/entry`。** URL では 2 段目と区別できない
→ `Get-FormSig` が**項目名の集合**で判定しているのは正しい（確認画面は入力欄が消える）。

- **日付は `yyyy/MM/dd` を直接タイプできる**（カレンダーも出るが手入力可）。実測 `2026/01/01`〜`2026/06/30`。
  ②が送っている形式と一致。
- **日付範囲は「採血日」ではなく「結果承認日」で絞られる。** 実測: `2026/01/01〜2026/06/30` の指定で
  **採血日 `20251225` / `20251223` / `20251228`（範囲外）** の行が返り、**結果承認日は `20260106`（範囲内）**。
  → **`last_to` は「結果承認日でここまで取り込み済み」の意味**。採血日ではない。
  単調前進の前提（後から遡らない）は結果承認日でも成り立つ。
- 検査結果は既定「正常終了のみ」のまま運用されている（担当者は触っていない）。

**【最重要】項目見出しの既定は「出力しない」。担当者は毎回「出力する」に変えている。**

- 取り込み側 `src/lib/elith-blood-csv.ts:221` は **1 行目をヘッダとして列名で引く**
  （`指図番号` / `性別` / `生年月日` / `採血日` / `結果承認日` / `結果項目数`）。
- **ヘッダ無しで取ると列が 1 つも引けず、取り込みが丸ごと壊れる。**
  しかも例外にならず「空のバンドルが並ぶ」形で**静かに壊れる**のがまずい。
- ②は radio の `checked` を尊重する作りなので、**放っておくと必ずヘッダ無しになる**。
  → v1.3 で **ラベルが「出力する」の選択肢へ切り替える**（値は画面から読む）＋
  **送信前に 1 行目へ `指図番号` があるか検査**して、無ければ送らず落とす（`last_to` も進まない）。

**CSV の中身（列）**: `レイアウトID`(=KEKKA) / **`指図番号`** / 姓 / 名 / 姓かな / 名かな / 性別 /
生年月日 / 電話番号 / 〒番号 / 都道府県 / 住所1 / 住所2 / メールアドレス / 商品CD / プログラム… /
代理店番号 / 二次店番号 / 検査グループ / 採血日 / 結果承認日 / 備考半角 / エラーコード / エラー内容 /
**結果項目数**(=76) / 項目名1 / …（以降 3 列 × 項目数の横持ち）。

- **`指図番号` の実値は 15 桁前後の数値**（Excel が `2.02E+14` と丸めて表示）。
  fixture の `ORD-0001` は**当社が作った架空値**なので、実データの形とは違う。
- **完全な PII**（氏名・カナ・生年月日・電話・郵便番号・住所・メールアドレス）。

**ファイル名の規則**: `Q05-0010-000000result_{YYYYMMDD}_{件数}.csv`
（例 `Q05-0010-000000result_20260701_18.csv`）。`{YYYYMMDD}` は**ダウンロード日**、
`{件数}` は履歴テーブルの件数と一致。**同じ日に複数回落とすと件数が違えば別名になる**。

**【PII 運用の実態・要対処】保存先は「ダウンロード」フォルダ。取り込み後に削除されていない。**

- CLAUDE.md の【未確認】「現在 CSV が実際どこに落ちているかは未確認」は**これで確定**＝
  ブラウザ既定の**ダウンロードフォルダ**。
- エクスプローラーに **2026-02 以降の CSV が 15 本前後そのまま残っている**
  （`20260203`×3 / `20260408`×2 / `20260513`×2 / `20260525` / `20260527` / `20260602` /
  `20260605` / `20260612` / `20260622` / `20260701`）。
  `demecal_attended_manual_guide.md:114,127` の「取込後に削除」は**実行されていない**。
- OneDrive は「太郎 - 個人用」で接続されているが、**デスクトップ/ドキュメント/ピクチャ/ミュージック/
  ビデオ/ダウンロード に雲アイコンは付いていない**（クイックアクセスのピン留めのみ）。
  → **ダウンロードフォルダが OneDrive へ同期されている様子は無い**。ただしアイコンだけでは
  決定的でないので、**「同期されていない」と断定はしない**（確認は実フォルダのパス）。
- **②は `C:\demecal\` に落として送信後に削除する**ので、②へ移行すればこの残置は増えない。
  **既に溜まっている分の扱いは Wellfort の判断**（消してよいか確認する）。

#### v1.3 も失敗した (2026-09-02) — **偵察の設計ミス**

```
[1段目] /hanyou/start → 200    [2段目] /hanyou/entry → 200    [3段目] /hanyou/entry → 200
エラー: 同じ画面から進めません (候補 1 通りを全て試行)
```

**「候補 1 通り」= 押せるものが 1 つも見つからなかった**（`(押さない)` だけ）。つまり

- `確認` / `ダウンロード` に **`name` 属性が無い**（付いていれば候補になる）
- `submitType` に入る値が **ページ本文の JS には書かれていない**（外部 .js か別の仕組み）

**なぜここまで分からなかったのか（=こちら側の設計ミス）**

①(recon) は **`<button>` のラベルしか出力していない**（`demecal-recon.ps1:302`）。
`name` も `onclick` も落としていた。動画も**画面は写るが HTML は写らない**。
つまり **①も動画も「押し方」を持ち帰れない作りだった** — 材料が足りないまま
毎回「たぶんこう」で 1 手ずつ試すことになり、**そのたびに Wellfort の実行を 1 回消費した**。

**`probe-upload` は最初からページ本文 (`page`) を受け取れる**
（ログイン画面では実際に使っていて `has_page_html: true`）。
**汎用CSV の画面でもそれをやっておけば、この往復は全部不要だった。**

#### v1.5 の対処 — **失敗したら「骨格」を必ず持ち帰る**

もう推測で 1 手ずつ試さない。**download 段で詰まったら、その画面の骨格を自動で回収する**
（`Send-Skeleton` → `POST /api/ops/probe-upload`・label `demecal-skeleton`）。
**成功した回は何も送らない。**

送るのは次の 3 つ**だけ**で、**テキストノードは 1 文字も載せない**:

1. form 内の `<input>/<select>/<option>/<button>/<label>/<textarea>` の**タグそのもの**
2. **inline `<script>` の中身**（押し方はここにしか書かれていない）
3. 外部 `<script src>` の**一覧**

→ **ダウンロード履歴の表や受診者名は構造上入らない**（合成 HTML で実測: 氏名 false /
電話 false / 履歴表 false / `val('confirm')` は true = 要るものだけ残る）。
hidden の value も含むが、antiforgery トークンは 1 回きりで回収時には無効。

併せて v1.4 で **外部 .js まで値を探しに行く**ようにした（定番ライブラリは除外・最大 6 本）。
これが当たれば v1.5 は骨格を送らずそのまま通る。

#### 真因確定 (2026-09-02・骨格を読んで判明) — **押し方ではなく、送っている値が壊れていた**

v1.5 が持ち帰った骨格に答えがあった。**`/hanyou/start` の form**:

```html
<button id="btnSubmit" type="button" onclick="dispLoading('処理中...'); submit();">次へ</button>
<input type="hidden" id="OutputHeader" name="OutputHeader" value="True" />
<input readonly type="text" id="DairitenName" name="DairitenName"
       value="&amp;amp;amp;#x682A;&amp;amp;amp;#x5F0F;&amp;amp;amp;#x4F1A;&amp;amp;amp;#x793E;" />
```

**1. 押し方は最初から正しかった。** `btnSubmit` は **name を持たず、ただ `submit()` を呼ぶだけ**。
`submitType` に値を入れる JS も無い。**つまり「何も押さずに form をそのまま送る」が正解**で、
v1.1〜v1.5 の候補探し (ボタン name / `submitType` の値 / 外部 .js の走査) は
**全部この画面には存在しないものを探していた**。

**2. 真因 = HTML 実体参照をデコードせずに送り返していた。**
`DairitenName` の値が **4 重にエスケープ**されている。初回 GET は `&#x682A;`(1 重) なので、
**1 回 POST するごとに 1 段増えた = こちらが値を壊しながら 3 回送った**証拠
(`[System.Net.WebUtility]::HtmlDecode` を 4 回かけて「株式会社」に戻ることを実測)。

3 段目の応答は **`action="/hanyou/start"` の form**、つまり **1 段目へ突き返されていた**。
`HanbaitenCode`/`HanbaitenName` も空になっている (動画では `000000`/株式会社ウェルフォートが
埋まっていた)。壊れた値を受け取ったサーバが、先頭の画面へ戻していた。

`Get-FormSig` が「1 段目と同じ画面」と判定して候補を使い切り、
**「候補 1 通りを全て試行」で止まっていた** — ログの読み方も辻褄が合う。

#### v1.6 の対処

`Html-Decode`（`[System.Net.WebUtility]::HtmlDecode`）を通してから送る。
**ブラウザと同じ 1 回だけ**デコードする (2 回やると別の壊し方になる)。
適用先は `<input value>` / `<option value>` / `<textarea>` の中身 / `<button value>` /
ログインの antiforgery トークン = **属性値を取り出す全経路**。

実測 (骨格が示した form をそのまま再現): `DairitenName` = 「株式会社」で送られる /
`token` の `&amp;` が `&` に戻る / **押せる候補は 0 件** (btnSubmit に name が無いので候補にならないのが正しく、
「押さない」でそのまま送られる)。

#### この 3 往復から学んだこと (同じ轍を踏まないために)

- **①(recon) が「押し方」を持ち帰れない作りだった**のは事実だが、**それは真因ではなかった**。
  真因は**送信値の破壊**で、これは**画面の骨格 (タグの生の value) を見て初めて分かる**。
- **症状 (同じ画面が返る) から原因を推測して 1 手ずつ試す**のは、外部サイト相手には成立しない。
  **最初から生の HTML を持ち帰る**のが唯一の正しい進め方だった。
  `probe-upload` は最初からそれができた (`page` フィールド・ログイン画面では実際に使っていた)。
- **今後、外部画面を自動化するときは「1 回目の偵察で form の生タグと script を回収する」を必須にする。**

#### 残る未確認（v1.6 で通れば無くなる）

- `確認`/`戻る`/`ダウンロード` に `name` があるか（①はラベルしか出さないので不明）
- ラジオのラベルが HTML でどう書かれているか（`<label for>` / 入れ子 / 素のテキスト の 3 通りに対応済み。
  どれにも当たらなければ「出力する」へ切り替えられないが、**ヘッダ検査が止める**）
- `submitType` に JS が入れる実際の値（`diag` に `hidden submitType に JS が入れる値 = […]` と出る）

#### 検証（実サイトは未確認・証明書が専用PCにしか無い）

`[Parser]::ParseFile` 構文 OK ／ ①が記録した `/hanyou/entry` と同じ形の合成 HTML で
**`submitType` の候補 `confirm`/`back` を JS から抽出し、`confirm` を先に試す順に並べる**ことを実測 ／
radio は `checked` のものだけ送る ／ ログアウト form を選ばない ／
`astro check` 0 errors ／ `verify:intake-scope` OK ／ bat 生成 OK。

### ②-1 立て直し — daily は凍結し、決定論の 3-state へ作り替えた（2026-09-02・Phase A）

**正本はこの文書ではない。`docs/lab/demecal_recovery_plan_20260902.md` が正本**
（発注者が ChatGPT/GPT-5.6 Sol と決めた立て直し計画）。ここは実装の記録だけ。

**やめたこと**: v1.0〜v1.7 は「失敗 → 診断を足す → 現地でもう一度実行してもらう」を
4 回繰り返した。専用PC の実行は**Wellfort 役員に依頼する高コストな本番相当テスト**であって
デバッグ工程ではない（計画 §0）。**実機テストは、手元で固めた結論を確かめる最終検証工程にする。**

- **`daily-1.7` は凍結**。ファイルは残すが**配布口を閉じた** —
  `GET /api/ops/probe-bat?script=daily` は **409** を返し、計画の場所を案内する
  （意思だけでは同じ反復が再発するので機械で止める）。
- **新しい `scripts/demecal-verify.ps1`（`verify-1.0`）= verify-only の疎通確認**。
  配布は `?script=verify`。**Phase A のレビューが通るまで現地では実行しない。**

**探索器をやめた**（計画 §3）。daily は「押さない→候補1→候補2→戻る/cancel→`MaxHops` まで反復」
だったが、業務サイトで総当たりするのは fail-closed ではない。新方式は**段数 3 の固定**で、
各段で期待した状態かを機械判定し、違えば**別の操作を試さず即 STOP**する。

| | 判定（**URL では見ない**。B と C は同じ `/hanyou/entry` になり得る） | 送るもの |
|---|---|---|
| STATE B | `DateFrom`+`DateTo` が在り、**`DataType` が radio** | 日付／検査結果`正常終了のみ`／項目見出し`出力する` を明示して「確認」 |
| STATE C | `ダウンロード` の押しどころが在る | 「ダウンロード」だけ |
| STATE A | `HanbaitenCode` が在り、日付欄が無い | 販売先 `000000` を**画面の選択肢から**選んで「次へ」 |

**判定順は B → C → A**（レビュー指摘 2026-09-02）。確認画面が `HanbaitenCode` を
hidden で持ち回り日付を持たない形のとき、A を先に見ると **C を A と誤判定して 1 段目へ戻ろうとする**。
「ダウンロードの押しどころが在る」は C にしか無い特徴なので A より先に見る。

**form の選び方も探索にしない**（同レビュー）。「token 以外の項目が最も多い form を採る」
というヒューリスティックは廃止した — 検索窓のような decoy が対象より項目を多く持てば
そちらを掴む。**各段で全 form を判定し、期待状態に一致する form が「ちょうど 1 件」の
ときだけ採用**する。0 件でも複数件でも fail-closed。

- **業務値は契約**（計画 §5.2 A-2）。`Q05-0010` / `000000` / `正常終了のみ` / `出力する`。
  **値は画面の option・radio から取る。無ければ FAIL。代替値を選ばない。**
  「いま checked だからそのまま」も不可（**項目見出しの既定は「出力しない」**）。
- **押し方も推測しない**。押すボタンを見出しで 1 つに決め、**そのボタン自身の `onclick`** だけを読む
  （外部 .js は見ない・候補を並べない）。決まらなければ
  `STATE_B_CONFIRM_ACTION_UNKNOWN` / `STATE_C_DOWNLOAD_ACTION_UNKNOWN` で止まり、
  画面の骨格（タグと script のみ）を 1 回だけ持ち帰る。
- **CSV は `RawContentStream` から byte[] を取る**。Windows PowerShell 5.1 の `$r.Content` は
  文字列で、byte[] として扱うと壊れる。取った byte[] で Shift_JIS デコード／SHA-256／
  バイト数／行数／必須ヘッダ（`指図番号`/`結果承認日`/`結果項目数`）を見る。
  ファイル名は `Q05-0010-000000result_YYYYMMDD_N.csv` の規則で照合。**データ 0 件は正常**。
- **verify-only が禁止するのは「業務データの write」**（レビューで言い方を訂正 2026-09-02）。
  「一切書かない」ではない — **非PII の診断 POST は在るべきもの**で、無くすと無人運用で
  黙って失敗する。
  - **禁止**: `elith-blood-csv`（BloodTestData / S3 本番投入）／`demecal-state`（`last_to`）の
    読み書き／CSV のディスク保存（**ファイルを 1 つも作らない**）／CSV 本文の送信。
  - **許可**: `/api/admin/demecal-run`（非PII の実行ログ）／**失敗時のみ**
    `/api/ops/probe-upload`（画面の骨格。タグと script だけで本文テキストは載せない）。
  - 機械保証は 3 本立て: **禁止語の静的検査**（`elith-blood-csv` / `demecal-state` /
    `WriteAllBytes` / `Set-Content` / `New-Item` / `csvBase64` / `MaxHops` / `Select-Form` …）
    ＋ **診断 POST が残っていることの検査** ＋ **`Send-Skeleton` の直後が必ず `Finish 1`**
    （= probe は失敗経路だけ）。

**検証（実サイトは未実施。証明書が専用PCにしか無い）**

`npm run verify:demecal-flow` = **56 件 PASS**（`scripts/tests/demecal-flow.tests.ps1`）。
配布される `.ps1` を **`-LibOnly` で dot-source して実物を呼ぶ**（判定を JS へ移植しない）。
テスト中は `Invoke-WebRequest`/`Invoke-RestMethod` を投げる関数で覆い、
**純粋関数が 1 回でも通信したら落ちる**ようにしてある。
fixture は完全架空（`scripts/tests/fixtures/demecal/`・CSV は実 Shift_JIS）。

**このテストが即日 2 件のバグを捕まえた**（どちらも現地で 1 回消費するはずだったもの）:

1. **「ダウンロード」が消えて「戻る」だけが残った画面で、戻るを押しかけていた** —
   「押しどころが 1 つならそれを押す」という逃げ道があった。逃げ道ごと削除。
2. 手続き部より前で `Join-Path 'C:\...'` を評価しており、**Windows 以外では
   読み込み自体が落ちていた**（fixture テストが dot-source できない）。

**レビューで 2 件を追加修正した**（2026-09-02・上記の判定順と form 選択）。
どちらも fixture と negative test を足してある（`state-c-hidden-seller.html` /
`state-b-decoy.html`）。判定順を元に戻す退行を注入すると **2 件落ちる**ことを確認済み。

**未確認のまま残していること**（推測で埋めない・計画 §4.3）:

- STATE B の「確認」／STATE C の「ダウンロード」の**実際の DOM 契約**
  （`name` の有無・`onclick` が `submitType` に入れる値）。骨格は `/hanyou/start` の分しか無い。
- 本番 CSV 応答の `Content-Type` / `Content-Disposition` の実値。
- `HanbaitenCode` が `<select>` か否か（動画では「プルダウン」）。
  select でも radio でもなく、現在値も `000000` でなければ
  `STATE_A_SELLER_000000_NOT_FOUND` で止まる。

**Phase B（現地 1 回・verify-only）は ChatGPT の GO を待つ。** それまで Wellfort に依頼しない。

### ②-2 Phase B 1 回目の実測と STATE A の修正（2026-09-03・`verify-1.1`）

**正本は `docs/lab/demecal_recovery_plan_20260902.md`。** ここは実測の記録。

専用PC で `verify-1.0` を **1 回だけ**実行。結果:

```
cert OK / credentials OK / login OK
STATE_A_SELLER_000000_NOT_FOUND
```

**Elith/S3 への書き込み・`last_to` の更新・CSV の保存は 1 件も発生していない**（verify-only）。
失敗時の骨格（タグと script のみ）を自動回収できたので、**現地で 2 回目を回さずに原因を確定できた**。

#### 実測した STATE A の構造（骨格 `2026-09-03` / `truncated:false` / form 1 個）

```html
<form class="form-horizontal" action="/hanyou/start" method="post">
<input type="hidden" id="ID" name="ID" value="0" />
<input type="hidden" id="OutputHeader" name="OutputHeader" value="False" />
<input readonly type="text" id="DairitenCode"   name="DairitenCode"   value="Q05-0010" />
<input readonly type="text" id="DairitenName"   name="DairitenName"   value="&#x682A;…" />  <!-- 1 重 -->
<input readonly type="text" id="HanbaitenCode"  name="HanbaitenCode"  value="" />           <!-- 空 -->
<input readonly type="text" id="HanbaitenName"  name="HanbaitenName"  value="" />           <!-- 空 -->
<button type="button" class="dropdown-toggle" data-toggle="dropdown">
<button type="button" id="btnClearHanbaiten">
<button id="btnSubmit" type="button" onclick="dispLoading('処理中...'); submit();">
<input name="__RequestVerificationToken" type="hidden" value="…" />
```

- **`<select>` 0 / `<option>` 0 / radio 0。** 販売先は標準の選択 UI ではない。
- 販売先の選択肢は inline script が **`GET /hanbaiten?dairitenCode=<代理店>` の JSON
  （`{code,name}` の配列）**から `<ul id="comboHanbaiten">` に生成し、
  `fillHanbaiten()` が **readonly の 2 つの input へ `.val()` で書き込む**。
  → **「人がプルダウンで選ぶ」の実体は input への値書き込み。**
- POST されるのは name を持つ **7 つだけ**（`btnSubmit` は name 無しなので送られない）。
  `readonly` は `disabled` と違い送信対象に**含まれる**。

**`verify-1.0` の停止は実装どおりの正しい fail-closed だった**（判定の誤りではない）。
select の option / radio / 現在値 の 3 経路しか見ておらず、**そのどれも実在しなかった**。

#### `verify-1.1` の修正（3 点）

1. **販売先の解決を JSON 由来にした。** select/radio 探索は本番経路から削除。
   STATE A 確認後、**同じ証明書・同じセッションで `GET /hanbaiten?dairitenCode=…` を 1 回だけ**実行し、
   `code == "000000"` が**ちょうど 1 件**かつ `name` が非空のときだけ
   `HanbaitenCode` / `HanbaitenName` に入れる。
   **代替販売先・先頭要素・部分一致は禁止。** 0 件 / 複数 / name 空 / JSON 不正 / 通信失敗はすべて fail-closed
   （新コード `STATE_A_HANBAITEN_FETCH_FAILED` を追加）。
   **一覧そのものは diag にも probe にも出さない** — 出すのは HTTP status / 件数 / `000000` の一致件数 だけ。
2. **plain submit の判定からボタン総数を外した。** 実 STATE A はボタンが **3 個**あるため、
   旧条件「押しどころが 1 個なら plain」は実サイトで永久に成立しない。
   見るのは**見出しで 1 つに決まった、そのボタン自身**だけ:
   name 無し ＋ hidden への値設定なし ＋ **onclick が実際に `submit()` を呼ぶ** → `plain`。
   **`submit()` を呼ばない未知の onclick は plain 扱いせず STOP。**
3. **`state-a.html` fixture を実測構造へ置換**（架空の select を廃止）＋ `hanbaiten.json`
   （完全架空・`000000` と別コードを含む）を追加。

#### 検証（実サイトは未実行）

`npm run verify:demecal-flow` = **74 件 PASS**。退行注入で**3 件とも落ちることを確認済み**:

| 注入 | 落ちるテスト |
|---|---|
| `Resolve-Press` を「ボタン 1 個なら plain」に戻す | T09 / T10 / T10a / T10b |
| `Select-Hanbaiten` を「先頭要素を採る」に変える | T11 / T11f（＋連鎖で T09 系） |
| 販売先名をコードに埋め込む | T08g / T08h |

`verify:ps1-order` OK ／ `verify:intake-scope` OK ／ `ParseFile` OK ／ `astro check` 0 errors ／
bat 生成 OK（`デメカル疎通確認_v1.1.bat`・placeholder 残り無し）。

**Wellfort への再実行は依頼していない。** Phase C にも進んでいない。

#### この回で残った未確認

- `GET /hanbaiten` が返す JSON の実体（`000000` を含むか・`code` の書式）。**未取得**。
- 初期ページの `<ul id="comboHanbaiten">` が空か、サーバ側で描画済みか
  （骨格が `<ul>/<li>/<a>` を捕捉しないため判定不能。`demecal-verify.ps1` の `Get-Skeleton` の
  捕捉対象は `input|select|option|button|label|textarea`）。
- ページ読み込み時に `loadHanbaitens()` が呼ばれるか（捕捉した inline script には呼び出しが無い）。
- `HanbaitenCode` を空のまま POST したときのサーバの挙動。**未試行**。

### ②-3 Phase B 2 回目の実測と STATE B の修正（2026-09-03・`verify-1.2`）

**正本は `docs/lab/demecal_recovery_plan_20260902.md`。** ここは実測の記録。

専用PC で `verify-1.1` を **1 回だけ**実行。結果:

```
cert OK / credentials OK / login OK
STATE A → HTTP 200 / text/html; charset=utf-8
STATE_B_CONFIRM_ACTION_UNKNOWN
```

**Elith/S3 への書き込み・`last_to` の更新・CSV の保存は 1 件も発生していない**（verify-only）。
今回も失敗時の骨格を自動回収できたので、**現地で 3 回目を回さずに原因を確定できた**。

**STATE A は通った。** = `GET /hanbaiten?dairitenCode=Q05-0010` が `code == "000000"` を
**ちょうど 1 件**・`name` 非空で返し、その値を載せた POST をサーバが受理して次の画面へ進んだ、
ということ（②-2 の未確認 1 件目がこれで埋まった）。次画面の `HanbaitenCode` に `000000` が
入って返ってきている。

#### 実測した STATE B の構造

```html
<form class="form-horizontal" name="myform" action="/hanyou/entry" method="post">
<input type="hidden" id="ID" name="ID" value="0" />
<input readonly type="text" id="DairitenCode"  name="DairitenCode"  value="Q05-0010" />
<input readonly type="text" id="DairitenName"  name="DairitenName"  value="&#x682A;…" />
<input readonly type="text" id="HanbaitenCode" name="HanbaitenCode" value="000000" />
<input readonly type="text" id="HanbaitenName" name="HanbaitenName" value="&#x682A;…" />
<input type='text' id="DateFrom" name="DateFrom" value="" />   <!-- type だけシングルクォート -->
<input type='text' id="DateTo"   name="DateTo"   value="" />
<input type="radio" value="0" checked id="DataType" name="DataType">すべて
<input type="radio" value="1"         id="DataType" name="DataType">正常終了のみ
<input type="radio" value="False" checked id="OutputHeader" name="OutputHeader">出力しない
<input type="radio" value="True"          id="OutputHeader" name="OutputHeader">出力する
<button id="btnSubmit" type="button">確認</button>   <!-- onclick 属性は無い -->
<button id="btnBack"   type="button">戻る</button>   <!-- onclick 属性は無い -->
<input id="submitType" name="submitType" type="hidden" />   <!-- value 属性が無い -->
<input name="__RequestVerificationToken" type="hidden" value="…" />
```

inline script（`<script src>` ではない側）:

```js
$("#btnSubmit").click(function () { dispLoading('処理中...'); document.myform.submit(); });
$("#btnBack").click(function () { $('#submitType').val('back'); document.myform.submit(); });
```

- **文字列 `confirm` は骨格全体で 0 件。** 「確認ボタン＝`submitType=confirm`」は**実在しない**。
  `verify-1.1` までの fixture が持っていた `submitType='confirm'` は**こちらの創作**なので撤回した。
- **`submitType` を触るのは「戻る」だけ。**「確認」は値を入れずに form を送る
  → **ブラウザ相当の POST は `submitType` を空文字のまま送る**。
- ボタンはどちらも `onclick` 属性を持たず、ハンドラは jQuery の `.click()` で後から付く。
- radio は `id` が重複している（`DataType` が 2 つ・`OutputHeader` が 2 つ）ので、
  **radio の特定に id は使えない**（ラベルと `name` で見る）。
- `submitType` の hidden に `value` 属性が無い = **既定値は空文字**。

**`verify-1.1` の停止も実装どおりの正しい fail-closed だった**（判定の誤りではない）。
汎用の `Resolve-Press` は**そのボタン自身の `onclick` 属性**しか読まないので、
属性が存在しない実サイトでは原理的に押し方が決まらない。

#### `verify-1.2` の修正

1. **STATE B を専用 contract にした**（`Test-StateBContract` / `New-StateBRequest`）。
   「確認」については**汎用 `Resolve-Press` を使わない**。機械確認するのは 7 点:
   form の `name="myform"` / `DateFrom`+`DateTo` の存在 / `submitType` が hidden で存在 /
   ラベル「正常終了のみ」がちょうど 1 件 / ラベル「出力する」がちょうど 1 件 /
   `id=btnSubmit` と `id=btnBack` がちょうど 1 件ずつ / `btnSubmit` が `type=button` で name 無し。
   加えて**今回実測した inline script のハンドラ契約**（btnSubmit は form を送るだけで
   `submitType` を触らない・btnBack だけが `'back'` を入れる）も見る。
   **どれか 1 つでも違えば `STATE_B_CONFIRM_ACTION_UNKNOWN` で fail-closed。**
2. **`submitType` は空文字で送る。`confirm` という値を作らない・送らない。**
3. **parser を必要最小限だけ拡張**した: form の `name` 属性を取る（属性は
   **form の開始タグからだけ**読む＝中身の `name=` を拾わない）/ button の `id` を取る。
4. **`state-b.html` / `state-b-decoy.html` fixture を実測 DOM へ置換**。
   `type='text'` のシングルクォートも**実測との差として残した**（parser が text と解釈することを
   T19g/T19h が固定する）。inline script のハンドラ 2 本も fixture に入れた。

**送る field は実測の 11 個**（`ID` / `DairitenCode` / `DairitenName` / `HanbaitenCode` /
`HanbaitenName` / `DateFrom` / `DateTo` / `DataType` / `OutputHeader` / `submitType` /
`__RequestVerificationToken`）。押しボタンは name を持たないので**混ぜない**。

#### 検証（実サイトは未実行）

`npm run verify:demecal-flow` = **91 件 PASS**（STATE B は T13〜T19h の 24 件）。
退行注入で**4 件とも落ちることを確認済み**:

| 注入 | 落ちるテスト |
|---|---|
| `submitType` に `'confirm'` を入れる | T16 / T16a |
| 「確認」を汎用 `Resolve-Press` に戻す | T16a / T16b / T16c / T16d / T16e |
| ハンドラ契約（⑦）を丸ごと外す | T19b / T19c / T19d |
| `DataType` を既定（checked の `0`）のままにする | T14 |

`verify:ps1-order` OK ／ `verify:intake-scope` OK ／ `verify:probe-bat-gate` OK（10 ケース）／
`ParseFile` 構文エラー 0 ／ `astro check` 0 errors ／
bat 生成 OK（`verify-1.2`・placeholder 残り無し）。

**Wellfort への再実行は依頼していない。** Phase C にも進んでいない。

#### この回で残った未確認

- **STATE C（確認画面）の DOM は依然 Unknown。** 「確認」を押した先が何を返すかは未取得なので
  `New-StateCRequest` は変更していない。
- `dispLoading()` の実体（別ファイルの script）。**押下相当の POST には不要**。
- サーバが `submitType` 空文字をどう解釈するか（確認へ進むのか）。**未試行**。
- 日付欄の書式が `yyyy/MM/dd` でよいか（datetimepicker の `format: 'YYYY/MM/DD'` から取ったが、
  サーバ側の受理は未確認）。

### ②-4 Phase B 3 回目の実測と STATE C の修正（2026-09-03・`verify-1.3`）

**正本は `docs/lab/demecal_recovery_plan_20260902.md`。** ここは実測の記録。

専用PC で `verify-1.2` を **1 回だけ**実行。結果:

```
cert OK / credentials OK / login OK
STATE A → /hanyou/start → HTTP 200
STATE B → /hanyou/entry → HTTP 200
STATE_C_DOWNLOAD_ACTION_UNKNOWN
```

**業務データの write は 1 件も発生していない**（verify-only）。骨格を自動回収できたので、
**現地で 4 回目を回さずに原因を確定できた**。

**STATE B の契約は実サイトで成立した。** = `submitType=''` で確認画面へ遷移し、
日付は `yyyy/MM/dd` で受理され、ラベル起点で選んだ「正常終了のみ」「出力する」の値も通った。

#### 実測した STATE C の構造

```html
<form name="myform" action="/hanyou/confirm" method="post">
<input type="hidden" id="ID"            name="ID"            value="0" />
<input type="hidden" id="DairitenCode"  name="DairitenCode"  value="Q05-0010" />
<input type="hidden" id="DairitenName"  name="DairitenName"  value="&#x682A;…" />
<input type="hidden" id="HanbaitenCode" name="HanbaitenCode" value="000000" />
<input type="hidden" id="HanbaitenName" name="HanbaitenName" value="&#x682A;…" />
<input type="hidden" id="DateFrom"      name="DateFrom"      value="2026/07/04" />
<input type="hidden" id="DateTo"        name="DateTo"        value="2026/09/02" />
<input type="hidden" id="DataType"      name="DataType"      value="0" />
<input type="hidden" id="DataCount"     name="DataCount"     value="6" />   <!-- STATE B に無い新規 -->
<input type="hidden" id="OutputHeader"  name="OutputHeader"  value="True" />
<button id="btnDownload" type="button">…</button>   <!-- onclick 属性は無い -->
<button id="btnBack"     type="button">…</button>   <!-- onclick 属性は無い -->
<input id="submitType" name="submitType" type="hidden" />   <!-- value 属性が無い -->
<input name="__RequestVerificationToken" type="hidden" value="…" />
</form>
```

```js
$("#btnDownload").click(function () { $('#submitType').val('download'); /* dispLoading(...) はコメントアウト */ document.myform.submit(); });
$("#btnBack").click(function () { $('#submitType').val('back'); document.myform.submit(); });
```

- **URL は 3 段とも別**（`/hanyou/start` → `/hanyou/entry` → `/hanyou/confirm`）。
  spec に残っていた「STATE C は `/hanyou/entry` と同じ URL」は推測で、実測で否定された。
  ただし状態判定は URL を見ないので実装の挙動には影響していない。
- **確認画面は入力欄を 1 つも持たない**（`<select>`/`<option>`/radio が 0・全部 hidden）。
- **`submitType` に入る値として実測できたのは `download` と `back` の 2 つだけ**。
  `confirm` という文字列は 3 画面のどこにも 0 件。
- **ボタンの表示文字は骨格に載らない**（`Get-Skeleton` は `<button>` の開始タグしか出さない）。
  実ページの `btnDownload` のラベルに「ダウンロード」が在ることは、
  `Get-StateOf` の C 判定（ラベル一致）を通って `STATE_C_DOWNLOAD_ACTION_UNKNOWN` へ
  到達したというコードパスから確定している。

**`verify-1.2` の停止も実装どおりの正しい fail-closed だった。** 根は STATE B と同一で、
汎用 `Resolve-Press` は**そのボタン自身の `onclick` 属性**しか読まない。

#### `verify-1.3` の修正

1. **STATE C を専用 contract にした**（`Test-StateCContract` / `New-StateCRequest`）。
   汎用 `Resolve-Press` を使わない。機械確認するのは:
   form の `name=myform` / `action=/hanyou/confirm` / `method=post` /
   **全 field が hidden**（radio が 1 つでもあれば別画面）/ `submitType` が hidden で**初期値が空** /
   `id=btnDownload`・`id=btnBack` がちょうど 1 件ずつ / どちらも `type=button`・name なし・**onclick 属性なし** /
   **ハンドラ契約**（btnDownload は `submitType='download'` を入れて `document.myform.submit()` を呼び
   `back` を入れない・btnBack はその逆）。**どれか 1 つでも違えば `STATE_C_DOWNLOAD_ACTION_UNKNOWN`。**
2. **`DataCount` は意味を推測せず、サーバが返した hidden をそのまま持ち回る。**
   送る field は実測の 12 個。押しボタンは name を持たないので body に載せない。
3. **`state-c.html` / `state-c-hidden-seller.html` を実測 DOM へ全面置換**（創作の onclick 形は撤回）。
4. **`DataType` / `OutputHeader` の 0/1・False/True の意味を fixture から外した**（下記）。
5. **骨格の `__RequestVerificationToken` は `[REDACTED]` にしてから送る。**
   患者 PII ではないが診断に要らない。骨格で見たいのは「その hidden が在るか」であって値ではない。

#### `DataType` の 0/1 を仕様にしない（レビュー裁定 2026-09-03）

Confirmed なのは**「ラベル『正常終了のみ』に対応する実 value を送ったら STATE C へ遷移した」**ことだけ。
どちらのラベルがどちらの value かは**観測した資料が 1 件も無い**（骨格は `<label>` の中身の文字を
載せないため、どの run にもその文字が出てこない）。旧 fixture の「正常終了のみ = `value 1`」は
**こちらの仮定**だった。→ fixture の値を架空の `DT-A`/`DT-B`・`OH-A`/`OH-B` に置き換え、
**「ラベル起点で value を引けること」自体**をテストする形にした（実装は元々ハードコードして
いないので挙動は不変）。T14/T15 の文言も「既定 0 のままにしない」から
「ラベルに対応する value を送る（checked のままにしない）」へ訂正。

#### CSV レスポンスの検査（既存のまま）

`RawContentStream` から byte[] を取り `Test-CsvResponse` で判定する経路は既に実装済みで変更なし。
ログに出すのは **status / content-type / content-disposition / filename / byte count / SHA-256 /
rows / 必須ヘッダの結果**だけ。**CSV 本文・先頭バイトは出さない。保存も S3 投入も `last_to` 更新もしない。**

#### 検証（実サイトは未実行）

`npm run verify:demecal-flow` = **116 件 PASS**（STATE C は T20〜T22d の 22 件 + 骨格 T41 系 4 件）。
退行注入で**7 件とも落ちることを確認済み**:

| 注入 | 落ちるテスト |
|---|---|
| 「ダウンロード」を汎用 `Resolve-Press` に戻す | T05b / T20a / T20b / T20c / T20e |
| ハンドラ契約（⑤）を丸ごと外す | T22a / T22b / T22c / T22d |
| 全 field hidden の確認（②）を外す | T21b |
| `action`／`method` の確認を外す | T21 |
| `DataCount` を作り直す | T20d |
| 骨格の `[REDACTED]` を外す | T41 / T41a |
| `DataType` を checked のまま送る | T14 |

`verify:ps1-order` OK ／ `verify:intake-scope` OK ／ `verify:probe-bat-gate` 10 ケース OK ／
`ParseFile` 構文エラー 0 ／ `astro check` 0 errors ／ bat 生成 OK（`verify-1.3`・placeholder 残り無し）。

**Wellfort への再実行は依頼していない。** Phase C にも進んでいない。

#### この回で残った未確認

- **`POST /hanyou/confirm`（`submitType=download`）の応答が CSV かどうか。** 未観測。
  実測できているのは `start → entry` と `entry → confirm` の 2 回で、**どちらも HTML が返っている**。
  4 つ目の画面か 302 かの可能性は現在の証拠では否定できない。
- `DataCount` の意味（該当件数か否か）。名前と値からそう読めるだけで、確認画面の表示文字が
  骨格に無いため断定できない。**だから値を作らず持ち回るだけにしてある。**
- `/js/site.min.js` に `btnDownload` を触る別のハンドラが在るか。未取得。
- `DataType` のラベル↔value 対応（上記）。

### ②-5 STATE C 応答が HTML だったときの骨格回収（2026-09-03・`verify-1.4`）

**レビューで指摘された blocker 1 件の修正。実機は未実行。**

②-4 の報告に「HTML が返れば `CSV_RESPONSE_INVALID` で止まって骨格が上がってくる」と書いたが、
**現実装と一致していなかった** — CSV 検査で落ちる経路に `Send-Skeleton` が無く、
**そのときの HTML が回収されないまま終わっていた**。
`POST /hanyou/confirm` の応答が未観測である以上、4 つ目の画面が在るかどうかは
**そのときの HTML でしか分からない**ので、ここで取れないと現地の 1 回を無駄にする。

#### 直し方

`Get-StateCHtmlForSkeleton($bytes, $contentType, $disposition, $csvCode)` を新設し、
**「HTML だと積極的に確認できたときだけ」本文を返す**（それ以外は `''` = 送らない）。
`''` なら従来どおり `Finish` だけで落ち、非空なら `Send-Skeleton` してから落ちる。

判定は **CSV を probe へ渡さないことを最優先**にした fail-closed:

1. **`attachment` が付いていたら無条件で対象外** — CSV はこれで返る。
2. `content-type` が `text/html`、**または** CSV 検査が `CSV_RESPONSE_INVALID`。
3. **かつ本文の先頭が HTML の形をしている**（`<!doctype html` / `<html` / `<head` / `<form`）。
   Shift_JIS の CSV を UTF-8 で読んでも例外にはならず化けるだけなので、
   **「読めたか」ではなく「HTML に見えるか」で判定する**。`content-type` が html でも
   ここを外れたら送らない。

**ログに出すものは変えていない**（status / content-type / content-disposition / filename /
byte count / SHA-256 / rows / 必須ヘッダ結果）。**CSV 本文・先頭バイトは出さない。
保存・S3・`last_to` 更新も禁止のまま。**

#### 検証

`npm run verify:demecal-flow` = **129 件 PASS**（この回で T42〜T45a の 13 件を追加）。
退行注入で**5 件とも落ちることを確認済み**:

| 注入 | 落ちるテスト |
|---|---|
| `attachment` ガードを外す | T43d |
| 「HTML に見えるか」の確認を外す | T43b / T43c |
| 骨格回収を丸ごと元へ戻す | T44b / T44c |
| CSV のバイト列を `Diag` に出す | T44a / T44c |
| 骨格の `[REDACTED]` を外す | T41 / T41a / **T45** |

**`attachment` ガードは最初 1 度も落ちなかった**（実データの CSV は Shift_JIS で
「HTML に見えない」側でも弾かれるため、ガードが load-bearing か分からなかった）。
→ **添付なのに本文が HTML の形をしている**という取り合わせの fixture を足して、
**ガード単体**を試す形にした（T43d）。**退行注入で落ちることも確認済み。**

`verify:ps1-order` OK ／ `verify:intake-scope` OK ／ `verify:probe-bat-gate` 10 ケース OK ／
`ParseFile` 構文エラー 0 ／ `astro check` 0 errors ／ bat 生成 OK（`verify-1.4`・placeholder 残り無し）。

**Wellfort への再実行は依頼していない。** Phase C にも進んでいない。

### ②-6 Phase B 完了（2026-09-03・`verify-1.4`・実機 ○ / ChatGPT 判定 PASS）

専用PC で `verify-1.4` を実行し **結果 ○**。**Phase B PASS**。
Exit Criteria と Confirmed の一覧は
**`docs/lab/demecal_recovery_plan_20260902.md` §6.6 が正**（二重管理しない）。要点だけ:

- **mTLS / login → STATE A → STATE B → STATE C → CSV** が実サイトで 1 本通った。
- **`GET /hanbaiten` → `000000`** / **「正常終了のみ」「出力する」** / **`submitType=download`** が受理された。
- **Windows PowerShell 5.1 の `RawContentStream` から byte[]** を取り、**Shift_JIS で decode** し、
  **filename 規則 / 必須ヘッダ / 行数** の検査まで通った。
- **業務データの write は 4 回とも 1 件も発生していない**（`elith-blood-csv` / BloodTestData / S3 /
  `last_to` / CSV のディスク保存・本文送信 いずれも無し）。
- 傍証: この回は `probe-upload` へ**新しい骨格が上がっていない**（`Send-Skeleton` は失敗経路にしか無い）。

**個々の実測値（行数・ファイル名・SHA-256）はここに書かない** — 実行画面の値がこちらへ渡って
いないため。**書けば捏造になる。** 非PII の実行ログ (`/api/admin/demecal-run`) に残っている。

#### ここで「無人化が終わった」わけではない

**取れたのは「CSV を 1 本、正しく取ってきてメモリ上で検証できる」ところまで。**
§3 以降が求めている **`last_to` の前進 / 0 件の扱い / タスク登録と監視** は
**1 行も実装していない**（Phase C）。
**`last_to` の単調前進**（§1 の「無人にしてよい根拠」）も、**まだコードで担保されていない**。

> **【2026-09-03 scope correction】初版はここに「本人紐付け / 冪等性 / 本番 write の順序」も
> Phase C として並べていた。訂正する — この 3 つは別セクションへ移管済み**
> （`demecal_recovery_plan_20260902.md` §7.0）。
> **取得 Phase C = C-1 date range / watermark ・ C-2 overlap / retry ・ C-3 zero rows ・
> C-4 production acquisition runner ・ C-5 scheduler ・ C-6 monitoring の 6 本**。

#### 凍結と証跡

- **`scripts/demecal-verify.ps1` (`verify-1.4`) は残す。** Phase B の成功証跡であり、
  Phase C 後も**業務データ write 抜きで取得部だけを試せる唯一の口**になる。
- **`daily-1.7` の凍結は維持**（`api/ops/probe-bat` の `FROZEN` が 409 を返す）。**配布しない。**
- 次は **ChatGPT から Phase C の詳細仕様**を受けてから着手する。**先回りして実装しない。**

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

> **【2026-09-03 scope correction】この項（§8 表の #7 と、以下の `external_test_id` / 本人突合の議論）は
> 取得スコープ外。ここでは解決しない。** 別セクションへ移管済み
> （`demecal_recovery_plan_20260902.md` §7.0 / 参照先は `lab_integration_workflow.md`・
> `lab_data_pipeline_master_spec.md`・`id_management_and_correlation_spec.md`）。
> **取得 Phase C の着手条件でも完成条件でもない**ので、ここが未決でも C-1〜C-6 は進められる。
> 以下は 2026-08-31 時点の調査記録として残す。

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
