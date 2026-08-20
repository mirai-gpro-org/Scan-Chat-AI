# Supabase 開発環境 (Phase 1.0 dev profile)

`Scan-Chat-AI` プロジェクトの DB レイヤを Supabase で立ち上げるための設定です。

## 構成方針

| 項目 | dev profile (本書) | 本番 (Phase 1.0+) |
|---|---|---|
| Supabase プロジェクト数 | **1 (本リポジトリ)** | **2** (顧客系 / 診断系) |
| スキーマ分離 | `customer` / `diagnosis` の 2 schema | 別 project で物理分離 |
| RLS | 緩い dev policy (`anon` read 可) | service_role + Edge Function のみ書込 |
| Auth | local Auth (Inbucket でメール確認) | Google One Tap + マイナ+JPKI |
| Storage | local volume | AWS S3 / Supabase Storage |

dev → 本番移行時は `customer` schema を別 Supabase プロジェクトに切出すだけで済む構造です。

---

## 必要なツール

- [Supabase CLI](https://supabase.com/docs/guides/cli)
- Docker (Supabase CLI が内部で利用)
- Node.js 20+ (Elith JSON ロードスクリプト用)

CLI の入れ方:

```bash
# macOS (Homebrew)
brew install supabase/tap/supabase

# その他
# https://supabase.com/docs/guides/cli/getting-started
```

---

## セットアップ手順

### 1. ローカル Supabase 起動

```bash
cd /path/to/Scan-Chat-AI
supabase start
```

成功すると以下が表示されます (例):

```
Started supabase local development setup.

         API URL: http://127.0.0.1:54321
     GraphQL URL: http://127.0.0.1:54321/graphql/v1
          DB URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres
      Studio URL: http://127.0.0.1:54323
    Inbucket URL: http://127.0.0.1:54324
        anon key: eyJ...
service_role key: eyJ...
```

### 2. マイグレーション + シードデータ適用

```bash
supabase db reset
```

このコマンドで:
- DB を初期化
- `supabase/migrations/` の全 SQL を順次実行
- `supabase/seed.sql` → `seed_notices.sql` → `seed_measurements.sql` → `seed_kit_demo.sql` を実行
  (config.toml の `[db.seed]` で指定。後ろの 2 本は前の seed が作った artifact / 顧客を参照するため順序が重要)

### 3. Elith 実サンプル JSON の投入 (任意)

`docs/elith/2026_05_24 Elith_demo.json` (21K 字、全 10 セクション) を 1 件の
`diagnosis_results` レコードに後置きで読み込みます:

```bash
# supabase status の service_role_key を export
export SUPABASE_SERVICE_ROLE_KEY="<service_role key を貼り付け>"

node supabase/load_elith_demo.mjs
```

実行後、`80000001` レコードの `report` カラムに実物 JSON が入ります。

### 4. Studio で確認

http://127.0.0.1:54323 にアクセス → `customer` / `diagnosis` schema を選択して各テーブルを確認。

---

## シードデータの内容

| schema.table | 行数 | 主な内容 |
|---|---:|---|
| customer.customer_profiles | 10 | 真鍋 慶次郎 / 田中 花子 / 山田 太郎 ... |
| customer.lab_companies     |  5 | リージャー / PREVENT / ジェノプラン / LAiF / 北里 |
| customer.subscription_plans |  3 | 基本 / がんリスク付 / AI 予測付 (年3回パック) |
| customer.subscriptions     |  6 | active 5 + paused 1 |
| customer.kit_shipments     | 12 | ライフサイクル各段階 (発送のみ / 受取済 / 返送済 / 完了) を網羅 |
| customer.lab_tests         |  9 | 検査 ID と顧客 ID の紐付け (Workflow 2 で auto_lookup) |
| diagnosis.app_users        | 10 | customer.customer_profiles と 1:1 で紐付き (diagnostic_user_id 経由) |
| diagnosis.test_artifacts   | 12 | 5 検査種別 × user_upload / wellfort_lab を網羅 |
| diagnosis.test_artifact_files | 24 | scan_md / summary_md / highlights_md / raw_pdf_redacted / raw_csv / extracted_json |
| diagnosis.diagnosis_results |  3 | Elith JSON 簡略版。`load_elith_demo.mjs` で 1 件を実物に置換可 |
| diagnosis.user_notices     |  4 | 個別の重要なお知らせ。真鍋 (未読2/既読1) + 田中 (未読1)。お知らせページ用 |
| diagnosis.announcements    | 10 | 一般のお知らせ 5 + ニュース 5 (全ユーザー共通)。お知らせページ用 |
| diagnosis.measurement_values | 275 | 検査値 (seed_measurements.sql)。血液 12 回 x 22 項目 + 健診 11 項目 |
| diagnosis.health_age_scores | 12 | 健康年齢の時系列 3 パターン (横ばい/改善/悪化) |
| customer.kit_shipments (追加分) | +4 | 6 段階を網羅するための表示確認用 (seed_kit_demo.sql) |

### 主な人物像

| 顧客 | diagnostic_user_id | 状況 |
|---|---|---|
| 真鍋 慶次郎 (55) | `d0000001-...` | サンプル PDF と同一人物。AI 予測付パック、検査履歴 5 件 + ユーザー UL 1 件、Elith 診断結果あり |
| 田中 花子 (41) | `d0000002-...` | がんリスク付パック、年 1 回目完了、次回 4 月 (現在発送中) |
| 山田 太郎 (67) | `d0000003-...` | AI 予測付、年 3 回目完了、次回 4 月 |
| 鈴木 一郎 (33) | `d0000004-...` | 契約直後、まだ検査なし |
| 高橋 健 (54) | `d0000006-...` | がんリスク付、進行中 |
| 伊藤 大輔 (63) | `d0000008-...` | サブスク一時停止中 |
| 中村 さくら (30) | `d0000009-...` | 検査中 (lab_received 済、結果未) |
| 渡辺 由美 (40) | `d0000007-...` | ユーザー UL 人間ドックのみ、検査キット発送中 |

---

## クエリ例

### 「真鍋様」のダッシュボード相当データ取得

```sql
-- 進捗中の検査キット (今回 + 次回)
select s.shipped_at, s.expected_arrival_date, s.user_received_at, s.lab_completed_at,
       lc.name as lab_name, s.test_type, sub.next_test_at
from customer.kit_shipments s
join customer.lab_companies lc on lc.id = s.lab_company_id
left join customer.subscriptions sub on sub.id = s.subscription_id
where s.customer_id = 'c0000001-0000-0000-0000-000000000000'
order by s.shipped_at desc;

-- 検査結果アーティファクト (時系列)
select ta.test_type, ta.test_date, ta.lab_name, ta.display_mode,
       (select count(*) from diagnosis.test_artifact_files f where f.test_artifact_id = ta.id) as file_count
from diagnosis.test_artifacts ta
where ta.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000'
order by ta.test_date desc;

-- Elith 診断結果
select dr.received_at, dr.summary_text, dr.status,
       jsonb_array_length(dr.report) as sections,
       (select sum((s->>'char_count')::int) from jsonb_array_elements(dr.report) s) as total_chars
from diagnosis.diagnosis_results dr
where dr.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000'
order by dr.received_at desc;
```

---

## 未実装 (次フェーズで追加)

| テーブル | 目的 | 担当 doc |
|---|---|---|
| `customer.lab_intake_files` | 検査会社から受領した原本 PDF 管理 | test_data_storage_and_db_design.md §7.2 |
| `customer.notifications` | 4 段階通知キュー (N1-N7) | kit_progress_management.md §8 |
| ~~`diagnosis.test_artifact_items`~~ | **不採用**。案A-3 (2026-08-20 承認) により `test_artifacts.measurements` (jsonb) + `diagnosis.measurement_values` (正規化) の 2 層に置き換え | 20260820000010_measurement_values.sql |
| `diagnosis.diagnosis_result_items` | Elith JSON の二次抽出項目 | elith_report_integration.md §3.2 |
| `diagnosis.sessions / messages` | AI 問診履歴 (パイロットの localStorage を DB 化) | data_integration_requirements.md §5.1 |
| `audit_logs` | 10 年保管監査ログ | data_integration_requirements.md §6 |

---

## 環境変数 (Astro アプリ → Supabase 接続用)

`.env.local` (gitignore 済み) に以下を設定:

```
PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
PUBLIC_SUPABASE_ANON_KEY=<supabase status の anon key>
SUPABASE_SERVICE_ROLE_KEY=<supabase status の service_role key>
```

`src/lib/supabase.ts` の既存スタブが自動的に拾います。

---

## 注意事項

- **dev profile の RLS は緩めです**。本番移行時に `data_integration_requirements.md §6` の RLS ポリシーへ差し替えてください。
- **本サンプルデータの氏名は架空**です (真鍋慶次郎はサンプル PDF の表記を流用)。
- **再シード** (`supabase db reset`) でデータは初期化されます。
