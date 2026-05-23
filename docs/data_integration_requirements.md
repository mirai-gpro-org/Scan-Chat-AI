# データ連携 要件定義書（HP ↔ アプリ）

| 項目 | 内容 |
|---|---|
| 文書名 | Scan-Chat Medical AI — データ連携要件定義書 |
| バージョン | 0.2 (Draft) |
| 作成日 | 2026-05-22 |
| 対象 | Scan-Chat-AI Supabase ↔ Wellfort HP Supabase ↔ 外部診断 AI (Elith) ↔ 将来の結果閲覧アプリ の連携 |
| 関連文書 | `docs/device_and_auth_requirements.md`, `docs/scan_feature_requirements.md` |
| 参考実装 | `mirai-gpro/wellfort-site` の `customer_profiles` テーブル / Supabase Auth 連携 |

---

## 1. 概要

### 1.1 目的

Scan-Chat-AI の診断データを **HP 側（Wellfort EC）の顧客マスタとは別の Supabase で管理**しつつ、両者を **アプリ専用の一意 ID（`diagnosis_user_id`）でリンク**する。ユーザーは Google アカウントのみを意識し、内部 ID は意識しない。

### 1.2 アーキテクチャ概念図（全体像）

```
┌─────────────────────────────────────────────────────────┐
│  Browser (iPhone / iPad / PC)                           │
│  - Google One Tap でログイン                            │
└─────────────────────────────────────────────────────────┘
            │ Google ID Token                  │
            ▼                                  │
┌──────────────────────────────────┐           │
│  App Supabase (Scan-Chat-AI)     │◀──────────┘
│  - auth.users (Supabase Auth)    │
│  - app_users (diagnosis_user_id) │
│  - sessions / messages           │
│  - scan_results                  │
│  - diagnosis_inputs              │   外部 AI 送信ペイロード保管（監査用）
│  - diagnosis_results             │   ← 診断 AI 戻り、結果保管の一次ソース
│                                  │
│  Edge Functions (App 側に集約):  │
│   ・verify-eligibility           │──┐
│   ・get-customer-profile         │──┤
│   ・submit-to-diagnosis-ai       │──┼─▶ 外部診断 AI へ送信
│   ・diagnosis-ai-callback        │◀─┤    （非同期 webhook 受け）
│   ・sync-customer-profile        │──┘
└──────────────────────────────────┘
        │                        ▲
        │ service_role HTTP      │ (将来) 別アプリから
        │ (App→HP)               │ diagnosis_user_id をキーに read
        ▼                        │
┌──────────────────────────────────────────────────────┐
│  HP Supabase (Wellfort EC, mirai-gpro/wellfort-site) │
│  - auth.users                                        │
│  - customer_profiles                                 │
│     ├─ user_id (FK auth.users)                       │
│     ├─ 氏名 / カナ / 性別 / 生年月日 / 住所 等       │
│     └─ diagnosis_user_id (NEW: 追加カラム)           │
│  - orders (対象検査商品の購入履歴)                   │
└──────────────────────────────────────────────────────┘
                ▲
                │ HP マイページ拡張
                │
┌──────────────────────────────────────────────────────┐
│ [将来] 診断結果閲覧アプリ (Scan-Chat とは別アプリ)   │
│  - HP マイページの拡張機能的位置づけ                 │
│  - App Supabase の diagnosis_results を表示          │
│  - 詳細仕様は Scan-Chat 完了後に別途要件定義         │
│  - 本書では「将来の読者」として制約条件のみ規定      │
└──────────────────────────────────────────────────────┘
              ▲
              │ 入力ペイロード（PII を含まず、
              │ diagnosis_user_id のみで識別）
              │
┌──────────────────────────────────────────────────────┐
│ 外部診断 AI                                          │
│ 株式会社 Elith（東大松尾研母体ベンチャー）           │
│ 現状: Elith 側 AWS で稼働                            │
│ 将来: クライアント側 AWS アカウントへ移植予定        │
│ 戻り: diagnosis_user_id + 結果 JSON                  │
└──────────────────────────────────────────────────────┘
```

