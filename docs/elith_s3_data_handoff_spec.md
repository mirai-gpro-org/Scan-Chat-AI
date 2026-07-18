# Elith AI 診断システム データ受け渡し仕様 (S3経由)

| 項目 | 内容 |
|---|---|
| 文書名 | Elith AI 診断システム データ受け渡し仕様 (S3経由) |
| バージョン | 0.1 (Draft) |
| 作成日 | 2026-06-25 |
| 対象範囲 | Wellfort → Elith への入力データ受け渡し (AIスキャン結果 / AI問診結果 / 検査機関の検査結果) を AWS S3 上に格納する仕様 |
| 関連文書 | `scan_s3_export.md` / `diagnostic_session_data_spec.md` §3.5 / `interview-export.ts` / `lab_integration_workflow.md` / `elith_report_integration.md` / `data_integration_requirements.md` §1.3 |

---

## 1. 目的・スコープ

Wellfort が保持する以下 3 系統の入力データを、**AWS S3 上に Elith 指定の構成で格納**し、
Elith の AI 診断システムへ受け渡すためのデータ仕様を定義する。

1. **AIスキャン機能** の読込結果 (紙の検査表・健診結果を OCR 構造化したもの)
2. **AI問診** の回答結果 (生活習慣等の問診)
3. **検査機関から Wellfort 経由で取得した検査結果** (血液 / 遺伝子 / がんリスク等)

これらを Elith が受け取り、AI診断 (`AI診断` = Elith レポート) を生成する。Elith からの**出力 (診断結果) の受信**は本書の対象外
(`elith_report_integration.md` を参照)。

```
[Wellfort 側]                                  [S3]                       [Elith 側]
  AIスキャン (scan-chat-ai)  ──┐
  AI問診     (scan-chat-ai)  ──┤── 構造化JSON ──▶  s3://{bucket}/user/   ──▶  AI診断システム
  検査機関結果 (wellfort_lab) ──┘                   {client_id}/date/...        (入力として読み取り)
                                                                                  │
                                          診断結果(別系統)  ◀───────────────────────┘
                                          (elith_report_integration.md)
```

> 本書は **データ仕様 (パス・命名・JSON フォーマット)** を確定させるためのものであり、
> 確定後に現行実装 (`scan-export-v0` / `interview-export-v0`) を本仕様へ寄せる (§10 移行)。

---

## 2. 識別子・用語の定義

| 用語 | 定義 | 備考 |
|---|---|---|
| `client_id` | **顧客 (利用者) を一意に識別する ID**。Wellfort の `diagnostic_user_id` (uuid) を充てる | 顧客系/診断系を橋渡しする唯一のキー。**PII を含まない** (`data_integration_requirements.md §1.3`) |
| `diagnostic_id` | 1 回の診断セッションを識別する ID (uuid) | 任意。JSON 本文に保持し、追跡・突合に使う |
| `format_id` | データ種別の識別子 (§4 の固定 6 種) | ファイル名の先頭に付与 |
| `YYYY_MM_DD` | **AI診断 (Elith) を実行する単位日**。当該回の入力データをまとめる日付フォルダ | JST 基準。アンダースコア区切り (Elith 指定) |
| `test_date` | 検査の実施日 / 検体採取日 (JSON 本文の項目) | フォルダの `YYYY_MM_DD` とは別概念 (§5.3) |

### 2.1 `client_id` に `diagnostic_user_id` を充てる理由

- 顧客系 DB (氏名・住所・生年月日等の PII) と診断系 DB を結ぶ**唯一の橋渡しキー**であり、
  それ自体は PII を含まない (`lab_integration_workflow.md §1.1`)。
- S3 のパス・ファイル名は外部 (Elith) と共有されるため、**ここに PII を絶対に載せない**という
  既存ポリシーと整合する。

> **要確認(Elith)**: `client_id` に uuid (`diagnostic_user_id`) を用いる前提でよいか。
> Elith 側で別途の顧客採番がある場合はマッピング方針を協議する。

---

## 3. S3 格納仕様

### 3.1 格納パス (Elith 指定)

