# 【返答 v0.3】HP/EC「Web連携依頼への回答」への回答（Web アプリチーム）

- 作成: Web アプリ（Scan-Chat / マイページ）チーム
- 宛先: HP/EC（wellfort-site）チーム
- 日付: 2026-06-21
- 対象: `wellfort-site/docs/web連携依頼への回答_draft.md`（HP/EC 返答ドラフト）への回答
- 関連改訂: `docs/bridge_table_design_draft.md` を **v0.3** に更新（本回答と整合）

---

## 0. 前提崩れの受け止め（重要）

HP/EC 回答で判明した以下を **全面的に受け入れ**、設計を現実に合わせて改訂しました。

1. HP 側に `diagnostic_user_id` / `google_sub` は **無い**（識別は `user_id`＋`email`、認証は magic_links）。
2. `kit_shipments` / `lab_tests` / `lab_companies` / `subscription_plans` テーブルは **無い**。実体は `orders` / `subscriptions` / `test_products`。
3. **検査結果(lab)系は HP は保持していない**。

→ これらは当初こちらが HP のスキーマを推測で書いたことが原因です。実スキーマ（`database-schema.md`）ベースに直しました。

---

## A. HP からの確認事項 C1〜C6 への回答

| # | HP 確認事項 | Web の回答 | 補足 |
|---|---|---|---|
| C1 | `diagnostic_user_id` を HP発番（`customer_profiles` 列追加, default `gen_random_uuid()`）→ #2 `app_users` へ連携 | **◯ 同意** | 連携タイミング: 顧客の診断系連携確定時。#2 側は `app_users` に当該 uuid を保存。 |
| C2 | 本人解決キーを当面 **email** | **◯ 同意（条件付き）** | google_sub 未導入のため email 突合で可。ただし **email 一覧を Web に晒さない**こと（§A-2）。 |
| C3 | `lab_delivery`（検査到着/取込）の供給元 | **解決: ブリッジから削除** | 検査結果は **診断系 #2 が正本**（`test_artifacts`/`diagnosis_results`）。HP の担当外。検査ラボ→#2 取込は別フィーチャ。 |
| C4 | NEWS 一元化の正本 | **HP `news` を正本 → `announcements` へ片方向同期** | §B 参照。 |
| C5 | `visible_on_hp`/`visible_on_web` 列追加は Web 側 | **◯ 同意** | `announcements` は #2 所有のため Web が migration 実施。HP は参照/書込みのみ。 |
| C6 | 発送状況ブリッジの更新頻度（倉庫CSV取込契機） | **◯ 許容** | キット進捗にリアルタイム性は不要。**取込イベント駆動 or 15〜30分間隔**で可。 |

---

## A-2. 本人解決（email 突合）の具体方式 — 提案

Web=Google One Tap / HP=メール認証 の橋渡しは **email** で行うが、PII配慮のため一覧露出を避ける。

1. One Tap → Google から `google_sub` ＋ `email` を取得。
2. **#1 に「解決用 Edge Function」`resolve-customer`** を用意（HP担当）。入力 `email` → 一致する1件のみ `{ diagnostic_user_id, display_name }` を返す（無ければ未連携=null）。
   - もしくは `app_bridge.customer_account` に email を載せ、**RLS で本人行のみ SELECT**（JWT の email クレームと一致）でも可。**Edge Function 方式を推奨**（emailをブリッジに載せず済む）。
3. Web は得た `diagnostic_user_id` と `google_sub` の対応を **#2 `app_users` に永続化**。次回以降は #2 の `google_sub` 解決だけで完結（#1 アクセス不要）。
4. 未連携（email一致なし）は適格性なしとして弾く。

> これにより `app_bridge.customer_account.google_sub` は不要（NULL固定でよい）。解決は email、永続化は #2。

---

## B. NEWS 一元化（C4 確定方針）

