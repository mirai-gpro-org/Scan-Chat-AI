# 検査キット進捗管理 仕様書

| 項目 | 内容 |
|---|---|
| 文書名 | 検査キット進捗管理 仕様書 |
| バージョン | 0.1 (Draft) |
| 作成日 | 2026-05-28 |
| 対象範囲 | (b) Wellfort 経由検査における**検査キット発送から検査完了まで**の進捗可視化、通知ロジック、ユーザー操作、DB スキーマ |
| 関連文書 | `docs/architecture/wellfort_app_design_concept.md` §5 / `docs/architecture/test_data_storage_and_db_design.md` §7 / `docs/lab/lab_integration_workflow.md` / `docs/proposals/ai_app_ui_ux_proposal.pdf §2.2` (アクション・タスク化) |

---

## 1. 文書範囲

サブスク契約者の検査キット 1 件について、**「いつ届く?」「届いた?」「返送した?」「結果は?」**のライフサイクル全体を、ユーザー UI と通知・DB の両側から規定する。

### 範囲内
- 検査キット内容表示・配送予定日・追跡番号
- ユーザー操作 (受取確認 / 返送申告 / 配送希望日変更)
- 通知ロジック (4 段階リマインダー)
- DB スキーマ拡張 (`kit_shipments`) + 新規 (`subscription_plans` / `subscriptions` / `notifications`)
- Phase 別の実装範囲

### 範囲外
- 検査結果データの表示 (→ `docs/architecture/test_data_storage_and_db_design.md`)
- ユーザー割当ワークフロー (→ `docs/lab/lab_integration_workflow.md`)
- 配送業者システム連携の詳細 API 仕様 (Phase 2 で別途)

---

## 2. 背景・課題

### ユーザー側
- 「次の検査キットはいつ届く?」が分からない
- 受け取ったキットを**戻し忘れ・遅らせる**
- 検査結果が**いつ届くか分からず**待ち時間が不安

### Wellfort 側
- 「検体未返送ユーザー」をリスト化できない
- 配送業者から「受取・配送完了」データが**現フェーズでは取れない** (Phase 2 で連携予定)
- 検査会社からの**受領通知が標準化されていない** (検査会社ごとに通知方式バラバラ)

### 設計方針
1. **デイリークエスト型** (`docs/proposals/ai_app_ui_ux_proposal.pdf §2.2`) のステップ可視化で「次にやること」を明示
2. 配送業者連携が無い間は**ユーザー任意の自己申告**で代替 (1 タップ完了)
3. 検査会社受領が無い間は**発送日 + 推定日数のタイマー型通知**で代替
4. **強制せず、達成感ベース**で行動を促す (Watch / Action 分離原則)

---

## 3. 全体機能マップと現フェーズスコープ

| # | 機能 | 現フェーズ | Phase 2 |
|---|---|---|---|
| 1 | 検査キット内容表示 | ◯ 実装 | (継続) |
| 2 | 配送予定日 (今回 + 次回) | ◯ 実装 | (継続) |
| 2-b | **受取希望日入力 + 担当者手動連絡** | **◯ 実装** | API 連携で自動化 |
| 3 | 倉庫発送日 + 伝票番号 | ◯ 実装 | (継続) |
| 4 | ユーザー受取 (配送業者 API) | ✕ | ◯ 自動化 |
| 4-b | **ユーザー受取自己申告 (任意ボタン)** | **◯ 代替実装** | (継続、自動化と併存) |
| 5 | **ユーザー検体返送自己申告 (任意ボタン)** | **◯ 実装** (却下せず) | (継続) |
| 6 | 検査会社受領通知 (API) | △ 対応可なら自動 / 不可なら**担当者手動入力 UI** | ◯ 全社 API 連携 |
| 7 | 検査完了 + 結果確認ボタン | ◯ 実装 | (継続) |
| 通知 | 4 段階リマインダー | ◯ 実装 | (拡張) |

---

## 4. 検査キット進捗ダッシュボード UI

`docs/proposals/ai_app_ui_ux_proposal.pdf §2.2 アクション・タスク化` + プログレッシブ・ディスクロージャーの応用。

### 4.1 画面構成 (モバイル想定)

