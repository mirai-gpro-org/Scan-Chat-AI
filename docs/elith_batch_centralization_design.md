# Elith 連携バッチ 一元化設計 (キー管理・実行制御)

| 項目 | 内容 |
|---|---|
| 文書名 | Elith 連携データ生成バッチの一元化設計 (キー管理・実行制御) |
| バージョン | 0.1 (Draft) |
| 作成日 | 2026-07-05 |
| 目的 | AIスキャン→Elith 形式 JSON→S3 の処理を、**API キーを一箇所で管理**しつつ、ユーザーアプリ・admin バッチ・CLI の全入口で共通利用できるようにする |
| 関連文書 | `elith_s3_data_handoff_spec.md` / `batch_scan_to_elith_usage.md` / `wellfort_admin_lab_upload_spec.md` / `subscription_management_feature_requirements.md` (要件2/4) |

---

## 1. 背景: 本番での役割分担

Elith へ渡す入力データは、検査種別ごとに**取得経路が異なる**。

| 検査 (format_id) | 本番での取得・処理 | 実行主体 |
|---|---|---|
| 検診・人間ドック (`HealthCheckupData`) | **ユーザー自身がアプリ上でAIスキャン** → S3 | エンドユーザー (アプリ) |
| がんリスク検査 (`CancerRiskAssessmentData`) | Wellfort が検査機関から**手動取得** → **admin バッチ**で処理 → S3 | Wellfort スタッフ (admin) |
| 遺伝子検査 (`GeneticTestResultData`) | 同上 (手動取得 → admin バッチ) | Wellfort スタッフ (admin) |
| 血液検査 (`BloodTestData`) | デメカル自動DL (別途 RPA) → 取込 → S3 | 自動 / スタッフ |
| 生活習慣・問診 (`LifestyleQuestionnaireData`) | アプリのAI問診 → S3 | エンドユーザー (アプリ) |

→ **がんリスク・遺伝子**は、Wellfort が手動取得したファイルを **admin 管理ダッシュボードの
バッチ機能**で「AIスキャン → Elith 形式 JSON → S3」する必要がある (検診のユーザー自身フローと同型)。

## 2. 課題: キー管理・実行制御の一元化

現状は 3 つの入口が別々にキーを持ちうる:
- ユーザーアプリのスキャン (`/api/scan/*`) — アプリのサーバ環境の `GEMINI_API_KEY` / `AWS_*`
- 単発 CLI (`scripts/batch-scan-to-elith.mjs`) — 実行端末の環境変数 / `.env`
- (将来) admin バッチ — ?

**要件: API キー (Gemini / AWS S3) を一箇所で管理し、operator の PC やクライアントに配らない。**

## 3. 設計方針: 「共通ロジック + 単一キー源 (サーバ)」

### 3.1 全体像

```
                ┌─────────────────────────────────────────────┐
                │  共有サーバモジュール (src/lib/elith-export)   │  ← ロジックは1つ
                │  scan(Gemini) → Elithエンベロープ → S3 put    │
                │  キーは「サーバ環境 (env/Secret)」からのみ取得   │  ← キー源も1つ
                └─────────────────────────────────────────────┘
                    ▲                 ▲                    ▲
          (a) ユーザーアプリ    (b) admin バッチ        (c) CLI (補助)
          /api/scan/export     /api/admin/elith-batch   scripts/*.mjs
          検診・問診(本人)      がんリスク・遺伝子(Wellfort) 一時的な一括処理
```

- **ロジックを 1 モジュールに集約** (`src/lib/elith-export.ts` など)。3 入口はこれを呼ぶだけ。
- **キーはサーバ環境変数 / Secret Manager にのみ置く**。UI・管理者PC・クライアントには置かない。
- admin バッチは**サーバ側で実行**されるため、operator は**UI でファイルを渡すだけ**でキーに触れない。

### 3.2 キー一元管理の具体

| 入口 | 実行場所 | キーの出所 | operator がキーを扱うか |
|---|---|---|---|
| (a) ユーザーアプリ スキャン | アプリサーバ (Vercel/専用) | サーバ env / Secret | No |
| (b) **admin バッチ** | **同じアプリサーバ** | **同じサーバ env / Secret** | **No (UI操作のみ)** |
| (c) CLI (単発) | 運用端末 | アプリの `.env` を自動読込 (= 同一ソース) | 端末に .env がある場合のみ |

