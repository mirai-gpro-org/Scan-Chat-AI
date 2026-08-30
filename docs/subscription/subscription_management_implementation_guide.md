# サブスク契約管理 機能拡張 実装手順書

| 項目 | 内容 |
|---|---|
| 文書名 | サブスク契約管理 機能拡張 実装手順書 |
| バージョン | 0.1 (Draft) |
| 作成日 | 2026-06-28 |
| 対象 | `docs/subscription/subscription_management_feature_requirements.md` (要件1〜4・データモデル拡張) の実装 |
| 関連文書 | (要件) `docs/subscription/subscription_management_feature_requirements.md` / (S3) `docs/elith/elith_s3_data_handoff_spec.md` / (UP) `docs/lab/wellfort_admin_lab_upload_spec.md` / (進捗) `docs/lab/kit_progress_management.md` / (割当) `docs/lab/lab_integration_workflow.md` |

> 本書は要件定義書を**実装に落とすための作業手順**。各フェーズは「対象ファイル / 変更内容 / 検証 / 依存」を
> 明記する。チェックボックスは進捗管理に使う。**未確定事項 (要件定義書 §9) は着手前に解消**すること。

---

## 0. 前提・環境

### 0.1 技術スタック (既存)

- **Astro v5 + TypeScript** (SSR / Vercel)。管理UIは `.astro`、API は `src/pages/api/**.ts`。
- **Supabase (PostgreSQL)** 2スキーマ構成: `customer` (PII) / `diagnosis` (非PII)、橋渡し `diagnostic_user_id`。
- **AWS S3** (`@aws-sdk/client-s3`、`src/lib/s3.ts`)。
- リポジトリ: 管理UIの一部は `wellfort-site/src/pages/admin/`、診断系ロジックは `Scan-Chat-AI/`。

### 0.2 着手前チェック (要件定義書 §9 の解消)

- [ ] #9 検査構成の正は `subscription_plans` か (EC `test_products` との二重管理方針)
- [ ] #10 マスタ/マッピングの SoT (シート→DB seed 後どちらを正にするか)
- [ ] #1 「初回/2回目/3回目」の軸 (`subscription_seq` / `subscription_year`)
- [ ] #2 発送通知手段 / #4 検査別CSVの提出先・列仕様 / #6 AI疾病予測の format_id

### 0.3 ブランチ / 進め方

- 開発ブランチ: `claude/clever-cray-ngg0h6` (両リポジトリ)。
- フェーズ単位でコミット。マイグレーションは**前方互換** (既存データを壊さない) で追加。

---

## フェーズ全体像 (依存順)

```
P1 データモデル ──▶ P2 キット発送/進捗(要件1) ──▶ P3 検査結果UP(要件2)
        │                                                  │
        └──────────▶ P4 AI問診パターン+出力(要件3) ──────────┴──▶ P5 Elith S3一括(要件4)
                                                                       │
                                                                  P6 結合・受入
```

- **P1 が全ての基盤**。P2〜P4 は P1 後に並行可能。P5 は P3・P4 の出力に依存。

---

## P1. データモデル拡張 (要件定義書 §6)

新規マスタ/関係/明細テーブルを追加する。**非PII設定は `catalog` スキーマ新設**、回答は `diagnosis`。

### P1-1. マイグレーション追加

- 対象: `Scan-Chat-AI/supabase/migrations/`（既存 `20260601000010_schemas_and_tables.sql` 命名に倣う）
- [ ] `2026XXXX_catalog_schema.sql` — `create schema catalog;`
- [ ] `2026XXXX_test_definitions.sql` — `catalog.test_definitions` (§6.2 DDL)
- [ ] `2026XXXX_plan_test_items.sql` — `customer.plan_test_items` (§6.4 DDL)
- [ ] `2026XXXX_questionnaire.sql` — `catalog.questionnaire_items` / `questionnaire_item_targets` (§6.3 DDL)
- [ ] `2026XXXX_diag_measurements_answers.sql` — `diagnosis.test_measurements` / `diagnosis.interview_answers`
- [ ] `updated_at` トリガが要るテーブルには既存 `touch_updated_at()` を適用

