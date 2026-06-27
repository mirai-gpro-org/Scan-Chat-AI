# サブスク契約管理 機能拡張 機能要件定義書

| 項目 | 内容 |
|---|---|
| 文書名 | 管理者ダッシュボード「サブスク契約管理」機能拡張 機能要件定義書 |
| バージョン | 0.1 (Draft) |
| 作成日 | 2026-06-27 |
| 対象範囲 | 検査キット発送/進捗の一元管理・検査結果PDF手動UP・AI問診のパターン制御と検査別出力・Elith用S3受け渡し |
| 関連文書 | `kit_progress_management.md` / `wellfort_admin_lab_upload_spec.md` / `lab_integration_workflow.md` / `elith_s3_data_handoff_spec.md` / `data_integration_requirements.md` §1.3 |
| 参照スプレッドシート | プラン/検査項目マトリクス (gid=1880102995) / 問診票まとめ「マッピング_最終」(gid=100284558) |

---

## 0. 概要・目的

管理者ダッシュボードの **「サブスク契約管理」** に、定期検査サービスの運用を回すための
4 つの機能群を追加する。

1. **要件1**: 契約(申込日)起点の検査キット発送指示と、発送通知/受取確認/返送確認の一元管理
2. **要件2**: 検査機関から戻る検査結果 PDF を Wellfort スタッフが手作業でアップロードする UI
3. **要件3**: AI問診の **5 パターン制御** と、検査別ファイル出力 (検査機関向け CSV / Elith 向け JSON / LLM 初期 md)
4. **要件4**: 必要データが揃ったタイミングで Elith 用 S3 バケットへ一括書き出し (全て JSON)

各検査の**対象/タイミングはプランによって異なる**ため、プラン定義 (検査項目マトリクス) を
全要件の基礎データとする。

> 本書は機能要件 (What) を定義する。データ仕様 (S3パス/JSON) は `elith_s3_data_handoff_spec.md`、
> キット進捗の画面詳細は `kit_progress_management.md`、PDF アップロード画面詳細は
> `wellfort_admin_lab_upload_spec.md` に委譲し、本書はそれらを束ねて拡張点を示す。

---

## 1. 既存資産 (再利用・拡張の前提)

新規開発ではなく**既存実装の拡張**として設計する。主な既存資産:

| 領域 | 既存実装 | 場所 |
|---|---|---|
| 管理ダッシュボード | `/admin/*` (orders/customers/subscriptions/shipping/products 他) | `wellfort-site/src/pages/admin/` |
| サブスク契約管理 UI | `subscriptions.astro` (一覧/詳細/状態変更) | `wellfort-site/src/pages/admin/subscriptions.astro` |
| 契約データ | `customer.subscriptions` / `customer.subscription_plans` | `Scan-Chat-AI/supabase/migrations/...010_schemas_and_tables.sql:79-108` |
| キット進捗データ | `customer.kit_shipments` (発送〜返送〜検査完了の時刻列) | 同上 `:111-140` |
| キット進捗仕様 | `kit_progress_management.md` (進捗6段階・通知) | `Scan-Chat-AI/docs/` |
| ユーザー自己申告 API | `POST /api/kit/{id}/self-report` (received/returned) | `Scan-Chat-AI/src/pages/api/kit/[id]/self-report.ts` |
| 検査結果UP UI | `/admin/lab-results/upload` (4社対応・重複チェック) | `Scan-Chat-AI/src/pages/admin/lab-results/` |
| 検査結果UP 仕様 | `wellfort_admin_lab_upload_spec.md` | `Scan-Chat-AI/docs/` |
| 検査成果物データ | `diagnosis.test_artifacts` / `test_artifact_files` | migration `:186-226` |
| AI問診 (条件分岐) | `interview-script.ts` (`when` による出し分け・検査種別分岐) | `Scan-Chat-AI/src/scripts/chat/interview-script.ts` |
| 問診エクスポート | `interview-export.ts` (JSON/Markdown) | `Scan-Chat-AI/src/lib/interview-export.ts` |
| Elith S3 受け渡し | `elith_s3_data_handoff_spec.md` | `Scan-Chat-AI/docs/` |

