# 検査データ受取 総合仕様（4検査・受取方式まとめ）

| 項目 | 内容 |
|---|---|
| 目的 | Wellfort が外部検査会社から受け取る **4 検査**のデータ受取方式・経路・現状・課題を一枚に集約する。各検査は最終的に **Elith 形式 JSON（`elith-handoff-v0.1`）へ変換し S3 経由で Elith へ受け渡す**（詳細=`docs/elith/elith_s3_data_handoff_spec.md` / `docs/elith/elith_assembly_wrapping_spec.md`）。 |
| 対象 | ①血液検査（リージャー）②がんリスク検査・尿（プリベント）③AI疾病発症予測（LAiF）④遺伝子検査（Genoplan）。※健診・人間ドックは会員がアプリでAIスキャンするため本書対象外。 |
| 版 | **2026-08-31（血液=受取方式を RPA/PAD から **PowerShell 方式**へ変更・§1/§0.1/§7 を更新）**<br>2026-08-26（Draft・LAiF 実データ疎通の結果／ID 連携仕様／問診データの渡し方マトリクスを追記） |
| 上位文書 | **本書は「受取方式（各社別）」に特化した詳細。EC購入→キット→問診→受取→Elith→表示の E2E 全体像は `docs/lab/lab_data_pipeline_master_spec.md`（総合仕様書）が正本。** |
| 関連 | **`docs/lab/demecal_unattended_spec.md`（血液=無人定期取得の正本・PowerShell方式）** / `docs/lab/demecal_powershell_probe_guide.md`（方式決定の実測）/ `docs/lab/demecal_auto_download_overview_spec.md`（概要）、`docs/elith/elith_assembly_wrapping_spec.md`（LAiF/ウェルネス年齢のラップ）、`docs/lab/lab_integration_workflow.md`（割当・PII）、`docs/lab/kit_progress_management.md`（進捗）、`docs/lab/wellfort_admin_lab_upload_spec.md`（admin取込） |

---

## 0. 一覧表

### 0.1 受取方式（下り：検査会社 → Wellfort）

| # | 検査 | 検査会社 | 受取方式 | 取得データ | Elith format_id | 変換方法 | ステータス |
|---|---|---|---|---|---|---|---|
| 1 | 血液検査 | 株式会社リージャー（Leisure／デメカル DSS） | **PowerShell 方式**（専用PC・mTLS＋無人定期実行。**RPA/PAD は不要**・2026-08-31 確定） | CSV | `BloodTestData` | **決定論パース**（CSV→JSON・LLM不使用） | 自動アクセス承認済・サーバ側実装済／**方式確定・PC側は未実装**（残=ログイン後のCSV一覧URL） |
| 2 | がんリスク検査（尿） | プリベント社（ALA-PDS） | **専用ポータル＋AWS S3＋パスキー方式を提案中**（LAiF流用）／現状：メール＋フォルダ共有の手動 | PDF/報告書 | `CancerRiskAssessmentData` | **admin バッチ AIスキャン**（画像→JSON） | **方式を提案中（プレゼン段階）**。現状は手動 |
| 3 | AI疾病発症予測 | LAiF社 | **AWS S3 専用バケット**（URLで受渡） | PDF | `Other`（`kind:"ai_prediction"`） | **admin バッチ AIスキャン**（多ページ・LLM構造化） | 受取方式確定・スキャン対応実装済／**2026-08-26 上り(弊社→LAiF)疎通OK・下り(返送)は未検証** |
| 4 | 遺伝子検査 | Genoplan社（ジェノプランジャパン） | **デスクトップRPA**（PAD / UiPath / WinAutomation）**※要再検討＝PowerShell 化の可能性あり** | PDF | `GeneticTestResultData` | **admin バッチ AIスキャン**（多ページ・LLM構造化） | 受取方式=RPA方針／スキャン対応実装済。**血液の PAD 枠組みを流用する前提が消えた**（血液は PowerShell 化）→ §4 |

### 0.2 問診データの渡し方（上り：Wellfort/ユーザー → 検査会社）— **確定 2026-08-26・発注者確認**

**下り（受取）とは経路も担い手も別**。AI問診（アプリ）を経由するのは **②がんリスクと③AI疾病発症予測の 2 検査だけ**で、①血液と④遺伝子は**ユーザーが検査会社へ直接届ける**ため**弊社の実装対象外**。