### 1.3 基本原則

1. **データ・オーナーシップ分離** — 顧客マスタ（氏名・住所・連絡先）は HP が一次ソース。診断データ（スキャン・問診・結果）は App が一次ソース。
2. **連携キーは `diagnosis_user_id`** — App 側で発行する UUID。HP 側 `customer_profiles` に同名カラムを追加し、双方からこの ID で参照する。
3. **ユーザーには非開示** — `diagnosis_user_id` はシステム内部および外部 AI 診断 API 連携のキーであり、ユーザーには見せない。
4. **入場ゲート** — 原則として **Wellfort EC で対象検査商品を購入済**でないとアプリ利用不可。未購入者は HP/EC の新規登録・購入ページへ誘導する。
5. **Edge Function は App 側に集約** — Wellfort HP 側の Supabase は service_role key で App-side Edge Function から参照・更新する。
6. **診断結果は App-side Supabase が一次ソース** — 外部診断 AI（Elith）からの戻りは App-side `diagnosis_results` に保存し、将来の閲覧アプリは同テーブルを参照する。Elith 側 AWS / クライアント AWS は計算リソースであり、結果データの永続ストアではない。
7. **外部 AI への送信ペイロードに PII を含めない** — 識別子は `diagnosis_user_id` のみ。氏名・住所・連絡先は送らない。

---

## 2. データ・オーナーシップ

| データ種別 | 保有元 | 同期方向 | 備考 |
|---|---|---|---|
| 認証（Google ID Token / セッション） | **App Supabase Auth** | — | Wellfort と独立した Auth インスタンス |
| 顧客マスタ（氏名・カナ・性別・生年月日・住所・電話・メール） | **HP Supabase**: `customer_profiles` | HP → App (read) | Wellfort EC が一次ソース。App は表示用に取得 |
| EC 購入履歴（対象検査商品の購入有無） | **HP Supabase**: `orders` | HP → App (read) | 入場ゲートの判定に利用 |
| 連携キー `diagnosis_user_id` | **App Supabase**: `app_users` | App → HP (write once) | App で発行、HP の `customer_profiles.diagnosis_user_id` に同期 |
| スキャン結果 | **App Supabase**: `scan_results` | App のみ | 画像は基本永続化しない |
| 問診チャット履歴 | **App Supabase**: `messages` | App のみ | |
| 外部 AI 送信ペイロード（監査用） | **App Supabase**: `diagnosis_inputs` | App → Elith AI（送信時のみ） | 送信した内容を再現可能な形で保管。PII は含まない |
| 診断結果（外部 AI 解析の戻り） | **App Supabase**: `diagnosis_results` | Elith AI → App (callback) → 将来の閲覧アプリ (read) | App-side が一次ソース。Elith 側 AWS には永続化されない想定 |

---

## 3. ID 設計

### 3.1 `diagnosis_user_id`

| 項目 | 仕様 |
|---|---|
| 型 | `uuid` (RFC 4122 v4) |
| 発行者 | **App 側 Supabase**（Edge Function `verify-eligibility` 内で `gen_random_uuid()`） |
| 不変性 | 一度発行したら変更しない |
| ユニーク性 | App 全体で一意（pk）+ HP `customer_profiles.diagnosis_user_id` でも unique |
| 露出範囲 | システム内部 / Edge Function 経由 / 外部 AI 診断 API 連携時のキー |
| ユーザー可視性 | 非表示（ユーザーは Google アカウントだけを意識） |
| 用途 | App-side 全テーブルの owner key、外部 AI 診断 API への送信ペイロード識別子 |

### 3.2 紐付くキー一覧

