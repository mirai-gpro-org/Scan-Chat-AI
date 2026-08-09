# Elith 納品セット アセンブリ ― ラップ仕様 説明書（健康年齢の時系列対応版）

| 項目 | 内容 |
|---|---|
| 目的 | 「📦 Elith 納品セット アセンブリ」および「プラン時系列生成（疑似データ）」が、**どのようにファイルをラップして S3 へ配置しているか**を、Elith 受け渡し仕様（`elith-handoff-v0.1`）に準拠して説明する。特に **健康年齢（HealthAgeData）を他検査と同様に時系列で納品する**点を明記する。 |
| 宛先 | 株式会社 Elith 御中 ／ 作成: 株式会社ウェルフォート・UNFIX（開発） |
| 版 | 2026-08-08（§5 LAiF AI疾病発症予測を **Elith承諾により確定**・合成の items ジッタ/昨年比引き継ぎを実装） |
| 根拠仕様 | `docs/elith/elith_s3_data_handoff_spec.md`（正本 §3 フォルダ/命名・§6 共通エンベロープ・§7 各format・§8 一括書出し）／ `docs/elith/elith_handoff.schema.json`（JSON Schema `elith-handoff-v0.1`・format_id 7種）／ `docs/elith/elith_masking_definition.md`（除外＝PII/bbox/region/category）。 |
| 重要な変更点 | **健康年齢を「1ユーザー1件」→「検査日毎（時系列）」に変更**（発注者判断 2026-08）。旧 §7.3.1 の「時系列は不要（2026-07）」を撤回。Elith 側の読み取りも「各 `date/` フォルダ内の `HealthAgeData_*`」を走査する形へ更新をお願いします。 |

---

## 1. フォルダ / ファイル構造（Elith 仕様 §3 準拠）

納品はすべて **バケット直下 `user/`** 配下に、**1 ユーザー ID = 1 フォルダ、受診回ごとに `date/` サブフォルダ**で配置します。

```
s3://{bucket}/user/{client_id}/date/{YYYY_MM_DD}/
    {format_id}_date_{YYYY_MM_DD}_user_{client_id}.json    # その受診回の各検査（複数）
```

- `client_id` … 仮名 ID（`diagnostic_user_id` 相当。PII 非含有）。**通年で不変**、受診回は `date/` で分離。
- `{YYYY_MM_DD}` … その回の検査日（アンダースコア区切り）。
- 命名は Elith 仕様 §3.2 / §7 と同一。**健康年齢も同じ命名規則**に従います（後述）。

年に複数回受診する検査は、Elith 仕様 §3.3 のとおり **回ごとに `date/` フォルダを 1 つ作成**し、その回で揃った format だけを収めます。

---

## 2. 収録 format（`elith-handoff-v0.1` の 7 種）

`format_id`（`docs/elith/elith_handoff.schema.json` の enum）:

| format_id | 内容 | 取得元 |
|---|---|---|
| `HealthCheckupData` | 健診・人間ドック | アプリ AI スキャン |
| `BloodTestData` | 血液検査 | デメカル等 |
| `CancerRiskAssessmentData` | がんリスク（尿） | 検査機関 |
| `GeneticTestResultData` | 遺伝子検査 | 検査機関 |
| `LifestyleQuestionnaireData` | 生活習慣・AI 問診 | アプリ |
| **`HealthAgeData`** | **健康年齢（CABA）** | **納品時に算出・生成** |
| `Other` | AI 疾病予測等（専用 format 無し） | 各種 |

各ファイルは共通エンベロープ（Elith 仕様 §6 / スキーマ必須項目）を持ちます:
`format_id` / `schema_version`（`elith-handoff-v0.1`）/ `client_id` / `test_date` / `exported_at` / `subject` / `source` / `data`。
**除外**（`docs/elith/elith_masking_definition.md`）: 氏名・住所・生年月日等の PII、版面座標(bbox)、見出し(region)、区分(category)。

