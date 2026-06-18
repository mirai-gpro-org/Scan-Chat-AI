-- ============================================================
-- OEM / 相手先ブランド向け デモアカウント "山田 太郎"
--
-- 目的:
--   業務提携の相手先ブランドEC向けデモ。パートナーのマイページから
--   `/dashboard?u=da000001-0000-0000-0000-000000000000` へリンクするだけで
--   Google One Tap 認証なしでダッシュボードに着地できる (?u= があると One Tap は
--   スキップされる。src/components/GoogleOneTap.astro / src/pages/dashboard.astro 参照)。
--
--   中身は「主役テスト顧客 真鍋 (旧: 物部, d0000001)」の検査データ一式を流用し、
--   表示名だけ "山田 太郎" にしたもの。真鍋アカウント本体は一切変更しない。
--
-- 適用順:
--   1) supabase db reset  (= migrations + seed.sql。lab_companies / subscription_plans が必要)
--   2) psql ... -f supabase/demo_oem_account.sql   (このファイル)
--   3) node supabase/load_elith_demo.mjs           (フル Elith レポートを 8a000001 にも投入)
--
-- 再実行可能 (冒頭で既存デモ行を削除してから再投入する)。
--
-- ID 規約 (真鍋 → デモ):
--   customer.user_id        c0000001 → ca000001
--   diagnostic_user_id      d0000001 → da000001
--   subscription            50000001 → 5a000001
--   kit_shipments           6000000x → 6a00000x
--   lab_tests               7000000x → 7a00000x
--   test_artifacts          a000000x → aa00000x
--   diagnosis_results       8000001x → 8a00001x / 80000001 → 8a000001
-- ============================================================

begin;

-- ---------- 既存デモ行のクリーンアップ (子→親順) ----------
delete from diagnosis.diagnosis_results  where diagnostic_user_id = 'da000001-0000-0000-0000-000000000000';
delete from diagnosis.test_artifacts     where diagnostic_user_id = 'da000001-0000-0000-0000-000000000000'; -- files は ON DELETE CASCADE
delete from customer.lab_tests           where diagnostic_user_id = 'da000001-0000-0000-0000-000000000000';
delete from customer.kit_shipments       where customer_id        = 'ca000001-0000-0000-0000-000000000000';
delete from customer.subscriptions       where customer_id        = 'ca000001-0000-0000-0000-000000000000';
delete from diagnosis.app_users          where diagnostic_user_id = 'da000001-0000-0000-0000-000000000000';
delete from customer.customer_profiles   where user_id            = 'ca000001-0000-0000-0000-000000000000';

-- ---------- customer_profiles (山田 太郎) ----------
-- 年齢/性別は検査データ (age_at_test=55/56, male) と整合させるため真鍋と同じ生年月日にする。
insert into customer.customer_profiles
  (user_id, family_name, given_name, family_name_kana, given_name_kana, sex, date_of_birth, email, phone, postal_code, prefecture, city, address_line, diagnostic_user_id, diagnostic_linked_at, google_sub) values
  ('ca000001-0000-0000-0000-000000000000', '山田', '太郎', 'ヤマダ', 'タロウ', 'male', '1969-11-24', 'yamada.taro.demo@example.com', '090-1000-0001', '060-0001', '北海道', '札幌市中央区', '北1条西1丁目', 'da000001-0000-0000-0000-000000000000', '2025-12-01', 'google_sub_demo_001');

-- ---------- app_users ----------
insert into diagnosis.app_users
  (diagnostic_user_id, google_sub, hp_customer_user_id, display_name_cache, eligibility_checked_at) values
  ('da000001-0000-0000-0000-000000000000', 'google_sub_demo_001', 'ca000001-0000-0000-0000-000000000000', '山田 太郎様', '2025-12-01');

-- ---------- subscriptions (AI予測付パック) ----------
insert into customer.subscriptions
  (id, customer_id, plan_id, started_at, next_test_at, last_test_at, current_cycle_year, current_cycle_seq, status) values
  ('5a000001-0000-0000-0000-000000000000', 'ca000001-0000-0000-0000-000000000000', '1b000003-0000-0000-0000-000000000000', '2025-04-01', '2026-05-01', '2026-01-15', 2, 2, 'active');