| キー | 所在 | 役割 |
|---|---|---|
| `google_sub` | Google ID Token の `sub` クレーム | Google アカウントの不変識別子。初回紐付け時の照合に使う |
| `auth.users.id` (App) | App Supabase Auth | App 側の認証セッションキー |
| `auth.users.id` (HP) | HP Supabase Auth | HP 側の認証セッションキー（App とは別インスタンス） |
| `customer_profiles.user_id` | HP Supabase | HP の `auth.users.id` への FK |
| `diagnosis_user_id` | App `app_users` / HP `customer_profiles` | **両 DB を結ぶマスターキー** |

---

## 4. 入場フロー

### 4.1 シーケンス

```
[Browser]                                           [App Supabase]                  [HP Supabase]
  │                                                       │                              │
  ├─ Google One Tap で credential 取得 ──────────────────▶│                              │
  │     supabase.auth.signInWithIdToken                   │                              │
  │◀────────── auth.users 行 (id, email, google_sub) ─────┤                              │
  │                                                       │                              │
  ├─ Edge Function: verify-eligibility ──────────────────▶│                              │
  │     ヘッダに App-side JWT、ボディに google_sub         │                              │
  │                                                       ├─ HP 側で google_sub に一致 ─▶│
  │                                                       │   する customer_profiles を   │
  │                                                       │   取得                        │
  │                                                       │◀─ customer_profile 行 ───────┤
  │                                                       │                              │
  │                                                       ├─ orders で対象検査商品の ───▶│
  │                                                       │   paid 確認                   │
  │                                                       │◀─ 対象注文 ──────────────────┤
  │                                                       │                              │
  │                                                       ├─ diagnosis_user_id を発行 or │
  │                                                       │   既存を取得                  │
  │                                                       │                              │
  │                                                       ├─ HP の customer_profiles に  │
  │                                                       │   diagnosis_user_id を書込 ──▶│
  │                                                       │                              │
  │                                                       ├─ App の app_users に挿入     │
  │                                                       │                              │
  │◀──── { eligible: true, diagnosis_user_id } ───────────┤                              │
  │                                                       │                              │
  ├─ /scan or /chat へ遷移                                │                              │
```

### 4.2 不適格時の振る舞い

| 不適格理由 | App 側挙動 |
|---|---|
| HP 側に `customer_profiles` が存在しない（Wellfort 未会員） | 「Wellfort 会員登録が必要です」モーダル → HP の新規登録ページへリダイレクト |
| `customer_profiles` はあるが対象検査商品の購入なし | 「対象検査商品のご購入が必要です」モーダル → HP の対象商品ページへリダイレクト |
| `orders` はあるが `payment_status != 'paid'` | 「お支払い確認中です」表示 → HP のマイページ orders 一覧へリダイレクト |

### 4.3 既存ユーザーの再ログイン

- `app_users` に該当 `auth_user_id`（または `google_sub`）が既にある場合、`verify-eligibility` は HP 側照会をスキップして即座に通過させる
- 定期的（例: 30 日毎）に HP 側との整合性チェックを行う（`sync-customer-profile`）

---

## 5. データモデル

### 5.1 App 側 Supabase（Scan-Chat-AI）

#### `auth.users`（Supabase 標準、変更なし）
Google One Tap でログインしたユーザーの認証行。Wellfort 側 `auth.users` とは**別インスタンス**。

#### `app_users`（新規・このアプリの診断アカウント実体）
| カラム | 型 | 備考 |
|---|---|---|
| `diagnosis_user_id` | uuid (pk) | アプリ全体の owner key |
| `auth_user_id` | uuid (fk → auth.users) unique | App-side Supabase Auth の user_id |
| `google_sub` | text unique | Google ID Token の sub クレーム |
| `hp_customer_user_id` | uuid nullable | HP 側 `customer_profiles.user_id` のミラー（参考用、HP 側変更時に再同期可能） |
| `display_name_cache` | text nullable | HP から取得した display_name のキャッシュ（任意） |
| `eligibility_checked_at` | timestamptz | 直近の入場資格チェック時刻 |
| `created_at` / `updated_at` | timestamptz | |