| # | 検査 | 問診の取得方法 | 渡し方（経路） | 形式 | 弊社の実装要否 |
|---|---|---|---|---|---|
| 1 | 血液検査（リージャー） | **ユーザーが専用用紙へ記入** | **郵送**（検体と共に検査会社へ返送） | 紙 | **なし**（弊社を経由しない） |
| 2 | がんリスク検査・尿（プリベント） | **AI問診**（アプリ） | **専用ポータル＋AWS S3＋パスキー方式**（提案中） | **CSV** | **あり**（AI問診→CSV変換＋ポータル配置） |
| 3 | AI疾病発症予測（LAiF） | **AI問診**（アプリ） | **専用ポータル＋AWS S3＋パスキー方式** | **所定 Excel フォーム**（`input_format_new_202312.xlsx`・約158項目）※ | **あり**（AI問診→所定フォーム変換＋ポータル配置） |
| 4 | 遺伝子検査（Genoplan） | **ユーザーが Genoplan 社の検査専用 Web へ直接入力** | **弊社は渡さない**（検査会社が直接取得） | — | **なし**（弊社を経由しない） |

> ※ **③の形式について**: 発注者ご指示は「AI問診→CSV」ですが、**LAiF 社は「CSV」表記を避け、所定の Excel フォーム
> `input_format_new_202312.xlsx` での受渡を要望**しており（2026-08 に行き違いを是正済・`docs/lab/partner_demo_confirmation_request_laif.md`）、
> 現行実装（`scripts/build-laif-input.py`）もこの Excel を出力します。**本表は実装に合わせて「所定 Excel フォーム」と記載**しています。
> 「CSV で確定」の意図であれば先方合意の取り直しが必要なため、**ご確認ください**。
>
> **本確定により `docs/lab/questionnaire_to_lab_csv_spec.md` の未確定事項が 2 件解消**します
> （§7-7 血液への問診受渡＝**不要**で確定／§4.4・§6 の Genoplan 列＝**対象外**）。同仕様書も追随して更新済み。

---

## 1. 血液検査（株式会社リージャー）

- **検査会社/ポータル**: 株式会社リージャー（Leisure）＝デメカル `DSS Web System`（`https://dl.demecal.net`）。
- **受取方式**: **PowerShell 方式（2026-08-31 確定・専用PC 実測）。RPA / PAD は不要。**
  正本 = **`docs/lab/demecal_unattended_spec.md`**（無人定期実行）。
  - 根拠（`demecal_powershell_probe_guide.md`「実測結果」）: 証明書つき接続 **HTTP 200**
    （`CN=Q05-0010`・発行者 `demecal.net CA`・**期限 2028-12-12**）／証明書なしは 400 ／
    ログイン画面は **`<form>` 1・`<input>` 3 の素の HTML フォーム**（ログインを動かす JS は無い）。
  - **PAD より優れる点**: ライセンス不要・**ブラウザ要素を指さないので画面デザイン変更に強い**・
    セットアップが「ダブルクリック 1 回」。
  - **旧案は不採用**: PAD ／ サーバ側 Playwright。どちらも `docs/旧版・ボツ/` へ移動済み
    （`旧版・ボツ/demecal_pad_{flow_skeleton,operation_guide,setup_guide}.md`・`旧版・ボツ/demecal_server_playwright_design.md`）。
