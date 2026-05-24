# 診断セッション データ仕様書

| 項目 | 内容 |
|---|---|
| 文書名 | Scan-Chat Medical AI — 診断セッション データ仕様書 |
| バージョン | 0.1 (Draft) |
| 作成日 | 2026-05-23 |
| 対象 | 1 回の診断で生まれる成果物（scan / 問診 / AI 診断）のデータ構造・保存先・連携仕様 |
| 関連文書 | `docs/data_integration_requirements.md`（ユーザー単位の ID/ 認証連携）|

> 本書は **「1 回の検査・診断セッション」単位**で生まれる成果物の取り回しを定義します。
> 「ユーザー単位の認証・ID マッピング」は `data_integration_requirements.md` を参照のこと。

---

## 1. スコープと前提

### 1.1 ユーザーフロー

```
1. ユーザーが HP/EC マイページで「検査を申し込む」
2. 検査キット発送・受領・採取・返送
3. 検査機関が紙の検査結果報告書を発行
4. ユーザーがマイページから「結果をスキャン」→ Scan-Chat-AI へ
5. 検査表をスマホで撮影 → Markdown に転記
6. 必要に応じて音声問診（Live API）
7. 全データを下流の AI 診断システムへ渡し、診断結果を生成
8. マイページで診断結果を閲覧、進捗管理
```

### 1.2 設計原則

| 原則 | 内容 |
|---|---|
| **PII 分離** | 顧客個人情報を持つ系統と診断データを持つ系統を物理的に分離する。診断系は氏名・メール等を一切持たない |
| **Pseudonymization** | 診断系では `diagnostic_id`（UUID）のみで個人を識別する |
| **段階的永続化** | パイロット中は端末保存、検証後に Supabase、本番で AWS と段階的に上げる |
| **スキーマ進化耐性** | 診断 AI の出力は将来変わるため、JSONB ハイブリッド設計とする |
| **Markdown ファースト** | 各成果物は LLM 処理に最適化した Markdown で保持する。JSON 変換は必要時のみ |

---

## 2. ID 体系

### 2.1 4 つの ID の関係

| ID | 発番者 | 紐づく単位 | 何系統に置くか |
|---|---|---|---|
| `customer_id` | HP/EC 既存システム | **1 ユーザー（自然人）= 1 customer** | 顧客系 Supabase |
| `diagnosis_user_id` | App 側 Supabase（既存設計） | **1 ユーザー = 1 diagnosis_user** | 診断系 Supabase |
| `diagnostic_id` | **Scan-Chat-AI** | **1 回の検査・診断セッション** | 診断系 Supabase（および橋渡しの link テーブル） |
| `artifact_id` | 診断系 Supabase | **1 つの成果物（scan, image, 問診 等）** | 診断系 Supabase |

```
customer_id (1) ─── (n) diagnosis_user_id [このユーザーの認証実体]
                          │
                          └─ (n) diagnostic_id [1回の検査セッション]
                                    │
                                    └─ (n) artifact_id [scan_md / image / 問診md / 診断結果]
```

通常は `customer_id : diagnosis_user_id = 1 : 1`、`diagnosis_user_id : diagnostic_id = 1 : n`（同一ユーザーが複数回検査する）、`diagnostic_id : artifact_id = 1 : n`（1 セッションに複数成果物）。

### 2.2 `diagnostic_id` の発番

- **発番者**: Scan-Chat-AI クライアント（`crypto.randomUUID()` v4）
- **発番タイミング**: 撮影開始（`/scan` の最初の `📷 撮影 & 解析`）または明示的に新セッション開始時
- **永続化**: クライアント localStorage → 後段で Supabase / API 同期
- **形式**: 標準 UUID v4 （例: `6f2c1a9b-1234-4abc-9def-d3a3aa30c777`）

#### 将来：マイページ側で発番に切り替える場合

```
マイページが「新規検査セッション開始」をトリガで diagnostic_id 発番
  → URL パラメータで Scan-Chat-AI に引き渡し
  → Scan-Chat-AI はクライアント側で受領、独自発番はしない
```

これにより `customer_diagnostic_link` の登録漏れを防ぐ。マイページからの導線が整った段階で切り替える。

---

## 3. 成果物（Artifacts）

### 3.1 1 セッションで発生する成果物

