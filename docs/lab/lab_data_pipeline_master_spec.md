# 検査データ・パイプライン 総合仕様書（EC購入 → キット → 問診 → 各社受渡 → Elith → 表示）

| 項目 | 内容 |
|---|---|
| 目的 | **サブスク検査プランの購入から、キット発送・進捗管理・AI問診／検体返送・各社への問診データ受渡・検査結果受領・Elithへのラップ書き出し・AI診断結果の表示まで**、E2E の一連の流れを1本に束ねる**総合仕様書（正本・上位文書）**。個別の詳細は下記3ドキュメントに委譲し、本書はそれらを **6ステップの流れ**で連結・統合する。 |
| 位置づけ | **本書＝E2E 全体像の正本**。各論の正本は下記(a)(b)(c)＋Elith/サブスク各 spec。**二重管理しない**（詳細は各 spec を参照し、本書は流れと責務分界・連結点のみ規定）。 |
| 統合対象（3本） | (a) `docs/lab/lab_data_reception_overview.md`（各社**受取方式**）／(b) `docs/lab/questionnaire_to_lab_csv_spec.md`（**AI問診→各社CSV** 写像）／(c) `docs/subscription/kit_lifecycle_and_handoff_management_spec.md`（**キット出荷・進捗・受渡** 統合管理・データモデル） |
| 版 | 2026-08-12（Draft・初版） |
| 関連 | `docs/subscription/subscription_management_feature_requirements.md`（サブスク契約管理）／`docs/billing/gmo_subscription_billing_spec.md`（決済・契約状態）／`docs/elith/elith_batch_centralization_design.md`・`docs/elith/elith_assembly_wrapping_spec.md`・`docs/elith/elith_s3_data_handoff_spec.md`（Elith 受渡）／`docs/lab/lab_integration_workflow.md`・`docs/architecture/data_integration_requirements.md`（割当・PII） |

---

## 0. E2E フロー全体像（6ステップ）

```
①EC購入(サブスク検査プラン)
   └─▶ ②プラン→キット構成・検査タイミング(版管理)  ……(c)§1,§6.1
          └─▶ ③倉庫(タカセ)へ発送指示 / ユーザーへ進捗管理  ……(c)§2,§3
                 ├─▶ ④AI問診＋検体返送を促し、問診データを各社へ所定方式で受渡  ……(b)全体 / (a)受取方式 / (c)§4.1
                 │       ・血液=リージャー(RPA) / がん=プリベント(専用ポータル+S3を提案中) /
                 │        AI疾病予測=LAiF(専用ポータル+S3) / 遺伝子=Genoplan(RPA)
                 └─▶ ⑤各社の検査結果を所定タイミング(仮:週次)でチェック→
                         必要データが揃ったらElith形式へラップ→AWS S3へ書き出し  ……(a)変換 / Elith各spec
                            └─▶ ⑥ElithのAI診断結果(PDF)をS3から受取→Webアプリへ表示UP
                                    (受取仕様は今後詰める・バケット設定済・PDF・表示実装テスト済)
```

- **責務分界（横断・重要）**: **UI＝wellfort-site（admin/マイページ）／処理・鍵・API＝Scan-Chat-AI**（`CLAUDE.md`「admin UI は wellfort-site / Scan-Chat-AI は API 提供側」）。鍵は **Vercel 本番 env のみ**。
- **PII 分離**: 外部・S3・診断系に氏名/住所は載せない。橋渡しは `client_id=diagnostic_user_id`（仮名）。**例外＝LAiF/プリベント上りCSVの生年月日**（発注者決定・ポータルで保護・(b)§6／(c)§4.1.1）。
- **ID 体系（採番・相関・PII境界・将来の外部ID/キット物理ID連携）＝`docs/architecture/id_management_and_correlation_spec.md` が正本**（顧客ID/診断ユーザーID/契約ID/検査ID/Elith client_id を層別に整理）。