- **フロー**（`demecal_unattended_spec.md §4.1`）:
  1. 専用PC（Pマーク準拠・クライアント証明書導入済）の **タスクスケジューラが PowerShell を起動**。
  2. 証明書を選ぶ（**発行者CN=`demecal.net CA` かつ秘密鍵あり**で絞る。CN のベタ書きはしない）。
  3. `GET /account/login` で **antiforgery トークン（`__RequestVerificationToken`）**を取得し、
     **同一セッション**で `POST /account/login`（**証明書は GET・POST の両方に付ける**）。
  4. **日付重複なく**新規分の血液CSVをダウンロード（状態は `/api/admin/demecal-state` で管理）。
     保存先は **`C:\demecal\`**（**デスクトップは OneDrive 同期対象＝PII がクラウドへ上がる**ため使わない）。
  5. admin 取込API `/api/admin/elith-blood-csv` へ投入 → **決定論パース**で `BloodTestData` JSON 化 → S3。
  6. 成功時のみ `last_to` を前進 → **原本CSVを削除** → 成否を実行ログAPIへ報告。
- **無人化の要点**: 証明書が **`Cert:\CurrentUser\My` にしかない**ため、タスクは
  **ユーザー `info` / 「ログオン中のみ実行」/ ログオン時＋毎日 / 「開始時刻を過ぎたらすぐ開始」**で組む。
  **自動ログオンも LocalMachine への証明書移設も不要**（`last_to` が単調前進なので、
  走らない日があっても次の成功回がまとめて回収する＝取り漏れゼロ）。
- **鍵管理**: AWS/Gemini 等の鍵は **Vercel 本番 env のみ**。専用PCには据え置きの鍵を置かない（CLAUDE.md）。取込は専用キー `x-intake-key`。
- **特記**: 血液のみ **CSV＝決定論パース**（画像AIスキャン不要）。ウェルネス年齢（CABA）の主要マーカー源。
- **問診データ（上り）**: **ユーザーが専用用紙へ記入し、検体と共に郵送**（§0.2）。**弊社を経由しない＝実装対象外**。
  ※ 旧検討の「Wellfort→デメカルへ問診CSVを渡す」方向は**不要で確定**（`questionnaire_to_lab_csv_spec §7-7` を解消）。
- **④ 構造照合（実装済）**: CSV↔JSON の**漏れゼロ/捏造ゼロ/コード解決/PII非混入**を固定検証する fixture。
  `scripts/verify-blood-csv-structure.ts`＋`scripts/blood-csv-fixtures/demecal_sample_v1.csv`。実行 `npm run verify:blood-csv`（決定論・鍵不要・26チェック全PASS）。
- **DL画面手順（確定済）**: `demecal_auto_download_overview_spec.md §2.1` と
  `demecal_attended_manual_guide.md` ステップ② に**確定手順を記載済**（ログイン→データDL→汎用CSV設定→確認→DL）。
  **ただし「ログイン後の一覧 URL とダウンロードの form」は未取得**＝スクリプト化にはこれが要る。
- **ステータス**: 自動アクセス承認済／サーバ側（変換・S3・状態管理・取込UI）実装済／DL画面手順=仕様確定済／
  ④構造照合fixture=実装済。**残＝PC側の PowerShell 実装**（`demecal_unattended_spec.md §9` に TODO 9 件）。
  **着手を止めているのは 2 点**: ①ログイン後の CSV 一覧 URL とダウンロードの form（専用PCで 1 回取得が必要）
  ②`指図番号` から本人（`diagnostic_user_id`）を特定する経路（§5.4 の実装ギャップ③と同根）。
  先方確認は `demecal_auto_download_overview_spec §6`（日付基準/レート制限）。**証明書のサーバ移設は不要になった**（下記）。
- **進め方（技術者不在への対応・2案並行）**:
  - **案1（即運用・技術者不要）**: attended手動DL＋admin取込。スタッフ向けクリック手順書＝`docs/lab/demecal_attended_manual_guide.md`。
  - **案2（確定・本命）**: **専用PC上の PowerShell を無人で定期実行**。正本＝`docs/lab/demecal_unattended_spec.md`。
    **発注者判断（2026-08-31）で「最初から無人」**。段階導入（まず手動ダブルクリック）は採らない。
    Wellfort 側の作業は**セットアップ bat のダブルクリック 1 回**。
  - **不採用**: ~~サーバ側 Playwright(mTLS)~~（`旧版・ボツ/demecal_server_playwright_design.md`）。
    **証明書をサーバへ移設する必要が無くなった**ため（専用PC上で完結）。
    ~~PAD~~（`旧版・ボツ/demecal_pad_*.md`）も同様に不採用。**最善は案0=公式データ連携(SFTP/API)を Leisure へ打診**（変わらず）。
- **詳細**: **`demecal_unattended_spec.md`（無人運用の正本）**・`demecal_powershell_probe_guide.md`（方式決定の実測＋ログインフォーム構造）・
  `demecal_auto_download_overview_spec.md`（概要）・`demecal_attended_manual_guide.md`（手動運用・**現在稼働中**）・
  `demecal_rpa_operation_design.md`（§1役割分担/§2API/§3attended は有効。**§4 unattended は上記正本が上書き**）。
  **不採用案**（参照しない）: `docs/旧版・ボツ/demecal_pad_*.md`・`docs/旧版・ボツ/demecal_server_playwright_design.md`。

## 2. がんリスク検査（尿・プリベント社）

- **検査会社**: プリベント社（様式=ALA-PDS）。
- **受取方式（提案中・プレゼン段階）**: **LAiF と同じ「専用ポータル＋AWS S3＋パスキー認証」方式を先方へ提案中**（確定ではない）。
  上り（弊社→プリベント）で **問診CSV** をポータル経由で受渡し、下り（プリベント→弊社）で **報告書PDF** を専用S3で受領する双方向運用へ移行する狙い。往復メール／アクセス権未設定リンクを解消する。
  - **提案資料**: `がんリスク検査_プリベント_データ受け渡し方式ご提案_v0.1_20260806.pdf`（冒頭フロー図＋3ページ）。
  - **デモ画面（パスキー設定前にお試し）**: `https://wellfort.co.jp/partner-portal-preview?partner=prevent`（LAiF ポータルを流用・ダミーデータ・noindex）。
  - **上り問診CSV（サンプル）**: `docs/lab/questionnaire_to_lab_csv_spec.md §4.2`（33項目）に準拠した仮データCSVを先方確認用に用意済。
  - **設計正本**: LAiF の `docs/lab/laif_s3_secure_handoff_spec.md`（ゼロトラスト・多層防御）を流用。IP許可制はプリベントの固定IP有無で判断（未確認）。