```
/user/{client_id}/date/{YYYY_MM_DD}/
```

- バケット直下の共通プレフィックスは `AWS_S3_PREFIX` で付与 (例: 無し or `prod/`)。
- 完全な URI 例:
  `s3://wellfort-ai-input/user/da000001-1111-2222-3333-444455556666/date/2026_03_15/`

### 3.2 ファイル命名規約 (Elith 指定)

```
{format_id}_date_{YYYY_MM_DD}_user_{client_id}.json
```

- 例:
  `BloodTestData_date_2026_03_15_user_da000001-1111-2222-3333-444455556666.json`
  `LifestyleQuestionnaireData_date_2026_03_15_user_da000001-1111-2222-3333-444455556666.json`

- 1 つの日付フォルダ内に、その回に取得できた **format_id ごとに 1 ファイル**を配置する。
- 同一日付・同一 format_id が複数発生する場合の扱いは §5.4 (要確認)。

### 3.3 年複数回 (年4回など) の扱い

プランによっては 1 人の顧客が**年 4 回 AI診断を実行**する。
この場合は **AI診断の実行ごとに `date/{YYYY_MM_DD}/` フォルダを 1 つ作成**する
(= 年 4 回なら**フォルダが 4 つ**)。Elith 合意済み。

```
/user/{client_id}/
  date/2026_03_15/   ← 第1回 AI診断 の入力一式
      BloodTestData_date_2026_03_15_user_{client_id}.json
      CancerRiskAssessmentData_date_2026_03_15_user_{client_id}.json
      LifestyleQuestionnaireData_date_2026_03_15_user_{client_id}.json
  date/2026_06_15/   ← 第2回
      ...
  date/2026_09_15/   ← 第3回
  date/2026_12_15/   ← 第4回
```

- `client_id` (顧客) は通年で不変。**日付フォルダで「いつの回か」を分離**する。
- 各回のフォルダには、その回で揃った検査・問診データのみを置く
  (例: 遺伝子検査は初回のみ → 第1回フォルダにだけ `GeneticTestResultData` が入る)。

---

## 4. format_id 一覧とデータソース対応

Elith 指定の `format_id` 6 種と、Wellfort 側のデータソース・既存実装の対応:

| format_id | データ種別 | 主なソース | 既存実装 / 検査機関 | 検査項目マトリクス上の名称 |
|---|---|---|---|---|
| `CancerRiskAssessmentData` | がんリスク検査データ | 検査機関 (尿) | `wellfort_lab` / PREVENT (`cancer_urine`) | がんリスク検査（尿） |
| `HealthCheckupData` | 健康診断データ | AIスキャン or 検査機関 | scan-export / 健診結果 (`health_checkup`) | 人間ドック・定期健康診断 |
| `GeneticTestResultData` | 遺伝子検査結果データ | 検査機関 | `wellfort_lab` / Genoplan (`genetics`) | 遺伝子検査 |
| `BloodTestData` | 血液検査データ | AIスキャン or 検査機関 | scan-export / Rieger (`blood`) | 血液検査 |
| `LifestyleQuestionnaireData` | 生活習慣データ (問診) | AI問診 (scan-chat-ai) | `interview-export-v0` | AI問診 |
| `Other` | その他 | AIスキャン等 | scan-export / AI疾病予測 (`ai_prediction`) 等 | AI疾病予測 ほか |

> **マッピングメモ**
> - `人間ドック` / `定期健康診断` はいずれも `HealthCheckupData` に集約する。
> - `AI疾病予測` (Elith 以外) は確定した置き場が無いため暫定で `Other`。専用 format_id が要るか要確認。
> - AIスキャンは「紙の検査表の OCR」であり、対象が血液検査結果なら `BloodTestData`、
>   健診結果なら `HealthCheckupData` というように**読み取り対象の種別で format_id を決定**する。

---

## 5. データ規約の詳細

### 5.1 文字コード / 形式

- すべて **UTF-8 / JSON (`application/json; charset=utf-8`)**。
- 改行・整形は任意 (`JSON.stringify(obj, null, 2)` を想定)。
- 日付項目は ISO8601 (`test_date` は `YYYY-MM-DD`、タイムスタンプは UTC `...Z`)。