---

## ① ユーザーが EC で検査プラン商品を購入

- **対象＝サブスク検査プラン（4バリアント）**。商品DB `test_products`（wellfort-site Supabase）の行、契約は `subscriptions`。決済は GMO（`gmo_subscription_billing_spec`）。
  - 幹部(50代以上) ¥187,000/157,300・年3回(4カ月毎)／幹部(30・40代) ¥143,000/113,300・年2回(6カ月毎)／ミドル(50代以上) ¥90,200/60,500・年3回／ミドル(30・40代) ¥79,200/49,500・年2回。
- **契約成立で D0 を確定**: **D0＝契約日（＝決済日）／土日祝は翌営業日**（`warehouse_calendar`）。以降の全スケジュールの起点。
- **正本**: (c)§1・§1.1（プラン×キット×タイミング／商品DB連携）。

## ② プラン毎にアセットされた検査キット・検査タイミング

- **キット構成・回数・発送間隔は「版管理された別テーブル」で保持**（確定＝案A・正規化＋版管理）:
  - `test_kits`（キット/項目マスタ・`kind`=physical_kit/data/app・`lab_company`・`format_id`）／`plan_compositions`（プラン構成ヘッダ＝版・per_year・interval_months・is_current）／`plan_composition_items`（明細・`ship_rule`=every/first_only/none）／`subscriptions.plan_composition_id`（**契約時の版をpin**＝プラン改定後も既存契約は当時構成のまま）。
- **物理キット発送（タカセ対象）＝ 遺伝子・がんリスク・血液**。
  - 遺伝子＝初回のみ(first_only) ／ がん＝毎回(every) ／ 血液＝毎回(幹部のみ) ／ AI疾病予測(LAiF)＝none（データ受領・年1回相当） ／ AI疾病予防＝none（アプリ機能・開発中）。
- **正本**: (c)§1・§6.1（DDL・初期データ・変更シナリオ耐性）。合成データ `elith-plan.ts` は上記テーブルを正として4プランへ拡張。

## ③ 倉庫（タカセ）への発送指示 ／ ユーザーへの進捗管理

### ③-1 タカセ出荷指示（プラン駆動の定期出荷）
- **契約時にキット別の出荷スケジュールを確定・登録**。各回予定日＝`D0 + 発送間隔(4/6カ月)×回index`（月末クランプ・非営業日は翌営業日）。キット別ルール（遺伝子=初回のみ／がん・血液=毎回）。
- 各予定日に、その回で発送するキットだけを **1件=1出荷指示（CSV行）** で生成→タカセへCSV送信（現行 `cron-shipping` を**スケジュール参照型**へ拡張・CSV様式は**現行踏襲**）。
- **解約/停止**で以降の予定出荷を停止（契約状態連動）。**冪等性**（契約×回×キットの二重出荷防止・`instruction_sent` 等）。
- **正本**: (c)§2。

### ③-2 Webアプリ 検査キット・ライフサイクル管理
- 状態機械（1キット×1回）:
  `出荷予定 → 出荷指示済 → 発送済 → [ユーザー]受取確認 → 検体採取/問診 → 検体返送 → 検査会社受領 → 検査結果受領 → Elithデータ作成 → 完了`。
- **ユーザー操作＝「受取確認」「返送済」**。各状態に日時・担当を記録。管理者ダッシュボード（サブスク契約管理）から契約単位で全キット進捗を一覧・操作。
- **正本**: (c)§3・`docs/lab/kit_progress_management.md`（パイロット実装済）。

## ④ 問診データが必要な検査：AI問診＋検体返送を促し、各社所定方式で受渡

### ④-1 AI問診の促し（催促エスカレーション・確定）
- 検体返送に関する Webアプリ通知の時点で **AI問診が未完了なら催促**（ハードブロックしない＝返送は止めない）。未完了の間 **毎日 Webアプリ通知**、**7日超で Wellfort 管理者へワーニング**。問診完了で停止。
- 問診CSVの各社受渡は**問診完了が前提**。
- **正本**: (c)§3.1。

