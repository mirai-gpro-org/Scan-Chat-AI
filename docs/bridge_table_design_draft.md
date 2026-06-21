# 【ドラフト v0.2】HP/EC ⇄ Web アプリ ブリッジテーブル設計

- 作成: Web アプリ（Scan-Chat / マイページ）チーム
- 宛先: HP/EC チーム（レビュー・返答依頼）
- ステータス: **ドラフト（叩き台）**。HP/EC チームのコメント返答 → 改訂、のキャッチボール前提。
- 変更履歴: v0.1 では診断系(#2)にブリッジを置く案だったが、**v0.2 でブリッジは HP/EC 系(#1) 内に設置**へ変更。
- 関連: `docs/data_integration_requirements.md`（PII分離原則）, `docs/test_data_storage_and_db_design.md`

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
   kit_shipment / lab_delivery               （restricted ロール / 専用キー）
                                          ──▶ diagnostic_user_id で #2 のデータと突合
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

本番仕様（v0.2）:
1. One Tap → `google_sub` / email を取得。
2. **#1 の `app_bridge.customer_account` を `google_sub`(または email)で引く → `diagnostic_user_id` を得る**（`DEMO_EMAIL_TO_UID` 撤去）。
   - 代替案: #2 `app_users.google_sub` で引く方式でも可。**どちらを“本人解決の正”にするか**は要相談（ブリッジに google_sub を載せるなら #1 解決が自然）。
3. 未連携ユーザー（HP/EC で連携未完了）は弾く（適格性なし）。方針要確認。
4. 表示名は `app_bridge.customer_account.display_name`（#1）から取得。`#2 app_users.display_name_cache` は将来撤去候補（当面は併存可）。

---

## 4. ブリッジテーブル定義（ドラフト）— 設置先: HP/EC #1 `app_bridge` スキーマ

すべて `diagnostic_user_id` を保持し、Web 側で #2 のデータと突合できるようにする。

### 4-1. `app_bridge.customer_account` — 顧客アカウント要約（1顧客1行）

| カラム | 型 | 由来(HP/EC) | 備考 |
|---|---|---|---|
| diagnostic_user_id | uuid PK | customer_profiles.diagnostic_user_id | 共有キー |
| hp_customer_id | uuid not null | customer_profiles.user_id | HP側主キー |
| google_sub | text null | customer_profiles.google_sub | 本人解決を #1 で行う場合に使用 |
| display_name | text | family_name(+given) | 表示名「真鍋」想定（敬称はアプリ側付与） |
| sex | text null | customer_profiles.sex | 要相談（PII最小化） |
| birth_year | int null | date_of_birth の年のみ | 年齢計算用。生年月日フルは載せない案 |
| status | text | 会員状態 | active / withdrawn 等 |
| synced_at | timestamptz | バッチ | 最終生成時刻 |
| source_updated_at | timestamptz null | 元レコード更新時刻 | 差分・整合確認用 |

### 4-2. `app_bridge.subscription` — プラン・契約要約

| カラム | 型 | 由来 | 備考 |
|---|---|---|---|
| diagnostic_user_id | uuid | | キー |
| plan_code | text | プラン識別子 | basic / cancer / ai 等 |
| plan_name | text | subscription_plans.name | 「年3回パック・AI予測付」等 |
| status | text | subscriptions.status | active/paused/cancelled |
| started_at | date | | |
| next_test_at | date null | | 「次回検査予定」表示 |
| last_test_at | date null | | |
| cycle_year | int null | current_cycle_year | 参考 |
| cycle_seq | int null | current_cycle_seq | 参考 |
| synced_at | timestamptz | | |

### 4-3. `app_bridge.kit_shipment` — 検査キット発送・進捗（1出荷1行）

UI（KitProgressCard）が使う項目に限定。

| カラム | 型 | 由来(kit_shipments) | 備考 |
|---|---|---|---|
| id | uuid PK | kit_shipments.id | HP側ID流用案 |
| diagnostic_user_id | uuid | customer_id を解決 | キー |
| order_id | text | | |
| test_type | text | | health_checkup/blood/genetics/cancer_urine/ai_prediction |
| lab_name | text null | lab_companies.name | 名称解決して載せる |
| shipped_at | timestamptz null | | |
| tracking_no | text null | | |
| carrier | text null | | |
| carrier_tracking_url | text null | | |
| expected_arrival_date | date null | | |
| user_received_at | timestamptz null | | ※自己申告（後述） |
| user_returned_at | timestamptz null | | ※自己申告（後述） |
| lab_received_at | timestamptz null | | |
| lab_completed_at | timestamptz null | | |
| synced_at | timestamptz | | |

### 4-4. `app_bridge.lab_delivery` — 検査結果の到着・取込状況（1検査1行）

| カラム | 型 | 由来(lab_tests) | 備考 |
|---|---|---|---|
| id | uuid PK | lab_tests.id | |
| diagnostic_user_id | uuid | | キー |
| shipment_id | uuid null | shipment_id | kit_shipment と対応 |
| test_type | text | | |
| lab_name | text null | lab_companies.name | |
| external_test_id | text null | | |
| sampled_at | date null | | |
| reported_at | date null | | 「結果到着」日 |
| status | text | lab_tests.status | pending/in_lab/reported/imported/failed |
| synced_at | timestamptz | | |

---

## 5. 自己申告（受取/返送）の書込み — 要相談

現状 Web には「📦受け取りました／💉返送しました」の自己申告があり `user_received_at/returned_at` を更新している。ブリッジは #1 内の**読み取り中心**ミラーなので、書込み正本をどうするか決めたい。

- **案A（推奨）**: HP/EC が受取/返送用の API / Edge Function を #1 に用意し、Web はそこへ POST。正本は #1 の生テーブル、ブリッジへは内部バッチで反映。
- 案B: `app_bridge` に Web からの insert 専用テーブル（user_event）を設け、HP がそれを取り込む。

---

## 6. 同期（HP/EC 内部バッチ）の論点 — HP/EC へ確認したい

1. **生成方式**: 全件再生成 / 差分（`source_updated_at`）。差分なら元テーブルに更新時刻が必要。
2. **頻度**: 顧客・プランは日次、キット発送・到着は数十分間隔、等。要件は？
3. **退会・取消**: status による論理表現（物理削除しない案）でよいか。
4. **キー安定性**: `customer_id` / `kit_shipments.id` / `lab_tests.id` は不変か（PK 流用可否）。
5. **`diagnostic_user_id` 発番の責任分界**: HP/EC が発番・保持し、#2 `app_users` へも連携する想定でよいか。
6. **PII 最小化合意**: §4-1 の display_name / sex / birth_year の可否。NG なら代替（年齢区分のみ等）。
7. **Web 参照ロール**: `app_bridge` のみ SELECT 可能な restricted ロール／キーの発行と、RLS（本番は本人行のみ）の設計。
8. **本人解決の正**: ログイン時の `google_sub`→`diagnostic_user_id` 解決を #1 ブリッジ / #2 app_users のどちらで行うか。

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
