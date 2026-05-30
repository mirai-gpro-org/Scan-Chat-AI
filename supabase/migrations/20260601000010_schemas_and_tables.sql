-- ============================================================
-- Wellfort Web アプリ — DB スキーマ (Phase 1.0 dev profile)
--
-- 設計起点:
--   - docs/test_data_storage_and_db_design.md (DB スキーマ §7)
--   - docs/kit_progress_management.md (進捗 §8)
--   - docs/elith_report_integration.md (Elith §3)
--   - docs/data_integration_requirements.md (PII 分離原則 §1.3)
--
-- 構成:
--   customer schema  : PII を含む顧客系テーブル (本番では Supabase #1)
--   diagnosis schema : PII を含まない診断系テーブル (本番では Supabase #2)
--
-- dev profile では同一プロジェクト内で 2 スキーマに分離し、
-- 本番移行時に customer schema を別プロジェクトへ切出す。
-- ============================================================

-- extensions ----------------------------------------------------
create extension if not exists "pgcrypto" with schema extensions;
-- gen_random_uuid() を使うため (pg14+ では拡張不要だが互換のため)

-- schemas -------------------------------------------------------
create schema if not exists customer;
create schema if not exists diagnosis;

comment on schema customer is
  'PII を含む顧客系データ。本番では別 Supabase プロジェクトへ分離する。';
comment on schema diagnosis is
  'PII を含まない診断系データ。diagnostic_user_id でのみ識別。';


-- ============================================================
-- customer schema (PII あり)
-- ============================================================

-- 1) customer_profiles — Wellfort HP/EC 顧客マスタ
--    本番では Wellfort HP 側の Supabase に既存。本 dev profile では模倣。
create table customer.customer_profiles (
  user_id              uuid primary key default gen_random_uuid(),
  family_name          text not null,
  given_name           text not null,
  family_name_kana     text,
  given_name_kana      text,
  sex                  text check (sex in ('male', 'female', 'other')),
  date_of_birth        date,
  email                text unique,
  phone                text,
  postal_code          text,
  prefecture           text,
  city                 text,
  address_line         text,
  building             text,
  diagnostic_user_id   uuid unique,        -- 診断系への橋渡し (本番は HP→App 連携で同期)
  diagnostic_linked_at timestamptz,
  google_sub           text unique,        -- Google ID Token の sub
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on table customer.customer_profiles is
  '顧客マスタ。PII を保持。diagnostic_user_id で診断系と紐付け。';

-- 2) lab_companies — 検査会社マスタ
create table customer.lab_companies (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  test_types          text[] not null,              -- ['blood', 'genetics', ...]
  delivery_format     text not null,                -- 'csv' | 'pdf' | 'csv_and_pdf'
  external_id_label   text,                          -- 例: '検査ID / バーコードNo'
  external_id_pattern text,                          -- regex
  notification_method text,                          -- 'sftp' | 'api' | 'email' | 'manual'
  contact_email       text,
  workflow_default    int not null default 2,        -- 1 | 2 | 3 (lab_integration_workflow.md)
  notes               text,
  created_at          timestamptz not null default now()
);
comment on table customer.lab_companies is
  '検査会社マスタ。lab_integration_workflow.md の Workflow 1/2/3 を default に保持。';

-- 3) subscription_plans — サブスク商品マスタ
create table customer.subscription_plans (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  cycle_months    int not null,                      -- 4 (= 年3回) など
  tests_per_cycle text[] not null,                   -- ['blood', 'cancer_urine']
  genetics_once   boolean not null default true,     -- 遺伝子検査は初回のみ
  price_yen       int,
  description     text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);

-- 4) subscriptions — 顧客のサブスク契約
create table customer.subscriptions (
  id                 uuid primary key default gen_random_uuid(),
  customer_id        uuid not null references customer.customer_profiles(user_id) on delete restrict,
  plan_id            uuid not null references customer.subscription_plans(id),
  started_at         date not null,
  next_test_at       date,
  last_test_at       date,
  current_cycle_year int default 1,
  current_cycle_seq  int default 0,
  status             text not null default 'active'  -- active | paused | cancelled
                       check (status in ('active','paused','cancelled')),
  paused_at          timestamptz,
  cancelled_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index on customer.subscriptions(customer_id, status);

-- 5) kit_shipments — 検査キット出荷・進捗台帳
create table customer.kit_shipments (
  id                      uuid primary key default gen_random_uuid(),
  order_id                text not null,
  customer_id             uuid not null references customer.customer_profiles(user_id),
  lab_company_id          uuid not null references customer.lab_companies(id),
  test_type               text not null,
  subscription_id         uuid references customer.subscriptions(id),
  subscription_year       int,
  subscription_seq        int,
  warehouse               text,                        -- 'タカセ倉庫' 等
  shipped_at              timestamptz,
  tracking_no             text,
  carrier                 text,                        -- 'yamato' | 'sagawa' | 'jp_post'
  carrier_tracking_url    text,
  expected_arrival_date   date,
  requested_arrival_date  date,
  requested_time_window   text,                        -- 'am' | 'pm' | 'evening'
  requested_at            timestamptz,
  requested_lock_at       timestamptz,                 -- 発送 2 日前以降 lock
  user_received_at        timestamptz,                 -- ユーザー任意自己申告
  user_returned_at        timestamptz,                 -- ユーザー任意自己申告
  lab_received_at         timestamptz,                 -- 検査会社受領
  lab_completed_at        timestamptz,                 -- 検査完了
  notes                   text,
  created_at              timestamptz not null default now()
);
create index on customer.kit_shipments(customer_id);
create index on customer.kit_shipments(order_id);
create index on customer.kit_shipments(subscription_id);