### 1.1 プラン × 検査の基礎データ (マトリクス)

検査の**対象/回数/タイミング**はプランで決まる (gid=1880102995)。`subscription_plans` の
`tests_per_cycle[]` / `genetics_once` / `cycle_months` がこれを表現する。
**マトリクスの全容・料金・発送タイミングのルールは付録B に掲載**する。

| 検査 (本書の記号) | test_type | 検査機関 | 主な発生規則 (例) |
|---|---|---|---|
| a) がんリスク検査(尿) | `cancer_urine` | PREVENT | プランごとに年2〜3回 |
| b) 血液検査 | `blood` | Rieger | 経営幹部=年3 / スタンダード=年1 等 |
| c) AI疾病予測(Elith以外) | `ai_prediction` | LAIF | 上位プランのみ |
| d) 遺伝子検査 | `genetics` | Genoplan | **初回1回のみ** (`genetics_once`) |
| 人間ドック/健診 | `health_checkup` | (スキャン取込) | 年1回・初回は直近結果をスキャン提出 |
| AI問診 / AI診断(Elith) | - | scan-chat-ai / Elith | 回ごと |

---

## 2. 要件1: 検査キット発送・進捗の一元管理

### 2.1 概要

契約 (申込日 = `subscriptions.started_at`) を起点に、プランの検査サイクルに沿って
**初回・2回目・3回目…の検査キット発送指示 (倉庫への出荷指示)** を生成し、Web アプリ経由の
**発送通知・受取確認・検体返送確認**までを「サブスク契約管理」画面から一元管理する。

### 2.2 機能要件

| ID | 要件 | 既存/新規 |
|---|---|---|
| R1-1 | 申込日とプラン (`cycle_months`, `tests_per_cycle[]`) から、各回 (第1〜N回) の**発送予定**を自動算出 | 新規 (`kit_progress_management.md` の通知スケジュールを拡張) |
| R1-2 | 各回の発送対象検査キットを特定し、**倉庫への出荷指示**を生成・送信 (既存 `/admin/shipping` を契約起点で起票) | 拡張 |
| R1-3 | 出荷実績 (`shipped_at`/`tracking_no`/`carrier`) を取り込み、`kit_shipments` を更新 | 既存 (出荷FB CSV取込) |
| R1-4 | Web アプリ経由で顧客へ**発送通知** (発送済・追跡URL) | 拡張 (通知基盤) |
| R1-5 | 顧客による**受取確認** (`user_received_at`) / **返送確認** (`user_returned_at`) を記録 | 既存 (`/api/kit/{id}/self-report`) |
| R1-6 | 検査機関の**受領** (`lab_received_at`) / **完了** (`lab_completed_at`) を記録 | 既存 (列あり・運用要) |
| R1-7 | 契約 1 件の中で「第何回・どの検査・いま進捗どこか」を一覧/タイムラインで俯瞰 | 新規 (契約詳細に進捗ビュー追加) |

### 2.3 進捗ステータス (既存踏襲: `kit_progress_management.md §4.2`)

```
出荷準備完了 → 倉庫から発送 → お受け取り(顧客) → 検体採取・返送(顧客)
  → 検査会社受領 → 検査完了
```

- `kit_shipments` は `subscription_id` / `subscription_year` / `subscription_seq` で
  「どの契約の第何回か」に紐付く (既存列)。要件1はこの粒度を契約画面に集約する。

### 2.4 画面 (サブスク契約管理への追加)

- 契約詳細モーダル (`subscriptions.astro:285-331`) に **「検査キット進捗」タブ/セクション**を追加。
- 回 (第1回/第2回…) ごとに、検査種別 × 進捗6段階のステータスと操作 (出荷指示・通知再送等) を表示。

> **要確認**: 「初回・2回目・3回目」は (a)サイクル内の回 (`subscription_seq`)、
> (b)契約年 (`subscription_year`)、のどちらの軸を主に指すか。マトリクスの「年N回」と整合させる。

---

## 3. 要件2: 検査結果 PDF の手動アップロード UI