-- ---------- kit_shipments (過去完了4件 + 進行中2件) ----------
insert into customer.kit_shipments
  (id, order_id, customer_id, lab_company_id, test_type, subscription_id, subscription_year, subscription_seq,
   warehouse, shipped_at, tracking_no, carrier, carrier_tracking_url,
   expected_arrival_date, requested_arrival_date,
   user_received_at, user_returned_at, lab_received_at, lab_completed_at) values
  ('6a000001-0000-0000-0000-000000000000', 'ORD-DEMO-001', 'ca000001-0000-0000-0000-000000000000', '1a000003-0000-0000-0000-000000000000', 'genetics',     '5a000001-0000-0000-0000-000000000000', 1, 1, 'タカセ倉庫', '2025-04-05 10:00+09', 'DEMO-0000-0000-9001', 'yamato', 'https://track.kuronekoyamato.co.jp/?no=DEMO-0000-0000-9001', '2025-04-07', null, '2025-04-07 14:00+09', '2025-04-10 09:00+09', '2025-04-14 10:00+09', '2026-02-24 15:00+09'),
  ('6a000002-0000-0000-0000-000000000000', 'ORD-DEMO-002', 'ca000001-0000-0000-0000-000000000000', '1a000001-0000-0000-0000-000000000000', 'blood',        '5a000001-0000-0000-0000-000000000000', 1, 2, 'タカセ倉庫', '2025-09-10 10:00+09', 'DEMO-0000-0000-9002', 'yamato', 'https://track.kuronekoyamato.co.jp/?no=DEMO-0000-0000-9002', '2025-09-12', null, '2025-09-12 11:00+09', '2025-09-14 09:00+09', '2025-09-17 10:00+09', '2025-09-25 15:00+09'),
  ('6a000003-0000-0000-0000-000000000000', 'ORD-DEMO-003', 'ca000001-0000-0000-0000-000000000000', '1a000001-0000-0000-0000-000000000000', 'blood',        '5a000001-0000-0000-0000-000000000000', 2, 1, 'タカセ倉庫', '2026-01-08 10:00+09', 'DEMO-0000-0000-9003', 'yamato', 'https://track.kuronekoyamato.co.jp/?no=DEMO-0000-0000-9003', '2026-01-10', null, '2026-01-10 18:00+09', '2026-01-13 09:00+09', '2026-01-15 10:00+09', '2026-01-23 15:00+09'),
  ('6a000004-0000-0000-0000-000000000000', 'ORD-DEMO-004', 'ca000001-0000-0000-0000-000000000000', '1a000002-0000-0000-0000-000000000000', 'cancer_urine', '5a000001-0000-0000-0000-000000000000', 2, 1, 'タカセ倉庫', '2026-01-08 10:00+09', 'DEMO-0000-0000-9004', 'yamato', 'https://track.kuronekoyamato.co.jp/?no=DEMO-0000-0000-9004', '2026-01-10', null, '2026-01-10 18:00+09', '2026-01-12 09:00+09', '2026-01-15 10:00+09', '2026-01-25 15:00+09'),
  -- 進行中: 発送済・未受取 → 「📦 受け取りました」ボタン表示
  ('6a000005-0000-0000-0000-000000000000', 'ORD-DEMO-010', 'ca000001-0000-0000-0000-000000000000', '1a000001-0000-0000-0000-000000000000', 'blood',        '5a000001-0000-0000-0000-000000000000', 2, 2, 'タカセ倉庫', '2026-05-26 10:00+09', 'DEMO-0000-0000-9020', 'yamato', 'https://track.kuronekoyamato.co.jp/?no=DEMO-0000-0000-9020', '2026-05-29', '2026-05-29', null, null, null, null),
  -- 進行中: 受取済・未返送 → 「💉 返送しました」ボタン表示
  ('6a000006-0000-0000-0000-000000000000', 'ORD-DEMO-011', 'ca000001-0000-0000-0000-000000000000', '1a000002-0000-0000-0000-000000000000', 'cancer_urine', '5a000001-0000-0000-0000-000000000000', 2, 2, 'タカセ倉庫', '2026-05-22 10:00+09', 'DEMO-0000-0000-9021', 'yamato', 'https://track.kuronekoyamato.co.jp/?no=DEMO-0000-0000-9021', '2026-05-24', null, '2026-05-25 10:00+09', null, null, null);

