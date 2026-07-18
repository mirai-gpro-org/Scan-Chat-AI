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
- **使用モデルは env で差替え可 (デプロイ不要・即時切替/切戻し)**。既定は `src/lib/gemini.ts` の `MODELS`。
  - スキャン (画像解析・全 REST 呼び出し): 既定 **`gemini-3.1-flash-lite`**。`GEMINI_SCAN_MODEL` で上書き。
    不具合/Tier1 未開通時は `GEMINI_SCAN_MODEL=gemini-2.5-flash` へ即切戻し (旧既定)。上げるなら `gemini-3-flash`。
    - **前提**: 3.x 系は **Tier1 (課金有効化) + 当該キーでのモデルアクセス** が必要。未開通のまま 3.x を指すと
      全スキャン (検診/がん/血液image/遺伝子) が失敗する → その場合は env で 2.5 に戻す。
    - スキャン精度は **検診 numeric → 健康年齢 (CABA)** に直結。モデル切替時は代表ページで再検証すること。
  - Live (AI問診): 既定 `gemini-3.1-flash-live-preview` (REST 非対応の専用プレビュー)。`GEMINI_LIVE_MODEL` で追従。
  - **Gemini 3.x の生成設定差は `callGemini` が自動吸収**: 呼び出し側は 2.x 形式 (`thinkingBudget`・`temperature`) の
    まま書けばよい。3.x 指定時のみ `temperature/topP/topK` を除去 (既定推奨) し `thinkingBudget→thinkingLevel` へ変換。
- したがって **ローカル端末での CLI 直実行は不可** (キーを読めない)。
  スキャン/エクスポート等の鍵が要る処理は **Vercel サーバ側 (API/admin バッチ)** で実行する。

### アプリ構成 / 管理画面の所在 (重要・誤解しやすい)
- **Scan-Chat-AI は単独アプリではなく、`www.wellfort.co.jp`(wellfort-site) 配下の診断アプリ**。
  ユーザーは `www.wellfort.co.jp` マイページのリンクから Scan-Chat-AI に遷移する
  (`docs/wellfort_mypage_button_spec.md`: 本番 `https://scan-chat-ai.vercel.app/`、将来 `app.wellfort.co.jp`)。
- **管理者メニューも `www.wellfort.co.jp/admin`(wellfort-site) 側**。
  - **admin UI は wellfort-site に置く**。**Scan-Chat-AI は API 提供側**
    (`https://scan-chat-ai.vercel.app/api/admin/...`)。根拠: `docs/wellfort_admin_lab_upload_spec.md`
    L5-6/§3「実装対象=Wellfort HP 管理画面 / Scan-Chat-AI=API提供側」。
  - **認証は 2 層**:
    1. **入口(admin判定)**: wellfort-site 側で管理者かを確認する。方式は既存 `admin/users.astro`
       (L543-551) と同じ = **ユーザー自身のアクセストークン + anon apikey で `admin_users` を照会**
       (`is_active=true`)。**service_role は使わない**。
    2. **上流(Scan-Chat-AI)**: **Bearer API Key** (`wellfort_admin_lab_upload_spec §6-1`)。
       wellfort-site 側 env `SCAN_CHAT_AI_API_KEY` = Scan-Chat-AI 側 env `ADMIN_API_KEY` (同値)。
       キーはブラウザに出さない・CORS不要。
  - **§6-2 の「Scan-Chat-AI 側で ID Token→admin_users 照合」は Phase 2.0 (将来)。Phase 1.0 では実装しない。**
  - → 新しい admin 機能を作るときは **UI=wellfort-site / 処理=Scan-Chat-AI API** で分ける。
    Scan-Chat-AI 側に admin 画面を作らない (キー・処理は Scan-Chat-AI、入口は wellfort-site)。

### AI問診 / Live API 制御 (絶対厳守)
- **Live API のターン制御（VAD・割り込み・復唱・エコー対策）は全て LLM/Live API に委ねる。
  プログラム側で制御しない。** マイクの半二重ゲート、AI発話中のマイク送信停止、
  「LLMが自発復唱するはずだから復唱依頼を出し分ける（silent 分岐）」等の**プログラム制御は禁止**。
  → 必ずドツボに嵌る（読み上げが途中で途切れる等の回帰を生む）。実績: 2026-07-05 に
    `f3d59e8`/`09af5ec` で silent 分岐・2パターンプロンプトを入れた結果、AI 読み上げが
    途中で切れる回帰が発生。`b67c15b`（単一依頼「①復唱 ②(切替時)導線 ③次質問」を送り
    ターン制御は LLM 任せ）へ戻して解消。
- 問診の進行（質問順・分岐・完了）は `InterviewEngine`（クライアント）が制御し、
  LLM は「渡された質問文の読み上げ＋回答の復唱」だけを担う。**LLM に問診順を決めさせない。**
- AI問診＝**5セクション（嗜好品・運動・食生活・睡眠・心身）**が仕様
  (`docs/20260331_AI参考問診票.png` / `docs/funding_application/要件定義書.md` F-3)。
  **同意設問・実施検査確認などは問診に含めない**（同意は登録/オンボーディングで取得）。
- **詳細仕様・設計原則・アンチパターン・二重話者問題の因果は `docs/AI問診_仕様と設計原則.md` が正本。
  AI問診コードに触れる前に必読。** 責務分界（フロー/選択肢/データ=プログラム, 音声のターン/発話=LLM任せ）、
  silent 分岐・マイクゲート禁止、`f99f47e` が二重話者の起点である因果、案1(音声=LLM単独話者)への修正方針を記載。

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
| `docs/AI問診_仕様と設計原則.md` | **AI問診の確定仕様・設計原則（責務分界/禁止事項/二重話者問題/修正方針）。コード変更前必読** |
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