```
┌─ 今回の検査 ─────────────────────────────┐
│ 🧪 血液検査 + がんリスク (尿)             │
│ 配送予定: 2026年6月15日 (木)              │
│ [📍 追跡する]  [📅 受取日を変更]          │
│                                          │
│ 📦 進捗 (タップで詳細)                    │
│  ✅ 出荷準備完了      6/13                │
│  ✅ 倉庫から発送      6/13 ヤマト xxxx    │
│  ⏳ お受け取り        予定 6/15            │
│      └─ [受け取りました] (任意)            │
│  ⏳ 検体採取・返送                        │
│      └─ [返送しました] (任意)              │
│  ⏳ 検査会社受領                          │
│  ⏳ 検査完了                              │
│                                          │
│ 💡 今やること                             │
│  [ ] 検査キットの受取後、検体採取         │
│  [ ] 同梱の返送用封筒で発送              │
└──────────────────────────────────────────┘

┌─ 次回の検査 ────────────────────────────┐
│ 🗓️ 2026年10月 (約 4 ヶ月後)              │
│ 🧬 遺伝子検査 (初回のみ・年1回扱い)        │
│ [📅 配送希望日を調整]                     │
└──────────────────────────────────────────┘

┌─ 過去の検査 ────────────────────────────┐
│ ✓ 2026/3 血液検査     [結果を見る]       │
│ ✓ 2025/12 がんリスク  [結果を見る]       │
└──────────────────────────────────────────┘
```

### 4.2 進捗ステッパーの状態

| ステップ | 表示条件 | 表示形 |
|---|---|---|
| 出荷準備完了 | `kit_shipments.created_at` 経過 | ✅ + 日付 |
| 倉庫から発送 | `shipped_at` 設定済 | ✅ + 日付 + 配送業者 + 伝票番号 |
| お受け取り | (Phase 2) または `user_received_at` 設定済 | ⏳予定 → ✅実績 |
| 検体採取・返送 | `user_returned_at` 設定済 | ⏳ → ✅ |
| 検査会社受領 | `lab_received_at` 設定済 | ⏳ → ✅ |
| 検査完了 | `lab_completed_at` 設定済 (`lab_tests.status='reported'`) | ⏳ → ✅ + **[結果を見る]** ボタン活性化 |

### 4.3 「今やること」(Daily Quest 部分)

現在のステータスから自動算出された**1〜2 個のアクション項目**だけを表示 (3 個以上は出さない、認知負荷削減)。

```
発送直後 → 「📦 検査キットを受け取ったら採取してください」
受取済 → 「💉 検体を返送してください」
返送済 → 「⏳ 検査結果をお待ちください」(タスクなし、待機)
完了 → 「📊 結果を確認しましょう」(action card)
```

---

## 5. 各機能の詳細

### 5.1 検査キット内容表示

| 項目 | 値の取得元 |
|---|---|
| 検査内容 (例: 血液 + がんリスク) | `subscription_plans.tests_per_cycle` × 今回の発送分 |
| 表示形 | アイコン + 検査名 + (補足: 「年1回」「年3回」等) |
| 遺伝子検査 | 「初回のみ」バッジ表示 |

### 5.2 配送予定日 (今回 + 次回)

#### 今回 (kit_shipments)
- `expected_arrival_date` = `shipped_at` + 配送日数 (デフォルト 2 日、配送業者ごとに調整可)
- `requested_arrival_date` が設定済ならそちらを優先表示

#### 次回 (subscriptions)
- `subscriptions.next_test_at` = 前回検査の `kit_shipments.shipped_at` + サブスクサイクル (例: 4 ヶ月)
- 「約 4 ヶ月後」「2026年10月予定」などの自然言語表示

### 5.3 倉庫発送日 + 伝票番号

| 項目 | 値 |
|---|---|
| 倉庫名 | `kit_shipments.warehouse` (例: タカセ倉庫) |
| 発送日 | `kit_shipments.shipped_at` |
| 配送業者 | `kit_shipments.carrier` (`yamato` / `sagawa` / `jp_post`) |
| 伝票番号 | `kit_shipments.tracking_no` |
| **追跡 URL** | カラム `carrier_tracking_url` (キャリア URL テンプレに伝票番号挿入) |

