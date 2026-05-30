-- ============================================================
-- Admin Users のデモデータ展開
--
-- 各 admin_users 行に対応する customer_profiles + app_users を作成し、
-- 物部 慶幸 (d0000001) の検査関連データ (test_artifacts, diagnosis_results,
-- kit_shipments, lab_tests, subscriptions) を各 user 用にコピー。
--
-- 実行方法:
--   Supabase Dashboard → SQL Editor → 貼り付け → Run
--
-- ベキ等性: customer_profiles と app_users は ON CONFLICT で skip。
--           検査データは「すでにコピー済かを source customer_id でチェック」
--           するため、初回のみ実行可。再実行する場合は手動 cleanup が必要。
-- ============================================================

begin;

-- ─────────────────────────────────────────────────────────────
-- 1. customer.customer_profiles に 5 admin を追加
--    user_id = admin_users.id (UUID をそのまま流用)
--    diagnostic_user_id も同じ UUID で揃える (cross-schema 名前空間別)
-- ─────────────────────────────────────────────────────────────
insert into customer.customer_profiles
  (user_id, family_name, given_name, family_name_kana, given_name_kana,
   sex, date_of_birth, email, phone, postal_code, prefecture, city, address_line,
   diagnostic_user_id, diagnostic_linked_at, google_sub) values
  ('14410d5a-d515-4fe9-9a8e-bbb1040021ac', '濱田', '太郎', 'ハマダ', 'タロウ',
   'male', '1985-04-01', 'unfix.hamada@gmail.com', '090-1100-0001', '101-0001',
   '東京都', '千代田区', '九段北1-1-1',
   '14410d5a-d515-4fe9-9a8e-bbb1040021ac', '2026-02-07', 'google_admin_hamada'),
  ('1c1ded05-6cce-4880-a5d8-3f964a43ba54', '宮澤', '真央', 'ミヤザワ', 'マオ',
   'female', '1990-08-15', 'miyazawa@wellfort.co.jp', '090-1100-0002', '060-0001',
   '北海道', '札幌市中央区', '北1条西1-1-1',
   '1c1ded05-6cce-4880-a5d8-3f964a43ba54', '2026-02-24', 'google_admin_miyazawa'),
  ('46b3651a-f14b-46bd-a24f-fe01256a1709', '新藤', '幹雄', 'シンドウ', 'ミキオ',
   'male', '1975-06-20', 'shindo@wellfort.co.jp', '090-1100-0003', '060-0002',
   '北海道', '札幌市中央区', '北2条西2-2-2',
   '46b3651a-f14b-46bd-a24f-fe01256a1709', '2026-02-24', 'google_admin_shindo'),
  ('7cbe6588-5a99-4068-9c40-5fa2427c7122', '大川', '健一郎', 'オオカワ', 'ケンイチロウ',
   'male', '1980-11-03', 'ohkawa@wellfort.co.jp', '090-1100-0004', '060-0003',
   '北海道', '札幌市中央区', '北3条西3-3-3',
   '7cbe6588-5a99-4068-9c40-5fa2427c7122', '2026-04-26', 'google_admin_ohkawa'),
  ('f9d47b45-45ad-4ffc-bad3-1bf4de130a1c', '岡部', '正寛', 'オカベ', 'マサヒロ',
   'male', '1970-02-09', 'okabe@wellfort.co.jp', '090-1100-0005', '060-0004',
   '北海道', '札幌市中央区', '北4条西4-4-4',
   'f9d47b45-45ad-4ffc-bad3-1bf4de130a1c', '2026-02-09', 'google_admin_okabe'),
  ('c0000020-0000-0000-0000-000000000000', '本田', '大作', 'ホンダ', 'ダイサク',
   'male', '1978-07-15', 'honda@wellfort.co.jp', '090-1100-0006', '060-0005',
   '北海道', '札幌市中央区', '北5条西5-5-5',
   'c0000020-0000-0000-0000-000000000000', '2026-05-30', 'google_admin_honda')
on conflict (user_id) do nothing;

-- ─────────────────────────────────────────────────────────────
-- 2. diagnosis.app_users に 5 admin を登録
-- ─────────────────────────────────────────────────────────────
insert into diagnosis.app_users
  (diagnostic_user_id, google_sub, hp_customer_user_id, display_name_cache, eligibility_checked_at) values
  ('14410d5a-d515-4fe9-9a8e-bbb1040021ac', 'google_admin_hamada',
   '14410d5a-d515-4fe9-9a8e-bbb1040021ac', '濱田様',  '2026-02-07'),
  ('1c1ded05-6cce-4880-a5d8-3f964a43ba54', 'google_admin_miyazawa',
   '1c1ded05-6cce-4880-a5d8-3f964a43ba54', '宮澤様',  '2026-02-24'),
  ('46b3651a-f14b-46bd-a24f-fe01256a1709', 'google_admin_shindo',
   '46b3651a-f14b-46bd-a24f-fe01256a1709', '新藤様',  '2026-02-24'),
  ('7cbe6588-5a99-4068-9c40-5fa2427c7122', 'google_admin_ohkawa',
   '7cbe6588-5a99-4068-9c40-5fa2427c7122', '大川様',  '2026-04-26'),
  ('f9d47b45-45ad-4ffc-bad3-1bf4de130a1c', 'google_admin_okabe',
   'f9d47b45-45ad-4ffc-bad3-1bf4de130a1c', '岡部様',  '2026-02-09'),
  ('c0000020-0000-0000-0000-000000000000', 'google_admin_honda',
   'c0000020-0000-0000-0000-000000000000', '本田様',  '2026-05-30')