### 5.2 PII (個人情報) の扱い — 必読

`data_integration_requirements.md §1.3` / `lab_integration_workflow.md §1.1` の**PII 越境禁止**に準拠する。

- パス・ファイル名・JSON 本文に、**氏名・住所・生年月日・電話・メールを含めない**。
- 年齢・性別は診断に必要なため、**生年月日ではなく `age` (年齢, 整数) と `sex` のみ**を載せる。
- 顧客の特定は `client_id` (`diagnostic_user_id`) のみで行う。

> **要確認(Elith)**: 現行 `interview-export-v0` は `user.name` / `user.date_of_birth` を含む。
> Elith 受け渡し版では氏名を除去し DOB→年齢へ変換する方針で問題ないか。

### 5.3 `YYYY_MM_DD` (フォルダ) と `test_date` (本文) の関係

- フォルダの `YYYY_MM_DD` = **その AI診断回の単位日** (診断実行/データ取り纏め日)。
- JSON 本文の `test_date` = **各検査の実施日**。検査ごとに異なりうる
  (例: 血液採取 3/10、問診 3/14、診断回 3/15)。
- Elith 側で「いつの検査値か」を厳密に扱えるよう、本文に `test_date` を必ず持たせる。

> **要確認(Elith)**: フォルダ日付は「診断実行日」基準でよいか、それとも「検体採取日」基準が望ましいか。

### 5.4 同一回・同一種別が複数ある場合

例: 1 回の診断で血液検査結果の紙が複数枚 → `BloodTestData` が複数になりうる。

- 暫定方針: ファイル名にサフィックスを付与し衝突回避 (例: `..._user_{client_id}_2.json`)、
  または JSON 内 `data.measurements[]` に統合。
- どちらが Elith にとって扱いやすいか要協議 (**要確認(Elith)**)。

---

## 6. JSON 共通エンベロープ

全 format 共通のトップレベル構造。`data` 配下が format 固有。

```jsonc
{
  "format_id": "BloodTestData",            // §4 の固定値
  "schema_version": "elith-handoff-v0.1",  // 本仕様のバージョン
  "client_id": "da000001-1111-2222-...",   // = diagnostic_user_id (PIIなし)
  "diagnostic_id": "6f2c1a9b-...",         // セッションID (任意, 突合用)
  "test_date": "2026-03-10",               // 検査実施日 (YYYY-MM-DD, 不明なら null)
  "exported_at": "2026-03-15T01:20:05Z",   // S3 書き出し時刻 (UTC)
  "subject": {                             // PIIを含まない属性のみ
    "sex": "male",                         // "male" | "female" | "other" | null
    "age": 52                              // 検査時点の年齢(整数) | null
  },
  "source": {                              // データの出所
    "origin": "wellfort_lab",              // "wellfort_lab" | "scan-chat-ai"
    "lab_name": "PREVENT",                 // 検査機関名 (検査機関由来のとき) | null
    "app": "scan-chat-ai",                 // アプリ由来のとき | null
    "model": null,                         // OCR/生成モデル名 | null
    "note": ""
  },
  "data": { /* format固有 (§7) */ },
  "raw_markdown": "## 検査表\n…"           // 元の確定Markdown(あれば。突合用) | null
}
```

---

## 7. format_id 別 JSON スキーマ

### 7.1 `BloodTestData` / `CancerRiskAssessmentData` / `HealthCheckupData` (検査値型)

検査値の集合は共通の `measurements[]` で表現する (scan-export の表構造を正規化したもの)。

