# 【ドラフト v0.3】HP/EC ⇄ Web アプリ ブリッジテーブル設計

- 作成: Web アプリ（Scan-Chat / マイページ）チーム
- 宛先: HP/EC チーム（レビュー・返答依頼）
- ステータス: **ドラフト（叩き台）**。HP/EC チームのコメント返答 → 改訂、のキャッチボール前提。
- 変更履歴:
  - v0.1: 診断系(#2)にブリッジを置く案。
  - v0.2: ブリッジは HP/EC 系(#1) 内に設置へ変更。
  - **v0.3: HP/EC 実スキーマ（`database-schema.md`）に整合。`lab_delivery` 廃止、`kit_shipment` を `orders` 由来に、本人解決を email 突合に。`docs/HP回答への返答_v0.3.md` と対。**
- 関連: `docs/data_integration_requirements.md`（PII分離原則）, `docs/test_data_storage_and_db_design.md`, `docs/HP回答への返答_v0.3.md`

> ⚠️ v0.3 重要修正: HP 側に `diagnostic_user_id` / `google_sub` / `kit_shipments` / `lab_tests` / `lab_companies` / `subscription_plans` は **存在しない**。実体は `customer_profiles`(+要列追加) / `orders` / `subscriptions` / `test_products`。検査結果(lab)系は **HP 非保持＝診断系 #2 が正本**。

---

## 1. 目的と方針（v0.2: ブリッジは HP/EC 系 Supabase 内）

Web アプリが顧客名・プラン・キット進捗・検査到着状況を表示するために、**HP/EC 系 Supabase(#1) 内に専用の「ブリッジ（公開用ビュー相当）テーブル」を新設**し、Web アプリはそのブリッジだけを **読み取り専用**で参照する。

```
[HP/EC Supabase #1 = 正本・PIIあり]               [診断系 Supabase #2 = Web 所有]
 customer_profiles / subscriptions /               diagnosis スキーマ
 kit_shipments / lab_tests  (生データ・内部)         app_users / test_artifacts /
        │  HP/EC 内部バッチ（同一プロジェクト内変換）    diagnosis_results /
        ▼                                            user_notices / announcements
 app_bridge スキーマ (本書の対象・最小項目)
   customer_account / subscription /     ◀── Web アプリが「読み取り専用」で参照
   kit_shipment (orders由来)                 （restricted ロール / 専用キー）
   ※lab_delivery は廃止(検査結果は#2が正本)  ──▶ diagnostic_user_id で #2 のデータと突合
```

原則:
1. **ブリッジは HP/EC 系(#1) 内に置き、正本(顧客・EC・プラン)から HP/EC の内部バッチで生成**する。プロジェクト跨ぎの書き込み同期は発生しない（#1 内変換のみ）。
2. **Web アプリは #1 の `app_bridge` スキーマのみ参照**。生の PII テーブル（住所・電話・生年月日等）には**アクセスさせない**（RLS / 専用ロールで制限）。
3. **PII は最小限**。ブリッジには表示に必要な項目のみ（氏名表示用 display_name 等）。
4. **共有キーは `diagnostic_user_id`**。HP/EC 側が顧客に発番済みの値（`customer_profiles.diagnostic_user_id`）をブリッジにも載せ、Web は #2 のデータとこのキーで突合する。
5. 既存のモック `customer` スキーマ（seed ダミー）は廃止し、参照は #1 の `app_bridge` に置換する（Web側TODO）。

> **PII 分離方針の変化（要確認）**: v0.1 の「物理的にプロジェクト分離」から、v0.2 は「**PII プロジェクト内に Web 向け最小公開スキーマを設け、アクセス制御(RLS/ロール)で分離**」する形になる。HP/EC のセキュリティ方針として、PII プロジェクトに Web 参照用の read ロールを設けてよいか合意したい。

---

## 2. Web アプリの接続構成（新規）

- Web アプリは **2 つの Supabase 接続**を持つ:
  - #2 診断系（既存）: `PUBLIC_SUPABASE_URL` / `SERVICE_ROLE_KEY`
  - #1 ブリッジ（新規・読み取り専用）: 例 `HP_BRIDGE_SUPABASE_URL` / `HP_BRIDGE_READONLY_KEY`
- #1 側キーは **`app_bridge` スキーマの SELECT のみ**許可する restricted ロールに紐付ける（生 PII テーブルは grant しない）。
- 本番ではユーザー JWT + RLS で**本人の行のみ**参照に絞る（dev は緩め）。

---

## 3. 認証・名前解決（暫定の撤去）

現状は `GoogleOneTap.astro` の **ハードコード `DEMO_EMAIL_TO_UID`** で email→`diagnostic_user_id` を固定マップし、名前は seed の `display_name_cache` 依存。

本番仕様（v0.3・email 突合に確定）:
> HP は `google_sub` 未保持・メール認証。Web=Google One Tap / HP=メール の橋渡しは **email** で行う。
1. One Tap → Google から `google_sub` ＋ `email` を取得。
2. **#1 の解決用 Edge Function `resolve-customer`（HP担当）へ email を渡す → `{ diagnostic_user_id, display_name }` を得る**（一致なしは未連携=null）。
   - email 一覧を Web に晒さないため Edge Function 方式を推奨。代替は `customer_account` に email を載せ RLS 本人行 SELECT。
3. Web は `google_sub ↔ diagnostic_user_id` を **#2 `app_users` に永続化**。次回以降は #2 の `google_sub` 解決のみ（#1 アクセス不要）。
4. 未連携ユーザー（email 一致なし）は弾く（適格性なし）。
5. 表示名は #2 `app_users.display_name_cache`（初回解決時に保存）を使用。`app_bridge.customer_account.google_sub` は不要（持たない）。

---

## 4. ブリッジテーブル定義（ドラフト）— 設置先: HP/EC #1 `app_bridge` スキーマ

すべて `diagnostic_user_id` を保持し、Web 側で #2 のデータと突合できるようにする。

### 4-1. `app_bridge.customer_account` — 顧客アカウント要約（1顧客1行）

| カラム | 型 | 由来(HP/EC) | 備考 |
|---|---|---|---|
| diagnostic_user_id | uuid PK | customer_profiles に**列追加**(HP発番) | 共有キー。default gen_random_uuid() |
| hp_customer_id | uuid not null | customer_profiles.user_id | HP側主キー（Auth=auth.users.id） |
| display_name | text | customer_profiles.name（**姓のみ**整形） | 表示名「真鍋」。敬称はアプリ側付与 |
| sex | text null | customer_profiles.gender | PII最小化合意済 |
| birth_year | int null | customer_profiles.birth_date の**年のみ** | 生年月日フルは載せない |
| status | text | customer_profiles に**列追加**(会員状態) | active / withdrawn 等 |
| synced_at | timestamptz | バッチ | 最終生成時刻 |
| source_updated_at | timestamptz null | customer_profiles.updated_at | 差分・整合確認用 |

> `google_sub` は**載せない**（HP 未保持）。本人解決は email 突合（§3）。

### 4-2. `app_bridge.subscription` — プラン・契約要約（由来: `subscriptions` ＋ `test_products`）

| カラム | 型 | 由来 | 備考 |
|---|---|---|---|
| diagnostic_user_id | uuid | | キー |
| plan_code | text | test_products の識別子 | |
| plan_name | text | **test_products.name** | 商品名 |
| status | text | subscriptions.status | active/paused/cancelled/payment_failed/expired |
| started_at | date | subscriptions | |
| next_test_at | date null | subscriptions | 「次回検査予定」表示 |
| last_test_at | date null | subscriptions | |
| synced_at | timestamptz | | |

> `cycle_year/seq` は HP に相当列が無いため**削除**（必要になれば別途定義）。

### 4-3. `app_bridge.kit_shipment` — 検査キット発送・進捗（由来: `orders`）

UI（KitProgressCard）の**発送ステージ**に限定。検査完了ステージは #2(`test_artifacts`) から取得。

| カラム | 型 | 由来(orders) | 備考 |
|---|---|---|---|
| id | uuid PK | orders.id | HP側ID流用（uuid PK・不変） |
| diagnostic_user_id | uuid | customer から解決 | キー |
| order_id | text | orders.id / 注文番号 | |
| test_type | text | 注文商品(test_products)から導出 | |
| shipping_status | text | orders.shipping_status | |
| instruction_sent_at | timestamptz null | orders.instruction_sent_at | 検査案内送付 |
| shipped_at | timestamptz null | orders.shipped_at | |
| tracking_no | text null | orders.tracking_number | |
| delivered_at | timestamptz null | orders.delivered_at | 配達完了（配送業者） |
| user_received_at | timestamptz null | 自己申告（案A Edge Function 経由→#1記録） | |
| user_returned_at | timestamptz null | 自己申告（同上） | |
| carrier / carrier_tracking_url / expected_arrival_date | text/date null | **NULL（HP未保持）** | UI で非表示フォールバック |
| synced_at | timestamptz | | |

> `lab_received_at` / `lab_completed_at` は**削除**（検査側＝#2 `test_artifacts.collected_at/diagnosed_at` 等から取得）。

### 4-4.（廃止）~~`app_bridge.lab_delivery`~~

検査結果の到着・取込状況は **診断系 #2 が正本**（`test_artifacts` / `diagnosis_results`）。HP は検査結果を保持しないため、**ブリッジには置かない**。検査ラボ → #2 取込は別フィーチャとして扱う。

---

## 5. 自己申告（受取/返送）の書込み — 案A 確定

現状 Web には「📦受け取りました／💉返送しました」の自己申告があり `user_received_at/returned_at` を更新している。
**案A 確定**: HP/EC が受取/返送用の Edge Function を #1 に用意（実績あり）、Web はそこへ POST。正本は #1、ブリッジへは内部反映。I/F（入力/出力）を別途すり合わせ。

---

## 6. 同期（HP/EC 内部バッチ）— 回答反映済み

1. **生成方式**: 差分（`updated_at` ベース）＋初回/整合補正に全件再生成。`customer_profiles`/`subscriptions`/`orders` は `updated_at` 保持。
2. **頻度**: 顧客・プラン=**日次**。発送=倉庫CSV取込契機のため**取込イベント駆動 or 15〜30分間隔**。
3. **退会・取消**: `subscriptions.status` で表現。`customer_account.status` 用に `customer_profiles` へ会員状態列を追加（HP）。
4. **キー安定性**: `orders.id` / `subscriptions.id` は uuid PK で不変＝流用可。
5. **`diagnostic_user_id` 発番**: HP/EC が `customer_profiles` に列追加・発番 → #2 `app_users` 連携（合意）。
6. **PII 最小化**: display_name(姓)/sex(gender)/birth_year(年) 供給可（合意）。
7. **Web 参照ロール**: `app_bridge` のみ SELECT 可の restricted ロール発行（HP）。本番 RLS の本人行絞り込みは email 突合(§3)前提。
8. **本人解決**: email 突合に確定（§3）。`resolve-customer` Edge Function 推奨。

---

## 7. Web アプリ側の改修（ドラフト確定後の TODO）

- #1 ブリッジ用の 2 つ目 Supabase クライアント追加（`getBridgeSupabase()`、read-only キー）。
- `loadDashboard()` の参照先を モック `customer` スキーマ → #1 `app_bridge` に変更。
- `GoogleOneTap.astro` の `DEMO_EMAIL_TO_UID` 撤去、`google_sub` 解決へ統一。未連携者の扱いを実装。
- 自己申告 API の書込み先を §5 の決定に合わせて変更。
- お知らせの表示名（`user_notices` の「○○様」）は #1 ブリッジ or `app_users.display_name_cache` のどちらから引くか §3-4 の決定に合わせる。
- テスト: HP/EC（pre-launch 相当）DB にデモ顧客＋`app_bridge` 生成バッチを流して E2E 確認。

---

## 8. 受け入れ基準（このフェーズ）

- [ ] `app_bridge` 4テーブルのスキーマに HP/EC が合意（PII範囲・キー・生成方式）
- [ ] Web 参照用 restricted ロール／キー／RLS の方式が決定
- [ ] 内部バッチの方式・頻度が決定
- [ ] `diagnostic_user_id` 発番・対応管理の責任分界が決定
- [ ] 自己申告（受取/返送）の書込み正本・経路が決定
- [ ] 上記に基づき Web 側の 2接続化＋`loadDashboard` 改修に着手可能

---

### HP/EC チームへの返答依頼
§6 の各論点、§4 のカラム（PII 範囲・キー流用可否）、§5（自己申告の書込み）、§2/§6-7（Web 参照ロール）について ◯/×/代替案 をお願いします。いただいた内容で v0.3 に改訂します。