### P1-2. seed (初期投入)

- [ ] `test_definitions`: 5検査 (cancer_urine/blood/ai_prediction/genetics/health_checkup) + `lab_company_id` + `elith_format_id`
- [ ] `plan_test_items`: **付録Bマトリクス**から (plan × test × annual_count × first_time_only × timing_rule)
- [ ] `questionnaire_items` / `questionnaire_item_targets`: 「問診票まとめ」共通項目 + 「マッピング_最終」(gid=100284558)
- [ ] seed スクリプトは `scripts/seed-*.sql` か `scripts/*.ts` で再現可能に

### P1-3. 既存項目の移行 (置換)

- [ ] `subscription_plans.tests_per_cycle[]` / `genetics_once` の利用箇所を `plan_test_items` 参照へ差し替え
- [ ] 旧カラムは「読み取り専用 → 後続リリースで drop」の2段階 (前方互換)
- [ ] TS 型を再生成: `src/types/supabase-*.ts` (customer/diagnosis) に新テーブルを反映

### P1-4. 検証

- [ ] seed 後、付録Bの各プランの検査回数が `plan_test_items` のクエリで一致
- [ ] `questionnaire_item_targets` で各検査の必要項目数がマッピング表と一致
- [ ] 既存 API (lab-results/upload, interview/export 等) がリグレッションなく動作

---

## P2. 要件1: 検査キット発送・進捗の一元管理

既存 `kit_shipments` / `/api/kit/[id]/self-report` / `/admin/shipping` を、契約起点に拡張する。

### P2-1. 発送スケジュール自動算出 (R1-1)

- 新規ロジック: `Scan-Chat-AI/src/lib/kit-schedule.ts` (純粋関数)
  - 入力: `subscriptions.started_at` + `plan_test_items` (annual_count, timing_rule, first_time_only)
  - 出力: 各回 (year, seq, test_type, 発送予定日) — 付録B「年4回=3ヶ月毎 …」ルールを適用
- [ ] 関数実装 + 単体テスト (経営幹部/スタンダード/管理職/個別の各プランで期待値検証)

### P2-2. 出荷指示の起票 (R1-2/R1-3)

- 対象: `wellfort-site/src/pages/admin/shipping.astro` (既存の出荷指示UI) を契約起点で起票できるよう拡張
- [ ] スケジュールから `kit_shipments` 行を生成 (`subscription_id`/`year`/`seq`/`test_type`)
- [ ] 出荷FB CSV 取込で `shipped_at`/`tracking_no`/`carrier` を更新 (既存踏襲)

### P2-3. 発送通知 / 受取・返送確認 (R1-4/R1-5/R1-6)