### 5.4 ユーザー受取 (自己申告 + 将来の自動化)

#### 現フェーズ (4-b)
- 「📦 受け取りました」ボタン (任意、強制しない)
- タップ → `user_received_at = now()` を記録
- タップ後はステップが ✅ 状態に切替
- タップしなくても、配送業者連携が無いので困らない (Phase 2 で API 連携時に置換)

#### Phase 2 (4)
- 配送業者 API (ヤマト / 佐川 / 日本郵便) から自動取得
- 自動 + ユーザー自己申告の**両方をサポート**

### 5.5 ユーザー検体返送自己申告

#### 「報告させる意味はない」却下案への反論

| 観点 | 自己申告ボタンを置く理由 |
|---|---|
| ユーザー体験 | 「やった!」の達成感 = 健康行動の継続動機 |
| 問題切り分け | 「検査会社受領遅延」発生時、ユーザー返送済か未返送か分かる |
| 督促判断 | Wellfort 側で「未返送ユーザー」を抽出可能 |
| 手間 | 1 タップで終了、強制しない |

→ **任意ボタンで残す**。デフォルト OFF (タップしなくても運用可)、タップで `user_returned_at` 記録。

### 5.6 検査会社受領通知

#### 対応可能なら自動 (理想)
- 検査会社 API or webhook で `lab_received_at` を更新
- 同時に `lab_tests.status = 'in_lab'` に遷移

#### 対応不可ならフォールバック
- Wellfort 担当者用 UI で**手動入力**
- 検査会社が CSV/PDF で「受領しました」を送ってきたら担当者が `lab_received_at` 設定
- 全く通知が無い検査会社の場合は**スキップ** (`null` のまま、ステップは ⏳ 状態を保持)

#### ユーザー側通知 (検査会社受領が空でも代替可)
- 推定日数で「検査中と思われます」通知 = `shipped_at + 14 日`頃 (検査会社受領 + 分析期間の推定)

### 5.7 検査完了 + 結果確認ボタン

- `lab_tests.status` が `reported` (Elith 送信前) または `imported` (scan_md 確定) で「✅ 検査完了」表示
- **[結果を見る]** ボタンが活性化
- タップ → 結果ダッシュボード (test_artifacts) へ遷移
- 並行して **「結果が届きました」通知**を 1 回送る (ピン留めバナー)

---

## 6. 受取希望日変更フロー

### 6.1 ユーザー操作

```
[今回の検査 / 次回の検査] カード
   ↓ [📅 受取日を変更] タップ
   
モーダル/ボトムシート:
   希望配送日: [YYYY/MM/DD ▼]
   時間帯:    [○ 午前 ○ 午後 ○ 夜間]
   [キャンセル] [この日付で希望する]
   
   ※ 〇月〇日以降は変更できません
     (発送 2 日前まで変更可能)
```

### 6.2 内部処理

```
1. ユーザー入力 → kit_shipments に保存
   - requested_arrival_date
   - requested_time_window
   - requested_at = now()

2. Wellfort 管理画面に**通知** (担当者の To-Do に追加)
   "顧客 〇〇 が配送希望日を 〇/〇 に変更しました"

3. Wellfort 担当者が配送業者 (タカセ倉庫 → 業者) に手動連絡
   - 業者の集荷時間調整
   - 個別配送指定

4. 担当者が完了したら kit_shipments の備考に記録
```

### 6.3 変更ロック (発送 2 日前)

```
requested_lock_at = shipped_at - 2 days
今が requested_lock_at 以降 → UI 上で変更ボタンを灰色化
                            「変更可能期間を過ぎました」表示
```

Phase 2 の配送業者 API 連携時は、ロック期間を業者ごとに可変にできる。

---

## 7. 通知ロジック

### 7.1 通知タイプ一覧