### ④-2 AI問診回答 → 各社CSV 写像・受渡
- **AI問診（`LifestyleQuestionnaireData`）＋健診スキャン（`HealthCheckupData`）＋基本情報**を、**各社が必要とする項目・記法へ決定論写像**（捏造ゼロ・値の無い項目は空）。共通設問No→各社行のマスターマッピングで管理。
  - 血液（リージャー）＝23項目 ／ がん（プリベント）＝主要33項目 ／ LAiF＝主要35項目〔上り入力フォームは約158項目に拡張・(c)§4.1.1〕 ／ 遺伝子（Genoplan）＝主要70項目。
- **正本**: (b) 全体（§3 マスターマッピング／§4 各社項目リスト／§5 生成ルール／§6 会社別出力仕様）。LAiF 上りCSVの集約写像は (c)§4.1.1（3系統源・進捗駆動生成）。

### ④-3 各社への受渡方式（所定方式＝会社別）
| # | 検査 | 検査会社 | 受渡・受取方式 | Elith format_id | ステータス |
|---|---|---|---|---|---|
| 1 | 血液 | リージャー（デメカルDSS） | **デスクトップRPA**（PAD本命・mTLS）で CSV DL → 決定論パース | `BloodTestData` | サーバ側実装済／PC側RPA構築中 |
| 2 | がんリスク（尿） | プリベント（ALA-PDS） | **専用ポータル＋AWS S3＋パスキー方式を提案中**（LAiF流用）／現状はメール＋フォルダ共有の手動 | `CancerRiskAssessmentData` | **提案中（プレゼン段階）** |
| 3 | AI疾病発症予測 | LAiF | **AWS S3 専用バケット**（ポータル・パスキー・上りCSV/下りPDF） | `Other`(ai_prediction) | 受取方式確定・スキャン実装済 |
| 4 | 遺伝子 | Genoplan | **デスクトップRPA**（PDF取得） | `GeneticTestResultData` | RPA方針・スキャン実装済 |
- **正本**: (a) 各章（§1血液／§2がん／§3 LAiF／§4遺伝子）。LAiF/プリベントのセキュア受渡設計＝`docs/lab/laif_s3_secure_handoff_spec.md`（ゼロトラスト・多層防御）。

## ⑤ 検査結果を所定タイミング（仮：週次）でチェック → Elith へラップ → AWS S3 書き出し

- **受領チェック（週次案）**: 各社の受領方式ごとに**受領予定と実績を管理**し、未受領はアラート／再督促。受領でキット行を「検査結果受領」へ前進。〔チェック頻度＝**仮に週次**。確定は §確認事項。〕
- **変換（会社別）**: 血液＝**CSV決定論パース**（LLM不使用）／がん・遺伝子・AI疾病予測＝**画像AIスキャン**（Gemini・サーバ側 admin バッチ）。納品整形は決定論（`sanitizeMeasurementsForDelivery`）に集約。
- **Elith データ作成指示**: 当該回の**全必要データ（検査結果＋問診＋健康年齢等）が揃った時点**で、**Elith 形式 JSON 生成＋S3受渡を指示**。
  - S3 パス `user/{client_id}/date/{YYYY_MM_DD}/{format_id}_date_{YYYY_MM_DD}_user_{client_id}.json`（`client_id=diagnostic_user_id` 仮名）。
  - 健康年齢（CABA）・AI疾病予測も**検査日毎の時系列**で同梱（`elith_assembly_wrapping_spec`）。
- **正本**: (c)§4.2・§4.3／`docs/elith/elith_s3_data_handoff_spec.md`・`elith_batch_centralization_design.md`・`elith_assembly_wrapping_spec.md`。

## ⑥ Elith の AI 診断結果を S3 から受取 → Webアプリへ表示 UP