| 種別 | 中身 | 形式 | 主たる消費先 |
|---|---|---|---|
| `scan_md` | 検査表を AI が転記した構造化 Markdown | text/markdown | 診断 AI / ユーザー閲覧 |
| `scan_image` | 撮影元画像（証跡） | image/jpeg | ユーザー閲覧 / 監査 |
| `interrogation_md` | 音声/テキスト問診の会話ログ | text/markdown | 診断 AI / ユーザー閲覧 |
| `diagnostic_result` | 下流 AI が生成した診断結果 | JSONB + Markdown 併存 | ユーザー閲覧 |

複数の検査表を 1 セッションに紐付ける場合は、`scan_md` / `scan_image` が複数個並ぶ（タイムスタンプで区別）。

### 3.2 `scan_md` のフォーマット

`/api/scan` が Gemini から取得する Markdown は次の形:

```markdown
## 左側検査値表
<!-- bbox: 0.05,0.05,0.95,0.50 -->

| No | 検査項目 | 結果 | 単位 | 基準値 |
|----|----------|------|------|--------|
| 1  | AST(GOT) | 18   | U/L  | 10-35  |
| 2  | ALT(GPT) | 12   | U/L  | 5-40   |

## 手書きメモ
<!-- bbox: 0.05,0.85,0.95,0.98 -->

- 古富先生
- CA19-9 4048.7H (前回 4981)
```

- 領域は H2（`## ラベル`）で開始
- 領域 bbox は HTML コメント `<!-- bbox: ymin,xmin,ymax,xmax -->`（0.0-1.0 正規化）
- 表は GFM テーブル
- 自由テキストは箇条書き / 段落
- 不明値は `(?)` と書く（推測で埋めない）

### 3.3 `interrogation_md` のフォーマット（予定）

```markdown
## 問診セッション
<!-- session_id: ... -->
<!-- started_at: 2026-05-23T14:30:00+09:00 -->

### 主訴
- 約 1 ヶ月前から食欲低下
- 体重 −3kg

### 既往歴
- 高血圧（10 年）
- 服薬: ARB 50mg/日

### 生活習慣
- 飲酒: 週 2-3 回
- 喫煙: なし
```

詳細フォーマットは Live API 実装フェーズで確定。

### 3.4 ファイル名規約（端末ダウンロード / オブジェクトストレージ共通）

```
{diagnostic_id}/
  scan-{ISO8601}.md
  scan-{ISO8601}.jpg
  interrogation-{ISO8601}.md
  diagnostic_result-{ISO8601}.json    # 後続で診断 AI が書く
  manifest.json
```

例:
```
6f2c1a9b-1234-4abc-9def-d3a3aa30c777/
  ├ scan-20260523T142005.md
  ├ scan-20260523T142005.jpg
  ├ interrogation-20260523T142810.md
  └ manifest.json
```

### 3.5 `manifest.json` のスキーマ

```json
{
  "diagnostic_id": "6f2c1a9b-1234-4abc-9def-d3a3aa30c777",
  "schema_version": 1,
  "created_at": "2026-05-23T14:20:05+09:00",
  "device": { "ua": "...", "screen": "..." },
  "app_version": "80f6a45",
  "artifacts": [
    { "type": "scan_md",          "file": "scan-20260523T142005.md",       "bytes": 2840 },
    { "type": "scan_image",       "file": "scan-20260523T142005.jpg",      "bytes": 287430, "mime": "image/jpeg" },
    { "type": "interrogation_md", "file": "interrogation-20260523T142810.md", "bytes": 1820 }
  ]
}
```

Supabase / S3 へ移行する際、この manifest を読めば全レコードを再構成できる。

---

## 4. 段階的ストレージ戦略

### Phase 0：パイロット（現在）

ローカル端末への明示ダウンロードのみ。サーバ側永続化はしない。

```
[iPhone Safari / iPad]
  ├ localStorage: 直近の diagnostic_id, 進行中セッション
  └ Files App / Downloads: {diagnostic_id}/*.md, *.jpg, manifest.json
                            (一括 ZIP ダウンロードボタン経由)
```

### Phase 1：Supabase 二分割

