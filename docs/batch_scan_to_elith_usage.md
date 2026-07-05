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
| `GOOGLE_ACCESS_TOKEN` **または** `GOOGLE_SERVICE_ACCOUNT_KEY(_FILE)` | `--drive`時○ | Google Drive 直読み用 (`drive.readonly`) |

Node は **v20 以上**。依存 (`@aws-sdk/client-s3`) は既存のものを使う (`npm install` 済み前提)。
Drive 直読みは追加パッケージ不要 (Drive REST を直接呼ぶ)。

## 2. 入力の指定 (2通り)

サブフォルダ名から `format_id` を自動判定する。判定キーワード:
がんリスク/尿→Cancer、遺伝子/genetic→Genetic、血液/blood→Blood、
人間ドック/検診/健診/ドック→HealthCheckup、問診/生活習慣→Lifestyle、その他→Other。
`--format <id>` で全画像を明示指定も可。

### 2a. Google Drive 直読み (推奨・ローカルに保存しない)

`--drive <フォルダID>` を指定すると、Drive のフォルダを**再帰的に読み、各画像をメモリ上で
受けて処理**する。**ローカルディスクには画像を保存しない**ため、大容量・重複データでも
ストレージを圧迫しない。

- フォルダID: 共有URL `https://drive.google.com/drive/folders/<ここがID>` の末尾。
  本件は `1N19u4NybUjgkkJF-fpe1xaPXG_s-Ozgh`。直下のサブフォルダ
  (がんリスク検査 / 検診・人間ドック / 遺伝子検査データ) が format_id 判定に使われる。
- 認証 (`drive.readonly`) はいずれか:
  - **サービスアカウント (推奨)**: SAキーJSONを `GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/path/key.json`
    (または中身を `GOOGLE_SERVICE_ACCOUNT_KEY` に)。**対象Driveフォルダを、その SA の
    メールアドレスに「閲覧者」で共有**しておく。
  - **一時トークン**: `GOOGLE_ACCESS_TOKEN=<OAuthアクセストークン>` (1時間有効。少数テスト向け)。

```bash
# ドライラン (件数・形式の確認。生成物は ./batch-out に出す)
GEMINI_API_KEY=xxxxx \
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/path/sa.json \
node scripts/batch-scan-to-elith.mjs --drive 1N19u4NybUjgkkJF-fpe1xaPXG_s-Ozgh --limit 3
```

### 2b. ローカルフォルダ

`--input <dir>` で、事前にDLした画像を種別サブフォルダに置いて処理する。

```
samples/
  がんリスク検査フォルダー/      → CancerRiskAssessmentData
  検診・人間ドックサンプル/       → HealthCheckupData
  遺伝子検査データサンプル/        → GeneticTestResultData
```

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

Drive 直読み → S3 (ローカルに一切保存しない、推奨):

```bash
GEMINI_API_KEY=xxxxx \
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/path/sa.json \
AWS_REGION=ap-northeast-1 AWS_S3_BUCKET=wellfort-ai-input \
AWS_ACCESS_KEY_ID=xxxx AWS_SECRET_ACCESS_KEY=xxxx \
node scripts/batch-scan-to-elith.mjs --drive 1N19u4NybUjgkkJF-fpe1xaPXG_s-Ozgh --upload
```

ローカルフォルダから:

```bash
GEMINI_API_KEY=xxxxx \
AWS_REGION=ap-northeast-1 AWS_S3_BUCKET=wellfort-ai-input \
AWS_ACCESS_KEY_ID=xxxx AWS_SECRET_ACCESS_KEY=xxxx \
node scripts/batch-scan-to-elith.mjs --input ./samples --upload
```

`--upload` 時は `batch-mapping.csv` も**ローカルに残さず S3** (`{prefix}user/_batch/`) に置く。

出力 (Elith 仕様):

```
s3://{bucket}/{prefix}user/{client_id}/date/{YYYY_MM_DD}/
    {format_id}_date_{YYYY_MM_DD}_user_{client_id}.json   ← スキャン結果 (Elith エンベロープ)
    {format_id}_date_{YYYY_MM_DD}_user_{client_id}.{元拡張子} ← 参考用の元画像 (同名)
```

## 5. 主なオプション

| オプション | 既定 | 説明 |
|---|---|---|
| `--drive <folderId>` | — | Google Drive フォルダを直読み (ローカル保存なし)。`--input` と排他 |
| `--input <dir>` | — | ローカル入力ルート。`--drive` と排他 (どちらか必須) |
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
