# AI スキャン読込結果 → S3 書き出し (Elith 連携・暫定)

AI スキャンの読込精度確認テスト用に、確定済スキャン結果を S3 バケットへ書き出して
Elith 側へ渡すための **暫定** 仕様。Elith 側のテストデータ不足を解消するのが目的で、
ファイル名・フォルダ名・JSON フォーマットはすべて暫定 (`schema_version: scan-export-v0`)。
正式仕様が決まり次第 bump する。

## フロー

```
スキャン → ユーザー検証(編集) → [☁️ S3へ書き出し（Elith用・テスト）]
   → POST /api/scan/export → S3 PutObject (json / md / manifest)
```

S3 未設定 (env なし) でも壊れない。その場合は「変換のみ (ドライラン)」で、生成される
JSON とファイル一覧をレスポンスでプレビュー返却する。

## フォルダ / ファイル名規約 (暫定)

`docs/diagnostic_session_data_spec.md` §3.5/§3.6 に準拠。

```
{AWS_S3_PREFIX}{diagnostic_id}/
  scan-{元ファイル名}-{YYYYMMDDThhmmss(JST)}.json   ← 構造化データ (メイン)
  scan-{元ファイル名}-{YYYYMMDDThhmmss(JST)}.md     ← 確定 Markdown (読込精度の突合用)
  manifest.json                                      ← 索引
```

- `diagnostic_id`: 端末で発番済の UUID (無ければサーバ生成)
- 時刻スタンプは JST のコンパクト ISO8601
- `{元ファイル名}`: アップロードした読込元ファイル名をスラッグ化して埋め込む
  (拡張子/ディレクトリ除去・空白や記号を `-` 化・40 文字制限)。
  例: `血液検査.pdf` → `scan-血液検査-20260618T142005.json`。
  カメラ撮影などファイル名が無い場合は `scan-{日時}.json` になる。
  原本のファイル名は JSON の `source.file` と `manifest.source_file` にも保持。
- `AWS_S3_PREFIX` 例: `scan-accuracy-test/`
- 画像 (jpg) は**同梱しない**方針 (容量優先)。必要になれば manifest に追加する

## JSON フォーマット (`scan-export-v0`)

```jsonc
{
  "schema_version": "scan-export-v0",
  "kind": "scan_result",
  "diagnostic_id": "6f2c1a9b-…",
  "diagnostic_user_id": "da000001-…",   // 無ければ null
  "captured_at": "2026-06-18T05:20:05.000Z",
  "exported_at": "2026-06-18T05:20:05.000Z",
  "source": { "app": "scan-chat-ai", "model": null, "hint": "血液検査", "note": "…テスト用…" },
  "region_count": 2,
  "row_count": 2,
  "regions": [
    {
      "index": 0,
      "label": "左側検査表",
      "bbox": [0.08, 0.02, 0.98, 0.50],   // [ymin,xmin,ymax,xmax] / null
      "type": "table",
      "columns": ["No","検査項目","検査項目詳細","読み取った値","単位","下限値","上限値","判定","備考"],
      "rows": [
        {
          "by_column": { "No": "1", "検査項目": "AST", "読み取った値": "26", "判定": "-" },
          "cells": ["1","AST","AST(GOT)","26","U/L","13","30","-","-"]
        }
      ]
    },
    { "index": 1, "label": "右側手書きメモ", "bbox": [0.5,0.2,0.95,0.85], "type": "notes",
      "notes": ["CA19-9 前回 4981 → 今回 4048 = -933 改善", "次回 8/4 (金)"] }
  ],
  "raw_markdown": "## 左側検査表\n…"
}
```

- `regions[].type`: `table` (印字表) / `notes` (手書きメモ・自由テキスト)
- 表は `columns` (一意化ヘッダ) と `rows[]` を持つ。各行は `by_column` (ヘッダ→値) と
  `cells` (生配列) を併記し、列数ズレも保持する
- `raw_markdown` は確定 Markdown 原本 (人/Elith が突合に使う)

## 環境変数 (サーバ専用)

| 変数 | 必須 | 用途 |
|------|------|------|
| `AWS_REGION` | ○ | リージョン (例 `ap-northeast-1`)。**これが書き出し有効化スイッチ**。未設定ならドライラン |
| `AWS_S3_BUCKET` | - | 書き出し先バケット (既定 `wellfort-ai-input`) |
| `AWS_S3_PREFIX` | - | 共通プレフィックス (既定 `scan-accuracy-test/`) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | - | 明示キー (未指定は IAM ロール等 SDK 既定チェーン) |
| `AWS_S3_ENDPOINT` | - | S3 互換エンドポイント (MinIO 等) |

> 既定の書き出し先: `s3://wellfort-ai-input/scan-accuracy-test/{diagnostic_id}/`
> `AWS_REGION` (＋認証 or IAM ロール) を設定すれば有効化される。

## 関連ファイル

| ファイル | 役割 |
|---|---|
| `src/lib/scan-export.ts` | Markdown→JSON 変換 / バンドル生成 (純粋関数) |
| `src/lib/s3.ts` | S3 PutObject (env 駆動) |
| `src/pages/api/scan/export.ts` | 書き出しエンドポイント (未設定時ドライラン) |
| `src/pages/scan.astro` | 検証 UI の「S3へ書き出し」ボタン |