### 3.1 概要

検査機関で採取検体を分析後、結果は Wellfort へ通知される。
**将来はシステム連携 (API)** を目指すが、**現状は手作業**:

```
検査機関 ──(完了通知メール等)──▶ Wellfortスタッフ
   Wellfortスタッフが各検査機関サイトへログイン → 顧客毎の結果PDFをDL
   → 本システムの管理UIへ手作業でアップロード
```

対象 4 検査: **a) がんリスク検査(尿) / b) 血液検査 / c) AI疾病予測(Elith以外) / d) 遺伝子検査**。

### 3.2 機能要件

既存の `/admin/lab-results/upload` (`wellfort_admin_lab_upload_spec.md`) を中核に据える。

| ID | 要件 | 既存/新規 |
|---|---|---|
| R2-1 | 検査機関 (rieger/prevent/genoplan/laif) を選択し、PDF/CSV を複数アップロード | 既存 |
| R2-2 | アップロード前に**重複チェック** (`POST /api/admin/lab-results/check`) | 既存 |
| R2-3 | `test_artifacts` (`source=wellfort_lab`, `test_type`, `lab_name`, `age_at_test`, `sex`, `imported_by=wellfort_manual`) と `test_artifact_files` (`raw_pdf_redacted`/`raw_csv`) を作成 | 既存 |
| R2-4 | アップロードした結果を正しい**顧客 (`diagnostic_user_id`)** に割当 | 既存ワークフロー (`lab_integration_workflow.md`) |
| R2-5 | 割当状況・未割当・取り込み済みを契約/顧客単位で可視化し、要件1の進捗 (`lab_completed_at`) と連動 | 拡張 |
| R2-6 | (将来) 検査機関 API 連携への差し替え余地を残す (取込経路を `imported_by` で区別済) | 設計方針 |

### 3.3 ユーザー割当の絶対制約 (PII)

`lab_integration_workflow.md §1.1` に従う:

- `diagnostic_user_id` が顧客系/診断系の**唯一の橋渡し**。
- **氏名・生年月日の OCR 自動マッピングのみで割当を確定するのは禁止** (誤割当=PHI漏洩)。
- 割当は ID 同伴方式 (★最終目標) / 検査ID逆引き / AI抽出+人手承認 のいずれか。

---

## 4. 要件3: AI問診のパターン制御と検査別ファイル出力

### 4.1 概要

AI問診の結果は **Elith の AI診断インプット**だけでなく、**a)〜d) の各検査でも利用**される。
ただし**各検査で必要な問診項目は微妙に異なる** (問診票まとめ「マッピング_最終」gid=100284558)。

> マッピングの実体: 共通問診 (FormsのNo.1〜81) の各設問が、検査ごとに
> 「使う項目No / `×`(対象外) / 空欄」で対応づけられている。
> 例: 共通No.1 → 血液=3,4 / がんリスク=× / AI疾病予測=× / 遺伝子=× 。
> → **各検査は共通問診の異なるサブセットを必要とする**。

### 4.2 5 つの問診パターン

顧客のプラン構成により、問診は次の 5 パターンに分かれる:

| パターン | 含まれる検査 | 必要な問診項目 (考え方) |
|---|---|---|
| A  | a) + b) + c) + AI診断Elith | a/b/c の必要項目の和集合 + Elith 用 |
| A' | a) + b) + c) + d) + AI診断Elith | a/b/c/d の和集合 + Elith 用 |
| B  | a) + AI診断Elith | a の必要項目 + Elith 用 |
| B' | a) + d) + AI診断Elith | a/d の和集合 + Elith 用 |
| C  | AI診断Elith のみ | Elith 用のみ |

- **問診で尋ねる設問** = そのパターンに含まれる全検査 + Elith が要求する項目の**和集合**。
- パターンは顧客のプラン (`subscription_plans.tests_per_cycle[]` 等) から決定する。

### 4.3 機能要件

