# 【返答 v0.4】HP/EC「IF仕様とマッピング」への回答（Web アプリチーム）

- 作成: Web アプリ（Scan-Chat / マイページ）チーム
- 宛先: HP/EC（wellfort-site）チーム
- 日付: 2026-06-21
- 対象: `wellfort-site/docs/web連携_IF仕様とマッピング_draft.md`
- 関連: `docs/hp_ec/HP回答への返答_v0.3.md`, `docs/architecture/bridge_table_design_draft.md`(v0.3),
  `supabase/migrations/20260621000010_announcements_news_sync.sql`（本回答で追加）

---

## 0. 総評

提示いただいた `resolve-customer` / `kit-self-report` の I/F、`migration-add-diagnostic-user-id.sql`、
`news→announcements` マッピングは **いずれも当方の v0.3 と整合**しており、基本合意です。
HP からの3依頼に回答し、`announcements` 側マイグレを当方で作成しました。

---

## 1. Edge Function I/F へのフィードバック

### 1-1. `resolve-customer`（本人解決） … ◯ 合意
- POST/GET 両対応・`x-resolve-secret` 認証・出力 `{ diagnostic_user_id, display_name }`・未連携=`data:null`・姓のみ整形：**そのまま合意**。
- Web 側運用: **#2 のサーバーサイド（SSR / API ルート）からのみ呼ぶ**。`google_sub→diagnostic_user_id` を初回解決後 #2 `app_users` に永続化し、2回目以降は #1 を叩かない。
- 追加要望（任意）: レート制限と、`email` 正規化（trim+lowercase）は HP 側実装に含める旨を明記いただけると安心。

### 1-2. `kit-self-report`（自己申告） … ◯ 合意
- 入力 `order_id`(=`kit_shipment.id`=`orders.id`) / `diagnostic_user_id` / `event('received'|'returned')` / `occurred_at?`、所有者照合で 403：**合意**。
- Web 側は現行の「📦受け取りました／💉返送しました」操作をこの POST に置換。**楽観的 UI 更新 → ブリッジ反映までのラグ**（次回同期まで）を許容する設計にします。

### 1-3. 共有シークレット（依頼1への回答）
- **本番 `RESOLVE_SHARED_SECRET` は、リポジトリに置かず secrets 管理で受け渡し**を提案：
  - HP が生成 → **1Password/Vault 等のセキュアチャネル**で共有 → 双方が各デプロイ環境のシークレットに登録
    （HP: Supabase Functions secrets / Web: #2 サーバー環境変数。**クライアントには絶対に出さない**）。
  - **ローテーション可能**にするため、当面は単一値、将来 `kid` 付き複数許容も検討。
  - dev は env 未設定で検証スキップ（提示どおりでOK）。

---

## 2. `announcements` 実スキーマの共有（依頼2への回答）

現行 `diagnosis.announcements`（`supabase/migrations/20260620000010_notices.sql`）:

| カラム | 型 | 備考 |
|---|---|---|
| id | uuid PK | #2 側 PK |
| category | text check(`general`/`news`) | HP 同期分は `news` 固定 |
| title | text not null | |
| **body** | text not null | ※`content` ではなく **`body`** |
| link_url | text | |
| published_at | timestamptz not null | 公開日時（開始） |
| created_at | timestamptz not null | |

**マッピングに不足していた項目を当方マイグレで追加**（`20260621000010_announcements_news_sync.sql`）:

| 追加カラム | 型 | 用途 |
|---|---|---|
| source_news_id | uuid (部分一意) | **HP `news.id` との突合キー**（冪等 upsert 用）。news 1件＝announcements 1件 |
| image_url | text | news.image_url |
| link_text | text | news.link_text（既定 '詳細はこちら' は Web 表示側で補完可） |
| visible_on_hp | boolean default false | 掲載面フラグ |
| visible_on_web | boolean default true | 掲載面フラグ |
| published_until | timestamptz null | **公開終了**（news に終了日があれば供給を。無ければ NULL=無期限） |
| updated_at | timestamptz（自動更新トリガ） | 監査・差分同期 |

→ HP マッピング表は次の点だけ読み替えてください：
- `content` → **`body`**
- 突合キーは `source_news_id`（**追加済み**。HP は同期時に `news.id` を入れてください）
- 公開期間は `published_at`（開始）＋ `published_until`（終了・任意）

### 確認したい点（HP→Web）
- HP `news` に **公開終了日**の概念はありますか？（あれば `published_until` に供給）
- `link_text` のデフォルト文言は Web 表示側で補完してよいですか？（news 側が NULL の場合）

## 3. `visible_on_hp`/`visible_on_web` マイグレ実施担当（依頼3への回答）

- **◯ Web 側（#2）で実施**。本回答に同梱の `20260621000010_announcements_news_sync.sql` で**追加済み**。
- 既定値の考え方（本テーブルは #2 所有のため）:
  - `visible_on_web` 既定 **true**（Web ネイティブの一般お知らせは既定で Web 表示）
  - `visible_on_hp` 既定 **false**
  - **HP `news` からの同期行は、同期処理側で両フラグを明示設定**してください（例: visible_on_hp=true、visible_on_web は編集判断）。

---

## 4. 残課題・次アクション

### 双方で確定したいもの
1. `news.published_until`（公開終了）の有無 → `published_until` 供給可否。
2. `news→announcements` 同期の**実体**（HP 更新時 push / #2 pull バッチ）と経路。push 先が必要なら **#2 側に取込 Edge Function** を用意します（要望あれば作成）。
3. 本番 `RESOLVE_SHARED_SECRET` の受け渡しチャネル決定（1Password/Vault 等）。

### Web 側 着手タスク（合意済み範囲）
- [x] `announcements` 拡張マイグレ（source_news_id / visible フラグ / image_url / link_text / published_until / updated_at）
- [ ] #2 の 2接続化（#1 `app_bridge` read-only クライアント）
- [ ] `loadDashboard` をブリッジ参照へ改修（kit=orders由来 / 検査完了=#2）
- [ ] One Tap を email 解決へ（`resolve-customer` 呼び出し、`DEMO_EMAIL_TO_UID` 撤去、#2 `app_users` へ google_sub 永続化）
- [ ] 自己申告 UI を `kit-self-report` POST へ置換
- [ ] （要望次第）`news→announcements` 取込 Edge Function（#2 側）

上記で齟齬なければ、Web 側はマイグレ反映に続き 2接続化・解決処理から実装着手します。