---

## 3. 健康年齢（HealthAgeData）のラップ ― 【今回の主眼】

### 3.1 位置づけと命名
- 健康年齢は、他の検査ファイルと **完全に同じ場所・同じ命名規則** で納品します:
  ```
  user/{client_id}/date/{YYYY_MM_DD}/HealthAgeData_date_{YYYY_MM_DD}_user_{client_id}.json
  ```
- **特別な場所・特別な名前ではありません。** 各 `date/` フォルダ内に、他検査と並んで置かれます。

### 3.2 時系列化（旧「1ユーザー1件」からの変更）
- **健康年齢は「血液検査ごとに最新を算出」する運用に合わせ、検査日毎（時系列）に納品します。**
  - 血液検査がある回 → **その血液検査日**に健康年齢を同梱。
  - 血液検査が無いプラン → **健診/人間ドック日**に健康年齢を同梱。
  - 同一 date に健診と血液が両方ある回は **健診（人間ドック）を優先**して 1 件。
- → Elith 側は **「各 `date/` フォルダ内の `HealthAgeData_*` を、その回の健康年齢として読む」** 形にしてください（従来の「ユーザーに 1 件だけ」という前提だと、2 回目以降の `date/` にある健康年齢を取りこぼします＝**今回の受信不良の主因と推定**）。

### 3.3 data スキーマ（`docs/elith/elith_handoff.schema.json` §HealthAgeData）
`data` は以下 5 項目（必須）:
```jsonc
{
  "format_id": "HealthAgeData",
  "schema_version": "elith-handoff-v0.1",
  "kind": "health_age",
  "client_id": "elith-test-exec-001",
  "test_date": "2024-02-15",           // その回の検査日
  "exported_at": "2026-08-04T…Z",
  "subject": { "sex": "male", "age": 51 },   // age=その回時点の実年齢
  "source": { "origin": "scan-chat-ai", "model": "CABA-v5.4", "note": "健康年齢(CABA)" },
  "data": {
    "health_age": 48.3,        // 健康年齢（生物学的年齢）
    "actual_age": 51,          // 実年齢
    "computed_date": "2026-08-04",
    "delta": -2.7,             // health_age - actual_age
    "model_version": "CABA-v5.4"
  }
}
```
- **モデルは `CABA-v5.4`**（Levine PhenoAge ベース＋ウェルフォート改変。旧 v4d から更新）。
- 実データ納品時は、算出済みスコア（`diagnosis.health_age_scores`）を **元 S3 キー（source_ref）で突合**して各回に載せます。算出済みスコアが無い回は **載せません（age は PII 除去済み納品からは再計算不可＝捏造しない）**。

---

## 4. 疑似（合成）時系列データの生成とラップ

Elith 結合テスト用に、**契約プランごとに 3 年分の時系列疑似データ**を生成します（`docs/elith/elith_synthetic_timeseries_plan_spec.md`）。
- 各 format は **実データ 1 件を種に、数値のみ ±5% の決定論ジッタ**（seed 固定＝再現可能・値をゼロから捏造しない）。
- **健康年齢も他検査と同様に時系列で生成**します。**数・タイミングは血液検査（無ければ健診）に一致**:

| プラン | 健康年齢の本数（3年） | 算出タイミング |
|---|---|---|
| 経営層・幹部 | **9 本** | 血液検査の各回（年3回×3年）。その回の合成血液値から算出 |
| ミドルマネジメント | **3 本** | 健診/人間ドックの各回（年1回×3年）。その回の合成健診値から算出 |

- 合成の健康年齢は、**その回の合成検査値から CABA v5.4 で算出**し、同じ `date/` フォルダへ同梱します（実データと同一のラップ）。
- 実年齢は経年で加算（`D0 実年齢 + 経過年数`）。
- 各ファイルに `synthetic: true` / `date_source: "synthetic"` を付与。**PII 非含有**。