#### `sessions`, `messages`, `scan_results`, `diagnosis_results`
すべて `diagnosis_user_id` を FK として持つ（`auth.users.id` ではなく `app_users.diagnosis_user_id` を参照）。

| テーブル | owner key |
|---|---|
| `sessions` | `diagnosis_user_id` |
| `messages` | `session_id` (→ sessions) |
| `scan_results` | `diagnosis_user_id` |
| `diagnosis_results` | `diagnosis_user_id` |

### 5.2 HP 側 Supabase（wellfort-site）— 追加変更点のみ

#### `customer_profiles`（既存テーブル、カラム追加）
| 追加カラム | 型 | 備考 |
|---|---|---|
| `diagnosis_user_id` | uuid unique nullable | App 側で発行された ID をミラー保持 |
| `diagnosis_linked_at` | timestamptz nullable | 初回連携時刻 |

#### マイグレーション例

```sql
ALTER TABLE customer_profiles
  ADD COLUMN diagnosis_user_id uuid UNIQUE,
  ADD COLUMN diagnosis_linked_at timestamptz;

CREATE INDEX idx_customer_profiles_diagnosis_user_id
  ON customer_profiles(diagnosis_user_id);
```

### 5.3 RLS ポリシー

#### App 側
| テーブル | ポリシー |
|---|---|
| `app_users` | `auth.uid() = auth_user_id` の行のみ select / update（insert は Edge Function のみ） |
| `sessions` 等 | `diagnosis_user_id IN (SELECT diagnosis_user_id FROM app_users WHERE auth_user_id = auth.uid())` |

#### HP 側
| テーブル | ポリシー |
|---|---|
| `customer_profiles.diagnosis_user_id` 書き込み | App-side Edge Function（service_role）のみ。一般ユーザーからの直接書込は不許可 |

---

## 6. Edge Function 仕様（App 側に集約）

すべて App-side Supabase の `supabase/functions/` 配下にデプロイ。HP Supabase へは環境変数で渡された service_role key で接続する。

### EF-1: `verify-eligibility`

| 項目 | 内容 |
|---|---|
| パス | `POST /functions/v1/verify-eligibility` |
| 認証 | App-side Supabase JWT 必須（`Authorization: Bearer <token>`） |
| 入力 | `{ google_sub: string }` |
| 処理 | 1. JWT から auth_user_id 抽出<br>2. HP `customer_profiles` を google_sub で照会<br>3. HP `orders` で対象検査商品の paid を確認<br>4. 既存 `diagnosis_user_id` があれば再利用、なければ新規発行<br>5. HP `customer_profiles.diagnosis_user_id` を更新<br>6. App `app_users` に upsert |
| 出力（適格） | `{ eligible: true, diagnosis_user_id: "..." }` |
| 出力（不適格） | `{ eligible: false, reason: 'no_customer' \| 'no_purchase' \| 'payment_pending', redirect_url: "..." }` |
| エラー | 401（JWT 無効）/ 500（HP 接続失敗） |

### EF-2: `get-customer-profile`

| 項目 | 内容 |
|---|---|
| パス | `POST /functions/v1/get-customer-profile` |
| 認証 | App-side JWT |
| 入力 | なし（JWT から diagnosis_user_id を解決） |
| 処理 | HP `customer_profiles` を `diagnosis_user_id` で取得し、UI 表示用フィールドのみ返却 |
| 出力 | `{ display_name, full_name, kana, date_of_birth, ...（必要最小限） }` |
| キャッシュ | App-side で TTL 5 分のメモリキャッシュ推奨 |

### EF-3: `sync-customer-profile`（将来）

| 項目 | 内容 |
|---|---|
| 用途 | HP 側で顧客情報（住所等）が更新された際に、App-side のキャッシュ無効化 + 必要なら再取得 |
| 起動 | 30 日毎の cron / もしくは HP 側 Database Webhook で能動 push |

### EF-4: `revoke-eligibility`（将来）

| 項目 | 内容 |
|---|---|
| 用途 | HP 側で会員資格喪失 / 返金等が発生した場合に App-side セッションを無効化 |