-- ---------- lab_tests ----------
insert into customer.lab_tests
  (id, shipment_id, customer_id, diagnostic_user_id, lab_company_id, test_type,
   external_test_id, external_barcode, sampled_at, reported_at, status, workflow_used, assigned_at, assigned_by) values
  ('7a000001-0000-0000-0000-000000000000', '6a000001-0000-0000-0000-000000000000', 'ca000001-0000-0000-0000-000000000000', 'da000001-0000-0000-0000-000000000000', '1a000003-0000-0000-0000-000000000000', 'genetics',     'DEMO-MNBO-YMDA', null,        '2025-04-10', '2026-02-24', 'imported', 2, '2026-02-25 10:00+09', 'auto_lookup'),
  ('7a000002-0000-0000-0000-000000000000', '6a000002-0000-0000-0000-000000000000', 'ca000001-0000-0000-0000-000000000000', 'da000001-0000-0000-0000-000000000000', '1a000001-0000-0000-0000-000000000000', 'blood',        'RG-2026-009001', null,        '2025-09-14', '2025-09-25', 'imported', 2, '2025-09-26 10:00+09', 'auto_lookup'),
  ('7a000003-0000-0000-0000-000000000000', '6a000003-0000-0000-0000-000000000000', 'ca000001-0000-0000-0000-000000000000', 'da000001-0000-0000-0000-000000000000', '1a000001-0000-0000-0000-000000000000', 'blood',        'RG-2026-009002', null,        '2026-01-13', '2026-01-23', 'imported', 2, '2026-01-24 10:00+09', 'auto_lookup'),
  ('7a000004-0000-0000-0000-000000000000', '6a000004-0000-0000-0000-000000000000', 'ca000001-0000-0000-0000-000000000000', 'da000001-0000-0000-0000-000000000000', '1a000002-0000-0000-0000-000000000000', 'cancer_urine', 'K9002',          '702009002', '2026-01-12', '2026-01-25', 'imported', 2, '2026-01-26 10:00+09', 'auto_lookup');

-- ---------- test_artifacts (真鍋の6成果物を流用) ----------
insert into diagnosis.test_artifacts
  (id, diagnostic_user_id, source, test_type, test_date, external_test_id, lab_name, schema_version, age_at_test, sex, display_mode, page_count, imported_at, imported_by, status) values
  ('aa000001-0000-0000-0000-000000000000', 'da000001-0000-0000-0000-000000000000', 'wellfort_lab', 'genetics',      '2025-04-10', 'DEMO-MNBO-YMDA',   'ジェノプランジャパン',     '1.0', 55, 'male', 'three_mode', 207, '2026-02-25 10:00+09', 'wellfort_batch', 'active'),
  ('aa000002-0000-0000-0000-000000000000', 'da000001-0000-0000-0000-000000000000', 'wellfort_lab', 'blood',         '2025-09-14', 'RG-2026-009001',   'リージャーラボラトリー',   '1.0', 55, 'male', 'single',     1,   '2025-09-26 10:00+09', 'wellfort_batch', 'active'),
  ('aa000003-0000-0000-0000-000000000000', 'da000001-0000-0000-0000-000000000000', 'wellfort_lab', 'blood',         '2026-01-13', 'RG-2026-009002',   'リージャーラボラトリー',   '1.0', 56, 'male', 'single',     1,   '2026-01-24 10:00+09', 'wellfort_batch', 'active'),
  ('aa000004-0000-0000-0000-000000000000', 'da000001-0000-0000-0000-000000000000', 'wellfort_lab', 'cancer_urine',  '2026-01-12', 'K9002',            'PREVENT メディカル',       '1.0', 56, 'male', 'single',     3,   '2026-01-26 10:00+09', 'wellfort_batch', 'active'),
  ('aa000005-0000-0000-0000-000000000000', 'da000001-0000-0000-0000-000000000000', 'user_upload',  'health_checkup','2025-06-15', null,               '某総合病院 (ユーザー UL)', '1.0', 55, 'male', 'three_mode', 8,   '2025-06-20 14:30+09', 'user',           'active'),
  ('aa000006-0000-0000-0000-000000000000', 'da000001-0000-0000-0000-000000000000', 'wellfort_lab', 'ai_prediction', '2024-09-12', 'LAIF-2026-09-001', 'LAiF',                     '1.0', 54, 'male', 'three_mode', 9,   '2024-09-15 10:00+09', 'wellfort_batch', 'active');