| ID | トリガ | 内容 | チャネル | フェーズ |
|---|---|---|---|---|
| N1 | `shipped_at` 当日 | 「発送しました。〇/〇 頃お届け予定」 | in-app + email | 現 |
| N2 | `shipped_at + 3 日` | 「お受け取りいただけましたか? 検体採取後、早めの返送をお願いします」 | in-app push + email | 現 |
| N3 | `shipped_at + 7 日` + `user_received_at` 未設定 | 「配送状況をご確認ください」 + 追跡 URL | in-app push + email | 現 |
| N4 | `shipped_at + 10 日` + `user_returned_at` 未設定 | 「検体返送はお済みでしょうか? お早めにお願いします」 | email + Wellfort 担当者にも通知 | 現 |
| N5 | `lab_received_at` 受信 (or `shipped_at + 14 日` 推定) | 「検査会社が受け取りました。結果は〇/〇 頃」 | in-app | 現 (推定) → Phase 2 (API) |
| N6 | `lab_completed_at` 受信 | 「結果が届きました!」(ピン留めバナー) | in-app push + email | 現 |
| N7 | `subscriptions.next_test_at - 14 日` | 「次回の検査キットを来月発送します。希望日があれば事前にどうぞ」 | in-app | 現 |

### 7.2 通知スケジューリング

- 発送・受領イベント時に**未来分の通知行を一括 INSERT** (`notifications.scheduled_at` 設定)
- バッチ (cron / scheduled function) が `scheduled_at <= now()` を毎時拾い、未送信なら送信
- ユーザー側の状態変化 (例: 自己申告で受取報告) が起こったら、関連する未来通知を**キャンセル** (`cancelled_at` 設定)

### 7.3 通知抑止ルール

- ユーザーが「受け取りました」報告 → N3 不要、N4 は維持
- ユーザーが「返送しました」報告 → N4 不要
- 通知設定で「メールのみ / プッシュのみ / 両方」を選択可
- 「夜間通知 OFF」(20:00〜8:00 は in-app バッジのみ、push 送らない) のオプト設定

---

## 8. DB スキーマ

### 8.1 `kit_shipments` 拡張 (既存に列追加)

```sql
alter table kit_shipments add column expected_arrival_date date;
alter table kit_shipments add column requested_arrival_date date;
alter table kit_shipments add column requested_time_window text;  -- 'am' | 'pm' | 'evening'
alter table kit_shipments add column requested_at timestamptz;
alter table kit_shipments add column requested_lock_at timestamptz;  -- 発送2日前以降変更不可
alter table kit_shipments add column user_received_at timestamptz;   -- 任意の自己申告
alter table kit_shipments add column user_returned_at timestamptz;   -- 任意の自己申告
alter table kit_shipments add column lab_received_at timestamptz;    -- 検査会社受領 (取れる場合)
alter table kit_shipments add column lab_completed_at timestamptz;   -- 検査完了
alter table kit_shipments add column carrier text;                   -- 'yamato' | 'sagawa' | 'jp_post'
alter table kit_shipments add column carrier_tracking_url text;      -- view で計算でも可
alter table kit_shipments add column subscription_id uuid references subscriptions(id);
```

→ ステップ可視化に必要なタイムスタンプ群を 1 テーブルに集約。`subscription_id` で「何回目の検査か」を辿れる。

### 8.2 `subscription_plans` (新規)

```sql
create table subscription_plans (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,                -- '年3回パック・血液+がんリスク'
  cycle_months    int not null,                 -- 4 (= 年3回)
  tests_per_cycle text[] not null,              -- ['blood', 'cancer_urine']
  genetics_once   boolean default true,         -- 遺伝子検査は初回のみ
  price_yen       int,
  description     text,
  is_active       boolean default true,
  created_at      timestamptz default now()
);
```

初期データ例:

| name | cycle_months | tests_per_cycle | genetics_once |
|---|---|---|---|
| 年3回パック・基本 | 4 | `['blood']` | true |
| 年3回パック・がんリスク付 | 4 | `['blood', 'cancer_urine']` | true |
| 年3回パック・AI 予測付 | 4 | `['blood', 'cancer_urine', 'ai_prediction']` | true |

### 8.3 `subscriptions` (新規)