- **現状フロー（手動・8ステップ・提案が合意されるまでの暫定）**:
  1. 会員がマイページ内Webアプリで「問診への回答」を行う。
  2. Webアプリのai機能でCSVへ転記。
  3. そのファイルを格納したフォルダのリンクを、**アクセス権未設定のまま**プリベント社へメール送付。
  4. プリベント社がアクセス権をリクエストし、ファイルを入手。
  5. プリベント社が「ID」で検体を特定・データ紐づけ → リスク検査報告書を作成。
  6. プリベント社が報告書を同フォルダへ格納。
  7. プリベント社が格納した旨をメールでウェルフォート社へ連絡。
  8. ウェルフォート社が報告書を確認し、その旨を返信して完了。
- **問診データ（上り）**: **AI問診（アプリ）→ CSV** を、**専用ポータル＋AWS S3＋パスキー方式**で受渡（§0.2）。項目は `questionnaire_to_lab_csv_spec §4.2`（主要33項目）。**弊社の実装対象**。
- **変換**: 受領した報告書（PDF/画像）を **admin バッチAIスキャン** → `CancerRiskAssessmentData` JSON → S3（🎯ゴールデン照合対応済）。
- **課題（提案で解消を狙う）**:
  - リンク共有＝手動・往復メール多く、リードタイム長い → **専用ポータル＋S3で双方向自動化**。
  - **アクセス権未設定リンクの送付**はセキュリティ/PII 面で要見直し（`docs/architecture/data_integration_requirements.md` の PII 分離方針との整合）→ **パスキー認証＋暗号化保管**で担保。
  - **提案の合意取り付け**（方式・IP有無・担当者/通知先・同意前提）が次アクション。
- **デモ画面ご確認依頼（2026-08 作成済・送付待ち）**: 文面＝`docs/lab/partner_demo_confirmation_request_prevent.md`／送付用PDF作成済。
  **送付前提＝デモURLが実際に開けること**（本番デプロイの鮮度を要確認）。

## 3. AI疾病発症予測（LAiF社）

- **検査会社**: LAiF社。
- **受取方式**: **AWS S3 専用バケットに置かれた URL で受渡**（LAiF→Wellfort）。
- **フロー**: 専用バケットURLからレポートPDFを入手 → **admin バッチAIスキャン（多ページ・LLM構造化）** → `Other`（`kind:"ai_prediction"`・`lab_name:"LAiF"`）JSON → S3（Elith納品層）。
- **データ内容**（実サンプル準拠）: 疾患ごとに **5年発症率(%)・10年発症率(%)・相対リスク比・昨年の相対リスク比**、カテゴリ（生活習慣病/循環器/悪性腫瘍/神経疾患）、リスク因子・予防策（AIアドバイス）。
- **変換/ラップ仕様**: `docs/elith/elith_assembly_wrapping_spec.md §5`（`Other`/`ai_prediction`・命名・data.items・時系列疑似データ提案）。
- **セキュア受渡方式（設計正本）**: `docs/lab/laif_s3_secure_handoff_spec.md`（**ポータル共有型ゼロトラスト**：Passkey認証＋IP制限＋Presigned直転送＋GuardDuty検疫＋Gemini File API丸投げ＋決定論検証＋Object Lock。Gemini/ChatGPT統合）。
- **問診データ（上り）**: **AI問診（アプリ）→ 所定 Excel フォーム**（`input_format_new_202312.xlsx`・約158項目）を、**専用ポータル＋AWS S3＋パスキー方式**で受渡（§0.2）。写像仕様＝`kit_lifecycle_and_handoff_management_spec §4.1.1`、生成＝`scripts/build-laif-input.py`。**名前欄(G1)＝整理番号（空欄不可）**。**弊社の実装対象**。
- **ステータス**: 受取方式確定。スキャン→JSON化 実装済（admin「🔮 AI疾病発症予測(LAiF)」）。**Elith 側の `Other`/`ai_prediction` 受領仕様は §5.6 で確認中**。**セキュア受渡は設計確定（実装/LAiF確認は上記spec §12-13）**。