### EF-5: `submit-to-diagnosis-ai`

| 項目 | 内容 |
|---|---|
| パス | `POST /functions/v1/submit-to-diagnosis-ai` |
| 認証 | App-side JWT |
| 入力 | `{ session_id }`（JWT から diagnosis_user_id を解決） |
| 処理 | 1. `sessions` / `messages` / `scan_results` を集約してペイロード生成<br>2. `diagnosis_inputs` に監査用に保存<br>3. Elith AI のエンドポイントへ HTTPS POST（識別子は `diagnosis_user_id` のみ、PII 非送付）<br>4. 同期戻りなら結果を `diagnosis_results` に保存、非同期なら job_id を返却し EF-6 で受け取り |
| 出力 | `{ status: 'completed' \| 'pending', diagnosis_id?, job_id? }` |

### EF-6: `diagnosis-ai-callback`

| 項目 | 内容 |
|---|---|
| パス | `POST /functions/v1/diagnosis-ai-callback` |
| 認証 | Elith AI 側との共有秘密（HMAC 署名）+ IP 制限（クライアント AWS 移植後） |
| 入力 | `{ diagnosis_user_id, job_id, result: {...} }` |
| 処理 | 1. 署名検証<br>2. `diagnosis_results` に upsert<br>3. （将来）ユーザー通知をトリガ |
| 出力 | `204 No Content` |

---

## 7. 環境変数（App 側 Edge Function 用）

```
# App-side Supabase
APP_SUPABASE_URL=
APP_SUPABASE_SERVICE_ROLE_KEY=

# HP-side Supabase（service_role でアクセス）
HP_SUPABASE_URL=
HP_SUPABASE_SERVICE_ROLE_KEY=

# 対象検査商品 SKU の許可リスト（カンマ区切り）
ELIGIBLE_PRODUCT_SKUS=

# 不適格時のリダイレクト先
HP_SIGNUP_URL=
HP_PRODUCT_PAGE_URL=
HP_MYPAGE_ORDERS_URL=

# 外部診断 AI (Elith) 連携
DIAGNOSIS_AI_ENDPOINT=          # 現状: Elith AWS / 移植後: クライアント AWS の URL に切替
DIAGNOSIS_AI_API_KEY=
DIAGNOSIS_AI_CALLBACK_HMAC_SECRET=  # EF-6 の署名検証用
```

---

## 8. セキュリティ・PHI

| 項目 | 要件 |
|---|---|
| HP Supabase の service_role key | **App-side Edge Function 環境変数にのみ**格納。クライアント・Astro SSR にも公開しない |
| HP 側 PII | App-side Edge Function 経由でのみ取得。生 SQL 接続は禁止 |
| 外部 AI 診断 API への送信ペイロード | `diagnosis_user_id`（uuid）のみを識別子として含み、氏名・住所等の PII は**含めない** |
| 通信 | App↔HP は HTTPS / Supabase Functions の内部経路。HP service_role key は HTTP ヘッダ送出のみ |
| 監査 | `verify-eligibility` / `sync-customer-profile` は呼出ログを `audit_logs` に残す（要 Supabase logging） |
| 退会フロー | App で退会 → `app_users` 論理削除 + HP `customer_profiles.diagnosis_user_id = NULL` を Edge Function 経由で更新 |

---

## 9. 整合性・エッジケース

| ケース | 想定挙動 |
|---|---|
| HP 側で `customer_profile` が削除された | App-side `app_users` を論理削除、再ログイン時に再資格チェック |
| Google アカウントを変更した（sub が変わる） | App-side `app_users.google_sub` を更新（HP 側 customer_profiles 連携経路は `diagnosis_user_id` で維持） |
| 同一 Google アカウントが複数の HP `customer_profiles` に紐付く（理論的） | 想定外。Edge Function で「複数該当の場合はエラー」とし、運用で名寄せ対応 |
| App-side 単独で `diagnosis_user_id` を発行したが HP 側書込失敗 | トランザクション失敗扱い、App-side ロールバック、ユーザーにリトライ案内 |
| HP の対象商品 SKU リストが変更された | 環境変数 `ELIGIBLE_PRODUCT_SKUS` を更新するだけで反映可能な設計 |