```sql
create table subscriptions (
  id                 uuid primary key default gen_random_uuid(),
  customer_id        uuid not null references customer_profiles(user_id),
  plan_id            uuid not null references subscription_plans(id),
  started_at         date not null,
  next_test_at       date,                      -- 次回検査の予定日
  last_test_at       date,
  current_cycle_year int default 1,             -- 契約年 (1, 2, 3, ...)
  current_cycle_seq  int default 0,             -- 今年の何回目か (1〜3)
  status             text not null default 'active',  -- active | paused | cancelled
  paused_at          timestamptz,
  cancelled_at       timestamptz,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);
create index on subscriptions(customer_id, status);
```

### 8.4 `notifications` (新規)

```sql
create table notifications (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid not null references customer_profiles(user_id),
  shipment_id     uuid references kit_shipments(id),
  notification_type text not null,  -- 'N1_shipped' | 'N2_arrival_check' | 'N3_tracking' |
                                    -- 'N4_return_reminder' | 'N5_lab_received' |
                                    -- 'N6_result_ready' | 'N7_next_test_preview'
  scheduled_at    timestamptz not null,
  sent_at         timestamptz,
  cancelled_at    timestamptz,
  channels        text[] not null,  -- ['in_app', 'email', 'push']
  subject         text,
  body            text,
  read_at         timestamptz,      -- in-app の既読
  dismissed_at    timestamptz,
  created_at      timestamptz default now()
);
create index on notifications(customer_id, scheduled_at);
create index on notifications(scheduled_at) where sent_at is null and cancelled_at is null;
```

### 8.5 ER 図 (進捗管理部分)

```
customer_profiles (HP side)
       │
       ├──◀ subscriptions
       │       │
       │       ├ plan_id ─▶ subscription_plans
       │       └ next_test_at
       │
       ├──◀ kit_shipments (拡張)
       │       ├ subscription_id ──▶ subscriptions
       │       ├ shipped_at / expected_arrival_date
       │       ├ user_received_at / user_returned_at
       │       ├ lab_received_at / lab_completed_at
       │       ├ requested_arrival_date / requested_lock_at
       │       └ carrier / tracking_no / carrier_tracking_url
       │
       └──◀ notifications
               ├ shipment_id ──▶ kit_shipments
               ├ scheduled_at / sent_at
               ├ notification_type
               └ channels[]
```

---

## 9. データフロー

### 9.1 検査キット出荷 → 進捗開始

```
1. EC 注文 (orders) → kit_shipments INSERT
   - subscription_id 設定
   - test_type / lab_company_id 設定
   - expected_arrival_date = shipped_at (まだ未定なので null)

2. タカセ倉庫から発送
   - shipped_at = 出荷日時
   - tracking_no = 伝票番号
   - carrier = 'yamato' 等
   - expected_arrival_date = shipped_at + 配送日数
   - requested_lock_at = shipped_at - 2 days

3. 通知をスケジュール (notifications に行追加)
   - N1: scheduled_at = shipped_at (即時)
   - N2: scheduled_at = shipped_at + 3 days
   - N3: scheduled_at = shipped_at + 7 days
   - N4: scheduled_at = shipped_at + 10 days
   - N5: scheduled_at = shipped_at + 14 days (推定、検査会社受領の実値が来たら上書き)

4. UI に「今回の検査」カードが表示開始
```

### 9.2 ユーザー受取自己申告

```
ユーザー: [📦 受け取りました] タップ
   ↓
kit_shipments.user_received_at = now()
   ↓
N3 (配送状況確認) を cancel (cancelled_at = now())
   ↓
UI ステップ: お受け取り ⏳ → ✅
「今やること」: 「💉 検体を返送してください」に切替
```

### 9.3 ユーザー返送自己申告

```
ユーザー: [💉 返送しました] タップ
   ↓
kit_shipments.user_returned_at = now()
   ↓
N4 (返送督促) を cancel
   ↓
UI ステップ: 検体返送 ⏳ → ✅
「今やること」: 「⏳ 検査結果をお待ちください」(タスクなし)
```

### 9.4 検査会社受領 (取れる場合)

```
検査会社から API or webhook
   ↓
kit_shipments.lab_received_at = 通知日時
lab_tests.status = 'in_lab'
   ↓
N5 (検査中) 通知を送信 (scheduled_at を now() に上書き)
   ↓
UI ステップ: 検査会社受領 ⏳ → ✅
```