### 4.1 配置例（経営層・幹部プラン・D0=2023-06-15）
```
user/elith-test-exec-001/
  date/2023_06_15/   ← Y1-R1
      HealthCheckupData_date_2023_06_15_user_elith-test-exec-001.json
      BloodTestData_date_2023_06_15_user_elith-test-exec-001.json
      CancerRiskAssessmentData_date_2023_06_15_user_elith-test-exec-001.json
      GeneticTestResultData_date_2023_06_15_user_elith-test-exec-001.json
      HealthAgeData_date_2023_06_15_user_elith-test-exec-001.json     ← 健康年齢（この回）
      (Other は種がある場合のみ)
  date/2023_10_15/   ← Y1-R2（血液・がん・健康年齢）
      BloodTestData_…json / CancerRiskAssessmentData_…json
      HealthAgeData_date_2023_10_15_user_elith-test-exec-001.json     ← 健康年齢（この回）
  date/2024_02_15/   ← Y1-R3（同上）
      …
      HealthAgeData_date_2024_02_15_user_elith-test-exec-001.json
  …（Y2/Y3 も同様。健康年齢は血液の全 9 回に 1 件ずつ）
```
→ **健康年齢は全 9 個の `date/` フォルダに 1 件ずつ**入ります。ミドルは健診の 3 回分に 1 件ずつ。

---

## 5. LAiF「AI 疾病発症予測」(`Other` / `ai_prediction`) のファイル仕様【確定・Elith承諾 2026-08】

Wellfort・Elith 双方で確認のとおり、**LAiF 社「AI 疾病発症予測」も PDF を AI スキャンして JSON 化し、
S3 経由で Elith へ受け渡します**（他検査と同じ経路）。健康年齢と同様に**時系列の疑似データも生成**します。
`elith-handoff-v0.1` に専用 format は無いため **`format_id: "Other"` / `kind: "ai_prediction"`** で納品します（スキーマ §7.4「Other=自由構造」）。
本 §5 の `data` 構造・時系列頻度・`昨年の相対リスク比` 引き継ぎは **Elith 承諾済（2026-08）＝確定**。実装反映済み（§5.4）。

### 5.1 命名・配置（他検査と同一）
```
user/{client_id}/date/{YYYY_MM_DD}/Other_date_{YYYY_MM_DD}_user_{client_id}.json
```

### 5.2 元レポートの構成（実サンプル LAiF PDF より）
- **発症予測ページ**: 疾患ごとに **5年発症率(%) / 10年発症率(%) / 相対リスク比 / 昨年の相対リスク比**。
  疾患は **生活習慣病 / 循環器疾患 / 悪性腫瘍 / 神経疾患** 等のカテゴリに分かれる
  （糖尿病・高血圧・脂質異常症・痛風・鉄欠乏性貧血・うつ病・労作性狭心症・急性心筋梗塞・心不全・
  閉塞性動脈硬化症・脳梗塞・肺がん・大腸がん・胃がん・すい臓がん・子宮頚がん・乳がん・前立腺がん 等）。
- **リスク因子・予防策ページ**: 疾患ごとに「AI のアドバイス（予防策の文章）」。

### 5.3 `data` 構造（提案）
```jsonc
{
  "format_id": "Other",
  "schema_version": "elith-handoff-v0.1",
  "kind": "ai_prediction",
  "client_id": "elith-test-exec-001",
  "test_date": "2023-06-15",
  "exported_at": "…Z",
  "subject": { "sex": null, "age": null },
  "source": { "origin": "scan-chat-ai", "model": "gemini-3.1-flash-lite", "lab_name": "LAiF",
              "note": "AI疾病発症予測(LAiF)。構造化はLLM。" },
  "data": {
    "item_count": 18,
    "items": [
      { "section": "生活習慣病", "項目名": "糖尿病",
        "5年発症率": "4.1%", "10年発症率": "8.0%", "相対リスク比": 0.7, "昨年の相対リスク比": 0.7,
        "アドバイス": "体重変化が発症リスクに関与します。体重コントロールをお願いします。" },
      { "section": "悪性腫瘍", "項目名": "肺がん",
        "5年発症率": "2.4%", "10年発症率": "4.7%", "相対リスク比": 0.6 }
      // …疾患ごとに1オブジェクト。印字が無いフィールドは省略（創作しない）。
    ],
    "pages": [ { "page": 2, "section": "生活習慣病/循環器疾患", "count": 11 }, … ]
  }
}
```
- **数値・文章は印字どおり**。読めない/無い項目は省略（捏造ゼロ）。カテゴリ見出し・凡例・氏名(PII)は含めない。