-- ---------- test_artifact_files ----------
insert into diagnosis.test_artifact_files
  (test_artifact_id, file_kind, storage_url, sha256, size_bytes, llm_model, llm_generated_at) values
  -- aa000001 (遺伝子: three_mode)
  ('aa000001-0000-0000-0000-000000000000', 'summary_md',       's3://wellfort-diagnosis/normalized/da000001/2025-04-10/genetics_summary.md',       repeat('a',64), 5200,    'gemini-2.5-flash', '2026-02-25 10:05+09'),
  ('aa000001-0000-0000-0000-000000000000', 'highlights_md',    's3://wellfort-diagnosis/normalized/da000001/2025-04-10/genetics_highlights.md',    repeat('b',64), 3100,    'gemini-2.5-flash', '2026-02-25 10:06+09'),
  ('aa000001-0000-0000-0000-000000000000', 'raw_pdf_redacted', 's3://wellfort-diagnosis/raw/da000001/genetics/DEMO-MNBO-YMDA.pdf',                 repeat('c',64), 8707569, null,               null),
  ('aa000001-0000-0000-0000-000000000000', 'extracted_json',   's3://wellfort-diagnosis/normalized/da000001/2025-04-10/genetics_extracted.json',  repeat('d',64), 18400,   'gemini-2.5-flash', '2026-02-25 10:07+09'),
  -- aa000002 (血液 1回目)
  ('aa000002-0000-0000-0000-000000000000', 'scan_md',          's3://wellfort-diagnosis/normalized/da000001/2025-09-14/blood.md',                  repeat('e',64), 2400,    'gemini-2.5-flash', '2025-09-26 10:05+09'),
  ('aa000002-0000-0000-0000-000000000000', 'raw_csv',          's3://wellfort-customer/lab_intake/1a000001/2025-09-25/RG-2026-009001.csv',         repeat('f',64), 1800,    null,               null),
  -- aa000003 (血液 2回目)
  ('aa000003-0000-0000-0000-000000000000', 'scan_md',          's3://wellfort-diagnosis/normalized/da000001/2026-01-13/blood.md',                  repeat('1',64), 2500,    'gemini-2.5-flash', '2026-01-24 10:05+09'),
  ('aa000003-0000-0000-0000-000000000000', 'raw_csv',          's3://wellfort-customer/lab_intake/1a000001/2026-01-23/RG-2026-009002.csv',         repeat('2',64), 1900,    null,               null),
  -- aa000004 (がんリスク)
  ('aa000004-0000-0000-0000-000000000000', 'scan_md',          's3://wellfort-diagnosis/normalized/da000001/2026-01-12/cancer_urine.md',           repeat('3',64), 1500,    'gemini-2.5-flash', '2026-01-26 10:05+09'),
  ('aa000004-0000-0000-0000-000000000000', 'raw_pdf_redacted', 's3://wellfort-diagnosis/raw/da000001/cancer_urine/K9002.pdf',                      repeat('4',64), 813693,  null,               null),
  -- aa000005 (ユーザー UL 人間ドック)
  ('aa000005-0000-0000-0000-000000000000', 'scan_md',          's3://wellfort-diagnosis/normalized/da000001/2025-06-15/health_checkup.md',         repeat('5',64), 4800,    'gemini-2.5-flash', '2025-06-20 14:35+09'),
  ('aa000005-0000-0000-0000-000000000000', 'summary_md',       's3://wellfort-diagnosis/normalized/da000001/2025-06-15/health_checkup_summary.md', repeat('6',64), 1200,    'gemini-2.5-flash', '2025-06-20 14:36+09'),
  ('aa000005-0000-0000-0000-000000000000', 'raw_pdf_redacted', 's3://wellfort-diagnosis/raw/da000001/health_checkup/2025-06-15.pdf',               repeat('7',64), 2200000, null,               null),
  -- aa000006 (AI 予測)
  ('aa000006-0000-0000-0000-000000000000', 'scan_md',          's3://wellfort-diagnosis/normalized/da000001/2024-09-12/ai_prediction.md',          repeat('8',64), 2900,    'gemini-2.5-flash', '2024-09-15 10:05+09'),
  ('aa000006-0000-0000-0000-000000000000', 'summary_md',       's3://wellfort-diagnosis/normalized/da000001/2024-09-12/ai_prediction_summary.md',  repeat('9',64), 900,     'gemini-2.5-flash', '2024-09-15 10:06+09'),
  ('aa000006-0000-0000-0000-000000000000', 'raw_pdf_redacted', 's3://wellfort-diagnosis/raw/da000001/ai_prediction/LAIF-2026-09-001.pdf',          repeat('0',64), 3154653, null,               null);