---

## 10. 外部診断 AI 連携（Elith）

### 10.1 概要

| 項目 | 内容 |
|---|---|
| 提供元 | 株式会社 Elith（東大松尾研母体ベンチャー） |
| 稼働環境（現状） | Elith 側 AWS アカウント |
| 稼働環境（将来） | クライアント側 AWS アカウント（新規開設予定、移植後切替） |
| 役割 | 計算リソース（解析エンジン）。**結果データの永続ストアではない** |
| 入力 | App-side `submit-to-diagnosis-ai` (EF-5) からの HTTPS POST。識別子は `diagnosis_user_id` のみ |
| 出力 | App-side `diagnosis-ai-callback` (EF-6) への結果 POST。同期戻りも将来検討 |
| 結果の保管場所 | **App-side Supabase `diagnosis_results` が一次ソース** |

### 10.2 ペイロード設計の原則

- **PII 非送付**: 氏名・住所・電話・メール・生年月日（年齢は age 換算で送付可）は含めない
- **識別子**: `diagnosis_user_id` のみ
- **再現性**: App 側に `diagnosis_inputs` テーブルを設けて送信時のペイロードスナップショットを保管（監査・再解析用）

### 10.3 AWS 移植時の切替

- エンドポイント変更は環境変数 `DIAGNOSIS_AI_ENDPOINT` の差し替えのみで完結する設計
- 移植期間中の二重稼働、フェイルオーバー、データ突合の運用ルールは TBD（11 章参照）

---

## 11. 将来の結果閲覧アプリ（HP マイページ拡張）— 制約条件のみ

### 11.1 位置づけ

| 項目 | 内容 |
|---|---|
| 名称 | 未定（仮称: Scan-Chat 結果閲覧アプリ） |
| 開発時期 | **Scan-Chat-AI 本体の要件定義・実装完了後に着手** |
| 詳細仕様 | **本書のスコープ外**。別途要件定義予定 |
| 位置づけ | Wellfort HP マイページの拡張機能的位置づけ。Scan-Chat とは別アプリ |
| 主要機能 | App-side `diagnosis_results` の閲覧（読み取り中心） |

### 11.2 本書（Scan-Chat 要件定義）で守るべき設計制約

将来の閲覧アプリが無理なく接続できるよう、Scan-Chat 側で**今のうちに**確保しておくべき設計事項のみ規定する。

| 制約 | 理由 |
|---|---|
| `diagnosis_results` は `diagnosis_user_id` を owner key として持つ | 閲覧アプリが HP `customer_profiles.diagnosis_user_id` 経由で照会可能にするため |
| `diagnosis_results` は read-only API を将来提供できるスキーマにする | 閲覧アプリは原則 read。書込は Scan-Chat の Edge Function 経由のみ |
| `diagnosis_results` に **PII を非正規化して埋め込まない** | 閲覧アプリ側で HP `customer_profiles` から都度結合する想定 |
| 結果データの versioning（schema_version カラム等）を持つ | Elith AI 出力スキーマの変化に閲覧アプリ側も追従できるよう |
| 結果の表示順制御用に `created_at` / `display_order` を持つ | 時系列表示が確実にできるよう |
| RLS は閲覧アプリ用の新 role を将来追加できる設計にする | 直接 Supabase 接続 / Edge Function 経由のどちらでも対応可能に |

### 11.3 本書で意図的に未確定とする項目

以下は閲覧アプリの要件定義時に確定するため、現段階では決めない。