### 5.4 時系列の疑似データ（健康年齢と同じ考え方）
- LAiF「AI 疾病発症予測」は **年1回**の検査として扱い、**健診/人間ドックと同じ受診回（各年 R1）**に同梱します。
  - 経営層・幹部プラン: **年1回 → 3年で 3 本**（各年 R1 の `date/` に `Other_…json`）。
  - ミドルプラン: プラン定義に含めない場合は 0 本（含める場合は健診と同じ 3 本）。※要 Elith/Wellfort 確定。
- 生成方法: **実 LAiF JSON（§5.3）を種に、数値フィールド（5年発症率・10年発症率・相対リスク比）を
  ±5% の決定論ジッタ**（seed 固定＝再現可能）。**疾患名・アドバイス文は維持**。`synthetic:true` 付与・PII 非含有。
- `昨年の相対リスク比` は **前年回の `相対リスク比` を引き継ぐ**（時系列として自然に表現）。**確定・実装済**。
- **実装（2026-08）**: `src/lib/elith-synthetic.ts` `jitterAiPredictionItems`（`data.items[]` の発症率%＝`jitterPercentString`／相対リスク比＝`jitterNumber` のみジッタ・疾患名/アドバイス/`item_count`/`pages` は不変）。**昨年比引き継ぎ**は `src/pages/api/admin/elith-plan-timeseries.ts`（Other occurrence を occIndex 順に処理し、前回の `相対リスク比` を疾患名一致で今回 `昨年の相対リスク比` へ。初回は種の値を維持）。旧 `data.payload` 形式の種は後方互換で従来ジッタ。

### 5.5 配置例（経営層・幹部・D0=2023-06-15）
```
user/elith-test-exec-001/
  date/2023_06_15/  … HealthCheckup / Blood / Cancer / Genetic / HealthAge / Other(AI疾病発症予測)
  date/2024_06_15/  … HealthCheckup / Blood / Cancer / HealthAge / Other(AI疾病発症予測)
  date/2025_06_15/  … 〃
```

### 5.6 読取方式：様式特化プロンプト（2026-08 確定・発注者判断）
- **LAiF は単一ベンダー・固定様式**。健診で「様式別プロンプト/テンプレOCR」を却下した理由は
  「多機関で様式が可変＝汎化しない負債」だが、**固定様式の LAiF には当てはまらない**。
  正準化正本 §0「設計思想は手段＝従属・ゴール(正確)が勝つ」に沿い、**LAiF に限り様式特化プロンプトを採用**する。
- 実装 = `src/lib/elith-genetic.ts` `AI_PREDICTION_USER`（固定様式の列構成を明示）。狙いは
  **発症予測テーブル(密表)の行ズレ・空行の捏造・入れ子ゆれ(疾患/項目詳細)** の抑制：
  - **行単位読取**（同じ行の疾患名↔値だけを対応・列をまたいで値をずらさない）。
  - **疾患名がある行だけ項目化**（空行/見出し/区切り線に疾患名や数値を割り当てない＝捏造禁止）。
  - **フラット固定キー**（`項目名/5年発症率/10年発症率/相対リスク比/昨年の相対リスク比/アドバイス/section` のみ・入れ子禁止）。
  - **疾患名は印字どおり**（標準病名化しない＝発注者判断 2026-08。後半アドバイスの要否は Elith 確認後に別途）。