**HP `news` を正本**とし、**`announcements`(#2) へ片方向同期**する。

- 同期方向: `wellfort-site.news` → `diagnosis.announcements`（HP→#2 の一方向）。
- 同期実体: ブリッジ生成バッチと同様、HP 側の仕組みで #2 へ反映（または #2 が用意する取込 Edge Function 経由）。経路は §A-2 と揃える。
- `announcements` のスキーマ（`category`, `visible_on_hp`, `visible_on_web`, 本文等）は **Web 側で確定・migration**。HP `news` の項目との **マッピング表**を別途すり合わせ（タイトル/本文/公開期間/カテゴリ）。
- Web マイページの「お知らせ」一覧は `announcements`（同期済み）＋個別通知 `user_notices` を表示。
- HP 管理画面は既存 `news.astro` を継続利用（正本のため改修最小）。

> 補足: 個別通知 `user_notices`（「○○様への重要なお知らせ」）は NEWS とは別系統で、HP 管理画面から #2 へ書込み（Edge Function 経由, §B-2 合意済み）。表示名は HP 同期の `display_name`（姓）を使用。

---

## C. ブリッジ設計の改訂（v0.3 概要）

詳細は `bridge_table_design_draft.md` v0.3。要点:

- **テーブルを 3 つに縮小**: `customer_account` / `subscription` / `kit_shipment`。**`lab_delivery` は廃止**（#2 が正本）。
- `customer_account`: `customer_profiles`（`user_id`→hp_customer_id, `name`→display_name=姓, `gender`→sex, `birth_date`→birth_year）＋ 追加列 `diagnostic_user_id` / `status`。`google_sub` は持たない。
- `subscription`: `subscriptions`＋`test_products`（`test_products.name`→plan_name）。`cycle_year/seq` は無し→列削除。
- `kit_shipment`: **`orders` 由来**にマッピング（下表）。`carrier`/`carrier_tracking_url`/`expected_arrival_date`/`lab_received_at`/`lab_completed_at` は **削除 or NULL**。
- KitProgressCard の表示は **「発送ステージ=ブリッジ(orders) / 検査完了ステージ=#2(test_artifacts)」** で出し分け。

### kit_shipment ⇄ orders マッピング

| ブリッジ列 | orders 由来 |
|---|---|
| id | orders.id |
| diagnostic_user_id | （customer から解決） |
| order_id | orders.id / 注文番号 |
| test_type | 注文商品（test_products）から導出 |
| shipping_status | orders.shipping_status |
| instruction_sent_at | orders.instruction_sent_at |
| shipped_at | orders.shipped_at |
| tracking_no | orders.tracking_number |
| delivered_at | orders.delivered_at |
| user_received_at / user_returned_at | 自己申告（案A Edge Function 経由で #1 に記録→反映） |
| carrier / carrier_tracking_url / expected_arrival_date | **NULL（未保持）** |
| lab_received_at / lab_completed_at | **削除（#2 由来）** |

---

## D. こちらからの返答まとめ＆次アクション

- C1/C5/C6: ◯ 合意。C3: ブリッジから lab_delivery 削除で解決。C4: HP `news` 正本→片方向同期で確定。
- C2: email 突合に合意。**email をブリッジに載せず、#1 `resolve-customer` Edge Function 方式**を提案（要HP合意）。

### 残課題（双方）
1. `resolve-customer` Edge Function の I/F（入力 email / 出力 diagnostic_user_id+display_name）合意。
2. `customer_profiles` への `diagnostic_user_id` / `status` 列追加（HP）。
3. `news` → `announcements` の項目マッピング表すり合わせ。
4. 自己申告（受取/返送）Edge Function の I/F 確定（案A）。
5. Web 側: #2 2接続化（#1 ブリッジ read-only）／`loadDashboard` 改修／`announcements` migration（`visible_on_hp/web`）／One Tap の email 解決化（`DEMO_EMAIL_TO_UID` 撤去）。

上記で齟齬なければ、双方の実装着手に進めます。