- **恒常運用は (b) admin バッチに寄せる** → キーはサーバの 1 箇所だけ。operator はブラウザで操作。
- (c) CLI は「今回の 61 サンプル」等の**一時的な一括処理の補助**。キーはアプリの `.env` から読む
  (単一ソース) が、端末にキーが乗るため常用しない。恒常運用は (b) へ移行。
- 将来的に (a) も含め、キーは **Secret Manager 一元管理 + サーバ起動時注入**に統一。

### 3.3 共有モジュールの責務 (案)

`src/lib/elith-export.ts` (サーバ専用):
- 入力: 画像 (Buffer) or 確定 Markdown、`format_id`、`client_id`、`test_date`(任意)。
- 処理: (画像なら) Gemini スキャン → Markdown → Elith エンベロープ (§`elith_s3_data_handoff_spec.md`) 生成。
- 出力: S3 へ JSON + 元画像 (同名・拡張子替え) を put。パス/命名は Elith 仕様。
- キー取得は `getServerConfig()` に集約 (Gemini/AWS を 1 関数で。env/Secret のみ参照)。
- **既存の `scan-export.ts` / `s3.ts` / `scan.ts(ANALYZE_SYSTEM)` を再利用**し、Elith エンベロープ化を追加。

## 4. admin バッチ機能 (がんリスク・遺伝子) の概要

`wellfort_admin_lab_upload_spec.md` の既存アップロード UI を拡張/隣接させる。

### 4.1 画面・API (案)

- 画面: `/admin/elith-batch` (または既存 `/admin/lab-results/upload` に「Elith出力」動作を追加)
  - 検査種別選択 (がんリスク / 遺伝子 …) → `format_id` 決定
  - ファイル複数アップロード (検査機関の PDF/画像) or サーバ上の取込済み成果物を選択
  - **顧客割当**: 実顧客の `diagnostic_user_id` に紐付け (サンプルと違い本番は実ユーザー。
    `lab_integration_workflow.md` の割当ワークフロー準拠。氏名OCRのみの自動確定は禁止)
  - 実行 → 進捗・結果 (件数 / S3 キー / 失敗一覧 / mapping)
- API: `POST /api/admin/elith-batch` (サーバ側で共有モジュールを呼ぶ)
  - 認証: admin 権限必須。キーはサーバ env。
  - `test_artifacts` / `test_artifact_files` への記録も連携 (要件2)。

### 4.2 サンプル一括 (CLI) との違い

| | CLI (今回のサンプル) | admin バッチ (本番) |
|---|---|---|
| client_id | 擬似 UUID (実顧客なし) | **実顧客 `diagnostic_user_id`** に割当 |
| 実行 | 運用端末 | アプリサーバ |
| キー | 端末 (.env) | サーバ env のみ |
| 入力 | NAS/Drive の画像 | admin UI アップロード / 取込済み成果物 |
| 対象 | 検診・がん・遺伝子 全部 (テスト) | がんリスク・遺伝子 (本番運用) |

## 5. 移行ステップ (案)

1. **共有モジュール抽出**: `src/lib/elith-export.ts` に「scan→Elithエンベロープ→S3」を集約
   (CLI の `.mjs` に実装した変換ロジックを TS へ移し、`scan-export.ts`/`s3.ts` と統合)。
2. **ユーザーアプリ (a)**: `/api/scan/export` を Elith 形式出力に対応 (検診・人間ドック用)。
3. **admin バッチ (b)**: `/admin/elith-batch` + `/api/admin/elith-batch` を実装 (がんリスク・遺伝子)。
   顧客割当・`test_artifacts` 連携・進捗表示。
4. **キー一元化**: Gemini/AWS キーを Secret Manager 等に集約。CLI は補助的位置づけへ。
5. CLI (c) は当面「一時的な一括処理」として維持 (キーはアプリ `.env` = 同一ソース)。

## 6. 未確定事項

| # | 内容 |
|---|---|
| 1 | admin バッチの入力: UI 直アップロード か、取込済み `test_artifacts` から選択か (両対応か) |
| 2 | 本番 client_id = 実顧客 `diagnostic_user_id` の割当タイミング/UI (`lab_integration_workflow.md`) |
| 3 | がんリスク/遺伝子の元ファイルは画像(AIスキャン対象)か PDF(抽出)か。PDF の構造化方式 |
| 4 | キー保管先 (Vercel env / Secret Manager / 専用サーバ) の確定と注入方法 |
| 5 | 検診(ユーザー)フローの Elith 形式化 (`/api/scan/export` 改修) の実施範囲 |
</content>