### 3.1 実データ疎通の結果（2026-08-26・メール往復の記録）

**上り（弊社→LAiF）は疎通しました。下り（LAiF→弊社）は未検証のまま止まっています。**

| 時刻 | 主体 | 内容 |
|---|---|---|
| 10:55 | Wellfort | 動作確認用の手順書を送付し確認依頼 |
| 11:37 | LAiF | 手順は問題なし。ただし **URL が not found** |
| 14:02 | Wellfort | リンク修正・動作確認済み、再確認依頼 |
| 14:45 | LAiF | **データ受領**。ただし「**ID に英字を入れてほしい。数字のみだと解析できない**」／今回は便宜上 LAiF 側で末尾に **W** を付与／**システム改修中のため時間がかかる** |
| 14:58 | Wellfort | 英字の大小区別を照会／**ダミーデータでのアップロードを依頼** |
| 15:01 | LAiF | 今後は Wellfort 側で任意の文字を付与／**大文字小文字どちらでも可**／解析終了後にアップ |
| — | Wellfort | 了解。解析後のデータ返送と、返送時のメール一報を依頼 |

**判明した仕様制約（重要）**
- **LAiF の解析システムは、ID に英字を 1 文字以上含む必要がある**（数字のみは解析不可）。**大文字・小文字は不問／文字の位置・内容は任意**。
- この制約は **§5 の「②各社上りID（LAiF 整理番号）」の採番規則**にかかるもの。**Elith の `client_id`（＝`diagnostic_user_id`）を変更する必要はない**。

**未解決（次アクション）**
1. **今回分の ID 突合**: LAiF が独自に末尾へ `W` を付けたため、**返送される結果の ID は送信した ID と一致しない**（`…0001` → `…0001W`）。受領時の読み替えが必要（本来は §5 の `external_test_id` に格納して突合する対象）。
2. **ダミーでの往復テストが未確約**: 弊社の依頼に対する回答は「解析終了後にアップ」のみ。**下り経路（LAiF がサーバへ上げる→弊社が取得）は一度も検証できていない**。
3. **返送時のメール一報**の了承が未取得（最新メールが弊社発信）。
4. **LAiF 側の桁数上限**が未確認（採番規則の桁決めに必要）。
5. **経年で同一人物として突合する必要があるか**が未確認（レポートに「昨年比」欄があるため。§5.3 の単位決定に必要）。

> 【未確認の仮説】11:37 の `not found` は、`wellfort.co.jp` の本番デプロイが古く一部ページが 404 を返す事象と症状が一致するが、**該当 URL がメールから特定できないため同一原因かは未確認**。同じ原因であれば手順書内の他リンクも同様に落ちうるため、本番デプロイの鮮度確認が望ましい。

## 4. 遺伝子検査（Genoplan社）