```
┌─ Supabase #1: 顧客系（既存 HP/EC）────────┐    ┌─ Supabase #2: 診断系（新規） ────────┐
│  customers (PII)                          │    │  diagnostics                          │
│  customer_diagnostic_link  ← 唯一の橋     │    │  scan_artifacts                       │
│  kit_shipments                            │    │  diagnostic_results (JSONB)           │
│  notifications                            │    │  Storage: {diagnostic_id}/*.md, *.jpg │
└───────────────────────────────────────────┘    └───────────────────────────────────────┘
            │                                              │
            └── diagnostic_id だけで橋渡し ────────────────┘
                (PII はこの境界を越えない)
```

### Phase 2：AWS 移行

```
┌─ 顧客系 ──────────────────────────────────┐    ┌─ 診断系 ─────────────────────────────┐
│  AWS RDS PostgreSQL (顧客 VPC)            │    │  AWS Aurora PostgreSQL Serverless v2 │
│  + S3 (各種ドキュメント)                  │    │  + S3 (scan_image, manifest)         │
│  + CloudFront (静的アセット)              │    │  + OpenSearch (任意・MD 全文検索)    │
└───────────────────────────────────────────┘    └───────────────────────────────────────┘

  両 DB は別 VPC、必要時のみ VPC Peering or PrivateLink で
  customer_diagnostic_link テーブル経由のクエリだけ流す。
```

各フェーズの境界では `pg_dump | pg_restore` でスキーマ移行可能（Supabase も AWS RDS/Aurora も PostgreSQL のため）。

---

## 5. スキーマ定義

### 5.1 顧客系 Supabase / RDS（PII を保持）

#### `customer_diagnostic_link`

顧客 ID と診断 ID を結ぶ唯一のテーブル。診断系には漏らさない。

```sql
create table customer_diagnostic_link (
  link_id        uuid primary key default gen_random_uuid(),
  customer_id    uuid not null references customers(customer_id),
  diagnostic_id  uuid not null unique,                  -- 診断系の diagnostic_id と同値
  created_at     timestamptz not null default now(),
  status         text not null default 'in_progress',   -- 'in_progress' | 'completed' | 'archived'
  kit_serial     text,                                   -- 検査キット個体番号
  notified_at    timestamptz,                            -- 診断完了通知送信日時
  viewed_at      timestamptz                             -- ユーザー閲覧日時
);

create index ix_cdl_customer  on customer_diagnostic_link(customer_id);
create index ix_cdl_diagnostic on customer_diagnostic_link(diagnostic_id);
create index ix_cdl_status     on customer_diagnostic_link(status);
```

### 5.2 診断系 Supabase / Aurora（PII を持たない）

#### `diagnostics`

1 セッションを表すルート行。

```sql
create table diagnostics (
  diagnostic_id  uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  status         text not null default 'in_progress',  -- 'in_progress' | 'analyzed' | 'completed' | 'archived'
  app_version    text                                   -- Scan-Chat-AI コミット SHA
);

create index ix_d_status on diagnostics(status);
create index ix_d_created_at on diagnostics(created_at desc);
```

#### `scan_artifacts`

スキャン関連の成果物（MD / 画像 / 問診 MD）。

```sql
create table scan_artifacts (
  artifact_id     uuid primary key default gen_random_uuid(),
  diagnostic_id   uuid not null references diagnostics(diagnostic_id) on delete cascade,
  type            text not null check (type in ('scan_md','scan_image','interrogation_md')),
  content         text,                                  -- md の場合
  storage_path    text,                                  -- バイナリの場合 (Supabase Storage / S3 のキー)
  storage_bucket  text,                                  -- バケット名
  bytes           int,
  mime_type       text,
  created_at      timestamptz not null default now(),
  meta            jsonb default '{}'::jsonb              -- bbox / model 等の補助情報
);

create index ix_sa_diagnostic on scan_artifacts(diagnostic_id);
create index ix_sa_type       on scan_artifacts(type);
create index ix_sa_meta_gin   on scan_artifacts using gin (meta);
```

#### `diagnostic_results`

下流 AI の診断結果。**JSONB ハイブリッド設計**で将来のスキーマ進化に対応。