| ID | 要件 | 既存/新規 |
|---|---|---|
| R3-1 | プランから問診パターン (A/A'/B/B'/C) を判定し、Web アプリの AI問診に適用 | 新規 (判定ロジック) |
| R3-2 | パターンに応じて**出題する設問を出し分け** (和集合のみ提示) | 拡張 (`interview-script.ts` の `when` 条件分岐基盤を利用) |
| R3-3 | 回答完了後、**検査別に問診ファイルを出力** (項目サブセットはマッピングに従う) | 新規 |
| R3-4 | 出力フォーマット: **a)〜d) は CSV** (各検査機関向け) / **Elith 用は JSON** / **LLM 初期出力は md** | 新規 (要確認) |
| R3-5 | 検査別 CSV の項目構成は「マッピング_最終」を単一の真実とし、変更時は同表から再生成 | 設計方針 |

### 4.4 出力フォーマットの整理 (要確認)

ユーザー指定: 「a)〜d)は CSV、Elith 用は Json、LLM からの初期の吐き出しは md ?」

```
[LLM 初期出力] interview_raw.md      ← 問診の生テキスト (人/監査用・一次成果物)
        │ 構造化
        ├─▶ [検査機関向け] a_cancer.csv / b_blood.csv / c_aipred.csv / d_genetics.csv
        │                  ← マッピングに基づく検査別サブセット (検査機関提出用)
        └─▶ [Elith向け]    LifestyleQuestionnaireData_...json
                           ← elith_s3_data_handoff_spec.md §7.3 準拠
```

> **要確認(Wellfort/Elith/検査機関)**:
> 1. a)〜d) の CSV は各検査機関へ提出する想定でよいか (提出先・列仕様・文字コード)。
> 2. md (LLM 初期出力) は保管/監査用の一次成果物という理解でよいか。
> 3. 既存 `interview-export-v0` (単一 JSON) との関係 — Elith 向けは JSON、検査機関向けは CSV、と二系統で出力する。

---

## 5. 要件4: Elith 用データの S3 受け渡し

### 5.1 概要

**必要なデータが揃ったタイミング**で、Elith 用 S3 バケットの所定フォルダへ
**一括書き出し**する。対象は **a)〜d) の検査結果・AI問診結果・AIスキャンで読み込んだ
人間ドックのデータ**で、**全て JSON 形式**。

> 本要件のデータ仕様 (パス/命名/JSON スキーマ/書き出しトリガ) は
> **`elith_s3_data_handoff_spec.md` に確定済**。本書はそれを要件として参照する。

### 5.2 機能要件 (要約。詳細は `elith_s3_data_handoff_spec.md`)

| ID | 要件 | 参照 |
|---|---|---|
| R4-1 | 格納パス `/user/{client_id}/date/{YYYY_MM_DD}/`、ファイル `{format_id}_date_{YYYY_MM_DD}_user_{client_id}.json` | §3 |
| R4-2 | format_id: `CancerRiskAssessmentData`/`BloodTestData`/`GeneticTestResultData`/`HealthCheckupData`/`LifestyleQuestionnaireData`/`Other` | §4 |
| R4-3 | **必要データが出揃った時点で**顧客フォルダへ**一括書き出し** (逐次ではない) | §8.0 |
| R4-4 | 「出揃った」判定はプランが要求する検査・問診項目の充足で行う | §8.1 |
| R4-5 | 年複数回 (例 年4回) は **AI診断実行ごとに日付フォルダを作成** | §3.3 |
| R4-6 | PII 越境禁止 (氏名/住所/生年月日を載せない。年齢・性別のみ) | §5.2 |

### 5.3 入力ソースの対応

| Elith 向け JSON (format_id) | ソース | 取得経路 |
|---|---|---|
| `CancerRiskAssessmentData` (a) | 検査機関 PDF/CSV | 要件2 のアップロード → 構造化 |
| `BloodTestData` (b) | 検査機関 PDF/CSV or スキャン | 要件2 / AIスキャン |
| `Other` (c: AI疾病予測) | 検査機関 PDF | 要件2 (専用 format_id 要否は要確認) |
| `GeneticTestResultData` (d) | 検査機関 PDF | 要件2 |
| `LifestyleQuestionnaireData` | AI問診 | 要件3 (Elith 向け JSON) |
| `HealthCheckupData` (人間ドック) | **AIスキャン**で読込んだ健診/ドック結果 | scan-export |