-- ---------- diagnosis_results (数値推移3件 + 最新1件) ----------
-- 最新 (8a000001) は load_elith_demo.mjs がフル Elith JSON で上書きする。
insert into diagnosis.diagnosis_results
  (id, diagnostic_user_id, diagnostic_id, report, schema_version, elith_job_id, elith_model_version, received_at, summary_text, status) values
  ('8a000010-0000-0000-0000-000000000000', 'da000001-0000-0000-0000-000000000000', '7a001010-0000-0000-0000-000000000000',
   '[{"section_name":"検査値フィードバック","char_count":150,"text":"今回の検査値フィードバックです。尿酸は6.5 mg/dl（基準値: ~7.0）でほぼ基準内です。最高血圧は138 mmHg、最低血圧は88 mmHgでやや高めです。空腹時血糖が95 mg/dl（基準値: ~99）と良好です。"}]'::jsonb,
   'elith-v1.0', 'elith-job-demo-2025-04-14-001', 'gemma4-med-v1.0',
   '2025-04-14 12:00+09', '血圧やや高 / 尿酸良好 / 空腹時血糖良好', 'published'),
  ('8a000011-0000-0000-0000-000000000000', 'da000001-0000-0000-0000-000000000000', '7a001011-0000-0000-0000-000000000000',
   '[{"section_name":"検査値フィードバック","char_count":150,"text":"今回の検査値フィードバックです。尿酸は7.0 mg/dl（基準値: ~7.0）で基準値ぎりぎりです。最高血圧は135 mmHg、最低血圧は86 mmHgでやや高めです。空腹時血糖が98 mg/dl（基準値: ~99）と良好です。"}]'::jsonb,
   'elith-v1.0', 'elith-job-demo-2025-09-25-001', 'gemma4-med-v1.1',
   '2025-09-25 12:00+09', '尿酸 上昇傾向 / 血圧やや高 / 空腹時血糖良好', 'published'),
  ('8a000012-0000-0000-0000-000000000000', 'da000001-0000-0000-0000-000000000000', '7a001012-0000-0000-0000-000000000000',
   '[{"section_name":"検査値フィードバック","char_count":150,"text":"今回の検査値フィードバックです。尿酸は7.8 mg/dl（基準値: ~7.0）で基準を超えました。最高血圧は133 mmHg、最低血圧は85 mmHgでやや高めです。空腹時血糖が102 mg/dl（基準値: ~99）で境界域に入りました。"}]'::jsonb,
   'elith-v1.0', 'elith-job-demo-2026-01-23-001', 'gemma4-med-v1.1',
   '2026-01-23 12:00+09', '尿酸 基準超え / 血圧やや高 / 空腹時血糖 境界域', 'published'),
  ('8a000001-0000-0000-0000-000000000000', 'da000001-0000-0000-0000-000000000000', '7a001003-0000-0000-0000-000000000000',
   '[{"section_name":"アブストラクト","char_count":120,"text":"血圧が改善されました。日々の工夫が実を結び、頑張りましたね。一方で、尿酸値や空腹時血糖、腎機能の数値に注意が必要な状態です。"},{"section_name":"医療受診の目安","char_count":80,"text":"眼底検査で緑内障の疑いが指摘されましたので、今週中に眼科での精密検査を強くお勧めします。"}]'::jsonb,
   'elith-v1.0', 'elith-job-demo-2026-01-24-001', 'gemma4-med-v1.2',
   '2026-01-24 12:00+09', '血圧改善 / 尿酸・腎機能要注意 / 緑内障精密検査推奨', 'extracted');

commit;

-- 確認:
--   select family_name, given_name, diagnostic_user_id from customer.customer_profiles where user_id='ca000001-0000-0000-0000-000000000000';
--   着地URL: /dashboard?u=da000001-0000-0000-0000-000000000000