- **検査会社**: Genoplan社（ジェノプランジャパン／GenePlanet）。
- **受取方式**: **デスクトップRPA 方針。ただし PowerShell 方式へ変更できる可能性があり、着手前に判定する（2026-08-31）。**
  当初は「血液で作る PAD の枠組みを流用する」前提だったが、**血液が PowerShell 方式に変わったのでその前提が消えた**。
  **血液で PAD が不要になったのと同じ理屈が、Genoplan にも当てはまる可能性がある。**

  - **判定の観点（血液で決め手になったのと同じ 2 点）**
    1. **ログイン画面が素の HTML フォームか** — フォーム POST だけで通るなら PowerShell で完結する。
       SPA / OAuth・SSO / MFA / CAPTCHA / Bot 対策があるならブラウザ自動操作が要る
    2. **レポート PDF が URL で直接取れるか** — JS が生成する一時 URL やブラウザ内描画だと難しい
  - **判定の仕方**: **血液で使ったプローブと同じ手を使える。** ログインせず画面の作りだけを記録する
    読み取り専用の bat を渡し、**ダブルクリック 1 回**で結果を返してもらう
    （`scripts/demecal-probe.ps1` / `src/lib/probe-bat.ts` が流用元。Wellfort 側は同じ手順に 1 回成功済み）。
  - **【未確認・仮説】クライアント証明書が不要なら、そもそも専用PCが要らない可能性がある。**
    血液で専用PCが必須なのは **証明書がその PC の証明書ストアにしかない**ため。
    Genoplan が ID/PW だけなら **サーバ側（Vercel）で完結**でき、PC の起動状態にも左右されない。
    **Genoplan の認証方式は未確認**なので、まず上記プローブで確かめる。
  - **結論の出し方**: 素のフォーム＋直リンク → **PowerShell**（ライセンス不要・画面変更に強い）。
    そうでなければ従来どおり **RPA**。**確認するまでどちらとも決めない。**
- **フロー**: 自動取得（方式未定）で Genoplan ポータル等からレポートPDFを取得 → **admin バッチAIスキャン（多ページ・LLM構造化）** → `GeneticTestResultData` JSON → S3。
- **問診データ（上り）**: **ユーザーが Genoplan 社の検査専用 Web へ直接入力**（§0.2）。**弊社は渡さない＝実装対象外**
  （`questionnaire_to_lab_csv_spec §4.4` の 70 項目マッピングは**対象外で確定**）。
- **データ内容**: 疾患ごとの**発症リスク倍率**＋発症率（％/定性）。🎯倍率ゴールデン照合（220項目）対応済。
- **ステータス**: 受取方式=RPA方針**（要再検討・上記）**。スキャン→JSON化 実装済（admin「🧬 遺伝子検査」・ページ範囲指定）。

---

## 5. ID 連携仕様（検査会社ID ↔ 内部ID の同期）

> 正本＝`docs/architecture/id_management_and_correlation_spec.md`。本章はその**受取側の実務断面**を抜き出したもの。
> **検査会社とのやり取りに使う ID は、Elith へ渡す ID とは別物**であり、`customer.lab_tests` で対応づける。

### 5.1 ID は 3 層ある（混同しないこと）

| 層 | 実体 | 採番 | 用途 |
|---|---|---|---|
| **① 内部の軸** | `diagnostic_user_id`（uuid・非PII） | Wellfort | PII と診断系を結ぶ**唯一の連携キー**。**Elith の `client_id` はこれ**（`elith_s3_data_handoff_spec §2`） |
| **② 各社への上りID** | LAiF＝**整理番号（識別番号 No.0）**／プリベント＝会員ID／Genoplan＝整理番号系 | **Wellfort 採番の仮名ID** | 検査会社へ渡す ID。**会社ごとに別体系**。LAiF は「**自社連番は使わない・Wellfort 整理番号で突合**」で確定（2026-08） |
| **③ 検査会社の独自ID** | `lab_tests.external_test_id`／`external_barcode` | **検査会社** | 検査会社が結果に付す固有ID・キット物理ID。**受領時に格納して①と対応づける**（照合・突合用） |

**原則**: **内部 `diagnostic_user_id` を軸に、②③は補助照合キーとして持つ**。②③を軸にしない。

### 5.2 同期テーブル（`customer.lab_tests`）

`supabase/migrations/20260601000010_schemas_and_tables.sql:143-162`（実在）。

| カラム | 層 | 状態 |
|---|---|---|
| `diagnostic_user_id` | ① | **実在**（`lab_companies` / `kit_shipments` と併せて 1 検査＝1 行） |
| `external_test_id`（`unique (lab_company_id, external_test_id)`） | ③ | **実在**。ただし**受領時に書き込む処理は未実装** |
| `external_barcode` | ③ | **実在**（キット物理ID・POS/バーコード用）。未実装 |
| **②の上りIDを入れる列** | ② | **存在しない → 新規カラムが必要**（例 `upstream_ref text` ＋ `unique (lab_company_id, upstream_ref)`） |