```sql
create table diagnostic_results (
  id              uuid primary key default gen_random_uuid(),
  diagnostic_id   uuid not null references diagnostics(diagnostic_id) on delete cascade,
  created_at      timestamptz not null default now(),

  -- AI トレーサビリティ（不変・必須）
  ai_provider     text not null,                         -- 'gemma' | 'qwen' | 'anthropic' | ...
  ai_model        text not null,                         -- 'gemma-4-medical-7b'
  ai_version      text,                                  -- '2026-05-15' or model hash
  schema_version  int  not null,                         -- AI 出力スキーマのバージョン

  -- 進化する本体
  result          jsonb not null,                        -- 診断結果本体（自由構造）
  result_md       text,                                  -- ユーザー閲覧用 Markdown（任意）

  -- よく使う指標の denormalized（任意）
  severity        text,                                  -- 'normal' | 'watch' | 'urgent'
  abnormal_count  int,
  flagged_items   text[],

  -- 監査・再現性
  prompt_used     text,
  raw_response    text,
  tokens_in       int,
  tokens_out      int,
  cost_usd        numeric(10,6),
  latency_ms      int
);

create index ix_dr_diagnostic on diagnostic_results(diagnostic_id);
create index ix_dr_created_at on diagnostic_results(created_at desc);
create index ix_dr_severity   on diagnostic_results(severity) where severity is not null;
create index ix_dr_ai_model   on diagnostic_results(ai_model, ai_version);
create index ix_dr_result_gin on diagnostic_results using gin (result);
```

**進化吸収のパターン:**

| 変化 | 対応 |
|---|---|
| AI が新しいフィールドを返すように | `result` JSONB に追加。テーブル定義変更なし。`schema_version` を上げる |
| ある指標が定着して頻繁にクエリされる | `alter table ... add column` で昇格、JSONB との二重保持で互換維持 |
| 別の AI モデルで A/B テスト | 同 `diagnostic_id` に対し別行 INSERT。`ai_model` / `ai_version` で識別 |
| 過去診断を embedding で類似検索 | 後付けで `embedding vector(768)` + `pgvector` を追加 |

### 5.3 Supabase Storage（バイナリ）

バケット構成:

```
diagnostic-artifacts/                     # private bucket, RLS で diagnostic_id 一致時のみ参照可
  {diagnostic_id}/
    scan-{ts}.jpg
    interrogation-audio-{ts}.webm        # Live API の録音（任意）
```

`scan_artifacts.storage_path` にこの key を入れる。

---

## 6. セキュリティ / アクセス制御

### 6.1 PII 越境禁止の原則

```
顧客系 ─→ 診断系: diagnostic_id のみ通過させる（氏名・メール等は絶対に流さない）
診断系 ─→ 顧客系: diagnostic_id と status / result_md のみ返す
```

これにより診断系 DB の万が一の漏洩でも個人特定が困難になる（HIPAA-style pseudonymization）。

### 6.2 セッション認証

Scan-Chat-AI クライアントは `diagnostic_id` だけで動作する。マイページ経由のセッション検証は HMAC トークン方式:

```
[マイページ]
  diagnostic_id = uuid4()
  scan_session_token = HMAC_SHA256(diagnostic_id + expires_at, secret)
  → リダイレクト URL: https://scan-chat-ai.../scan?diagnostic_id={id}&token={t}&exp={exp}

[Scan-Chat-AI]
  URL から diagnostic_id / token / exp を取得
  サーバ側で HMAC 再計算し一致確認
  exp を過ぎていれば拒否
  ※ token に customer_id は含めない
```

### 6.3 RLS（Row Level Security）

#### 顧客系
```sql
-- customer_diagnostic_link: 本人 customer_id のみ参照可
create policy "customers see own links" on customer_diagnostic_link
  for select using (customer_id = auth.uid());
```

#### 診断系
```sql
-- diagnostics / scan_artifacts / diagnostic_results: 一般ユーザーは参照不可
-- マイページからの参照は API 経由（diagnostic_id allowlist 検証あり）
```

---

## 7. データフロー詳細

### 7.1 スキャン → 保存

```
[Scan-Chat-AI (Vercel iad1)]
  capture → Files API upload → Gemini Flash → Markdown stream
                                                       │
                                                       ▼
  [Phase 0] ローカル ZIP ダウンロード（manifest.json + scan-*.md + scan-*.jpg）
  [Phase 1] Supabase Storage に画像 PUT、Postgres に scan_artifacts INSERT
  [Phase 2] AWS S3 に PUT、Aurora に INSERT
```

### 7.2 診断 AI トリガ