- **方向＝Elith→Wellfort（下り）**。ElithはAI診断結果を**所定のS3バケットに出力**、Wellfortが受取ってWebアプリ（マイページ）へ表示する。
- **フォーマット＝PDF**。**サンプルデータで表示実装テスト済**。
- **バケット＝設定済**（所定S3）。
- **受取仕様＝これから詰める（未確定）**: 命名規則・出力トリガ／通知・世代管理（同一ユーザー複数回の版）・表示のひも付け（`diagnostic_user_id`／検査日）・受領確認の運用。→ §確認事項。
- **注記**: ①〜⑤は主に**上り（Wellfort→各社／Wellfort→Elith）**、⑥は**下り（Elith→Wellfort→ユーザー）**。上り書き出し（⑤）と下り受取（⑥）は**別S3経路・別仕様**（同一バケットに混在させない前提で受取仕様を詰める）。

---

## 7. 横断事項（4検査・全ステップ共通）

- **鍵一元管理**: AWS/Gemini の鍵は Vercel 本番 env のみ。専用PC・operator・クライアントに鍵を置かない。
- **PII 分離**: `client_id=diagnostic_user_id`（仮名）で橋渡し。氏名/住所は外部・S3・診断系に載せない。氏名OCRのみの割当確定は禁止。**例外**＝LAiF/プリベント上りCSVの**生年月日**（発注者決定・ポータル保護・同意前提の確認は運用）。
- **変換の別**: 血液＝CSV決定論パース／がん・遺伝子・AI疾病予測＝画像AIスキャン。
- **admin/UI＝wellfort-site、処理/API/鍵＝Scan-Chat-AI**。

## 8. 実装状況（サマリ）

- **実装済**: EC決済→発送指示CSV・`cron-shipping`（日次）・キット発送（パイロット）・各社スキャン/CSV写像/Elith 書き出しの各要素・LAiFスキャン→JSON・血液CSV↔JSON構造照合。⑥PDF表示のサンプル実装テスト済。
- **未実装（主眼）**: (a) プラン→キット展開の**定期出荷スケジュール**化、(b) ライフサイクル状態機械＋AI問診促しの結線、(c) 進捗駆動の各社受渡・受領・Elith作成指示の**オーケストレーション**、(d) ⑤受領チェック（週次）ジョブ、(e) ⑥Elith下り受取仕様の確定と本番表示結線。

## 9. 確認事項（本書で束ねる横断項目）

1. **⑤ 受領チェック頻度**: 「仮：週次」の妥当性（各社の結果提供SLAに合わせる／リアルタイム化の要否）。
2. **⑥ Elith 下り受取仕様（最重要・未確定）**: PDFの命名規則・出力トリガ／通知・世代（版）管理・`diagnostic_user_id`/検査日でのひも付け・受領確認運用。バケットは設定済・PDF・表示はサンプルでテスト済。
3. **がんリスク（プリベント）**: 専用ポータル＋S3方式の合意可否（提案中）。固定IP有無・担当者/通知先・生年月日提供の同意前提。→ (a)§7。
4. **キット構成データ**: 案A（正規化＋版管理）の DDL 実装・初期データ投入・`subscriptions.plan_composition_id` pin の結線。→ (c)§6.1。
5. **AI疾病予測/予防**: 物理キット外。AI疾病予測=年1回データ受領、AI疾病予防=開発中の回数/仕様（管理対象化の時期）。→ (c)§8。

---

### 付記：本書と各論の関係（更新ルール）
- **流れ・責務分界・連結点・E2E確認事項＝本書**を更新。
- **各社受取方式の詳細＝(a)**／**問診→CSV 写像の詳細＝(b)**／**キット出荷・進捗・受渡・データモデル（DDL）＝(c)**。詳細変更は各 spec を先に更新し、本書は要約・参照のみ（**二重管理しない**）。
</content>
</invoke>