### 9.5 検査完了

```
docs/lab/lab_integration_workflow.md Workflow に従い、結果取り込み
   ↓
kit_shipments.lab_completed_at = 完了日時
lab_tests.status = 'imported'
test_artifacts INSERT (検査結果)
   ↓
N6 (結果が届きました) 通知を送信 (push + email + in-app バッジ)
   ↓
UI: 「✅ 検査完了」+ [結果を見る] ボタン活性化
ピン留めバナー: 「結果が届きました」(アクション・タスク化)
   ↓
次回検査のスケジューリング
   subscriptions.last_test_at = today
   subscriptions.next_test_at = today + cycle_months (例: + 4 months)
   subscriptions.current_cycle_seq += 1 (年内何回目か)
```

---

## 10. 段階的実装計画

### Phase 0 (パイロット — 現在)
- ✕ 進捗管理機能なし

### Phase 1.0 (本格運用初期)
- [ ] DB: `subscription_plans` / `subscriptions` / `notifications` 新規、`kit_shipments` 拡張
- [ ] 「検査キット進捗ダッシュボード」UI を マイページに追加
- [ ] 1) 検査キット内容表示
- [ ] 2) 配送予定日 + 次回予定 (subscriptions.next_test_at から算出)
- [ ] 3) 倉庫発送日 + 伝票番号 + 追跡 URL
- [ ] 4-b) ユーザー受取自己申告ボタン
- [ ] 5) ユーザー返送自己申告ボタン
- [ ] 7) 検査完了 + 結果確認ボタン (lab_tests.status から判定)
- [ ] 通知 N1〜N4, N6, N7
- [ ] 受取希望日入力 UI + Wellfort 管理画面の To-Do 連携

### Phase 1.5 (検査会社との 6 連携が可能になり次第)
- [ ] 6) 検査会社受領通知 (検査会社ごとに API / webhook / メール解析)
- [ ] N5 通知を推定タイマーから実値に切替
- [ ] 担当者用「手動で lab_received_at を入力」UI (補助)

### Phase 2 (スケール)
- [ ] 4) 配送業者 API 連携 (ヤマト / 佐川 / 日本郵便) で自動 user_received_at
- [ ] 受取希望日の業者直接連携 (担当者手動 → API)
- [ ] 全検査会社で Workflow 1 + 6) 完全 API 化

---

## 11. 未確定事項 (TBD)

- [ ] 配送日数の推定値 (`shipped_at + N 日`の N) — 配送業者・地域ごとに可変か
- [ ] 通知のチャネル優先度 (in-app / email / push のデフォルト)
- [ ] 「夜間通知 OFF」のデフォルト時間帯 (20:00〜8:00 で良いか)
- [ ] 受取希望日の選択範囲 (発送日 + N〜M 日)
- [ ] 配送希望日変更時の Wellfort 担当者通知方法 (Slack? 管理画面の To-Do?)
- [ ] サブスク休止 (`status='paused'`) 時の次回検査スケジューリング
- [ ] サブスク解約時の処理 (進行中検査の扱い、キット返送義務、データ保持期間)
- [ ] 通知を**読まなかった**場合のフォロー (例: 検査結果通知 N6 を 1 週間読まなかったら再通知)
- [ ] 「次回検査」が複数種同時の場合の UI (例: 同じ月に血液と尿が来る)
- [ ] 検査会社受領が遅延した場合の長期化通知 (`shipped_at + 21 日` 等)
- [ ] 受領通知が無い検査会社 (検査完了通知のみ) の場合の N5 省略ルール

---

## 12. 変更履歴

| Ver | 日付 | 内容 |
|---|---|---|
| 0.1 | 2026-05-28 | 初版。検査キット進捗ダッシュボードの 1〜7 機能を現フェーズスコープで規定。`kit_shipments` 拡張 + 新規 `subscription_plans` / `subscriptions` / `notifications`、4 段階通知ロジック (N1-N7)、受取希望日入力フロー (発送 2 日前ロック)、検査会社受領の現実的フォールバック (担当者手動入力 + 推定タイマー通知) を明文化 |