```jsonc
{
  "format_id": "BloodTestData",
  "schema_version": "elith-handoff-v0.1",
  "client_id": "da000001-…",
  "diagnostic_id": "6f2c1a9b-…",
  "test_date": "2026-03-10",
  "exported_at": "2026-03-15T01:20:05Z",
  "subject": { "sex": "male", "age": 52 },
  "source": { "origin": "wellfort_lab", "lab_name": "Rieger", "app": null, "model": null, "note": "" },
  "data": {
    "measurements": [
      {
        "category": "左側検査表",  // 区分/領域 (身体計測/血液/尿 等) | null
        "name": "AST",            // 検査項目 (略称)
        "name_detail": "AST(GOT)",// 正式名称 | null
        "value": "26",            // 読み取り値 (数値のみ。単位/判定マーカは含めない)
        "value_num": 26,          // 数値化できる場合 | null (範囲値 "127/82"・定性値は null)
        "unit": "U/L",            // 単位 | null
        "ref_low": "13",          // 基準下限 | null
        "ref_high": "30",         // 基準上限 | null
        "flag": "-",              // "H"(高) | "L"(低) | "-"(基準内) | null
        "note": ""                // 備考・要確認マーカー等
      }
    ],
    "notes": [                    // 手書きメモ・自由記述 (scan の notes 領域)
      "CA19-9 前回 4981 → 今回 4048 改善"
    ]
  },
  "raw_markdown": "## 左側検査表\n| No | 検査項目 | … |\n…"
}
```

- **キー統一 (ファイル間で揃える)**: `BloodTestData` / `CancerRiskAssessmentData` / `HealthCheckupData` は
  **同じ `measurements[]` キー集合** (`category`/`name`/`name_detail`/`value`/`value_num`/`unit`/`ref_low`/`ref_high`/`flag`/`note`) を使う。
  血液CSV由来で無いフィールド (unit/ref/flag) は `null`。
- **`value` の方針 (Elith 要望対応)**: `value` は **数値のみ** を目標とし、単位は `unit`・判定は `flag` に分離する
  (数値までの箇所と単位混在の乱れを解消)。構造化 (項目名/単位/判定の分離) は **AIスキャンの LLM が担う**。
  プログラムは LLM 出力が汚れている場合だけ最小限そぎ落とす保険を持つ (数値は書き換えない)。血液CSVは決定論転記で原本を保持。
- **不要データの非同梱 (Elith 要望対応)**: 版面座標 `bbox` や `regions[]`、監査専用列 (`No`/`推論値`) は
  **納品 JSON に含めない**。`raw_markdown` からも `<!-- bbox: … -->` コメントを除去する。
- **`CancerRiskAssessmentData`** (尿): 同一構造。`source.lab_name: "PREVENT"`, `source.origin: "wellfort_lab"`。
  リスクスコア/判定があれば `measurements[]` に項目として格納 (例 `name: "膀胱がんリスク"`, `value: "中"`)。
- **`HealthCheckupData`** (人間ドック/健診): 同一構造。複数枚・複数区分 (身体計測/血液/尿/画像所見 等) は
  `measurements[]` の `category` で区別する。AIスキャン由来なら `source.origin: "scan-chat-ai"`。

> AIスキャン由来データはこの正規化形に加え、`raw_markdown` に確定 Markdown 原本 (bbox コメント除去済) を同梱し、
> Elith 側が読み取り精度を突合できるようにする (現行 `scan-export-v0` の思想を踏襲)。

### 7.2 `GeneticTestResultData` (遺伝子検査)

遺伝子検査は項目構造が独自のため、汎用の `items[]` + 原本で表現する。
**`items[]` の各要素の構造化は LLM に全面委任**し、固定キーは課さない (§7.1 のキー統一対象外)。
理由: 遺伝子レポートはページ/項目ごとに体系が異なり、固定スキーマだと取りこぼす。CLAUDE.md の確定ルール
「構造化の判断は全て LLM に任せる」に従う。下記はあくまで LLM が出しうる一例。

```jsonc
{
  "format_id": "GeneticTestResultData",
  "schema_version": "elith-handoff-v0.1",
  "client_id": "da000001-…",
  "test_date": "2026-03-01",
  "exported_at": "2026-03-15T01:20:05Z",
  "subject": { "sex": "male", "age": 52 },
  "source": { "origin": "wellfort_lab", "lab_name": "Genoplan", "app": null, "model": null, "note": "" },
  "data": {
    "items": [
      {
        "category": "生活習慣病リスク",  // 区分 | null
        "name": "2型糖尿病",            // 項目名
        "result": "リスクやや高い",      // 判定/結果 (文字列)
        "score": null,                  // 数値スコア (あれば) | null
        "gene": null,                   // 遺伝子名 (あれば) | null
        "comment": ""                   // 補足
      }
    ]
  },
  "raw_markdown": null
}
```