-- 6) lab_tests — 検査 ID ↔ 顧客 ID 紐付け (要のテーブル)
create table customer.lab_tests (
  id                 uuid primary key default gen_random_uuid(),
  shipment_id        uuid references customer.kit_shipments(id),
  customer_id        uuid not null references customer.customer_profiles(user_id),
  diagnostic_user_id uuid not null,                    -- diagnosis 側との橋渡し
  lab_company_id     uuid not null references customer.lab_companies(id),
  test_type          text not null,
  external_test_id   text,                              -- 検査会社の検査 ID
  external_barcode   text,                              -- バーコード No (PREVENT 等)
  sampled_at         date,
  reported_at        date,
  status             text not null default 'pending'    -- pending|in_lab|reported|imported|failed
                       check (status in ('pending','in_lab','reported','imported','failed')),
  workflow_used      int,                               -- 1 | 2 | 3
  assigned_at        timestamptz,
  assigned_by        text,                              -- 'auto_id' | 'auto_lookup' | 'manual:<id>'
  notes              text,
  created_at         timestamptz not null default now(),
  unique (lab_company_id, external_test_id)
);
create index on customer.lab_tests(customer_id);
create index on customer.lab_tests(diagnostic_user_id);
create index on customer.lab_tests(reported_at);


-- ============================================================
-- diagnosis schema (PII なし)
-- ============================================================

-- 1) app_users — 診断系の owner key 保持
create table diagnosis.app_users (
  diagnostic_user_id uuid primary key default gen_random_uuid(),
  auth_user_id       uuid unique,                       -- Supabase Auth の user_id (本 dev profile では未連携)
  google_sub         text unique,
  hp_customer_user_id uuid,                              -- HP 側 customer_profiles.user_id のミラー (参考)
  display_name_cache text,
  eligibility_checked_at timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
comment on table diagnosis.app_users is
  '診断系の匿名 owner key。PII は保持しない。';

-- 2) test_artifacts — a/b 統一の検査成果物メタ
create table diagnosis.test_artifacts (
  id                 uuid primary key default gen_random_uuid(),
  diagnostic_user_id uuid not null references diagnosis.app_users(diagnostic_user_id),
  source             text not null                           -- user_upload | wellfort_lab
                       check (source in ('user_upload','wellfort_lab')),
  test_type          text not null                           -- health_checkup|blood|genetics|cancer_urine|ai_prediction
                       check (test_type in ('health_checkup','blood','genetics','cancer_urine','ai_prediction')),
  test_date          date,
  external_test_id   text,                                   -- (b) 経由のみ
  lab_name           text,                                   -- 検査機関名
  schema_version     text not null default '1.0',
  age_at_test        int,                                    -- 年齢のみ (生年月日は保存しない)
  sex                text check (sex in ('male','female','other')),
  display_mode       text not null default 'single'          -- single | three_mode (5pg 以上で auto)
                       check (display_mode in ('single','three_mode')),
  page_count         int,
  imported_at        timestamptz not null default now(),
  imported_by        text not null,                          -- user | wellfort_batch | wellfort_manual
  status             text not null default 'active'          -- active | superseded | withdrawn
                       check (status in ('active','superseded','withdrawn')),
  notes              text,
  unique (diagnostic_user_id, source, test_type, test_date, external_test_id)
);
create index on diagnosis.test_artifacts(diagnostic_user_id, test_type, test_date desc);

-- 3) test_artifact_files — 物理ファイルへの参照
create table diagnosis.test_artifact_files (
  id                 uuid primary key default gen_random_uuid(),
  test_artifact_id   uuid not null references diagnosis.test_artifacts(id) on delete cascade,
  file_kind          text not null                           -- scan_md | summary_md | highlights_md | raw_pdf_redacted | raw_csv | extracted_json
                       check (file_kind in
                         ('scan_md','summary_md','highlights_md','raw_pdf_redacted','raw_csv','extracted_json')),
  storage_url        text not null,                          -- s3://... or supabase storage path
  sha256             text not null,
  size_bytes         bigint not null,
  llm_model          text,
  llm_generated_at   timestamptz,
  created_at         timestamptz not null default now()
);
create index on diagnosis.test_artifact_files(test_artifact_id);

-- 4) diagnosis_results — Elith AI 診断結果 (JSON)
create table diagnosis.diagnosis_results (
  id                  uuid primary key default gen_random_uuid(),
  diagnostic_user_id  uuid not null references diagnosis.app_users(diagnostic_user_id),
  diagnostic_id       uuid not null,                          -- 1 セッションの識別子
  report              jsonb not null,                         -- Elith JSON 配列
  schema_version      text not null default 'elith-v1.0',
  elith_job_id        text,
  elith_model_version text,
  received_at         timestamptz not null default now(),
  summary_text        text,                                   -- a) サマリー版 (アブストラクト原文)
  highlights_text     text,                                   -- b) 要注意抜粋 (二次抽出)
  extracted_at        timestamptz,
  extracted_by_model  text,
  status              text not null default 'received'        -- received | extracted | published | superseded
                        check (status in ('received','extracted','published','superseded')),
  unique (diagnostic_user_id, diagnostic_id)
);
create index on diagnosis.diagnosis_results(diagnostic_user_id, received_at desc);


-- ============================================================
-- updated_at auto-update trigger
-- ============================================================
create or replace function customer.touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger customer_profiles_touch_updated_at before update on customer.customer_profiles
  for each row execute function customer.touch_updated_at();
create trigger subscriptions_touch_updated_at before update on customer.subscriptions
  for each row execute function customer.touch_updated_at();

create or replace function diagnosis.touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger app_users_touch_updated_at before update on diagnosis.app_users
  for each row execute function diagnosis.touch_updated_at();