> **注意 (フォーマットの二系統)**: 要件3 で検査機関向けに出す **CSV** と、要件4 で Elith 向けに出す
> **JSON** は別物。同じ問診回答でも、提出先により CSV / JSON を作り分ける。

---

## 6. 全体データフロー

```
[契約(申込日)]
   └─ プラン(cycle_months, tests_per_cycle[], genetics_once) → 問診パターン判定(要件3)
                                                              → 発送スケジュール(要件1)
[要件1] 出荷指示 → 倉庫発送 → (Web)発送通知 → 受取確認 → 検体返送確認
                                                          │ 検体は検査機関へ
[検査機関] 分析 → 結果通知(現状メール)
[要件2] Wellfortスタッフが結果PDFをDL → /admin/lab-results/upload → test_artifacts/files
                                                                    → 顧客割当(diagnostic_user_id)
[要件3] AI問診(パターン制御) → interview_raw.md
            ├─ 検査機関向け a〜d.csv (マッピング準拠)
            └─ Elith向け LifestyleQuestionnaireData.json
[AIスキャン] 人間ドック等を読込 → HealthCheckupData/BloodTestData.json
                              │
[要件4] 必要データが揃った判定 → /user/{client_id}/date/{YYYY_MM_DD}/ へ一括書き出し(全JSON)
                              → Elith AI診断 → (別系統)診断結果受信 elith_report_integration.md
```

---

## 7. 既存実装とのギャップ (新規/拡張の所在)

| 要件 | 既存で充足 | 新規/拡張が必要 |
|---|---|---|
| 要件1 | kit_shipments 列・自己申告API・出荷FB取込 | 申込日起点の自動スケジュール・契約画面への進捗集約・発送通知基盤 |
| 要件2 | アップロードUI・重複チェック・DB書込 | 契約/回との連動・割当状況の可視化・(将来)API連携 |
| 要件3 | `when` による条件分岐基盤・問診JSON | パターン判定・検査別サブセット出力(CSV)・md/JSON 二系統出力 |
| 要件4 | データ仕様確定 (`elith_s3_data_handoff_spec.md`) | 出揃い判定オーケストレーション・検査結果PDF→JSON構造化・スキャン健診→JSON |

---

## 8. 未確定事項 (要確認サマリ)

| # | 確認先 | 内容 | 関連 |
|---|---|---|---|
| 1 | Wellfort | 「初回/2回目/3回目」はサイクル内回 (`subscription_seq`) か契約年 (`subscription_year`) か | §2.4 |
| 2 | Wellfort | 発送通知の手段 (Webアプリ内通知/メール/プッシュ) と通知基盤 | §2.2 R1-4 |
| 3 | Wellfort/検査機関 | 検査結果の将来的なAPI連携の可否・各社の提供形態 | §3.2 R2-6 |
| 4 | Wellfort/検査機関 | a)〜d) 問診CSVの提出先・列仕様・文字コード | §4.4 |
| 5 | Wellfort | LLM初期出力 md の位置づけ (保管/監査用一次成果物か) | §4.4 |
| 6 | Elith | AI疾病予測(c)を `Other` で送るか専用 format_id が要るか | §5.3 |
| 7 | Wellfort | 検査結果PDF/CSV → Elith向けJSON への構造化方式 (自動OCR/手入力/別紙CSV) | §5.3 |
| 8 | Wellfort | 問診パターン判定をプランのどの属性で行うか (`tests_per_cycle[]` で十分か) | §4.2 |

---

## 付録 A: 問診パターンと検査・出力の対応早見表

```
パターン  含む検査                  検査機関向けCSV          Elith向けJSON
  A      a + b + c + Elith        a,b,c.csv               Lifestyle...json
  A'     a + b + c + d + Elith    a,b,c,d.csv             Lifestyle...json
  B      a + Elith                a.csv                   Lifestyle...json
  B'     a + d + Elith            a,d.csv                 Lifestyle...json
  C      Elith のみ               (なし)                  Lifestyle...json

a)=がんリスク検査(尿)  b)=血液検査  c)=AI疾病予測(Elith以外)  d)=遺伝子検査
※ 各検査が必要とする問診項目サブセットは「マッピング_最終」(gid=100284558) を真実とする
```