- [ ] 発送通知: 通知手段確定 (§9 #2) 後に実装 (Webアプリ内通知 or メール)
- [ ] 受取/返送: 既存 `POST /api/kit/{id}/self-report` を利用 (`user_received_at`/`user_returned_at`)
- [ ] 検査会社受領/完了: `lab_received_at`/`lab_completed_at` の更新経路を整備

### P2-4. 契約画面への進捗集約 (R1-7)

- 対象: `wellfort-site/src/pages/admin/subscriptions.astro` 詳細モーダル (既存 `:285-331`)
- [ ] 「検査キット進捗」セクション追加: 回 × 検査種別 × 進捗6段階 (`docs/lab/kit_progress_management.md §4.2`)
- [ ] データ取得 API: `GET /api/admin/subscriptions/{id}/kits` (契約配下の `kit_shipments` 一覧)

### P2-5. 検証

- [ ] 申込日入力 → 各回の発送予定が正しく算出・起票される
- [ ] 自己申告・出荷FBで進捗ステータスが遷移する
- [ ] 契約詳細でタイムライン表示

---

## P3. 要件2: 検査結果 PDF の手動アップロード UI

既存 `/admin/lab-results/upload` (`docs/lab/wellfort_admin_lab_upload_spec.md`) を中核に、契約/回と連動。

### P3-1. 既存UP機能の確認・微修正

- 対象: `Scan-Chat-AI/src/pages/admin/lab-results/upload.astro` / `api/admin/lab-results/{upload,check}.ts`
- [ ] 4社 (rieger/prevent/genoplan/laif) → `test_type` マッピングが `test_definitions` 参照に統一
- [ ] `test_artifacts` (`source=wellfort_lab`, `imported_by=wellfort_manual`) + `test_artifact_files` 生成 (既存)

### P3-2. ユーザー割当 (R2-4)

- [ ] `docs/lab/lab_integration_workflow.md` の Workflow 1/2/3 に従い `diagnostic_user_id` を確定
- [ ] **氏名・生年月日の自動マッピングのみで確定しない** (PHI誤割当防止)

### P3-3. 割当状況の可視化・進捗連動 (R2-5)

- [ ] 契約/顧客単位で「取込済 / 未割当 / 未着」を可視化
- [ ] 取込完了で `kit_shipments.lab_completed_at` と連動 (要件1進捗へ反映)

### P3-4. 検証

- [ ] PDF/CSV アップロード → 重複チェック → 正しい顧客へ割当 → 進捗反映の一連が通る

---

## P4. 要件3: AI問診のパターン制御と検査別ファイル出力

`interview-script.ts` の `when` 基盤を活かしつつ、パターン判定と検査別出力を追加。

### P4-1. パターン判定 (R3-1)

- 新規: `Scan-Chat-AI/src/lib/interview-pattern.ts`
  - 入力: 顧客のプラン (`plan_test_items` の対象検査集合)
  - 出力: パターン A/A'/B/B'/C (要件定義書 §4.2 / 付録A)
- [ ] 実装 + テスト (各プラン→期待パターン)

### P4-2. 出題の出し分け (R3-2)

- 対象: `src/scripts/chat/interview-script.ts` (出題エンジン) / `questionnaire_items` (DB化する場合)
- [ ] パターンに含まれる検査+Elith が要求する項目の**和集合**のみ出題
- [ ] 段階移行: まず `questionnaire_item_targets` を参照して出題集合を決定 (エンジン全DB化は後追い)
- [ ] 階層 (飲酒有無＞種類＞摂取量) は既存 `when`/新 `show_when` で制御

### P4-3. 回答の永続化

- [ ] `diagnosis.interview_answers` に保存 (`diagnostic_user_id`/`diagnostic_id`/`items_version`)
- 既存 `src/lib/interview-export.ts` は出力変換に専念させる

### P4-4. 検査別ファイル出力 (R3-3/R3-4)

- 新規: `src/lib/interview-outputs.ts`
  - [ ] **LLM初期出力 md**: `interview_raw.md` (一次成果物・監査用)
  - [ ] **検査機関向け CSV**: a/b/c/d 別。列構成は `questionnaire_item_targets.output_col` 準拠 (提出先・文字コードは §9 #4 確定後)
  - [ ] **Elith向け JSON**: `LifestyleQuestionnaireData` (`docs/elith/elith_s3_data_handoff_spec.md §7.3`)
- [ ] マッピング変更時は同関数で再生成できる (シート/DB を真実に)

### P4-5. 検証

- [ ] 各パターンで出題項目が和集合と一致
- [ ] 検査別CSVがマッピングの項目サブセットと一致 / Elith JSON がスキーマ準拠

---

## P5. 要件4: Elith 用データの S3 一括書き出し

データ仕様は `docs/elith/elith_s3_data_handoff_spec.md` 確定済。**出揃い判定 → 一括書き出し**を実装。

### P5-1. 構造化変換 (各ソース → 共通エンベロープ)

- [ ] 検査結果 (PDF/CSV) → `test_measurements` → format別 JSON (§7.1/7.2)。構造化方式は §9 #7 確定後
- [ ] AIスキャン健診 → `HealthCheckupData`/`BloodTestData` (既存 `scan-export.ts` を共通エンベロープへ載せ替え)
- [ ] AI問診 → `LifestyleQuestionnaireData` (P4-4 を再利用)

### P5-2. 出揃い判定オーケストレーション (R4-3/R4-4)

- 新規: `src/lib/elith-handoff.ts`
  - [ ] プランが要求する format_id 集合 (`plan_test_items`) を充足したか判定 (`docs/elith/elith_s3_data_handoff_spec.md §8.1`)
  - [ ] 充足時に当該回の全 JSON を変換 → `/user/{client_id}/date/{YYYY_MM_DD}/` へ一括 PutObject
  - [ ] 最後に `manifest.json` (`complete:true`) を Put → Elith 通知 (§8.2)
- [ ] 既存 `src/lib/s3.ts` を再利用。逐次書き出し (`scan/export`,`interview/export`) は**ステージング保存**へ変更

### P5-3. PII / 命名

- [ ] パス・ファイル名・本文に氏名/住所/生年月日を載せない (年齢・性別のみ)
- [ ] 命名規約 `{format_id}_date_{YYYY_MM_DD}_user_{client_id}.json` を厳守

### P5-4. 検証

- [ ] 必要データ充足の前後で「未書き出し → 一括書き出し」が起きる
- [ ] 年複数回で日付フォルダが回ごとに分かれる
- [ ] Elith 側が `manifest.json` 起点で半端読み取りせずに取得できる

---

## P6. 結合テスト・受け入れ

- [ ] **エンドツーエンド**: 契約 → 発送 → 受取/返送 → 結果UP → 問診 → 出揃い判定 → S3一括 → (Elith診断結果受信は `docs/旧版・ボツ/elith_report_integration.md`)
- [ ] 各プラン (経営幹部/スタンダード/管理職/個別) で回数・タイミング・パターンが付録Bと一致
- [ ] PII 越境がないこと (S3/CSV/ログに氏名等が出ない)
- [ ] リグレッション (既存 admin/orders/customers/products、scan/interview export)

---

## 付録: 主な新規/変更ファイル一覧

| フェーズ | 種別 | パス | 内容 |
|---|---|---|---|
| P1 | 新規(SQL) | `Scan-Chat-AI/supabase/migrations/2026XXXX_*.sql` | catalog schema / test_definitions / plan_test_items / questionnaire_* / measurements / interview_answers |
| P1 | 新規(seed) | `Scan-Chat-AI/scripts/seed-*.sql` (or `.ts`) | マトリクス・マッピングの初期投入 |
| P1 | 変更 | `Scan-Chat-AI/src/types/supabase-*.ts` | 型再生成 |
| P2 | 新規 | `Scan-Chat-AI/src/lib/kit-schedule.ts` | 発送スケジュール算出 |
| P2 | 変更 | `wellfort-site/src/pages/admin/subscriptions.astro` / `shipping.astro` | 進捗集約 / 契約起点起票 |
| P2 | 新規(API) | `Scan-Chat-AI/src/pages/api/admin/subscriptions/[id]/kits.ts` | 契約配下キット一覧 |
| P3 | 変更 | `Scan-Chat-AI/src/pages/admin/lab-results/upload.astro` ほか | test_definitions 統一・割当可視化・進捗連動 |
| P4 | 新規 | `Scan-Chat-AI/src/lib/interview-pattern.ts` / `interview-outputs.ts` | パターン判定 / 検査別CSV・md・JSON 出力 |
| P4 | 変更 | `Scan-Chat-AI/src/scripts/chat/interview-script.ts` / `src/lib/interview-export.ts` | 出題出し分け / 出力分離 |
| P5 | 新規 | `Scan-Chat-AI/src/lib/elith-handoff.ts` | 出揃い判定・一括書き出しオーケストレーション |
| P5 | 変更 | `Scan-Chat-AI/src/pages/api/{scan,interview}/export.ts` / `src/lib/scan-export.ts` | ステージング化・共通エンベロープ |

## 付録: リリース順 (推奨)

1. **R0**: P1 マイグレーション + seed (旧カラムは温存=前方互換)
2. **R1**: 要件1 (発送・進捗) → 運用で最も効く
3. **R2**: 要件2 (結果UP連動)
4. **R3**: 要件3 (問診パターン・出力)
5. **R4**: 要件4 (S3一括) → R2/R3 の出力が揃ってから
6. **R5**: 旧 `tests_per_cycle[]`/`genetics_once` drop・逐次S3書き出し廃止 (クリーンアップ)
