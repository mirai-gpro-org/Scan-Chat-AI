# CLAUDE.md — このリポジトリで作業する前に必ず読む

この文書は **確定済みの決定事項と、その根拠ドキュメントの索引**。
作業前にここと該当ドキュメントを読み、**推測・再質問で確定事項を蒸し返さない**こと。

## 作業ルール (厳守)

1. **まず `docs/` を読む。** 質問する前に、関連ドキュメントを検索・精読する
   (`docs/`, `docs/operations/`, ルートの各 `*.md`)。答えは大抵書いてある。
2. **確定事項 (下記) を再質問しない。** 変更や矛盾があるときだけ確認する。
3. 決定が変わったら **この CLAUDE.md と該当ドキュメントを更新**してから進む。
4. 憶測で仕様を作らない。ドキュメントに無い場合のみ、明示して確認する。

## 確定事項 (Settled decisions)

### 環境変数・キー管理
- **API キー (Gemini / AWS S3 など) は Vercel 本番環境の環境変数で一元管理**。
  **ローカル `.env`・operator PC・クライアントには置かない。**
  - 根拠: `docs/operations/Gemini_APIキー作成手順書_Wellfort_v1.0.md` L26 / L153
    「UNFIX が受領した API キーを Vercel 本番環境の環境変数 `GEMINI_API_KEY` に設定」。
  - キーローテーション: 3 か月に 1 回程度 (同 L155)。法人パスワードマネージャに保管 (L154)。
  - **キー形式変更 `AIza`→`AQ.`**: 新 `AQ.` キーで本アプリはそのまま動作 (ネイティブ endpoint に
    `x-goog-api-key` ヘッダ + 公式SDK 利用のため。コード変更不要)。
    **旧 `AIza` は 2026-09 に失効** → それまでに Vercel の `GEMINI_API_KEY` を `AQ.` キーへ差し替える
    (運用のみ)。詳細: `docs/operations/Gemini_APIキー作成手順書_Wellfort_v1.0.md` §7.1。
  - Gemini 呼び出しは `src/lib/gemini.ts` に集約。キーは `x-goog-api-key` ヘッダ送信 (URL に載せない)。
- したがって **ローカル端末での CLI 直実行は不可** (キーを読めない)。
  スキャン/エクスポート等の鍵が要る処理は **Vercel サーバ側 (API/admin バッチ)** で実行する。

### インフラ / 実行モデル
- **Vercel Serverless (iad1 / US East)**。Gemini API と地理的近接 (`system_architecture_overview.md` L143/L273)。
- 関数タイムアウト ~60s。大型検査表はストリーミング/分割。
  → バッチは **1 画像 = 1 リクエスト**で処理し、クライアントが順に呼ぶ (`system_architecture_overview.md` L316)。

### Elith 連携 (S3 データ受け渡し)
- 仕様は `docs/elith_s3_data_handoff_spec.md` が正:
  - パス `/{prefix}user/{client_id}/date/{YYYY_MM_DD}/`
  - ファイル `{format_id}_date_{YYYY_MM_DD}_user_{client_id}.json`
  - format_id: `CancerRiskAssessmentData` / `HealthCheckupData` / `GeneticTestResultData` /
    `BloodTestData` / `LifestyleQuestionnaireData` / `Other`
  - `client_id` = `diagnostic_user_id` (PII 非含有)。必要データが揃った時点で一括書き出し。
- S3 既定: バケット `wellfort-ai-input` / prefix は用途による (`src/lib/s3.ts`)。

### 検査種別ごとの本番処理 (役割分担)
根拠: `docs/elith_batch_centralization_design.md`
- 検診・人間ドック (`HealthCheckupData`) … **ユーザーがアプリでAIスキャン**
- がんリスク (`CancerRiskAssessmentData`) / 遺伝子 (`GeneticTestResultData`) …
  **Wellfort が検査機関から手動取得 → admin バッチ (サーバ実行) で処理**
- 血液 (`BloodTestData`) … デメカル (dl.demecal.net) から取得。自動DLは
  `docs/demecal_auto_download_overview_spec.md` (クライアント証明書 mTLS)
- 生活習慣・問診 (`LifestyleQuestionnaireData`) … アプリの AI 問診

### PII / データ分離
- `customer` スキーマ(PII) と `diagnosis` スキーマ(非PII) を **`diagnostic_user_id` のみで橋渡し**。
  氏名・住所・生年月日を診断系/外部/S3 に載せない (`docs/data_integration_requirements.md` §1.3,
  `docs/lab_integration_workflow.md` §1.1)。氏名OCRのみでの顧客割当確定は禁止。

## 主要ドキュメント索引

| ドキュメント | 内容 |
|---|---|
| `docs/operations/Gemini_APIキー作成手順書_Wellfort_v1.0.md` | Gemini キー発行・**Vercel 環境変数運用**・ローテーション |
| `docs/system_architecture_overview.md` | 全体構成・**Vercel/タイムアウト**・データフロー |
| `docs/elith_s3_data_handoff_spec.md` | **Elith S3 受け渡し仕様** (パス/命名/format_id/JSON) |
| `docs/elith_batch_centralization_design.md` | Elith バッチ**一元化設計**(キーは Vercel・役割分担・admin バッチ) |
| `docs/batch_scan_to_elith_usage.md` | サンプル一括スキャン→S3 バッチ手順 (`scripts/batch-scan-to-elith.mjs`) |
| `docs/demecal_auto_download_overview_spec.md` | 血液検査データ自動DL (デメカル/mTLS) 概要 |
| `docs/demecal_inquiry_email_template.md` | 検査会社への自動DL可否 照会メール雛形 |
| `docs/subscription_management_feature_requirements.md` | サブスク契約管理 拡張 機能要件 (要件1〜4・データモデル・付録Bマトリクス) |
| `docs/subscription_management_implementation_guide.md` | 上記の実装手順書 |
| `docs/wellfort_admin_lab_upload_spec.md` | 管理UI: 検査結果ファイルアップロード仕様 |
| `docs/lab_integration_workflow.md` | 検査機関→ユーザー割当ワークフロー (PII 制約) |
| `docs/kit_progress_management.md` | 検査キット発送・進捗管理 |
| `docs/data_integration_requirements.md` | PII 分離・連携要件 |
| `docs/diagnostic_session_data_spec.md` | 診断セッションのデータ構造 |
| `docs/scan_feature_requirements.md` / `docs/scan_s3_export.md` | AIスキャン機能要件 / S3書き出し |

## コード / スタック
- Astro v5 + TypeScript (SSR / Vercel)。UI=`.astro`、API=`src/pages/api/**.ts`、ロジック=`src/lib/`。
- Supabase 2スキーマ (`customer`=PII / `diagnosis`=非PII)。マイグレーション=`supabase/migrations/`。
- 標準スクリプトは `scripts/*.mjs` (Node ESM, 追加依存なし方針)。
- 主要ライブラリ: `@google/genai`(Gemini)、`@aws-sdk/client-s3`(S3)、`@supabase/supabase-js`。

## 開発ブランチ
- 本作業ブランチ: `claude/clever-cray-ngg0h6` (指示がある限りここへコミット/プッシュ)。
</content>