---

## 付録 B: プラン/検査項目マトリクス (出典 gid=1880102995)

本マトリクスを全要件のプラン×検査の基礎データとする (§1.1)。出典スプレッドシートの内容を
整理して掲載する。

### B-1. プラン区分と料金 (税込)

| プラン | 対象目安 | 初年度 | 次年度以降 |
|---|---|---|---|
| 経営幹部プラン | 50代以上推奨 | ￥187,000 | ￥157,300 |
| スタンダードプラン | 30代〜40代推奨 | ￥143,000 | ￥113,000 |
| 管理職プラン (上) | 50代以上推奨 | ￥90,200 | ￥60,500 |
| 管理職プラン (下) | 30代・40代推奨 | ￥79,200 | ￥49,500 |
| 個別 AI疾病予防 | (個別購入) | ￥7,700 | — |

### B-2. 検査項目別 実施回数 (年間・初年度ベース)

| 区分 | 検査項目 | フォーマット | 経営幹部 | スタンダード | 管理職(上) | 管理職(下) | 個別 |
|---|---|---|---:|---:|---:|---:|---:|
| 個人/会社で受診 | 人間ドック | 複数 | 1 | 1 | 1 | 1 | 1 |
| 〃 | 定期健康診断 | 複数 | 1 | 1 | 1 | 1 | 1 |
| 〃 | その他検査 (血液検査など) | 複数 | — | — | — | — | — |
| Wellfort経由 | 血液検査 | 固定 | 3 | 1 | — | — | — |
| 〃 | 遺伝子検査 | 固定 | 初回1回 | 初回1回 | 初回1回 | 初回1回 | — |
| 〃 | がんリスク検査 (尿) | 固定 | 3 | 3 | 3 | 2 | — |
| 〃 | AI疾病予測 (Elith以外) | 固定 | 1 | 1 | — | — | — |
| 〃 | AI問診 (Webアプリで直接回答) | 固定 | 3 | 3 | 3 | 2 | 1 |
| Elith診断結果 | AI診断 | — | 4 | 2 | 1 | 1 | 1 |

- 数値 = 年間実施回数。`—` = そのプランでは対象外。
- 「遺伝子検査」は全プラン**初回1回のみ** (`subscription_plans.genetics_once` に対応)。
- 「フォーマット」: 複数=結果様式が一定でない (スキャン取込対象) / 固定=様式が定型 (検査機関の定型帳票)。
- 次年度以降の各検査回数は出典で空欄 = 初年度に準ずる想定。**要確認** (§8)。

### B-3. 確認事項 (出典の注記。要件1・要件3に直結)

**1) 検査キットの発送・実施タイミング** (申込月を 1ヶ月目とする)

| 年間回数 | 発送間隔 |
|---|---|
| 年4回 | 3ヶ月毎 |
| 年3回 | 4ヶ月毎 |
| 年2回 | 6ヶ月毎 |
| 年1回 | 1ヶ月目 (申込月) |

→ **要件1 (R1-1)** の発送スケジュール自動算出は、このルールとプランの実施回数から導出する。

**2) 人間ドック・健康診断のユーザーからの提出タイミング**

- 人間ドック・健康診断は基本**年1回**。
- **初回**は、申込月の直近 (直前) の検査結果を**スキャン提出**。
- **2年目以降**は、がんリスク検査のタイミング (ユーザーへの検査キット送付通知) に合わせて:
  - ① Webアプリで **AI問診のお願い** (ユーザーの実行催促・管理)
  - ② Webアプリで **最新の人間ドック・健康診断結果の有無確認とスキャン提出依頼** (実行催促・管理)

→ **要件1 (R1-4〜R1-7)** / **要件3** の Web アプリ催促・進捗管理に反映する。
</content>