- **固定は永遠でない**: LAiF が様式改訂した場合に備え、期待構成と乖離した run を検知する仕組み（アンカー確認/フォールバック）は今後の課題。
- **後段の決定論統合**（`ai-prediction-consolidate.ts`・env `SCAN_AI_PREDICTION_DEDUP`）は本プロンプトと直交で併用（重複統合・見出し除去）。
→ **AI疾病発症予測（Other）は各年 R1 の 3 フォルダに 1 件ずつ**（健診と同じタイミング）。

### 5.6 確認結果（Elith 承諾済・2026-08）
1. ✅ `format_id:"Other"` / `kind:"ai_prediction"` で**受領可**（専用 format 追加は不要）。
2. ✅ §5.3 の `data.items` フィールド名（`5年発症率`/`10年発症率`/`相対リスク比`/`昨年の相対リスク比`/`アドバイス`）で**問題なし**。
3. ✅ 時系列頻度＝**年1回・健診と同回**で確定。ミドルプランは対象外（プラン定義に Other を含めない）。
→ 上記承諾を受け、§5.4 の合成生成（items ジッタ・昨年比引き継ぎ）を実装済み。

---

## 6. Elith 側の読み取り手順（推奨）

1. `user/{client_id}/` 配下の **各 `date/{YYYY_MM_DD}/` を走査**する（回数分ある）。
2. 各 `date/` フォルダ内の `*.json` を **`format_id` で識別**して取り込む。
3. **`HealthAgeData` は「その回の健康年齢」**として、他検査と同じ粒度（date 単位）で時系列に積む。
   - ※「ユーザーに 1 件だけ」の前提は撤回。**date フォルダごとに存在し得る**。

---

## 7. 確認事項（受信不良の切り分け）

Elith 側で「アセンブリ内容／健康年齢を認識できない」場合、次のいずれかが原因と考えられます。ご確認ください。

1. **健康年齢の時系列化（本書 §3.2）に読み取りが未対応** … 最有力。各 `date/` の `HealthAgeData_*` を走査する形へ更新をお願いします。
2. **`format_id: "HealthAgeData"` の未対応** … 本 format は `elith-handoff-v0.1` スキーマの 7 種に含まれます（`docs/elith/elith_handoff.schema.json`）。enum に無い実装であれば追加をお願いします。
3. **LAiF「AI疾病発症予測」(`Other`/`ai_prediction`) の受領（本書 §5）** … `data` フィールド名・時系列頻度をご確認ください（§5.6）。
4. **`manifest.json` の扱い（要相談）**:
   - 実データの「納品セット アセンブリ」は、以前の Elith ご指摘（「構成が違う」）を受け、**`manifest.json` を書き出していません**（各 `date/` には `{format_id}_…json` のみ）。
   - 一方、**疑似データの「プラン時系列生成」は、完了合図として各 `date/` に `manifest.json`（`complete:true`・収録一覧）を最後に置いています**（`docs/elith/elith_s3_data_handoff_spec.md §8.3` 提案どおり）。
   - **この不一致が受信不良の一因であれば、疑似データ側の `manifest.json` を無効化（実データと同一構成に統一）します。** manifest を「読む／無視する／不要」のいずれをご希望か、ご指定ください。

---

## 8. 参照
- `docs/elith/elith_s3_data_handoff_spec.md`（正本・パス/命名/エンベロープ/各format/一括書出し）
- `docs/elith/elith_handoff.schema.json`（JSON Schema `elith-handoff-v0.1`・7 format_id）
- `docs/elith/elith_masking_definition.md`（納品除外＝PII/bbox/region/category）
- `docs/elith/elith_synthetic_timeseries_plan_spec.md`（3年疑似データ生成の全体仕様）
- `docs/scan/health_age_caba_v5.4_spec.md`（健康年齢 CABA v5.4 の確定事項）