- 認証経路（Wellfort マイページのセッション継承 / 別途 Google ログイン / Supabase Auth 共有）
- データ取得経路（App-side Supabase 直接 read / App-side Edge Function 経由 / GraphQL 等の仲介）
- 実装基盤（Wellfort 同一リポジトリ拡張 / 別リポジトリ / Astro / Next.js 等）
- 機能範囲（閲覧のみ / 共有 / PDF 出力 / 削除）
- 通知（結果到着時の push / email）

---

## 12. 未確定事項（TBD）

- [ ] App 内で表示する顧客情報の範囲（氏名のみ / 生年月日も / 住所も）
- [ ] HP 側の「対象検査商品」の SKU 一覧（運用ルール）
- [ ] HP 側 `orders.payment_status` の値域確認（`'paid'` 以外の状態）
- [ ] 外部 AI 診断 API への送信時の暗号化方式（JWE / mTLS / 別途）
- [ ] HP 側の顧客情報変更を App-side に通知する方式（cron pull / Database Webhook push）
- [ ] 退会フロー時の医療データ取扱（即削除 / N 年保管 / 匿名化）
- [ ] 家族共有・代理アクセス（ケアギバー）の取扱
- [ ] HP 側 Supabase へのスキーマ追加（`diagnosis_user_id` カラム）は誰がいつ実施するか
- [ ] `get-customer-profile` のキャッシュ TTL とキャッシュ無効化トリガ
- [ ] 監査ログの保管期間と形式
- [ ] Elith AI の API 仕様（同期/非同期、認証方式、レイテンシ、SLA）
- [ ] Elith AI 出力スキーマ（`diagnosis_results` テーブル設計の前提）
- [ ] Elith AI が Elith AWS → クライアント AWS へ移植される時期・切替手順
- [ ] 移植期間中の二重稼働、フェイルオーバー、データ突合の運用ルール
- [ ] 将来の結果閲覧アプリの認証経路・データ取得経路・実装基盤（→ Scan-Chat 完了後に別途要件定義）

---

## 13. 関連実装ファイル（予定）

| ファイル | 役割 |
|---|---|
| `supabase/functions/verify-eligibility/index.ts` | 入場ゲート Edge Function |
| `supabase/functions/get-customer-profile/index.ts` | HP 顧客情報取得 |
| `supabase/functions/sync-customer-profile/index.ts` | 定期同期（将来） |
| `supabase/functions/submit-to-diagnosis-ai/index.ts` | Elith AI への送信 (EF-5) |
| `supabase/functions/diagnosis-ai-callback/index.ts` | Elith AI からの結果受信 (EF-6) |
| `supabase/migrations/00001_app_users.sql` | App-side `app_users` テーブル定義 |
| `supabase/migrations/00002_sessions_diagnosis_key.sql` | sessions 等を `diagnosis_user_id` 参照に統一 |
| `supabase/migrations/00003_diagnosis_inputs_results.sql` | `diagnosis_inputs` / `diagnosis_results` テーブル定義（schema_version 等を含む） |
| `src/lib/eligibility.ts` | Astro 側のラッパ（ログイン直後に EF-1 を呼ぶ） |
| `src/pages/welcome.astro` | 不適格時のリダイレクト先解説ページ |
| HP 側 マイグレーション SQL | `ALTER TABLE customer_profiles ADD diagnosis_user_id ...` |

---

## 14. 変更履歴

| バージョン | 日付 | 内容 |
|---|---|---|
| 0.1 | 2026-05-22 | 初版。App 専用 `diagnosis_user_id` で HP `customer_profiles` とリンクする方針を確定。入場ゲートは Wellfort EC での対象商品購入を必須に。Edge Function は App 側に集約 |
| 0.2 | 2026-05-22 | 外部診断 AI（株式会社 Elith、東大松尾研母体、Elith AWS → クライアント AWS 移植予定）連携を 10 章として追加。診断結果は App-side Supabase `diagnosis_results` を一次ソースとする方針を明文化。将来の結果閲覧アプリ（HP マイページ拡張、Scan-Chat とは別アプリ、Scan-Chat 完了後に別途要件定義）向けの設計制約のみを 11 章として規定 |
