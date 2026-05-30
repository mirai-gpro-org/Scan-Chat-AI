-- ============================================================
-- RLS (Row Level Security) — Phase 1.0 dev profile
--
-- 本番 (Phase 1.0+) では:
--   - customer 系: HP-side Edge Function (service_role) のみ書込可
--   - diagnosis 系: app_users.auth_user_id = auth.uid() の行のみ select
--
-- dev profile では:
--   - RLS を有効化するが、anon ロールに広めの policy を当てて
--     supabase studio + 開発用クライアントから動作確認できるようにする
--   - service_role は RLS bypass で全アクセス可
--   - 本番移行時に anon policy を絞る
-- ============================================================

-- Supabase 外部 (素の Postgres) で実行された時のためにロール用意 ----
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

-- すべてのテーブルで RLS 有効化 ----------------------------------
alter table customer.customer_profiles  enable row level security;
alter table customer.lab_companies      enable row level security;
alter table customer.subscription_plans enable row level security;
alter table customer.subscriptions      enable row level security;
alter table customer.kit_shipments      enable row level security;
alter table customer.lab_tests          enable row level security;

alter table diagnosis.app_users           enable row level security;
alter table diagnosis.test_artifacts      enable row level security;
alter table diagnosis.test_artifact_files enable row level security;
alter table diagnosis.diagnosis_results   enable row level security;

-- スキーマ使用権限 (Supabase の anon / authenticated に schema USAGE 必要)
grant usage on schema customer to anon, authenticated, service_role;
grant usage on schema diagnosis to anon, authenticated, service_role;
grant select on all tables in schema customer to anon, authenticated;
grant select on all tables in schema diagnosis to anon, authenticated;
grant all on all tables in schema customer to service_role;
grant all on all tables in schema diagnosis to service_role;

-- dev policy: anon / authenticated 共に read 可、write は authenticated のみ ----
-- (本番移行時に customer 系は service_role 以外の write を禁止する)

do $$
declare
  t record;
begin
  for t in
    select schemaname, tablename
    from pg_tables
    where schemaname in ('customer','diagnosis')
  loop
    execute format(
      'create policy "dev_read_all" on %I.%I for select using (true);',
      t.schemaname, t.tablename
    );
    execute format(
      'create policy "dev_authn_write" on %I.%I for all to authenticated using (true) with check (true);',
      t.schemaname, t.tablename
    );
  end loop;
end $$;