会社ごとの様式差は **`customer.lab_companies.external_id_label` / `external_id_pattern`（regex）** で吸収する設計（実在・未登録）。

### 5.3 上りID（②）の採番規則 — **未確定・要決定**

LAiF の条件は「**英字を 1 文字以上含む／大小不問／文字は任意**」のみ。**先頭を英字にすると「数字のみ」が構造的に起こらない**。

**書式の案**

| 案 | 形式 | 例 | 正規表現 | 評価 |
|---|---|---|---|---|
| A-1 接頭辞＋通番 | `WF-` ＋6桁 | `WF-000123` | `^WF-[0-9]{6}$` | **推奨**。短く読みやすい。電話・メール照合が楽 |
| A-2 短縮ID | `W`＋Base32 7桁 | `W7K9Q2M4` | `^W[0-9A-HJ-NP-Z]{7}$` | 採番テーブル不要（`lab_tests.id` から導出）・推測困難。読み上げにくい |
| A-3 年＋通番 | `WF`＋年2桁＋通番 | `WF26-000123` | `^WF[0-9]{2}-[0-9]{6}$` | 年が目視で分かる。桁が長い（**LAiF の桁数上限が未確認**） |

**単位の案（要 LAiF 確認）**

| 案 | 中身 | 評価 |
|---|---|---|
| B-1 検査（回）単位 | 1 検体＝1 ID | `lab_tests` の一意制約と素直に整合。**LAiF 側からは毎回「別人」に見える** |
| B-2 顧客単位 | 1 顧客＝1 ID | 同一人物として扱えるが、**どの回か ID だけでは判別不可** |
| B-3 顧客＋回（折衷） | `WF-000123-01` | **推奨**。前方一致で同一人物・末尾で回を判別 |

> B は **「LAiF が経年で同一人物として突合する必要があるか」**（レポートに昨年比欄あり）の回答待ち。**不要なら B-1 が最もシンプル**。

**保存方式**: **DB に保存する（`upstream_ref`）**。「いつ・誰に・どの ID で送ったか」の証跡が残り、今回の「先方が `W` を付加」のような差異も突合できる。都度導出（保存しない）方式は、規則変更時に過去分と不整合になり証跡も残らないため不採用。

### 5.4 実装ギャップ（設計に追いついていない箇所）

| # | 状態 | 根拠 |
|---|---|---|
| 1 | **整理番号（②）の採番機構が未実装**。`src/` `scripts/` に「整理番号」のヒット **0 件** | 実測 grep |
| 2 | そのため LAiF 上りビルダーは、入力 JSON の `client_id`（①）を**そのまま名前欄 G1 と No.0 に書いている** | `scripts/build-laif-input.py:103-104`（`671bd91`） |
| 3 | ③の受領時格納（`external_test_id`）が未実装 | 実測 |
| 4 | `lab_companies.external_id_label` / `external_id_pattern` に各社様式が未登録 | 実測 |

### 5.5 実装の最小セット

1. **マイグレーション** — `lab_tests.upstream_ref text` 追加＋`unique (lab_company_id, upstream_ref)`
2. **マスタ登録** — `lab_companies` の LAiF 行に `external_id_label='整理番号'` と決定した `external_id_pattern` を設定
3. **採番処理** — 決定した規則で発番し `upstream_ref` に保存
4. **ビルダー修正** — `build-laif-input.py` を「**整理番号を受け取る**」に変更（①を渡さない）。**pattern 違反は出力前にエラーで落とす**
5. **受領側** — ③（`external_test_id`）の記録（当面は admin からの手入力でも可）
6. **暫定処理** — 今回の 1 件（`…0001` ↔ `…0001W`）を手動で対応表に記録

---

## 6. 共通事項（4検査共通）