```
[scan_artifacts] INSERT
        │ (Postgres trigger or Supabase Realtime)
        ▼
[診断 AI ワーカー（別ホスト）]
  diagnostic_id をキーに最新の scan_artifacts と interrogation_md を読み込み
  AI 診断生成
  diagnostic_results に INSERT
        │
        ▼
[Edge Function / Webhook]
  顧客系 customer_diagnostic_link.status = 'completed' に更新
  notified_at は通知配信後に更新
        │
        ▼
[マイページ]
  push / メール通知
  ユーザーが結果を閲覧 → viewed_at 更新
```

### 7.3 マイページからの閲覧

```
[ユーザー: マイページ]
  ログイン (customer_id)
  自分の link 行を SELECT → diagnostic_id 一覧
  各 diagnostic_id について diagnostic_results を SELECT (API 経由)
  scan_md, scan_image, interrogation_md も同様に取得
  → ダッシュボードに統合表示
```

---

## 8. 移行プレイブック

### 8.1 Phase 0 → Phase 1 (Supabase 二分割)

1. 顧客系 Supabase に `customer_diagnostic_link` テーブル追加（マイグレーション）
2. 診断系 Supabase プロジェクト新規作成
3. 診断系に `diagnostics` / `scan_artifacts` / `diagnostic_results` テーブル作成
4. 診断系に Storage バケット `diagnostic-artifacts` 作成
5. Scan-Chat-AI 側にクライアント追加（`@supabase/supabase-js` 既存）
6. `/api/scan` 完了時に Supabase に書き込み
7. ユーザーは引き続き ZIP ダウンロードも可能（バックアップ）
8. ローカル保存はオプション機能として残す

### 8.2 Phase 1 → Phase 2 (AWS 移行)

1. AWS Aurora PostgreSQL Serverless v2 をプロビジョン（診断系）
2. AWS RDS PostgreSQL をプロビジョン（顧客系）
3. `pg_dump` で Supabase の各 DB をダンプ
4. `pg_restore` で AWS にリストア
5. Supabase Storage の object を S3 に同期（`gsutil` 経由でも `s3 sync` でも可）
6. アプリの DB 接続文字列を切替
7. RLS / IAM を AWS に合わせて再構成
8. Supabase 側は読み取り専用にして並行運用 → 安定確認後にクローズ

### 8.3 GCS バックアップ

両フェーズで並行:

```
日次 cron:
  pg_dump --format=custom <db_url> | gsutil cp - gs://medical-backup/{date}/{db}.dump
  gsutil rsync s3://artifacts gs://medical-backup/{date}/artifacts/
```

GCS 側は Coldline で保管、30 日以降は Archive クラスへライフサイクル遷移。

---

## 9. 未確定事項 / 今後の議論

| # | 項目 | 検討要否 |
|---|---|---|
| 1 | 同一 `diagnostic_id` に複数検査表をまとめる UX（複数撮影） | UI 設計時 |
| 2 | 問診中断・再開 時のセッション継続戦略 | Live API 実装時 |
| 3 | 診断 AI の冪等性（同じ scan_md に対して何度呼んでも同じ結果か） | 診断 AI 仕様確定後 |
| 4 | `result` JSONB の言語切替（日本語/英語両出力） | 国際化検討時 |
| 5 | 監査ログ / アクセスログのスキーマ | HIPAA 監査要件確定時 |
| 6 | 画像のサムネイル生成（一覧表示用） | UI 拡張時 |
| 7 | `diagnostic_id` 発番をマイページ側に移譲する切替時期 | マイページ実装後 |

---

## 10. 参考: 現在のコード位置

| ファイル | 役割 |
|---|---|
| `src/pages/api/scan.ts` | スキャン → Markdown 生成 |
| `src/pages/api/live-token.ts` | Live API 問診の ephemeral token 発行 |
| `src/pages/api/diag.ts` | Gemini Tier 状態の診断ツール |
| `src/scripts/camera-scan.ts` | 撮影 + Markdown ストリーム受信 |
| `src/scripts/chat/live-controller.ts` | 問診 (Live API) UI 連携 |
| `src/pages/scan.astro` | スキャン UI |
| `src/pages/chat.astro` | 問診 UI |

Phase 1 着手時の追加予定:
| ファイル | 役割 |
|---|---|
| `src/lib/diagnosis-storage.ts` | 診断系 Supabase クライアント |
| `src/lib/diagnostic-id.ts` | UUID 生成・localStorage 永続化 |
| `supabase/diagnosis/migrations/*.sql` | 診断系スキーマ |
| `supabase/customer/migrations/*.sql` | 顧客系スキーマ（追加分のみ）|