> **要確認(Wellfort/Elith)**: 遺伝子検査の正式フォーマット (Genoplan の項目体系) を確認のうえ
> `items[]` のスキーマを確定する。現状は `docs/kensa_sample/遺伝子検査.pdf` を一次情報とする。

### 7.3 `LifestyleQuestionnaireData` (AI問診)

現行 `interview-export-v0` (`src/lib/interview-export.ts`) を共通エンベロープへ載せ替えたもの。
回答配列 `answers[]` の各要素は現行 `InterviewAnswerJson` と同一。

```jsonc
{
  "format_id": "LifestyleQuestionnaireData",
  "schema_version": "elith-handoff-v0.1",
  "client_id": "da000001-…",
  "diagnostic_id": "6f2c1a9b-…",
  "test_date": "2026-03-14",          // 問診完了日
  "exported_at": "2026-03-15T01:20:05Z",
  "subject": { "sex": "male", "age": 52 },  // ← 氏名/DOBは載せない (PII)
  "source": { "origin": "scan-chat-ai", "lab_name": null, "app": "scan-chat-ai", "model": null, "note": "" },
  "data": {
    "answer_count": 81,
    "answers": [
      {
        "id": "B-HEIGHT",
        "section_id": "basic",
        "section_title": "基本情報",
        "question": "身長を教えてください。（cm）",
        "answer_kind": "text",
        "answer": "172",                 // string | string[] | number
        "answer_label": "172"
      },
      {
        "id": "H-SYMPTOMS",
        "section_id": "health",
        "section_title": "健康状態・既往歴",
        "question": "現在気になる自覚症状を教えてください。",
        "answer_kind": "wheel",
        "answer": ["頭痛", "肩こり"],
        "answer_label": "頭痛、肩こり"
      }
    ]
  },
  "raw_markdown": "# AI 問診結果\n…"
}
```

### 7.4 `Other` (その他)

専用 format が無いデータ (AI疾病予測・Elith 以外の結果 等)。`data` は自由構造 + 原本同梱。

```jsonc
{
  "format_id": "Other",
  "schema_version": "elith-handoff-v0.1",
  "client_id": "da000001-…",
  "test_date": "2026-03-12",
  "exported_at": "2026-03-15T01:20:05Z",
  "subject": { "sex": "male", "age": 52 },
  "source": { "origin": "wellfort_lab", "lab_name": "LAIF", "app": null, "model": null, "note": "AI疾病予測" },
  "data": {
    "kind": "ai_prediction",          // 中身の種別を示すヒント
    "payload": { /* 任意 */ }
  },
  "raw_markdown": null
}
```

---

## 8. 書き出しタイミング・連携運用

### 8.0 書き出しトリガ (最重要要件)

S3 への書き出しは、**個々の検査・問診データが届くたびに逐次行うのではない**。
**「その回の AI診断を開始するのに必要な情報が全て揃った時点」で、顧客 (`client_id`) の
当該日付フォルダに、その回の検査データファイル群 (JSON) を一括で書き出す。**

```
逐次到着: 血液検査(3/10着) … 問診完了(3/14) … がんリスク(3/15着)
                                                    │
              [Wellfort側で「この回の必要データが出揃ったか」を判定]
                                                    │ 揃った！
                                                    ▼
   一括書き出し ──▶ /user/{client_id}/date/{YYYY_MM_DD}/
                      ├─ BloodTestData_…json
                      ├─ CancerRiskAssessmentData_…json
                      ├─ LifestyleQuestionnaireData_…json
                      └─ manifest.json   (complete: true)
```

- 利点: Elith は**部分的に揃ったフォルダを読んでしまう心配がない**。フォルダの存在 (または
  `manifest.json`) = 「この回の入力は完備」を意味する。
