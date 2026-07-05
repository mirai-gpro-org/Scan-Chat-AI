# サンプル画像 一括スキャン → Elith S3 出力 バッチ 実行手順

`scripts/batch-scan-to-elith.mjs` の実行手順。サンプル検査画像を **AIスキャン(Gemini)** で
読み取り、**Elith 連携仕様の JSON** と **元画像(同名・拡張子替え)** を S3 に一括書き出す。

> 位置づけ: `elith_s3_data_handoff_spec.md` の出力仕様を、既存アプリのスキャン機能を使って
> サンプル全件へ適用する **方式A (バッチ)**。Elith へ急ぎテストデータを渡すためのもの。

## 1. 前提 (アプリと同じ資格情報)

このバッチは「画像を Gemini に送って読む」ため、**アプリと同じ鍵が要る**。
アプリのデプロイ環境 / 専用サーバ (鍵が通っている場所) で実行する。

| 環境変数 | 必須 | 用途 |
|---|---|---|
| `GEMINI_API_KEY` | ○ | 画像OCR (これが無いと1枚も処理できない) |
| `AWS_REGION` | `--upload`時○ | 例 `ap-northeast-1` |
| `AWS_S3_BUCKET` | `--upload`時○ | 例 `wellfort-ai-input` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `--upload`時○ | Elith バケットへの書込権限 (未指定なら IAM ロール等 SDK 既定チェーン) |

Node は **v20 以上**。依存 (`@aws-sdk/client-s3`) は既存のものを使う (`npm install` 済み前提)。

## 2. 入力の準備

Google Drive の画像を**ローカルにダウンロード**し、種別ごとのサブフォルダに置く。
サブフォルダ名から `format_id` を自動判定する。

```
samples/
  がんリスク検査フォルダー/      → CancerRiskAssessmentData
  検診・人間ドックサンプル/       → HealthCheckupData
  遺伝子検査データサンプル/        → GeneticTestResultData
```

判定キーワード: がんリスク/尿→Cancer、遺伝子/genetic→Genetic、血液/blood→Blood、
人間ドック/検診/健診/ドック→HealthCheckup、問診/生活習慣→Lifestyle、その他→Other。
`--format <id>` で全画像を明示指定も可。

## 3. まずドライラン (S3 に書かない)

生成物をローカル `./batch-out/` に、S3 と同じキー構成で書き出して確認する。

```bash
GEMINI_API_KEY=xxxxx \
node scripts/batch-scan-to-elith.mjs --input ./samples
```

- `./batch-out/user/{client_id}/date/{YYYY_MM_DD}/…json` と同名画像が出る。
- `./batch-out/batch-mapping.csv` に「画像 ↔ client_id / 検査日 / キー / 成否」の一覧。
- 少数で試すなら `--limit 3`。

## 4. 本番アップロード

```bash
GEMINI_API_KEY=xxxxx \
AWS_REGION=ap-northeast-1 AWS_S3_BUCKET=wellfort-ai-input \
AWS_ACCESS_KEY_ID=xxxx AWS_SECRET_ACCESS_KEY=xxxx \
node scripts/batch-scan-to-elith.mjs --input ./samples --upload
```

出力 (Elith 仕様):

```
s3://{bucket}/{prefix}user/{client_id}/date/{YYYY_MM_DD}/
    {format_id}_date_{YYYY_MM_DD}_user_{client_id}.json   ← スキャン結果 (Elith エンベロープ)
    {format_id}_date_{YYYY_MM_DD}_user_{client_id}.{元拡張子} ← 参考用の元画像 (同名)
```

## 5. 主なオプション

| オプション | 既定 | 説明 |
|---|---|---|
| `--input <dir>` | (必須) | 入力ルート |
| `--upload` | off | S3 へアップロード (省略時ドライラン) |
| `--out <dir>` | `./batch-out` | ドライラン出力先 |
| `--prefix <s3prefix>` | 空 | バケット内共通プレフィックス (例 `prod/`) |
| `--client-id <mode>` | `uuid` | `uuid`(画像毎に採番) / `fixed:<id>`(全件1つ) / `filename`(元名由来) |
| `--format <id>` | (推定) | 全画像の format_id を明示 |
| `--today <YYYY-MM-DD>` | 実行日(JST) | 検査日不明時に使う日付 |
| `--concurrency <n>` | 2 | 同時処理数 |
| `--limit <n>` | 0 | 先頭 n 件だけ |

## 6. 仕様メモ

- **検査日 (`date/{YYYY_MM_DD}`)**: 画像から検査日が読めれば採用、読めなければ本日 (JST)。
  JSON の `date_source` に `exam_date`/`markdown`/`today` のどれで決めたか記録する。
  (スキャン時に「検査日が読めれば先頭に `<!-- exam_date: YYYY-MM-DD -->` を出す」よう指示している)
- **client_id**: サンプルには実顧客が無いため既定で**画像毎に UUID を採番**し、対応は
  `batch-mapping.csv` に残す。実顧客IDに寄せたい場合は `--client-id fixed:<id>` 等で調整。
- **JSON 中身**: `elith_s3_data_handoff_spec.md` の共通エンベロープ
  (`format_id`/`client_id`/`test_date`/`subject`/`data.measurements[]`/`data.notes[]`/`raw_markdown` 等)。
  スキャンの生 Markdown も `raw_markdown` に保持 (突合用)。
- **元画像**: JSON と同名 (拡張子だけ元のまま) で同フォルダに併置。
- **プロンプト**: `src/pages/api/scan.ts` の `ANALYZE_SYSTEM` を実行時に読み取って再利用
  (アプリのスキャンと同一ロジック。二重管理しない)。

## 7. 既存13件との関係

手動処理済みの13件 (`scan-export-v0` をアプリからS3出力) は**そのまま**。本バッチは
残りのサンプルを Elith 仕様パスで新規生成する。両者は別パス・別スキーマなので競合しない。

## 8. 注意

- Gemini の読み取りは完璧ではない。`batch-mapping.csv` の `status`/`rows` で件数を確認し、
  必要なら少数を目視突合する。失敗行は `status=error` で残る (再実行可)。
- 医療情報のため、`--client-id` に**実顧客の氏名等 PII を使わない**こと (UUID 推奨)。
</content>