on conflict (diagnostic_user_id) do nothing;

-- ─────────────────────────────────────────────────────────────
-- 3. 物部 (d0000001 / c0000001) の検査データを 5 admin にコピー
--    PL/pgSQL で 5 user × 各テーブルをループ
-- ─────────────────────────────────────────────────────────────
do $$
declare
  src_did uuid := 'd0000001-0000-0000-0000-000000000000';
  src_cid uuid := 'c0000001-0000-0000-0000-000000000000';
  target_uids uuid[] := array[
    '14410d5a-d515-4fe9-9a8e-bbb1040021ac',
    '1c1ded05-6cce-4880-a5d8-3f964a43ba54',
    '46b3651a-f14b-46bd-a24f-fe01256a1709',
    '7cbe6588-5a99-4068-9c40-5fa2427c7122',
    'f9d47b45-45ad-4ffc-bad3-1bf4de130a1c',
    'c0000020-0000-0000-0000-000000000000'
  ];
  t uuid;
  -- ループ内 subquery 用に、コピー対象のプライマリキーを管理
  src_subs uuid[]; new_subs uuid[];
  src_ships uuid[]; new_ships uuid[];
  i int;
begin
  foreach t in array target_uids loop
    -- スキップ条件: 既にこの user 用にコピー済 (artifact が 1 件でもあれば)
    if exists (select 1 from diagnosis.test_artifacts where diagnostic_user_id = t) then
      raise notice 'skip (already copied): %', t;
      continue;
    end if;

    raise notice 'copying for: %', t;

    -- 3a. subscriptions コピー (物部のサブスクをこの user に)
    insert into customer.subscriptions
      (id, customer_id, plan_id, started_at, next_test_at, last_test_at,
       current_cycle_year, current_cycle_seq, status)
    select gen_random_uuid(), t, plan_id, started_at, next_test_at, last_test_at,
           current_cycle_year, current_cycle_seq, status
    from customer.subscriptions where customer_id = src_cid;

    -- 3b. kit_shipments コピー
    insert into customer.kit_shipments
      (id, order_id, customer_id, lab_company_id, test_type,
       warehouse, shipped_at, tracking_no, carrier, carrier_tracking_url,
       expected_arrival_date, requested_arrival_date,
       user_received_at, user_returned_at, lab_received_at, lab_completed_at)
    select gen_random_uuid(),
           order_id || '-' || substring(t::text, 1, 8),
           t, lab_company_id, test_type,
           warehouse, shipped_at, tracking_no || '-' || substring(t::text, 1, 4),
           carrier, carrier_tracking_url,
           expected_arrival_date, requested_arrival_date,
           user_received_at, user_returned_at, lab_received_at, lab_completed_at
    from customer.kit_shipments where customer_id = src_cid;

    -- 3c. lab_tests コピー
    insert into customer.lab_tests
      (id, customer_id, diagnostic_user_id, lab_company_id, test_type,
       external_test_id, external_barcode, sampled_at, reported_at,
       status, workflow_used, assigned_at, assigned_by)
    select gen_random_uuid(), t, t, lab_company_id, test_type,
           external_test_id || '-' || substring(t::text, 1, 4),
           external_barcode,
           sampled_at, reported_at, status, workflow_used, assigned_at, assigned_by
    from customer.lab_tests where customer_id = src_cid;

    -- 3d. test_artifacts コピー
    insert into diagnosis.test_artifacts
      (id, diagnostic_user_id, source, test_type, test_date,
       external_test_id, lab_name, schema_version, age_at_test, sex,
       display_mode, page_count, imported_at, imported_by, status)
    select gen_random_uuid(), t, source, test_type, test_date,
           external_test_id, lab_name, schema_version, age_at_test, sex,
           display_mode, page_count, imported_at, imported_by, status
    from diagnosis.test_artifacts where diagnostic_user_id = src_did;

    -- 3e. diagnosis_results コピー (Elith JSON 含む全件)
    insert into diagnosis.diagnosis_results
      (id, diagnostic_user_id, diagnostic_id, report, schema_version,
       elith_job_id, elith_model_version, received_at, summary_text, status)
    select gen_random_uuid(), t, gen_random_uuid(), report, schema_version,
           elith_job_id, elith_model_version, received_at, summary_text, status
    from diagnosis.diagnosis_results where diagnostic_user_id = src_did;
  end loop;
end $$;

commit;

-- ─────────────────────────────────────────────────────────────
-- 確認用クエリ
-- ─────────────────────────────────────────────────────────────
-- select diagnostic_user_id, count(*) as artifacts
-- from diagnosis.test_artifacts
-- where diagnostic_user_id in (
--   '14410d5a-d515-4fe9-9a8e-bbb1040021ac',
--   '1c1ded05-6cce-4880-a5d8-3f964a43ba54',
--   '46b3651a-f14b-46bd-a24f-fe01256a1709',
--   '7cbe6588-5a99-4068-9c40-5fa2427c7122',
--   'f9d47b45-45ad-4ffc-bad3-1bf4de130a1c'
-- )
-- group by diagnostic_user_id;
-- 各 user に 6 件ずつ表示されれば成功