- 揃う前の中間データは Wellfort 側 (Supabase / Storage) に保持し、揃った時点でまとめて変換・出力する。

### 8.1 「揃った」の判定条件

「必要な情報が全て揃った」かは、**顧客のプランがその回に要求する検査・問診項目が
すべて取得済みか**で判定する (検査項目マトリクス由来)。

- 期待される `format_id` の集合は、顧客のプラン × その回 (年次サイクル内の第何回か) で決まる。
  例: スタンダードプラン初年度の第1回は `BloodTestData` / `CancerRiskAssessmentData` /
  `GeneticTestResultData`(初回のみ) / `LifestyleQuestionnaireData` が揃って初めて「完備」。
- 判定ロジックは `subscription_plans` (`tests_per_cycle[]`, `genetics_once` 等) を参照する想定。
- **欠落許容/タイムアウト** (一部検査が期限内に揃わない場合の扱い) は要決定 (§11 #9)。

### 8.2 連携運用 (通知・冪等性)

| 項目 | 方針 (案) | 状態 |
|---|---|---|
| 書き込み主体 | Wellfort 側 (`scan-chat-ai` のエクスポート/オーケストレーション) が PutObject | 確定 |
| 書き込み単位 | **回 (date フォルダ) 単位で一括** (§8.0)。出揃った時にまとめて出力 | 確定 |
| バケット | Elith 用バケットは準備済。`AWS_S3_BUCKET` で指定 | 確定 |
| 読み取り | Elith が当該パスを読み取り (Pull 型) | **要確認** |
| 起動トリガ | フォルダ完成を Elith に通知する手段 (S3イベント / 完了マーカー / API 通知) | **要確認** |
| 完了マーカー | 各日付フォルダに `manifest.json` (収録一覧 + `complete:true`) を**最後に**置き「揃った」合図にする | 提案 |
| 冪等性 | 同一 (client_id, date, format_id) は同一キーで上書き。再送で重複しない | 提案 |
| 認可 | Elith からの読み取りは IAM ロール/バケットポリシーで該当プレフィックスに限定 | **要確認** |

> **書き込み順序の推奨**: 各 `format_id` の JSON をすべて Put し終えた**後に** `manifest.json` を Put する。
> Elith が `manifest.json` の存在/`complete:true` を起点に読み取れば、半端な読み取りを防げる。

### 8.3 完了マーカー (manifest) 案

```jsonc
// /user/{client_id}/date/{YYYY_MM_DD}/manifest.json
{
  "client_id": "da000001-…",
  "date": "2026_03_15",
  "schema_version": "elith-handoff-v0.1",
  "created_at": "2026-03-15T01:20:05Z",
  "files": [
    { "format_id": "BloodTestData",            "file": "BloodTestData_date_2026_03_15_user_da000001-….json" },
    { "format_id": "LifestyleQuestionnaireData","file": "LifestyleQuestionnaireData_date_2026_03_15_user_da000001-….json" }
  ],
  "complete": true   // この回の入力が出揃ったか
}
```

---

## 9. データフロー (ソース別 → 一括書き出し)

各ソースは到着次第まず **Wellfort 側 (Supabase / Storage) に蓄積**し、出揃った時点で
オーケストレーションが §6 の形へ変換し、回 (date フォルダ) 単位で **S3 へ一括書き出し** (§8.0)。

```
[AIスキャン]  scan.astro → POST /api/scan/export
   src/lib/scan-export.ts (Markdown→正規化) ─┐
[AI問診]      chat UI → POST /api/interview/export
   src/lib/interview-export.ts ──────────────┤
[検査機関結果] 検査機関 → Wellfort 代理アップロード
   POST /api/admin/lab-results/upload         │
   (test_artifacts / test_artifact_files)     │
   ※割当は diagnostic_user_id で確定          │
   (lab_integration_workflow.md)              │
                                              ▼
                         [Wellfort側ステージング (Supabase/Storage)]
                                              │
                         [完備判定 (§8.1: プランが要求する項目が出揃ったか)]
                                              │ 揃った
                                              ▼
            共通エンベロープ(§6)へ変換 → /user/{client_id}/date/{YYYY_MM_DD}/ へ一括 PutObject
                                              → 最後に manifest.json (complete:true)
```

---

## 10. 現行実装とのギャップ / 移行

| 観点 | 現行 (暫定) | 本仕様 (目標) |
|---|---|---|
| パス | `{AWS_S3_PREFIX}{diagnostic_id}/` | `/user/{client_id}/date/{YYYY_MM_DD}/` |
| ファイル名 | `scan-{元名}-{ts}.json` / `interview-{ts}.json` | `{format_id}_date_{YYYY_MM_DD}_user_{client_id}.json` |
| 主キー | `diagnostic_id` (セッション) でフォルダ分け | `client_id` (顧客) + 日付でフォルダ分け |
| schema_version | `scan-export-v0` / `interview-export-v0` | `elith-handoff-v0.1` (共通エンベロープ) |
| PII | interview に氏名/DOB を含む | 氏名除去・DOB→年齢へ |
| 検査機関結果の JSON | 未定義 (PDF/CSV を Storage 保管のみ) | §7.1/7.2 で構造化して S3 へ |

移行手順 (案):
1. 本仕様を Elith と合意し `elith-handoff-v0.1` を確定。
2. `src/lib/scan-export.ts` / `interview-export.ts` に「Elith 受け渡し形」への変換を追加
   (共通エンベロープ・パス命名・PII 除去)。逐次 S3 書き出しは**ステージング保存**へ変更。
3. 検査機関結果 (PDF/CSV) からの構造化抽出 → §7 形式の生成パイプラインを追加。
4. **完備判定 → 一括書き出しのオーケストレーション** (§8.0/§8.1) を実装。最後に
   `manifest.json` (`complete:true`) を Put し、Elith への通知 (§8.2) を行う。
5. 旧 `scan-accuracy-test/` 配下 (逐次書き出し) は廃止 or 並行運用。

---

## 11. 未確定事項 (要確認サマリ)

| # | 確認先 | 内容 |
|---|---|---|
| 1 | Elith | `client_id` に `diagnostic_user_id` (uuid) を用いる前提で良いか (§2.1) |
| 2 | Elith | フォルダ `YYYY_MM_DD` の基準日 = 「診断実行日」か「検体採取日」か (§5.3) |
| 3 | Elith | PII 方針: 氏名除去・DOB→年齢への変換で良いか (§5.2) |
| 4 | Elith | 同一回・同一 format_id が複数ある場合の扱い (サフィックス vs 統合) (§5.4) |
| 5 | Elith | 連携方式: Pull 型か、フォルダ完成の通知手段は何か (§8) |
| 6 | Elith | `AI疾病予測` は `Other` で良いか、専用 format_id が要るか (§4) |
| 7 | Wellfort/Elith | 遺伝子検査 (Genoplan) の項目体系と `GeneticTestResultData.items[]` 確定 (§7.2) |
| 8 | Wellfort | 検査機関 PDF/CSV からの構造化抽出方式 (自動 OCR / 手入力 / 別紙CSV) |
| 9 | Wellfort/Elith | 一部検査が期限内に揃わない場合の扱い (欠落許容で出力 / タイムアウト / 待機) (§8.1) |

---

## 付録 A: パス・ファイル名 早見表

```
バケット:   s3://{AWS_S3_BUCKET}/{AWS_S3_PREFIX}
パス:       user/{client_id}/date/{YYYY_MM_DD}/
ファイル:   {format_id}_date_{YYYY_MM_DD}_user_{client_id}.json
完了マーカー: manifest.json (同フォルダ)

format_id:
  CancerRiskAssessmentData    がんリスク検査(尿)
  HealthCheckupData           人間ドック / 定期健康診断
  GeneticTestResultData       遺伝子検査
  BloodTestData               血液検査
  LifestyleQuestionnaireData  生活習慣(AI問診)
  Other                       その他 (AI疾病予測 等)
```
</content>
</invoke>