- **最終受け渡し**: いずれも **Elith 形式 JSON へ変換 → S3 `user/{client_id}/date/{YYYY_MM_DD}/{format_id}_..._user_{client_id}.json`**（`docs/elith/elith_s3_data_handoff_spec.md`）。
- **鍵一元管理**: AWS/Gemini の鍵は **Vercel 本番 env のみ**。専用PC・operator・クライアントに鍵を置かない（CLAUDE.md）。
- **PII 分離**: 外部・S3・診断系には氏名/住所/生年月日を載せない。**Elith へは `client_id`＝`diagnostic_user_id`（仮名）のみ**で橋渡し（`docs/architecture/data_integration_requirements.md` / `docs/lab/lab_integration_workflow.md`）。氏名OCRのみでの割当確定は禁止。
- **ID の使い分け**: **検査会社へ渡す ID は Elith の `client_id` とは別物**（§5）。会社別の上りID（②）と会社採番の独自ID（③）を `customer.lab_tests` で①に対応づける。**②③を軸にしない**。
- **変換の別**: 血液＝**CSV決定論パース**（LLM不使用）／がん・遺伝子・AI疾病予測＝**画像AIスキャン**（Gemini・サーバ側 admin バッチ）。
- **進捗管理**: キット発送〜完了は `docs/lab/kit_progress_management.md`、割当は `docs/lab/lab_integration_workflow.md`。

## 7. ステータス早見 & 次アクション

| 検査 | 受取自動化 | 主な次アクション |
|---|---|---|
| 血液（リージャー） | **方式確定（PowerShell・無人定期実行）／PC側は未実装**。**attended 手動取込が現在の本番運用**（admin 独立メニュー `/admin/demecal-csv`・手順書 v1.1） | ①**ログイン後の CSV 一覧 URL／form** を専用PCで 1 回取得 ②`指図番号`→`diagnostic_user_id` の写像（§5.4-③）③`LAB_INTAKE_API_KEY`・実行ログAPI・監視（`demecal_unattended_spec.md §9`） |
| がんリスク（プリベント） | **専用ポータル＋S3方式を提案中**（現状は手動） | **デモ画面ご確認依頼の送付**（文面・PDF作成済／**デモURLが開けることの確認が前提**）＋固定IP有無・担当者/通知先・生年月日提供の同意前提を確認 |
| AI疾病予測（LAiF） | S3 URL（確定）／**上り疎通OK・下り未検証** | ①**上りID採番規則の決定**（§5.3・英字必須）②**ダミーでの往復テスト**を再依頼（下り経路の検証）③今回分 `…0001W` の突合記録 ④Elith へ `Other`/`ai_prediction` の**受領仕様確認**（`elith_assembly_wrapping_spec §5.6`） |
| 遺伝子（Genoplan） | RPA方針**（要再検討＝PowerShell 化の可能性あり）** | **血液の PAD 枠組みを流用する前提が消えた**（血液は PowerShell 化）。→ **血液と同じ読み取り専用プローブを Genoplan ポータルへ 1 回流し**、①ログインが素の HTML フォームか ②PDF が URL で直接取れるか を判定。素のフォームなら **PowerShell 化**（ライセンス不要・画面変更に強い）。**証明書不要ならサーバ側で完結し専用PCも不要になり得る（未確認）** |

## 8. 確認事項
1. **がんリスク（プリベント・提案中）**: 専用ポータル＋S3方式の合意可否。固定グローバルIPの有無（IP許可制の採否判断）。ご利用担当者／通知先。上りCSVに含める**生年月日の外部提供・同意前提**の可否。合意までの暫定手動運用の継続可否とアクセス権未設定リンクの是正。
2. **AI疾病予測（LAiF）**: S3 専用バケットの命名/URL発行ルール、Elith の `Other`/`ai_prediction` 受領仕様。
   **2026-08-26 追加**: ① ID の**桁数上限**（採番規則の桁決めに必要）② **経年で同一人物として突合する必要があるか**（レポートの昨年比欄・§5.3 の単位決定に必要）③ **ダミーデータでの往復テスト**の可否 ④ 返送時のメール一報の可否 ⑤ 今回 LAiF 側で付与された `W` 付き ID の**返送時の表記**。
3. **上りID（②）の採番規則の決定**（§5.3）: 書式（A-1/A-2/A-3）と単位（B-1/B-2/B-3）。**4 社共通の枠組みとして一度に決めるのが望ましい**（LAiF だけ個別対応しない）。
4. **専用PC運用（血液・遺伝子）**: 専用PC台数・保守主体（UNFIX構築/Wellfort運用）・Pマーク運用の最終確認。
   血液は **PowerShell 方式**で確定（`demecal_unattended_spec.md`）。**RPA/PAD のライセンスは不要**。
   遺伝子は方式が未定（上記のとおり要再検討）。
5. **各社独自ID（③）の運用**: `external_test_id`/`external_barcode` の**採番タイミング・スキャン工程・突合ルール**（`id_management_and_correlation_spec §7-3` の未確定事項）。
