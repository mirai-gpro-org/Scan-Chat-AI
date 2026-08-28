-- 検査値テストレコード (STEP 2 / 発注者承認 2026-08-20)。
-- 目的: 時系列グラフ・ウェルネス年齢カード・空状態を、実データ経路で確認できるようにする。
--
-- 【原則1】Elith と各検査機関が実際に返すものだけを入れる。判定レベル・生活指導文は入れない
--          (アプリが作るものではないため。入れられない=UIにも作れない)。
-- 【原則2】医学的に成立する値にする。生成時に Friedewald(TC≒LDL+HDL+TG/5)・LDL+HDL<=TC・
--          eGFR は日本人向け推算式から導出 (生成器で計算)。
-- 【原則3】PII を入れない。diagnostic_user_id のみ。氏名は customer スキーマ側にのみ存在する。
--
-- 基準値は「テストデータ用の代表値」。実運用では検査機関の帳票由来の値をそのまま格納する
-- (アプリが基準値を決めない)。canonical_name は standard-master.ts の実在名のみ。
-- アルブミン/CRP/MCV は master 未収録のため canonical_name=null (非ヒット経路の検証用)。
--
-- 冪等: 本ファイルは何度流しても同じ結果になる (artifact は on conflict do nothing、
--       measurement_values は artifact 単位で delete→insert)。

-- ── ① 血液検査 artifact (既存に無い日付だけ追加) ────────────────────────
insert into diagnosis.test_artifacts
  (diagnostic_user_id, source, test_type, test_date, external_test_id, lab_name,
   schema_version, age_at_test, sex, display_mode, page_count, imported_at, imported_by, status) values
  ('d0000001-0000-0000-0000-000000000000', 'wellfort_lab', 'blood', '2025-01-20', 'RG-2025-000118', 'リージャーラボラトリー', '1.0', 55, 'male', 'single', 1, '2025-01-20 10:00+09', 'wellfort_batch', 'active'),
  ('d0000001-0000-0000-0000-000000000000', 'wellfort_lab', 'blood', '2025-05-19', 'RG-2025-000642', 'リージャーラボラトリー', '1.0', 55, 'male', 'single', 1, '2025-05-19 10:00+09', 'wellfort_batch', 'active'),
  ('d0000001-0000-0000-0000-000000000000', 'wellfort_lab', 'blood', '2025-09-14', 'RG-2025-001234', 'リージャーラボラトリー', '1.0', 55, 'male', 'single', 1, '2025-09-14 10:00+09', 'wellfort_batch', 'active'),
  ('d0000001-0000-0000-0000-000000000000', 'wellfort_lab', 'blood', '2026-01-13', 'RG-2026-001045', 'リージャーラボラトリー', '1.0', 56, 'male', 'single', 1, '2026-01-13 10:00+09', 'wellfort_batch', 'active'),
  ('d0000001-0000-0000-0000-000000000000', 'wellfort_lab', 'blood', '2026-05-18', 'RG-2026-001588', 'リージャーラボラトリー', '1.0', 56, 'male', 'single', 1, '2026-05-18 10:00+09', 'wellfort_batch', 'active'),
  ('d0000002-0000-0000-0000-000000000000', 'wellfort_lab', 'blood', '2025-04-15', 'RG-2025-000455', 'リージャーラボラトリー', '1.0', 41, 'female', 'single', 1, '2025-04-15 10:00+09', 'wellfort_batch', 'active'),
  ('d0000002-0000-0000-0000-000000000000', 'wellfort_lab', 'blood', '2025-12-19', 'RG-2025-019876', 'リージャーラボラトリー', '1.0', 41, 'female', 'single', 1, '2025-12-19 10:00+09', 'wellfort_batch', 'active'),
  ('d0000002-0000-0000-0000-000000000000', 'wellfort_lab', 'blood', '2026-04-14', 'RG-2026-001402', 'リージャーラボラトリー', '1.0', 42, 'female', 'single', 1, '2026-04-14 10:00+09', 'wellfort_batch', 'active'),
  ('d0000003-0000-0000-0000-000000000000', 'wellfort_lab', 'blood', '2025-03-06', 'RG-2025-000301', 'リージャーラボラトリー', '1.0', 66, 'male', 'single', 1, '2025-03-06 10:00+09', 'wellfort_batch', 'active'),
  ('d0000003-0000-0000-0000-000000000000', 'wellfort_lab', 'blood', '2025-09-03', 'RG-2025-001180', 'リージャーラボラトリー', '1.0', 67, 'male', 'single', 1, '2025-09-03 10:00+09', 'wellfort_batch', 'active'),
  ('d0000003-0000-0000-0000-000000000000', 'wellfort_lab', 'blood', '2026-03-05', 'RG-2026-002500', 'リージャーラボラトリー', '1.0', 67, 'male', 'single', 1, '2026-03-05 10:00+09', 'wellfort_batch', 'active'),
  ('d0000003-0000-0000-0000-000000000000', 'wellfort_lab', 'blood', '2026-07-15', 'RG-2026-001905', 'リージャーラボラトリー', '1.0', 68, 'male', 'single', 1, '2026-07-15 10:00+09', 'wellfort_batch', 'active')
on conflict (diagnostic_user_id, source, test_type, test_date, external_test_id) do nothing;

-- ── ② 検査値 (原本忠実 jsonb + 正規化行) ────────────────────────────────
-- artifact は (diagnostic_user_id, test_type, test_date) で突合する (id をハードコードしない)。

-- 2025-01-20  (d0000001)
update diagnosis.test_artifacts set measurements = '[{"name": "白血球数", "value": "6200", "value_num": 6200.0, "unit": "/μL", "ref_low": "3300", "ref_high": "8600", "flag": null}, {"name": "赤血球数", "value": "478", "value_num": 478.0, "unit": "万/μL", "ref_low": "400", "ref_high": "539", "flag": null}, {"name": "血色素量", "value": "15.1", "value_num": 15.1, "unit": "g/dL", "ref_low": "13.7", "ref_high": "16.8", "flag": null}, {"name": "ヘマトクリット", "value": "45.2", "value_num": 45.2, "unit": "%", "ref_low": "40.7", "ref_high": "50.1", "flag": null}, {"name": "血小板数", "value": "24.1", "value_num": 24.1, "unit": "万/μL", "ref_low": "15.8", "ref_high": "34.8", "flag": null}, {"name": "総蛋白", "value": "7.3", "value_num": 7.3, "unit": "g/dL", "ref_low": "6.6", "ref_high": "8.1", "flag": null}, {"name": "アルブミン", "value": "4.4", "value_num": 4.4, "unit": "g/dL", "ref_low": "4.1", "ref_high": "5.1", "flag": null}, {"name": "GOT(AST)", "value": "24", "value_num": 24.0, "unit": "U/L", "ref_low": "13", "ref_high": "30", "flag": null}, {"name": "GPT(ALT)", "value": "27", "value_num": 27.0, "unit": "U/L", "ref_low": "10", "ref_high": "42", "flag": null}, {"name": "γ-GTP", "value": "62", "value_num": 62.0, "unit": "U/L", "ref_low": "13", "ref_high": "64", "flag": null}, {"name": "ALP", "value": "71", "value_num": 71.0, "unit": "U/L", "ref_low": "38", "ref_high": "113", "flag": null}, {"name": "総コレステロール", "value": "209", "value_num": 209.0, "unit": "mg/dL", "ref_low": "130", "ref_high": "219", "flag": null}, {"name": "HDLコレステロール", "value": "52", "value_num": 52.0, "unit": "mg/dL", "ref_low": "40", "ref_high": null, "flag": null}, {"name": "LDLコレステロール", "value": "128", "value_num": 128.0, "unit": "mg/dL", "ref_low": "60", "ref_high": "119", "flag": "H"}, {"name": "空腹時中性脂肪", "value": "145", "value_num": 145.0, "unit": "mg/dL", "ref_low": "30", "ref_high": "149", "flag": null}, {"name": "空腹時血糖", "value": "106", "value_num": 106.0, "unit": "mg/dL", "ref_low": "73", "ref_high": "109", "flag": null}, {"name": "HbA1c(NGSP)", "value": "5.9", "value_num": 5.9, "unit": "%", "ref_low": "4.6", "ref_high": "6.2", "flag": null}, {"name": "クレアチニン", "value": "0.92", "value_num": 0.92, "unit": "mg/dL", "ref_low": "0.65", "ref_high": "1.07", "flag": null}, {"name": "eGFR", "value": "67.3", "value_num": 67.3, "unit": "mL/min/1.73m²", "ref_low": "60", "ref_high": null, "flag": null}, {"name": "尿酸", "value": "7.2", "value_num": 7.2, "unit": "mg/dL", "ref_low": "3.7", "ref_high": "7.8", "flag": null}, {"name": "CRP", "value": "0.06", "value_num": 0.06, "unit": "mg/dL", "ref_low": "0.00", "ref_high": "0.14", "flag": null}, {"name": "MCV", "value": "94.6", "value_num": 94.6, "unit": "fL", "ref_low": "83.6", "ref_high": "98.2", "flag": null}]'::jsonb
 where diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and test_type = 'blood' and test_date = '2025-01-20';
delete from diagnosis.measurement_values mv using diagnosis.test_artifacts ta
 where mv.artifact_id = ta.id and ta.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2025-01-20';
insert into diagnosis.measurement_values
  (artifact_id, diagnostic_user_id, test_type, test_date, seq, item_name, canonical_name,
   value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag, source_file_kind)
select ta.id, ta.diagnostic_user_id, ta.test_type, ta.test_date, v.seq, v.item_name, v.canonical_name,
       v.value, v.value_num, v.unit, v.ref_low, v.ref_high, v.ref_low_num, v.ref_high_num, v.flag, 'raw_csv'
  from diagnosis.test_artifacts ta,
  (values
    (0, '白血球数', '白血球数', '6200', 6200.0, '/μL', '3300', '8600', 3300.0, 8600.0, null),
    (1, '赤血球数', '赤血球数', '478', 478.0, '万/μL', '400', '539', 400.0, 539.0, null),
    (2, '血色素量', '血色素量', '15.1', 15.1, 'g/dL', '13.7', '16.8', 13.7, 16.8, null),
    (3, 'ヘマトクリット', 'ヘマトクリット', '45.2', 45.2, '%', '40.7', '50.1', 40.7, 50.1, null),
    (4, '血小板数', '血小板数', '24.1', 24.1, '万/μL', '15.8', '34.8', 15.8, 34.8, null),
    (5, '総蛋白', '総蛋白', '7.3', 7.3, 'g/dL', '6.6', '8.1', 6.6, 8.1, null),
    (6, 'アルブミン', null, '4.4', 4.4, 'g/dL', '4.1', '5.1', 4.1, 5.1, null),
    (7, 'GOT(AST)', 'GOT(AST)', '24', 24.0, 'U/L', '13', '30', 13.0, 30.0, null),
    (8, 'GPT(ALT)', 'GPT(ALT)', '27', 27.0, 'U/L', '10', '42', 10.0, 42.0, null),
    (9, 'γ-GTP', 'γ-GTP', '62', 62.0, 'U/L', '13', '64', 13.0, 64.0, null),
    (10, 'ALP', 'ALP', '71', 71.0, 'U/L', '38', '113', 38.0, 113.0, null),
    (11, '総コレステロール', '総コレステロール', '209', 209.0, 'mg/dL', '130', '219', 130.0, 219.0, null),
    (12, 'HDLコレステロール', 'HDLコレステロール', '52', 52.0, 'mg/dL', '40', null, 40.0, null, null),
    (13, 'LDLコレステロール', 'LDLコレステロール', '128', 128.0, 'mg/dL', '60', '119', 60.0, 119.0, 'H'),
    (14, '空腹時中性脂肪', '空腹時中性脂肪', '145', 145.0, 'mg/dL', '30', '149', 30.0, 149.0, null),
    (15, '空腹時血糖', '空腹時血糖', '106', 106.0, 'mg/dL', '73', '109', 73.0, 109.0, null),
    (16, 'HbA1c(NGSP)', 'HbA1c(NGSP)', '5.9', 5.9, '%', '4.6', '6.2', 4.6, 6.2, null),
    (17, 'クレアチニン', 'クレアチニン', '0.92', 0.92, 'mg/dL', '0.65', '1.07', 0.65, 1.07, null),
    (18, 'eGFR', 'eGFR', '67.3', 67.3, 'mL/min/1.73m²', '60', null, 60.0, null, null),
    (19, '尿酸', '尿酸', '7.2', 7.2, 'mg/dL', '3.7', '7.8', 3.7, 7.8, null),
    (20, 'CRP', null, '0.06', 0.06, 'mg/dL', '0.00', '0.14', 0.0, 0.14, null),
    (21, 'MCV', null, '94.6', 94.6, 'fL', '83.6', '98.2', 83.6, 98.2, null)
  ) as v(seq, item_name, canonical_name, value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag)
 where ta.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2025-01-20';

-- 2025-05-19  (d0000001)
update diagnosis.test_artifacts set measurements = '[{"name": "白血球数", "value": "6500", "value_num": 6500.0, "unit": "/μL", "ref_low": "3300", "ref_high": "8600", "flag": null}, {"name": "赤血球数", "value": "474", "value_num": 474.0, "unit": "万/μL", "ref_low": "400", "ref_high": "539", "flag": null}, {"name": "血色素量", "value": "15", "value_num": 15.0, "unit": "g/dL", "ref_low": "13.7", "ref_high": "16.8", "flag": null}, {"name": "ヘマトクリット", "value": "44.8", "value_num": 44.8, "unit": "%", "ref_low": "40.7", "ref_high": "50.1", "flag": null}, {"name": "血小板数", "value": "23.6", "value_num": 23.6, "unit": "万/μL", "ref_low": "15.8", "ref_high": "34.8", "flag": null}, {"name": "総蛋白", "value": "7.2", "value_num": 7.2, "unit": "g/dL", "ref_low": "6.6", "ref_high": "8.1", "flag": null}, {"name": "アルブミン", "value": "4.3", "value_num": 4.3, "unit": "g/dL", "ref_low": "4.1", "ref_high": "5.1", "flag": null}, {"name": "GOT(AST)", "value": "26", "value_num": 26.0, "unit": "U/L", "ref_low": "13", "ref_high": "30", "flag": null}, {"name": "GPT(ALT)", "value": "31", "value_num": 31.0, "unit": "U/L", "ref_low": "10", "ref_high": "42", "flag": null}, {"name": "γ-GTP", "value": "71", "value_num": 71.0, "unit": "U/L", "ref_low": "13", "ref_high": "64", "flag": "H"}, {"name": "ALP", "value": "74", "value_num": 74.0, "unit": "U/L", "ref_low": "38", "ref_high": "113", "flag": null}, {"name": "総コレステロール", "value": "214", "value_num": 214.0, "unit": "mg/dL", "ref_low": "130", "ref_high": "219", "flag": null}, {"name": "HDLコレステロール", "value": "50", "value_num": 50.0, "unit": "mg/dL", "ref_low": "40", "ref_high": null, "flag": null}, {"name": "LDLコレステロール", "value": "132", "value_num": 132.0, "unit": "mg/dL", "ref_low": "60", "ref_high": "119", "flag": "H"}, {"name": "空腹時中性脂肪", "value": "158", "value_num": 158.0, "unit": "mg/dL", "ref_low": "30", "ref_high": "149", "flag": "H"}, {"name": "空腹時血糖", "value": "109", "value_num": 109.0, "unit": "mg/dL", "ref_low": "73", "ref_high": "109", "flag": null}, {"name": "HbA1c(NGSP)", "value": "6", "value_num": 6.0, "unit": "%", "ref_low": "4.6", "ref_high": "6.2", "flag": null}, {"name": "クレアチニン", "value": "0.94", "value_num": 0.94, "unit": "mg/dL", "ref_low": "0.65", "ref_high": "1.07", "flag": null}, {"name": "eGFR", "value": "65.7", "value_num": 65.7, "unit": "mL/min/1.73m²", "ref_low": "60", "ref_high": null, "flag": null}, {"name": "尿酸", "value": "7.4", "value_num": 7.4, "unit": "mg/dL", "ref_low": "3.7", "ref_high": "7.8", "flag": null}, {"name": "CRP", "value": "0.08", "value_num": 0.08, "unit": "mg/dL", "ref_low": "0.00", "ref_high": "0.14", "flag": null}, {"name": "MCV", "value": "94.5", "value_num": 94.5, "unit": "fL", "ref_low": "83.6", "ref_high": "98.2", "flag": null}]'::jsonb
 where diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and test_type = 'blood' and test_date = '2025-05-19';
delete from diagnosis.measurement_values mv using diagnosis.test_artifacts ta
 where mv.artifact_id = ta.id and ta.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2025-05-19';
insert into diagnosis.measurement_values
  (artifact_id, diagnostic_user_id, test_type, test_date, seq, item_name, canonical_name,
   value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag, source_file_kind)
select ta.id, ta.diagnostic_user_id, ta.test_type, ta.test_date, v.seq, v.item_name, v.canonical_name,
       v.value, v.value_num, v.unit, v.ref_low, v.ref_high, v.ref_low_num, v.ref_high_num, v.flag, 'raw_csv'
  from diagnosis.test_artifacts ta,
  (values
    (0, '白血球数', '白血球数', '6500', 6500.0, '/μL', '3300', '8600', 3300.0, 8600.0, null),
    (1, '赤血球数', '赤血球数', '474', 474.0, '万/μL', '400', '539', 400.0, 539.0, null),
    (2, '血色素量', '血色素量', '15', 15.0, 'g/dL', '13.7', '16.8', 13.7, 16.8, null),
    (3, 'ヘマトクリット', 'ヘマトクリット', '44.8', 44.8, '%', '40.7', '50.1', 40.7, 50.1, null),
    (4, '血小板数', '血小板数', '23.6', 23.6, '万/μL', '15.8', '34.8', 15.8, 34.8, null),
    (5, '総蛋白', '総蛋白', '7.2', 7.2, 'g/dL', '6.6', '8.1', 6.6, 8.1, null),
    (6, 'アルブミン', null, '4.3', 4.3, 'g/dL', '4.1', '5.1', 4.1, 5.1, null),
    (7, 'GOT(AST)', 'GOT(AST)', '26', 26.0, 'U/L', '13', '30', 13.0, 30.0, null),
    (8, 'GPT(ALT)', 'GPT(ALT)', '31', 31.0, 'U/L', '10', '42', 10.0, 42.0, null),
    (9, 'γ-GTP', 'γ-GTP', '71', 71.0, 'U/L', '13', '64', 13.0, 64.0, 'H'),
    (10, 'ALP', 'ALP', '74', 74.0, 'U/L', '38', '113', 38.0, 113.0, null),
    (11, '総コレステロール', '総コレステロール', '214', 214.0, 'mg/dL', '130', '219', 130.0, 219.0, null),
    (12, 'HDLコレステロール', 'HDLコレステロール', '50', 50.0, 'mg/dL', '40', null, 40.0, null, null),
    (13, 'LDLコレステロール', 'LDLコレステロール', '132', 132.0, 'mg/dL', '60', '119', 60.0, 119.0, 'H'),
    (14, '空腹時中性脂肪', '空腹時中性脂肪', '158', 158.0, 'mg/dL', '30', '149', 30.0, 149.0, 'H'),
    (15, '空腹時血糖', '空腹時血糖', '109', 109.0, 'mg/dL', '73', '109', 73.0, 109.0, null),
    (16, 'HbA1c(NGSP)', 'HbA1c(NGSP)', '6', 6.0, '%', '4.6', '6.2', 4.6, 6.2, null),
    (17, 'クレアチニン', 'クレアチニン', '0.94', 0.94, 'mg/dL', '0.65', '1.07', 0.65, 1.07, null),
    (18, 'eGFR', 'eGFR', '65.7', 65.7, 'mL/min/1.73m²', '60', null, 60.0, null, null),
    (19, '尿酸', '尿酸', '7.4', 7.4, 'mg/dL', '3.7', '7.8', 3.7, 7.8, null),
    (20, 'CRP', null, '0.08', 0.08, 'mg/dL', '0.00', '0.14', 0.0, 0.14, null),
    (21, 'MCV', null, '94.5', 94.5, 'fL', '83.6', '98.2', 83.6, 98.2, null)
  ) as v(seq, item_name, canonical_name, value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag)
 where ta.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2025-05-19';

-- 2025-09-14  (d0000001)
update diagnosis.test_artifacts set measurements = '[{"name": "白血球数", "value": "6300", "value_num": 6300.0, "unit": "/μL", "ref_low": "3300", "ref_high": "8600", "flag": null}, {"name": "赤血球数", "value": "476", "value_num": 476.0, "unit": "万/μL", "ref_low": "400", "ref_high": "539", "flag": null}, {"name": "血色素量", "value": "15.1", "value_num": 15.1, "unit": "g/dL", "ref_low": "13.7", "ref_high": "16.8", "flag": null}, {"name": "ヘマトクリット", "value": "45", "value_num": 45.0, "unit": "%", "ref_low": "40.7", "ref_high": "50.1", "flag": null}, {"name": "血小板数", "value": "23.9", "value_num": 23.9, "unit": "万/μL", "ref_low": "15.8", "ref_high": "34.8", "flag": null}, {"name": "総蛋白", "value": "7.3", "value_num": 7.3, "unit": "g/dL", "ref_low": "6.6", "ref_high": "8.1", "flag": null}, {"name": "アルブミン", "value": "4.4", "value_num": 4.4, "unit": "g/dL", "ref_low": "4.1", "ref_high": "5.1", "flag": null}, {"name": "GOT(AST)", "value": "25", "value_num": 25.0, "unit": "U/L", "ref_low": "13", "ref_high": "30", "flag": null}, {"name": "GPT(ALT)", "value": "29", "value_num": 29.0, "unit": "U/L", "ref_low": "10", "ref_high": "42", "flag": null}, {"name": "γ-GTP", "value": "68", "value_num": 68.0, "unit": "U/L", "ref_low": "13", "ref_high": "64", "flag": "H"}, {"name": "ALP", "value": "72", "value_num": 72.0, "unit": "U/L", "ref_low": "38", "ref_high": "113", "flag": null}, {"name": "総コレステロール", "value": "211", "value_num": 211.0, "unit": "mg/dL", "ref_low": "130", "ref_high": "219", "flag": null}, {"name": "HDLコレステロール", "value": "51", "value_num": 51.0, "unit": "mg/dL", "ref_low": "40", "ref_high": null, "flag": null}, {"name": "LDLコレステロール", "value": "130", "value_num": 130.0, "unit": "mg/dL", "ref_low": "60", "ref_high": "119", "flag": "H"}, {"name": "空腹時中性脂肪", "value": "150", "value_num": 150.0, "unit": "mg/dL", "ref_low": "30", "ref_high": "149", "flag": "H"}, {"name": "空腹時血糖", "value": "108", "value_num": 108.0, "unit": "mg/dL", "ref_low": "73", "ref_high": "109", "flag": null}, {"name": "HbA1c(NGSP)", "value": "6", "value_num": 6.0, "unit": "%", "ref_low": "4.6", "ref_high": "6.2", "flag": null}, {"name": "クレアチニン", "value": "0.93", "value_num": 0.93, "unit": "mg/dL", "ref_low": "0.65", "ref_high": "1.07", "flag": null}, {"name": "eGFR", "value": "66.5", "value_num": 66.5, "unit": "mL/min/1.73m²", "ref_low": "60", "ref_high": null, "flag": null}, {"name": "尿酸", "value": "7.3", "value_num": 7.3, "unit": "mg/dL", "ref_low": "3.7", "ref_high": "7.8", "flag": null}, {"name": "CRP", "value": "0.07", "value_num": 0.07, "unit": "mg/dL", "ref_low": "0.00", "ref_high": "0.14", "flag": null}, {"name": "MCV", "value": "94.5", "value_num": 94.5, "unit": "fL", "ref_low": "83.6", "ref_high": "98.2", "flag": null}]'::jsonb
 where diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and test_type = 'blood' and test_date = '2025-09-14';
delete from diagnosis.measurement_values mv using diagnosis.test_artifacts ta
 where mv.artifact_id = ta.id and ta.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2025-09-14';
insert into diagnosis.measurement_values
  (artifact_id, diagnostic_user_id, test_type, test_date, seq, item_name, canonical_name,
   value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag, source_file_kind)
select ta.id, ta.diagnostic_user_id, ta.test_type, ta.test_date, v.seq, v.item_name, v.canonical_name,
       v.value, v.value_num, v.unit, v.ref_low, v.ref_high, v.ref_low_num, v.ref_high_num, v.flag, 'raw_csv'
  from diagnosis.test_artifacts ta,
  (values
    (0, '白血球数', '白血球数', '6300', 6300.0, '/μL', '3300', '8600', 3300.0, 8600.0, null),
    (1, '赤血球数', '赤血球数', '476', 476.0, '万/μL', '400', '539', 400.0, 539.0, null),
    (2, '血色素量', '血色素量', '15.1', 15.1, 'g/dL', '13.7', '16.8', 13.7, 16.8, null),
    (3, 'ヘマトクリット', 'ヘマトクリット', '45', 45.0, '%', '40.7', '50.1', 40.7, 50.1, null),
    (4, '血小板数', '血小板数', '23.9', 23.9, '万/μL', '15.8', '34.8', 15.8, 34.8, null),
    (5, '総蛋白', '総蛋白', '7.3', 7.3, 'g/dL', '6.6', '8.1', 6.6, 8.1, null),
    (6, 'アルブミン', null, '4.4', 4.4, 'g/dL', '4.1', '5.1', 4.1, 5.1, null),
    (7, 'GOT(AST)', 'GOT(AST)', '25', 25.0, 'U/L', '13', '30', 13.0, 30.0, null),
    (8, 'GPT(ALT)', 'GPT(ALT)', '29', 29.0, 'U/L', '10', '42', 10.0, 42.0, null),
    (9, 'γ-GTP', 'γ-GTP', '68', 68.0, 'U/L', '13', '64', 13.0, 64.0, 'H'),
    (10, 'ALP', 'ALP', '72', 72.0, 'U/L', '38', '113', 38.0, 113.0, null),
    (11, '総コレステロール', '総コレステロール', '211', 211.0, 'mg/dL', '130', '219', 130.0, 219.0, null),
    (12, 'HDLコレステロール', 'HDLコレステロール', '51', 51.0, 'mg/dL', '40', null, 40.0, null, null),
    (13, 'LDLコレステロール', 'LDLコレステロール', '130', 130.0, 'mg/dL', '60', '119', 60.0, 119.0, 'H'),
    (14, '空腹時中性脂肪', '空腹時中性脂肪', '150', 150.0, 'mg/dL', '30', '149', 30.0, 149.0, 'H'),
    (15, '空腹時血糖', '空腹時血糖', '108', 108.0, 'mg/dL', '73', '109', 73.0, 109.0, null),
    (16, 'HbA1c(NGSP)', 'HbA1c(NGSP)', '6', 6.0, '%', '4.6', '6.2', 4.6, 6.2, null),
    (17, 'クレアチニン', 'クレアチニン', '0.93', 0.93, 'mg/dL', '0.65', '1.07', 0.65, 1.07, null),
    (18, 'eGFR', 'eGFR', '66.5', 66.5, 'mL/min/1.73m²', '60', null, 60.0, null, null),
    (19, '尿酸', '尿酸', '7.3', 7.3, 'mg/dL', '3.7', '7.8', 3.7, 7.8, null),
    (20, 'CRP', null, '0.07', 0.07, 'mg/dL', '0.00', '0.14', 0.0, 0.14, null),
    (21, 'MCV', null, '94.5', 94.5, 'fL', '83.6', '98.2', 83.6, 98.2, null)
  ) as v(seq, item_name, canonical_name, value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag)
 where ta.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2025-09-14';

-- 2026-01-13  (d0000001)
update diagnosis.test_artifacts set measurements = '[{"name": "白血球数", "value": "6600", "value_num": 6600.0, "unit": "/μL", "ref_low": "3300", "ref_high": "8600", "flag": null}, {"name": "赤血球数", "value": "472", "value_num": 472.0, "unit": "万/μL", "ref_low": "400", "ref_high": "539", "flag": null}, {"name": "血色素量", "value": "14.9", "value_num": 14.9, "unit": "g/dL", "ref_low": "13.7", "ref_high": "16.8", "flag": null}, {"name": "ヘマトクリット", "value": "44.6", "value_num": 44.6, "unit": "%", "ref_low": "40.7", "ref_high": "50.1", "flag": null}, {"name": "血小板数", "value": "23.4", "value_num": 23.4, "unit": "万/μL", "ref_low": "15.8", "ref_high": "34.8", "flag": null}, {"name": "総蛋白", "value": "7.2", "value_num": 7.2, "unit": "g/dL", "ref_low": "6.6", "ref_high": "8.1", "flag": null}, {"name": "アルブミン", "value": "4.3", "value_num": 4.3, "unit": "g/dL", "ref_low": "4.1", "ref_high": "5.1", "flag": null}, {"name": "GOT(AST)", "value": "27", "value_num": 27.0, "unit": "U/L", "ref_low": "13", "ref_high": "30", "flag": null}, {"name": "GPT(ALT)", "value": "33", "value_num": 33.0, "unit": "U/L", "ref_low": "10", "ref_high": "42", "flag": null}, {"name": "γ-GTP", "value": "74", "value_num": 74.0, "unit": "U/L", "ref_low": "13", "ref_high": "64", "flag": "H"}, {"name": "ALP", "value": "76", "value_num": 76.0, "unit": "U/L", "ref_low": "38", "ref_high": "113", "flag": null}, {"name": "総コレステロール", "value": "215", "value_num": 215.0, "unit": "mg/dL", "ref_low": "130", "ref_high": "219", "flag": null}, {"name": "HDLコレステロール", "value": "49", "value_num": 49.0, "unit": "mg/dL", "ref_low": "40", "ref_high": null, "flag": null}, {"name": "LDLコレステロール", "value": "134", "value_num": 134.0, "unit": "mg/dL", "ref_low": "60", "ref_high": "119", "flag": "H"}, {"name": "空腹時中性脂肪", "value": "162", "value_num": 162.0, "unit": "mg/dL", "ref_low": "30", "ref_high": "149", "flag": "H"}, {"name": "空腹時血糖", "value": "111", "value_num": 111.0, "unit": "mg/dL", "ref_low": "73", "ref_high": "109", "flag": "H"}, {"name": "HbA1c(NGSP)", "value": "6.1", "value_num": 6.1, "unit": "%", "ref_low": "4.6", "ref_high": "6.2", "flag": null}, {"name": "クレアチニン", "value": "0.95", "value_num": 0.95, "unit": "mg/dL", "ref_low": "0.65", "ref_high": "1.07", "flag": null}, {"name": "eGFR", "value": "64.6", "value_num": 64.6, "unit": "mL/min/1.73m²", "ref_low": "60", "ref_high": null, "flag": null}, {"name": "尿酸", "value": "7.5", "value_num": 7.5, "unit": "mg/dL", "ref_low": "3.7", "ref_high": "7.8", "flag": null}, {"name": "CRP", "value": "0.09", "value_num": 0.09, "unit": "mg/dL", "ref_low": "0.00", "ref_high": "0.14", "flag": null}, {"name": "MCV", "value": "94.5", "value_num": 94.5, "unit": "fL", "ref_low": "83.6", "ref_high": "98.2", "flag": null}]'::jsonb
 where diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and test_type = 'blood' and test_date = '2026-01-13';
delete from diagnosis.measurement_values mv using diagnosis.test_artifacts ta
 where mv.artifact_id = ta.id and ta.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2026-01-13';
insert into diagnosis.measurement_values
  (artifact_id, diagnostic_user_id, test_type, test_date, seq, item_name, canonical_name,
   value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag, source_file_kind)
select ta.id, ta.diagnostic_user_id, ta.test_type, ta.test_date, v.seq, v.item_name, v.canonical_name,
       v.value, v.value_num, v.unit, v.ref_low, v.ref_high, v.ref_low_num, v.ref_high_num, v.flag, 'raw_csv'
  from diagnosis.test_artifacts ta,
  (values
    (0, '白血球数', '白血球数', '6600', 6600.0, '/μL', '3300', '8600', 3300.0, 8600.0, null),
    (1, '赤血球数', '赤血球数', '472', 472.0, '万/μL', '400', '539', 400.0, 539.0, null),
    (2, '血色素量', '血色素量', '14.9', 14.9, 'g/dL', '13.7', '16.8', 13.7, 16.8, null),
    (3, 'ヘマトクリット', 'ヘマトクリット', '44.6', 44.6, '%', '40.7', '50.1', 40.7, 50.1, null),
    (4, '血小板数', '血小板数', '23.4', 23.4, '万/μL', '15.8', '34.8', 15.8, 34.8, null),
    (5, '総蛋白', '総蛋白', '7.2', 7.2, 'g/dL', '6.6', '8.1', 6.6, 8.1, null),
    (6, 'アルブミン', null, '4.3', 4.3, 'g/dL', '4.1', '5.1', 4.1, 5.1, null),
    (7, 'GOT(AST)', 'GOT(AST)', '27', 27.0, 'U/L', '13', '30', 13.0, 30.0, null),
    (8, 'GPT(ALT)', 'GPT(ALT)', '33', 33.0, 'U/L', '10', '42', 10.0, 42.0, null),
    (9, 'γ-GTP', 'γ-GTP', '74', 74.0, 'U/L', '13', '64', 13.0, 64.0, 'H'),
    (10, 'ALP', 'ALP', '76', 76.0, 'U/L', '38', '113', 38.0, 113.0, null),
    (11, '総コレステロール', '総コレステロール', '215', 215.0, 'mg/dL', '130', '219', 130.0, 219.0, null),
    (12, 'HDLコレステロール', 'HDLコレステロール', '49', 49.0, 'mg/dL', '40', null, 40.0, null, null),
    (13, 'LDLコレステロール', 'LDLコレステロール', '134', 134.0, 'mg/dL', '60', '119', 60.0, 119.0, 'H'),
    (14, '空腹時中性脂肪', '空腹時中性脂肪', '162', 162.0, 'mg/dL', '30', '149', 30.0, 149.0, 'H'),
    (15, '空腹時血糖', '空腹時血糖', '111', 111.0, 'mg/dL', '73', '109', 73.0, 109.0, 'H'),
    (16, 'HbA1c(NGSP)', 'HbA1c(NGSP)', '6.1', 6.1, '%', '4.6', '6.2', 4.6, 6.2, null),
    (17, 'クレアチニン', 'クレアチニン', '0.95', 0.95, 'mg/dL', '0.65', '1.07', 0.65, 1.07, null),
    (18, 'eGFR', 'eGFR', '64.6', 64.6, 'mL/min/1.73m²', '60', null, 60.0, null, null),
    (19, '尿酸', '尿酸', '7.5', 7.5, 'mg/dL', '3.7', '7.8', 3.7, 7.8, null),
    (20, 'CRP', null, '0.09', 0.09, 'mg/dL', '0.00', '0.14', 0.0, 0.14, null),
    (21, 'MCV', null, '94.5', 94.5, 'fL', '83.6', '98.2', 83.6, 98.2, null)
  ) as v(seq, item_name, canonical_name, value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag)
 where ta.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2026-01-13';

-- 2026-05-18  (d0000001)
update diagnosis.test_artifacts set measurements = '[{"name": "白血球数", "value": "6100", "value_num": 6100.0, "unit": "/μL", "ref_low": "3300", "ref_high": "8600", "flag": null}, {"name": "赤血球数", "value": "479", "value_num": 479.0, "unit": "万/μL", "ref_low": "400", "ref_high": "539", "flag": null}, {"name": "血色素量", "value": "15.2", "value_num": 15.2, "unit": "g/dL", "ref_low": "13.7", "ref_high": "16.8", "flag": null}, {"name": "ヘマトクリット", "value": "45.3", "value_num": 45.3, "unit": "%", "ref_low": "40.7", "ref_high": "50.1", "flag": null}, {"name": "血小板数", "value": "24.3", "value_num": 24.3, "unit": "万/μL", "ref_low": "15.8", "ref_high": "34.8", "flag": null}, {"name": "総蛋白", "value": "7.3", "value_num": 7.3, "unit": "g/dL", "ref_low": "6.6", "ref_high": "8.1", "flag": null}, {"name": "アルブミン", "value": "4.5", "value_num": 4.5, "unit": "g/dL", "ref_low": "4.1", "ref_high": "5.1", "flag": null}, {"name": "GOT(AST)", "value": "23", "value_num": 23.0, "unit": "U/L", "ref_low": "13", "ref_high": "30", "flag": null}, {"name": "GPT(ALT)", "value": "26", "value_num": 26.0, "unit": "U/L", "ref_low": "10", "ref_high": "42", "flag": null}, {"name": "γ-GTP", "value": "59", "value_num": 59.0, "unit": "U/L", "ref_low": "13", "ref_high": "64", "flag": null}, {"name": "ALP", "value": "70", "value_num": 70.0, "unit": "U/L", "ref_low": "38", "ref_high": "113", "flag": null}, {"name": "総コレステロール", "value": "207", "value_num": 207.0, "unit": "mg/dL", "ref_low": "130", "ref_high": "219", "flag": null}, {"name": "HDLコレステロール", "value": "53", "value_num": 53.0, "unit": "mg/dL", "ref_low": "40", "ref_high": null, "flag": null}, {"name": "LDLコレステロール", "value": "126", "value_num": 126.0, "unit": "mg/dL", "ref_low": "60", "ref_high": "119", "flag": "H"}, {"name": "空腹時中性脂肪", "value": "141", "value_num": 141.0, "unit": "mg/dL", "ref_low": "30", "ref_high": "149", "flag": null}, {"name": "空腹時血糖", "value": "107", "value_num": 107.0, "unit": "mg/dL", "ref_low": "73", "ref_high": "109", "flag": null}, {"name": "HbA1c(NGSP)", "value": "5.9", "value_num": 5.9, "unit": "%", "ref_low": "4.6", "ref_high": "6.2", "flag": null}, {"name": "クレアチニン", "value": "0.92", "value_num": 0.92, "unit": "mg/dL", "ref_low": "0.65", "ref_high": "1.07", "flag": null}, {"name": "eGFR", "value": "66.9", "value_num": 66.9, "unit": "mL/min/1.73m²", "ref_low": "60", "ref_high": null, "flag": null}, {"name": "尿酸", "value": "7.1", "value_num": 7.1, "unit": "mg/dL", "ref_low": "3.7", "ref_high": "7.8", "flag": null}, {"name": "CRP", "value": "0.05", "value_num": 0.05, "unit": "mg/dL", "ref_low": "0.00", "ref_high": "0.14", "flag": null}, {"name": "MCV", "value": "94.6", "value_num": 94.6, "unit": "fL", "ref_low": "83.6", "ref_high": "98.2", "flag": null}]'::jsonb
 where diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and test_type = 'blood' and test_date = '2026-05-18';
delete from diagnosis.measurement_values mv using diagnosis.test_artifacts ta
 where mv.artifact_id = ta.id and ta.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2026-05-18';
insert into diagnosis.measurement_values
  (artifact_id, diagnostic_user_id, test_type, test_date, seq, item_name, canonical_name,
   value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag, source_file_kind)
select ta.id, ta.diagnostic_user_id, ta.test_type, ta.test_date, v.seq, v.item_name, v.canonical_name,
       v.value, v.value_num, v.unit, v.ref_low, v.ref_high, v.ref_low_num, v.ref_high_num, v.flag, 'raw_csv'
  from diagnosis.test_artifacts ta,
  (values
    (0, '白血球数', '白血球数', '6100', 6100.0, '/μL', '3300', '8600', 3300.0, 8600.0, null),
    (1, '赤血球数', '赤血球数', '479', 479.0, '万/μL', '400', '539', 400.0, 539.0, null),
    (2, '血色素量', '血色素量', '15.2', 15.2, 'g/dL', '13.7', '16.8', 13.7, 16.8, null),
    (3, 'ヘマトクリット', 'ヘマトクリット', '45.3', 45.3, '%', '40.7', '50.1', 40.7, 50.1, null),
    (4, '血小板数', '血小板数', '24.3', 24.3, '万/μL', '15.8', '34.8', 15.8, 34.8, null),
    (5, '総蛋白', '総蛋白', '7.3', 7.3, 'g/dL', '6.6', '8.1', 6.6, 8.1, null),
    (6, 'アルブミン', null, '4.5', 4.5, 'g/dL', '4.1', '5.1', 4.1, 5.1, null),
    (7, 'GOT(AST)', 'GOT(AST)', '23', 23.0, 'U/L', '13', '30', 13.0, 30.0, null),
    (8, 'GPT(ALT)', 'GPT(ALT)', '26', 26.0, 'U/L', '10', '42', 10.0, 42.0, null),
    (9, 'γ-GTP', 'γ-GTP', '59', 59.0, 'U/L', '13', '64', 13.0, 64.0, null),
    (10, 'ALP', 'ALP', '70', 70.0, 'U/L', '38', '113', 38.0, 113.0, null),
    (11, '総コレステロール', '総コレステロール', '207', 207.0, 'mg/dL', '130', '219', 130.0, 219.0, null),
    (12, 'HDLコレステロール', 'HDLコレステロール', '53', 53.0, 'mg/dL', '40', null, 40.0, null, null),
    (13, 'LDLコレステロール', 'LDLコレステロール', '126', 126.0, 'mg/dL', '60', '119', 60.0, 119.0, 'H'),
    (14, '空腹時中性脂肪', '空腹時中性脂肪', '141', 141.0, 'mg/dL', '30', '149', 30.0, 149.0, null),
    (15, '空腹時血糖', '空腹時血糖', '107', 107.0, 'mg/dL', '73', '109', 73.0, 109.0, null),
    (16, 'HbA1c(NGSP)', 'HbA1c(NGSP)', '5.9', 5.9, '%', '4.6', '6.2', 4.6, 6.2, null),
    (17, 'クレアチニン', 'クレアチニン', '0.92', 0.92, 'mg/dL', '0.65', '1.07', 0.65, 1.07, null),
    (18, 'eGFR', 'eGFR', '66.9', 66.9, 'mL/min/1.73m²', '60', null, 60.0, null, null),
    (19, '尿酸', '尿酸', '7.1', 7.1, 'mg/dL', '3.7', '7.8', 3.7, 7.8, null),
    (20, 'CRP', null, '0.05', 0.05, 'mg/dL', '0.00', '0.14', 0.0, 0.14, null),
    (21, 'MCV', null, '94.6', 94.6, 'fL', '83.6', '98.2', 83.6, 98.2, null)
  ) as v(seq, item_name, canonical_name, value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag)
 where ta.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2026-05-18';

-- 2025-04-15  (d0000002)
update diagnosis.test_artifacts set measurements = '[{"name": "白血球数", "value": "6900", "value_num": 6900.0, "unit": "/μL", "ref_low": "3300", "ref_high": "8600", "flag": null}, {"name": "赤血球数", "value": "432", "value_num": 432.0, "unit": "万/μL", "ref_low": "360", "ref_high": "489", "flag": null}, {"name": "血色素量", "value": "12.9", "value_num": 12.9, "unit": "g/dL", "ref_low": "11.6", "ref_high": "14.8", "flag": null}, {"name": "ヘマトクリット", "value": "39.4", "value_num": 39.4, "unit": "%", "ref_low": "35.1", "ref_high": "44.4", "flag": null}, {"name": "血小板数", "value": "26.8", "value_num": 26.8, "unit": "万/μL", "ref_low": "15.8", "ref_high": "34.8", "flag": null}, {"name": "総蛋白", "value": "7.1", "value_num": 7.1, "unit": "g/dL", "ref_low": "6.6", "ref_high": "8.1", "flag": null}, {"name": "アルブミン", "value": "4.2", "value_num": 4.2, "unit": "g/dL", "ref_low": "4.1", "ref_high": "5.1", "flag": null}, {"name": "GOT(AST)", "value": "22", "value_num": 22.0, "unit": "U/L", "ref_low": "13", "ref_high": "30", "flag": null}, {"name": "GPT(ALT)", "value": "25", "value_num": 25.0, "unit": "U/L", "ref_low": "7", "ref_high": "23", "flag": "H"}, {"name": "γ-GTP", "value": "34", "value_num": 34.0, "unit": "U/L", "ref_low": "9", "ref_high": "32", "flag": "H"}, {"name": "ALP", "value": "68", "value_num": 68.0, "unit": "U/L", "ref_low": "38", "ref_high": "113", "flag": null}, {"name": "総コレステロール", "value": "210", "value_num": 210.0, "unit": "mg/dL", "ref_low": "130", "ref_high": "219", "flag": null}, {"name": "HDLコレステロール", "value": "58", "value_num": 58.0, "unit": "mg/dL", "ref_low": "40", "ref_high": null, "flag": null}, {"name": "LDLコレステロール", "value": "124", "value_num": 124.0, "unit": "mg/dL", "ref_low": "60", "ref_high": "119", "flag": "H"}, {"name": "空腹時中性脂肪", "value": "138", "value_num": 138.0, "unit": "mg/dL", "ref_low": "30", "ref_high": "149", "flag": null}, {"name": "空腹時血糖", "value": "101", "value_num": 101.0, "unit": "mg/dL", "ref_low": "73", "ref_high": "109", "flag": null}, {"name": "HbA1c(NGSP)", "value": "5.8", "value_num": 5.8, "unit": "%", "ref_low": "4.6", "ref_high": "6.2", "flag": null}, {"name": "クレアチニン", "value": "0.71", "value_num": 0.71, "unit": "mg/dL", "ref_low": "0.46", "ref_high": "0.79", "flag": null}, {"name": "eGFR", "value": "71.8", "value_num": 71.8, "unit": "mL/min/1.73m²", "ref_low": "60", "ref_high": null, "flag": null}, {"name": "尿酸", "value": "5.7", "value_num": 5.7, "unit": "mg/dL", "ref_low": "2.6", "ref_high": "5.5", "flag": "H"}, {"name": "CRP", "value": "0.11", "value_num": 0.11, "unit": "mg/dL", "ref_low": "0.00", "ref_high": "0.14", "flag": null}, {"name": "MCV", "value": "91.2", "value_num": 91.2, "unit": "fL", "ref_low": "83.6", "ref_high": "98.2", "flag": null}]'::jsonb
 where diagnostic_user_id = 'd0000002-0000-0000-0000-000000000000' and test_type = 'blood' and test_date = '2025-04-15';
delete from diagnosis.measurement_values mv using diagnosis.test_artifacts ta
 where mv.artifact_id = ta.id and ta.diagnostic_user_id = 'd0000002-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2025-04-15';
insert into diagnosis.measurement_values
  (artifact_id, diagnostic_user_id, test_type, test_date, seq, item_name, canonical_name,
   value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag, source_file_kind)
select ta.id, ta.diagnostic_user_id, ta.test_type, ta.test_date, v.seq, v.item_name, v.canonical_name,
       v.value, v.value_num, v.unit, v.ref_low, v.ref_high, v.ref_low_num, v.ref_high_num, v.flag, 'raw_csv'
  from diagnosis.test_artifacts ta,
  (values
    (0, '白血球数', '白血球数', '6900', 6900.0, '/μL', '3300', '8600', 3300.0, 8600.0, null),
    (1, '赤血球数', '赤血球数', '432', 432.0, '万/μL', '360', '489', 360.0, 489.0, null),
    (2, '血色素量', '血色素量', '12.9', 12.9, 'g/dL', '11.6', '14.8', 11.6, 14.8, null),
    (3, 'ヘマトクリット', 'ヘマトクリット', '39.4', 39.4, '%', '35.1', '44.4', 35.1, 44.4, null),
    (4, '血小板数', '血小板数', '26.8', 26.8, '万/μL', '15.8', '34.8', 15.8, 34.8, null),
    (5, '総蛋白', '総蛋白', '7.1', 7.1, 'g/dL', '6.6', '8.1', 6.6, 8.1, null),
    (6, 'アルブミン', null, '4.2', 4.2, 'g/dL', '4.1', '5.1', 4.1, 5.1, null),
    (7, 'GOT(AST)', 'GOT(AST)', '22', 22.0, 'U/L', '13', '30', 13.0, 30.0, null),
    (8, 'GPT(ALT)', 'GPT(ALT)', '25', 25.0, 'U/L', '7', '23', 7.0, 23.0, 'H'),
    (9, 'γ-GTP', 'γ-GTP', '34', 34.0, 'U/L', '9', '32', 9.0, 32.0, 'H'),
    (10, 'ALP', 'ALP', '68', 68.0, 'U/L', '38', '113', 38.0, 113.0, null),
    (11, '総コレステロール', '総コレステロール', '210', 210.0, 'mg/dL', '130', '219', 130.0, 219.0, null),
    (12, 'HDLコレステロール', 'HDLコレステロール', '58', 58.0, 'mg/dL', '40', null, 40.0, null, null),
    (13, 'LDLコレステロール', 'LDLコレステロール', '124', 124.0, 'mg/dL', '60', '119', 60.0, 119.0, 'H'),
    (14, '空腹時中性脂肪', '空腹時中性脂肪', '138', 138.0, 'mg/dL', '30', '149', 30.0, 149.0, null),
    (15, '空腹時血糖', '空腹時血糖', '101', 101.0, 'mg/dL', '73', '109', 73.0, 109.0, null),
    (16, 'HbA1c(NGSP)', 'HbA1c(NGSP)', '5.8', 5.8, '%', '4.6', '6.2', 4.6, 6.2, null),
    (17, 'クレアチニン', 'クレアチニン', '0.71', 0.71, 'mg/dL', '0.46', '0.79', 0.46, 0.79, null),
    (18, 'eGFR', 'eGFR', '71.8', 71.8, 'mL/min/1.73m²', '60', null, 60.0, null, null),
    (19, '尿酸', '尿酸', '5.7', 5.7, 'mg/dL', '2.6', '5.5', 2.6, 5.5, 'H'),
    (20, 'CRP', null, '0.11', 0.11, 'mg/dL', '0.00', '0.14', 0.0, 0.14, null),
    (21, 'MCV', null, '91.2', 91.2, 'fL', '83.6', '98.2', 83.6, 98.2, null)
  ) as v(seq, item_name, canonical_name, value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag)
 where ta.diagnostic_user_id = 'd0000002-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2025-04-15';

-- 2025-12-19  (d0000002)
update diagnosis.test_artifacts set measurements = '[{"name": "白血球数", "value": "6400", "value_num": 6400.0, "unit": "/μL", "ref_low": "3300", "ref_high": "8600", "flag": null}, {"name": "赤血球数", "value": "438", "value_num": 438.0, "unit": "万/μL", "ref_low": "360", "ref_high": "489", "flag": null}, {"name": "血色素量", "value": "13.2", "value_num": 13.2, "unit": "g/dL", "ref_low": "11.6", "ref_high": "14.8", "flag": null}, {"name": "ヘマトクリット", "value": "40.1", "value_num": 40.1, "unit": "%", "ref_low": "35.1", "ref_high": "44.4", "flag": null}, {"name": "血小板数", "value": "26.2", "value_num": 26.2, "unit": "万/μL", "ref_low": "15.8", "ref_high": "34.8", "flag": null}, {"name": "総蛋白", "value": "7.2", "value_num": 7.2, "unit": "g/dL", "ref_low": "6.6", "ref_high": "8.1", "flag": null}, {"name": "アルブミン", "value": "4.4", "value_num": 4.4, "unit": "g/dL", "ref_low": "4.1", "ref_high": "5.1", "flag": null}, {"name": "GOT(AST)", "value": "20", "value_num": 20.0, "unit": "U/L", "ref_low": "13", "ref_high": "30", "flag": null}, {"name": "GPT(ALT)", "value": "21", "value_num": 21.0, "unit": "U/L", "ref_low": "7", "ref_high": "23", "flag": null}, {"name": "γ-GTP", "value": "27", "value_num": 27.0, "unit": "U/L", "ref_low": "9", "ref_high": "32", "flag": null}, {"name": "ALP", "value": "64", "value_num": 64.0, "unit": "U/L", "ref_low": "38", "ref_high": "113", "flag": null}, {"name": "総コレステロール", "value": "197", "value_num": 197.0, "unit": "mg/dL", "ref_low": "130", "ref_high": "219", "flag": null}, {"name": "HDLコレステロール", "value": "63", "value_num": 63.0, "unit": "mg/dL", "ref_low": "40", "ref_high": null, "flag": null}, {"name": "LDLコレステロール", "value": "112", "value_num": 112.0, "unit": "mg/dL", "ref_low": "60", "ref_high": "119", "flag": null}, {"name": "空腹時中性脂肪", "value": "112", "value_num": 112.0, "unit": "mg/dL", "ref_low": "30", "ref_high": "149", "flag": null}, {"name": "空腹時血糖", "value": "95", "value_num": 95.0, "unit": "mg/dL", "ref_low": "73", "ref_high": "109", "flag": null}, {"name": "HbA1c(NGSP)", "value": "5.5", "value_num": 5.5, "unit": "%", "ref_low": "4.6", "ref_high": "6.2", "flag": null}, {"name": "クレアチニン", "value": "0.68", "value_num": 0.68, "unit": "mg/dL", "ref_low": "0.46", "ref_high": "0.79", "flag": null}, {"name": "eGFR", "value": "75.3", "value_num": 75.3, "unit": "mL/min/1.73m²", "ref_low": "60", "ref_high": null, "flag": null}, {"name": "尿酸", "value": "5.1", "value_num": 5.1, "unit": "mg/dL", "ref_low": "2.6", "ref_high": "5.5", "flag": null}, {"name": "CRP", "value": "0.07", "value_num": 0.07, "unit": "mg/dL", "ref_low": "0.00", "ref_high": "0.14", "flag": null}, {"name": "MCV", "value": "91.6", "value_num": 91.6, "unit": "fL", "ref_low": "83.6", "ref_high": "98.2", "flag": null}]'::jsonb
 where diagnostic_user_id = 'd0000002-0000-0000-0000-000000000000' and test_type = 'blood' and test_date = '2025-12-19';
delete from diagnosis.measurement_values mv using diagnosis.test_artifacts ta
 where mv.artifact_id = ta.id and ta.diagnostic_user_id = 'd0000002-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2025-12-19';
insert into diagnosis.measurement_values
  (artifact_id, diagnostic_user_id, test_type, test_date, seq, item_name, canonical_name,
   value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag, source_file_kind)
select ta.id, ta.diagnostic_user_id, ta.test_type, ta.test_date, v.seq, v.item_name, v.canonical_name,
       v.value, v.value_num, v.unit, v.ref_low, v.ref_high, v.ref_low_num, v.ref_high_num, v.flag, 'raw_csv'
  from diagnosis.test_artifacts ta,
  (values
    (0, '白血球数', '白血球数', '6400', 6400.0, '/μL', '3300', '8600', 3300.0, 8600.0, null),
    (1, '赤血球数', '赤血球数', '438', 438.0, '万/μL', '360', '489', 360.0, 489.0, null),
    (2, '血色素量', '血色素量', '13.2', 13.2, 'g/dL', '11.6', '14.8', 11.6, 14.8, null),
    (3, 'ヘマトクリット', 'ヘマトクリット', '40.1', 40.1, '%', '35.1', '44.4', 35.1, 44.4, null),
    (4, '血小板数', '血小板数', '26.2', 26.2, '万/μL', '15.8', '34.8', 15.8, 34.8, null),
    (5, '総蛋白', '総蛋白', '7.2', 7.2, 'g/dL', '6.6', '8.1', 6.6, 8.1, null),
    (6, 'アルブミン', null, '4.4', 4.4, 'g/dL', '4.1', '5.1', 4.1, 5.1, null),
    (7, 'GOT(AST)', 'GOT(AST)', '20', 20.0, 'U/L', '13', '30', 13.0, 30.0, null),
    (8, 'GPT(ALT)', 'GPT(ALT)', '21', 21.0, 'U/L', '7', '23', 7.0, 23.0, null),
    (9, 'γ-GTP', 'γ-GTP', '27', 27.0, 'U/L', '9', '32', 9.0, 32.0, null),
    (10, 'ALP', 'ALP', '64', 64.0, 'U/L', '38', '113', 38.0, 113.0, null),
    (11, '総コレステロール', '総コレステロール', '197', 197.0, 'mg/dL', '130', '219', 130.0, 219.0, null),
    (12, 'HDLコレステロール', 'HDLコレステロール', '63', 63.0, 'mg/dL', '40', null, 40.0, null, null),
    (13, 'LDLコレステロール', 'LDLコレステロール', '112', 112.0, 'mg/dL', '60', '119', 60.0, 119.0, null),
    (14, '空腹時中性脂肪', '空腹時中性脂肪', '112', 112.0, 'mg/dL', '30', '149', 30.0, 149.0, null),
    (15, '空腹時血糖', '空腹時血糖', '95', 95.0, 'mg/dL', '73', '109', 73.0, 109.0, null),
    (16, 'HbA1c(NGSP)', 'HbA1c(NGSP)', '5.5', 5.5, '%', '4.6', '6.2', 4.6, 6.2, null),
    (17, 'クレアチニン', 'クレアチニン', '0.68', 0.68, 'mg/dL', '0.46', '0.79', 0.46, 0.79, null),
    (18, 'eGFR', 'eGFR', '75.3', 75.3, 'mL/min/1.73m²', '60', null, 60.0, null, null),
    (19, '尿酸', '尿酸', '5.1', 5.1, 'mg/dL', '2.6', '5.5', 2.6, 5.5, null),
    (20, 'CRP', null, '0.07', 0.07, 'mg/dL', '0.00', '0.14', 0.0, 0.14, null),
    (21, 'MCV', null, '91.6', 91.6, 'fL', '83.6', '98.2', 83.6, 98.2, null)
  ) as v(seq, item_name, canonical_name, value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag)
 where ta.diagnostic_user_id = 'd0000002-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2025-12-19';

-- 2026-04-14  (d0000002)
update diagnosis.test_artifacts set measurements = '[{"name": "白血球数", "value": "6100", "value_num": 6100.0, "unit": "/μL", "ref_low": "3300", "ref_high": "8600", "flag": null}, {"name": "赤血球数", "value": "443", "value_num": 443.0, "unit": "万/μL", "ref_low": "360", "ref_high": "489", "flag": null}, {"name": "血色素量", "value": "13.5", "value_num": 13.5, "unit": "g/dL", "ref_low": "11.6", "ref_high": "14.8", "flag": null}, {"name": "ヘマトクリット", "value": "40.8", "value_num": 40.8, "unit": "%", "ref_low": "35.1", "ref_high": "44.4", "flag": null}, {"name": "血小板数", "value": "25.7", "value_num": 25.7, "unit": "万/μL", "ref_low": "15.8", "ref_high": "34.8", "flag": null}, {"name": "総蛋白", "value": "7.3", "value_num": 7.3, "unit": "g/dL", "ref_low": "6.6", "ref_high": "8.1", "flag": null}, {"name": "アルブミン", "value": "4.5", "value_num": 4.5, "unit": "g/dL", "ref_low": "4.1", "ref_high": "5.1", "flag": null}, {"name": "GOT(AST)", "value": "18", "value_num": 18.0, "unit": "U/L", "ref_low": "13", "ref_high": "30", "flag": null}, {"name": "GPT(ALT)", "value": "17", "value_num": 17.0, "unit": "U/L", "ref_low": "7", "ref_high": "23", "flag": null}, {"name": "γ-GTP", "value": "21", "value_num": 21.0, "unit": "U/L", "ref_low": "9", "ref_high": "32", "flag": null}, {"name": "ALP", "value": "61", "value_num": 61.0, "unit": "U/L", "ref_low": "38", "ref_high": "113", "flag": null}, {"name": "総コレステロール", "value": "189", "value_num": 189.0, "unit": "mg/dL", "ref_low": "130", "ref_high": "219", "flag": null}, {"name": "HDLコレステロール", "value": "69", "value_num": 69.0, "unit": "mg/dL", "ref_low": "40", "ref_high": null, "flag": null}, {"name": "LDLコレステロール", "value": "101", "value_num": 101.0, "unit": "mg/dL", "ref_low": "60", "ref_high": "119", "flag": null}, {"name": "空腹時中性脂肪", "value": "94", "value_num": 94.0, "unit": "mg/dL", "ref_low": "30", "ref_high": "149", "flag": null}, {"name": "空腹時血糖", "value": "89", "value_num": 89.0, "unit": "mg/dL", "ref_low": "73", "ref_high": "109", "flag": null}, {"name": "HbA1c(NGSP)", "value": "5.3", "value_num": 5.3, "unit": "%", "ref_low": "4.6", "ref_high": "6.2", "flag": null}, {"name": "クレアチニン", "value": "0.66", "value_num": 0.66, "unit": "mg/dL", "ref_low": "0.46", "ref_high": "0.79", "flag": null}, {"name": "eGFR", "value": "77.3", "value_num": 77.3, "unit": "mL/min/1.73m²", "ref_low": "60", "ref_high": null, "flag": null}, {"name": "尿酸", "value": "4.6", "value_num": 4.6, "unit": "mg/dL", "ref_low": "2.6", "ref_high": "5.5", "flag": null}, {"name": "CRP", "value": "0.04", "value_num": 0.04, "unit": "mg/dL", "ref_low": "0.00", "ref_high": "0.14", "flag": null}, {"name": "MCV", "value": "92.1", "value_num": 92.1, "unit": "fL", "ref_low": "83.6", "ref_high": "98.2", "flag": null}]'::jsonb
 where diagnostic_user_id = 'd0000002-0000-0000-0000-000000000000' and test_type = 'blood' and test_date = '2026-04-14';
delete from diagnosis.measurement_values mv using diagnosis.test_artifacts ta
 where mv.artifact_id = ta.id and ta.diagnostic_user_id = 'd0000002-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2026-04-14';
insert into diagnosis.measurement_values
  (artifact_id, diagnostic_user_id, test_type, test_date, seq, item_name, canonical_name,
   value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag, source_file_kind)
select ta.id, ta.diagnostic_user_id, ta.test_type, ta.test_date, v.seq, v.item_name, v.canonical_name,
       v.value, v.value_num, v.unit, v.ref_low, v.ref_high, v.ref_low_num, v.ref_high_num, v.flag, 'raw_csv'
  from diagnosis.test_artifacts ta,
  (values
    (0, '白血球数', '白血球数', '6100', 6100.0, '/μL', '3300', '8600', 3300.0, 8600.0, null),
    (1, '赤血球数', '赤血球数', '443', 443.0, '万/μL', '360', '489', 360.0, 489.0, null),
    (2, '血色素量', '血色素量', '13.5', 13.5, 'g/dL', '11.6', '14.8', 11.6, 14.8, null),
    (3, 'ヘマトクリット', 'ヘマトクリット', '40.8', 40.8, '%', '35.1', '44.4', 35.1, 44.4, null),
    (4, '血小板数', '血小板数', '25.7', 25.7, '万/μL', '15.8', '34.8', 15.8, 34.8, null),
    (5, '総蛋白', '総蛋白', '7.3', 7.3, 'g/dL', '6.6', '8.1', 6.6, 8.1, null),
    (6, 'アルブミン', null, '4.5', 4.5, 'g/dL', '4.1', '5.1', 4.1, 5.1, null),
    (7, 'GOT(AST)', 'GOT(AST)', '18', 18.0, 'U/L', '13', '30', 13.0, 30.0, null),
    (8, 'GPT(ALT)', 'GPT(ALT)', '17', 17.0, 'U/L', '7', '23', 7.0, 23.0, null),
    (9, 'γ-GTP', 'γ-GTP', '21', 21.0, 'U/L', '9', '32', 9.0, 32.0, null),
    (10, 'ALP', 'ALP', '61', 61.0, 'U/L', '38', '113', 38.0, 113.0, null),
    (11, '総コレステロール', '総コレステロール', '189', 189.0, 'mg/dL', '130', '219', 130.0, 219.0, null),
    (12, 'HDLコレステロール', 'HDLコレステロール', '69', 69.0, 'mg/dL', '40', null, 40.0, null, null),
    (13, 'LDLコレステロール', 'LDLコレステロール', '101', 101.0, 'mg/dL', '60', '119', 60.0, 119.0, null),
    (14, '空腹時中性脂肪', '空腹時中性脂肪', '94', 94.0, 'mg/dL', '30', '149', 30.0, 149.0, null),
    (15, '空腹時血糖', '空腹時血糖', '89', 89.0, 'mg/dL', '73', '109', 73.0, 109.0, null),
    (16, 'HbA1c(NGSP)', 'HbA1c(NGSP)', '5.3', 5.3, '%', '4.6', '6.2', 4.6, 6.2, null),
    (17, 'クレアチニン', 'クレアチニン', '0.66', 0.66, 'mg/dL', '0.46', '0.79', 0.46, 0.79, null),
    (18, 'eGFR', 'eGFR', '77.3', 77.3, 'mL/min/1.73m²', '60', null, 60.0, null, null),
    (19, '尿酸', '尿酸', '4.6', 4.6, 'mg/dL', '2.6', '5.5', 2.6, 5.5, null),
    (20, 'CRP', null, '0.04', 0.04, 'mg/dL', '0.00', '0.14', 0.0, 0.14, null),
    (21, 'MCV', null, '92.1', 92.1, 'fL', '83.6', '98.2', 83.6, 98.2, null)
  ) as v(seq, item_name, canonical_name, value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag)
 where ta.diagnostic_user_id = 'd0000002-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2026-04-14';

-- 2025-03-06  (d0000003)
update diagnosis.test_artifacts set measurements = '[{"name": "白血球数", "value": "7100", "value_num": 7100.0, "unit": "/μL", "ref_low": "3300", "ref_high": "8600", "flag": null}, {"name": "赤血球数", "value": "452", "value_num": 452.0, "unit": "万/μL", "ref_low": "400", "ref_high": "539", "flag": null}, {"name": "血色素量", "value": "14.2", "value_num": 14.2, "unit": "g/dL", "ref_low": "13.7", "ref_high": "16.8", "flag": null}, {"name": "ヘマトクリット", "value": "42.6", "value_num": 42.6, "unit": "%", "ref_low": "40.7", "ref_high": "50.1", "flag": null}, {"name": "血小板数", "value": "21.8", "value_num": 21.8, "unit": "万/μL", "ref_low": "15.8", "ref_high": "34.8", "flag": null}, {"name": "総蛋白", "value": "7", "value_num": 7.0, "unit": "g/dL", "ref_low": "6.6", "ref_high": "8.1", "flag": null}, {"name": "アルブミン", "value": "4.1", "value_num": 4.1, "unit": "g/dL", "ref_low": "4.1", "ref_high": "5.1", "flag": null}, {"name": "GOT(AST)", "value": "31", "value_num": 31.0, "unit": "U/L", "ref_low": "13", "ref_high": "30", "flag": "H"}, {"name": "GPT(ALT)", "value": "38", "value_num": 38.0, "unit": "U/L", "ref_low": "10", "ref_high": "42", "flag": null}, {"name": "γ-GTP", "value": "88", "value_num": 88.0, "unit": "U/L", "ref_low": "13", "ref_high": "64", "flag": "H"}, {"name": "ALP", "value": "88", "value_num": 88.0, "unit": "U/L", "ref_low": "38", "ref_high": "113", "flag": null}, {"name": "総コレステロール", "value": "217", "value_num": 217.0, "unit": "mg/dL", "ref_low": "130", "ref_high": "219", "flag": null}, {"name": "HDLコレステロール", "value": "45", "value_num": 45.0, "unit": "mg/dL", "ref_low": "40", "ref_high": null, "flag": null}, {"name": "LDLコレステロール", "value": "138", "value_num": 138.0, "unit": "mg/dL", "ref_low": "60", "ref_high": "119", "flag": "H"}, {"name": "空腹時中性脂肪", "value": "168", "value_num": 168.0, "unit": "mg/dL", "ref_low": "30", "ref_high": "149", "flag": "H"}, {"name": "空腹時血糖", "value": "114", "value_num": 114.0, "unit": "mg/dL", "ref_low": "73", "ref_high": "109", "flag": "H"}, {"name": "HbA1c(NGSP)", "value": "6.2", "value_num": 6.2, "unit": "%", "ref_low": "4.6", "ref_high": "6.2", "flag": null}, {"name": "クレアチニン", "value": "1.05", "value_num": 1.05, "unit": "mg/dL", "ref_low": "0.65", "ref_high": "1.07", "flag": null}, {"name": "eGFR", "value": "55.3", "value_num": 55.3, "unit": "mL/min/1.73m²", "ref_low": "60", "ref_high": null, "flag": "L"}, {"name": "尿酸", "value": "7.6", "value_num": 7.6, "unit": "mg/dL", "ref_low": "3.7", "ref_high": "7.8", "flag": null}, {"name": "CRP", "value": "0.13", "value_num": 0.13, "unit": "mg/dL", "ref_low": "0.00", "ref_high": "0.14", "flag": null}, {"name": "MCV", "value": "94.2", "value_num": 94.2, "unit": "fL", "ref_low": "83.6", "ref_high": "98.2", "flag": null}]'::jsonb
 where diagnostic_user_id = 'd0000003-0000-0000-0000-000000000000' and test_type = 'blood' and test_date = '2025-03-06';
delete from diagnosis.measurement_values mv using diagnosis.test_artifacts ta
 where mv.artifact_id = ta.id and ta.diagnostic_user_id = 'd0000003-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2025-03-06';
insert into diagnosis.measurement_values
  (artifact_id, diagnostic_user_id, test_type, test_date, seq, item_name, canonical_name,
   value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag, source_file_kind)
select ta.id, ta.diagnostic_user_id, ta.test_type, ta.test_date, v.seq, v.item_name, v.canonical_name,
       v.value, v.value_num, v.unit, v.ref_low, v.ref_high, v.ref_low_num, v.ref_high_num, v.flag, 'raw_csv'
  from diagnosis.test_artifacts ta,
  (values
    (0, '白血球数', '白血球数', '7100', 7100.0, '/μL', '3300', '8600', 3300.0, 8600.0, null),
    (1, '赤血球数', '赤血球数', '452', 452.0, '万/μL', '400', '539', 400.0, 539.0, null),
    (2, '血色素量', '血色素量', '14.2', 14.2, 'g/dL', '13.7', '16.8', 13.7, 16.8, null),
    (3, 'ヘマトクリット', 'ヘマトクリット', '42.6', 42.6, '%', '40.7', '50.1', 40.7, 50.1, null),
    (4, '血小板数', '血小板数', '21.8', 21.8, '万/μL', '15.8', '34.8', 15.8, 34.8, null),
    (5, '総蛋白', '総蛋白', '7', 7.0, 'g/dL', '6.6', '8.1', 6.6, 8.1, null),
    (6, 'アルブミン', null, '4.1', 4.1, 'g/dL', '4.1', '5.1', 4.1, 5.1, null),
    (7, 'GOT(AST)', 'GOT(AST)', '31', 31.0, 'U/L', '13', '30', 13.0, 30.0, 'H'),
    (8, 'GPT(ALT)', 'GPT(ALT)', '38', 38.0, 'U/L', '10', '42', 10.0, 42.0, null),
    (9, 'γ-GTP', 'γ-GTP', '88', 88.0, 'U/L', '13', '64', 13.0, 64.0, 'H'),
    (10, 'ALP', 'ALP', '88', 88.0, 'U/L', '38', '113', 38.0, 113.0, null),
    (11, '総コレステロール', '総コレステロール', '217', 217.0, 'mg/dL', '130', '219', 130.0, 219.0, null),
    (12, 'HDLコレステロール', 'HDLコレステロール', '45', 45.0, 'mg/dL', '40', null, 40.0, null, null),
    (13, 'LDLコレステロール', 'LDLコレステロール', '138', 138.0, 'mg/dL', '60', '119', 60.0, 119.0, 'H'),
    (14, '空腹時中性脂肪', '空腹時中性脂肪', '168', 168.0, 'mg/dL', '30', '149', 30.0, 149.0, 'H'),
    (15, '空腹時血糖', '空腹時血糖', '114', 114.0, 'mg/dL', '73', '109', 73.0, 109.0, 'H'),
    (16, 'HbA1c(NGSP)', 'HbA1c(NGSP)', '6.2', 6.2, '%', '4.6', '6.2', 4.6, 6.2, null),
    (17, 'クレアチニン', 'クレアチニン', '1.05', 1.05, 'mg/dL', '0.65', '1.07', 0.65, 1.07, null),
    (18, 'eGFR', 'eGFR', '55.3', 55.3, 'mL/min/1.73m²', '60', null, 60.0, null, 'L'),
    (19, '尿酸', '尿酸', '7.6', 7.6, 'mg/dL', '3.7', '7.8', 3.7, 7.8, null),
    (20, 'CRP', null, '0.13', 0.13, 'mg/dL', '0.00', '0.14', 0.0, 0.14, null),
    (21, 'MCV', null, '94.2', 94.2, 'fL', '83.6', '98.2', 83.6, 98.2, null)
  ) as v(seq, item_name, canonical_name, value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag)
 where ta.diagnostic_user_id = 'd0000003-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2025-03-06';

-- 2025-09-03  (d0000003)
update diagnosis.test_artifacts set measurements = '[{"name": "白血球数", "value": "7400", "value_num": 7400.0, "unit": "/μL", "ref_low": "3300", "ref_high": "8600", "flag": null}, {"name": "赤血球数", "value": "446", "value_num": 446.0, "unit": "万/μL", "ref_low": "400", "ref_high": "539", "flag": null}, {"name": "血色素量", "value": "14", "value_num": 14.0, "unit": "g/dL", "ref_low": "13.7", "ref_high": "16.8", "flag": null}, {"name": "ヘマトクリット", "value": "42.1", "value_num": 42.1, "unit": "%", "ref_low": "40.7", "ref_high": "50.1", "flag": null}, {"name": "血小板数", "value": "21.2", "value_num": 21.2, "unit": "万/μL", "ref_low": "15.8", "ref_high": "34.8", "flag": null}, {"name": "総蛋白", "value": "6.9", "value_num": 6.9, "unit": "g/dL", "ref_low": "6.6", "ref_high": "8.1", "flag": null}, {"name": "アルブミン", "value": "4", "value_num": 4.0, "unit": "g/dL", "ref_low": "4.1", "ref_high": "5.1", "flag": "L"}, {"name": "GOT(AST)", "value": "35", "value_num": 35.0, "unit": "U/L", "ref_low": "13", "ref_high": "30", "flag": "H"}, {"name": "GPT(ALT)", "value": "44", "value_num": 44.0, "unit": "U/L", "ref_low": "10", "ref_high": "42", "flag": "H"}, {"name": "γ-GTP", "value": "104", "value_num": 104.0, "unit": "U/L", "ref_low": "13", "ref_high": "64", "flag": "H"}, {"name": "ALP", "value": "95", "value_num": 95.0, "unit": "U/L", "ref_low": "38", "ref_high": "113", "flag": null}, {"name": "総コレステロール", "value": "227", "value_num": 227.0, "unit": "mg/dL", "ref_low": "130", "ref_high": "219", "flag": "H"}, {"name": "HDLコレステロール", "value": "42", "value_num": 42.0, "unit": "mg/dL", "ref_low": "40", "ref_high": null, "flag": null}, {"name": "LDLコレステロール", "value": "147", "value_num": 147.0, "unit": "mg/dL", "ref_low": "60", "ref_high": "119", "flag": "H"}, {"name": "空腹時中性脂肪", "value": "192", "value_num": 192.0, "unit": "mg/dL", "ref_low": "30", "ref_high": "149", "flag": "H"}, {"name": "空腹時血糖", "value": "123", "value_num": 123.0, "unit": "mg/dL", "ref_low": "73", "ref_high": "109", "flag": "H"}, {"name": "HbA1c(NGSP)", "value": "6.5", "value_num": 6.5, "unit": "%", "ref_low": "4.6", "ref_high": "6.2", "flag": "H"}, {"name": "クレアチニン", "value": "1.12", "value_num": 1.12, "unit": "mg/dL", "ref_low": "0.65", "ref_high": "1.07", "flag": "H"}, {"name": "eGFR", "value": "51.3", "value_num": 51.3, "unit": "mL/min/1.73m²", "ref_low": "60", "ref_high": null, "flag": "L"}, {"name": "尿酸", "value": "8.1", "value_num": 8.1, "unit": "mg/dL", "ref_low": "3.7", "ref_high": "7.8", "flag": "H"}, {"name": "CRP", "value": "0.18", "value_num": 0.18, "unit": "mg/dL", "ref_low": "0.00", "ref_high": "0.14", "flag": "H"}, {"name": "MCV", "value": "94.4", "value_num": 94.4, "unit": "fL", "ref_low": "83.6", "ref_high": "98.2", "flag": null}]'::jsonb
 where diagnostic_user_id = 'd0000003-0000-0000-0000-000000000000' and test_type = 'blood' and test_date = '2025-09-03';
delete from diagnosis.measurement_values mv using diagnosis.test_artifacts ta
 where mv.artifact_id = ta.id and ta.diagnostic_user_id = 'd0000003-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2025-09-03';
insert into diagnosis.measurement_values
  (artifact_id, diagnostic_user_id, test_type, test_date, seq, item_name, canonical_name,
   value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag, source_file_kind)
select ta.id, ta.diagnostic_user_id, ta.test_type, ta.test_date, v.seq, v.item_name, v.canonical_name,
       v.value, v.value_num, v.unit, v.ref_low, v.ref_high, v.ref_low_num, v.ref_high_num, v.flag, 'raw_csv'
  from diagnosis.test_artifacts ta,
  (values
    (0, '白血球数', '白血球数', '7400', 7400.0, '/μL', '3300', '8600', 3300.0, 8600.0, null),
    (1, '赤血球数', '赤血球数', '446', 446.0, '万/μL', '400', '539', 400.0, 539.0, null),
    (2, '血色素量', '血色素量', '14', 14.0, 'g/dL', '13.7', '16.8', 13.7, 16.8, null),
    (3, 'ヘマトクリット', 'ヘマトクリット', '42.1', 42.1, '%', '40.7', '50.1', 40.7, 50.1, null),
    (4, '血小板数', '血小板数', '21.2', 21.2, '万/μL', '15.8', '34.8', 15.8, 34.8, null),
    (5, '総蛋白', '総蛋白', '6.9', 6.9, 'g/dL', '6.6', '8.1', 6.6, 8.1, null),
    (6, 'アルブミン', null, '4', 4.0, 'g/dL', '4.1', '5.1', 4.1, 5.1, 'L'),
    (7, 'GOT(AST)', 'GOT(AST)', '35', 35.0, 'U/L', '13', '30', 13.0, 30.0, 'H'),
    (8, 'GPT(ALT)', 'GPT(ALT)', '44', 44.0, 'U/L', '10', '42', 10.0, 42.0, 'H'),
    (9, 'γ-GTP', 'γ-GTP', '104', 104.0, 'U/L', '13', '64', 13.0, 64.0, 'H'),
    (10, 'ALP', 'ALP', '95', 95.0, 'U/L', '38', '113', 38.0, 113.0, null),
    (11, '総コレステロール', '総コレステロール', '227', 227.0, 'mg/dL', '130', '219', 130.0, 219.0, 'H'),
    (12, 'HDLコレステロール', 'HDLコレステロール', '42', 42.0, 'mg/dL', '40', null, 40.0, null, null),
    (13, 'LDLコレステロール', 'LDLコレステロール', '147', 147.0, 'mg/dL', '60', '119', 60.0, 119.0, 'H'),
    (14, '空腹時中性脂肪', '空腹時中性脂肪', '192', 192.0, 'mg/dL', '30', '149', 30.0, 149.0, 'H'),
    (15, '空腹時血糖', '空腹時血糖', '123', 123.0, 'mg/dL', '73', '109', 73.0, 109.0, 'H'),
    (16, 'HbA1c(NGSP)', 'HbA1c(NGSP)', '6.5', 6.5, '%', '4.6', '6.2', 4.6, 6.2, 'H'),
    (17, 'クレアチニン', 'クレアチニン', '1.12', 1.12, 'mg/dL', '0.65', '1.07', 0.65, 1.07, 'H'),
    (18, 'eGFR', 'eGFR', '51.3', 51.3, 'mL/min/1.73m²', '60', null, 60.0, null, 'L'),
    (19, '尿酸', '尿酸', '8.1', 8.1, 'mg/dL', '3.7', '7.8', 3.7, 7.8, 'H'),
    (20, 'CRP', null, '0.18', 0.18, 'mg/dL', '0.00', '0.14', 0.0, 0.14, 'H'),
    (21, 'MCV', null, '94.4', 94.4, 'fL', '83.6', '98.2', 83.6, 98.2, null)
  ) as v(seq, item_name, canonical_name, value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag)
 where ta.diagnostic_user_id = 'd0000003-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2025-09-03';

-- 2026-03-05  (d0000003)
update diagnosis.test_artifacts set measurements = '[{"name": "白血球数", "value": "7700", "value_num": 7700.0, "unit": "/μL", "ref_low": "3300", "ref_high": "8600", "flag": null}, {"name": "赤血球数", "value": "441", "value_num": 441.0, "unit": "万/μL", "ref_low": "400", "ref_high": "539", "flag": null}, {"name": "血色素量", "value": "13.8", "value_num": 13.8, "unit": "g/dL", "ref_low": "13.7", "ref_high": "16.8", "flag": null}, {"name": "ヘマトクリット", "value": "41.7", "value_num": 41.7, "unit": "%", "ref_low": "40.7", "ref_high": "50.1", "flag": null}, {"name": "血小板数", "value": "20.6", "value_num": 20.6, "unit": "万/μL", "ref_low": "15.8", "ref_high": "34.8", "flag": null}, {"name": "総蛋白", "value": "6.8", "value_num": 6.8, "unit": "g/dL", "ref_low": "6.6", "ref_high": "8.1", "flag": null}, {"name": "アルブミン", "value": "3.9", "value_num": 3.9, "unit": "g/dL", "ref_low": "4.1", "ref_high": "5.1", "flag": "L"}, {"name": "GOT(AST)", "value": "39", "value_num": 39.0, "unit": "U/L", "ref_low": "13", "ref_high": "30", "flag": "H"}, {"name": "GPT(ALT)", "value": "51", "value_num": 51.0, "unit": "U/L", "ref_low": "10", "ref_high": "42", "flag": "H"}, {"name": "γ-GTP", "value": "121", "value_num": 121.0, "unit": "U/L", "ref_low": "13", "ref_high": "64", "flag": "H"}, {"name": "ALP", "value": "102", "value_num": 102.0, "unit": "U/L", "ref_low": "38", "ref_high": "113", "flag": null}, {"name": "総コレステロール", "value": "238", "value_num": 238.0, "unit": "mg/dL", "ref_low": "130", "ref_high": "219", "flag": "H"}, {"name": "HDLコレステロール", "value": "39", "value_num": 39.0, "unit": "mg/dL", "ref_low": "40", "ref_high": null, "flag": "L"}, {"name": "LDLコレステロール", "value": "156", "value_num": 156.0, "unit": "mg/dL", "ref_low": "60", "ref_high": "119", "flag": "H"}, {"name": "空腹時中性脂肪", "value": "214", "value_num": 214.0, "unit": "mg/dL", "ref_low": "30", "ref_high": "149", "flag": "H"}, {"name": "空腹時血糖", "value": "131", "value_num": 131.0, "unit": "mg/dL", "ref_low": "73", "ref_high": "109", "flag": "H"}, {"name": "HbA1c(NGSP)", "value": "6.8", "value_num": 6.8, "unit": "%", "ref_low": "4.6", "ref_high": "6.2", "flag": "H"}, {"name": "クレアチニン", "value": "1.19", "value_num": 1.19, "unit": "mg/dL", "ref_low": "0.65", "ref_high": "1.07", "flag": "H"}, {"name": "eGFR", "value": "48", "value_num": 48.0, "unit": "mL/min/1.73m²", "ref_low": "60", "ref_high": null, "flag": "L"}, {"name": "尿酸", "value": "8.5", "value_num": 8.5, "unit": "mg/dL", "ref_low": "3.7", "ref_high": "7.8", "flag": "H"}, {"name": "CRP", "value": "0.24", "value_num": 0.24, "unit": "mg/dL", "ref_low": "0.00", "ref_high": "0.14", "flag": "H"}, {"name": "MCV", "value": "94.6", "value_num": 94.6, "unit": "fL", "ref_low": "83.6", "ref_high": "98.2", "flag": null}]'::jsonb
 where diagnostic_user_id = 'd0000003-0000-0000-0000-000000000000' and test_type = 'blood' and test_date = '2026-03-05';
delete from diagnosis.measurement_values mv using diagnosis.test_artifacts ta
 where mv.artifact_id = ta.id and ta.diagnostic_user_id = 'd0000003-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2026-03-05';
insert into diagnosis.measurement_values
  (artifact_id, diagnostic_user_id, test_type, test_date, seq, item_name, canonical_name,
   value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag, source_file_kind)
select ta.id, ta.diagnostic_user_id, ta.test_type, ta.test_date, v.seq, v.item_name, v.canonical_name,
       v.value, v.value_num, v.unit, v.ref_low, v.ref_high, v.ref_low_num, v.ref_high_num, v.flag, 'raw_csv'
  from diagnosis.test_artifacts ta,
  (values
    (0, '白血球数', '白血球数', '7700', 7700.0, '/μL', '3300', '8600', 3300.0, 8600.0, null),
    (1, '赤血球数', '赤血球数', '441', 441.0, '万/μL', '400', '539', 400.0, 539.0, null),
    (2, '血色素量', '血色素量', '13.8', 13.8, 'g/dL', '13.7', '16.8', 13.7, 16.8, null),
    (3, 'ヘマトクリット', 'ヘマトクリット', '41.7', 41.7, '%', '40.7', '50.1', 40.7, 50.1, null),
    (4, '血小板数', '血小板数', '20.6', 20.6, '万/μL', '15.8', '34.8', 15.8, 34.8, null),
    (5, '総蛋白', '総蛋白', '6.8', 6.8, 'g/dL', '6.6', '8.1', 6.6, 8.1, null),
    (6, 'アルブミン', null, '3.9', 3.9, 'g/dL', '4.1', '5.1', 4.1, 5.1, 'L'),
    (7, 'GOT(AST)', 'GOT(AST)', '39', 39.0, 'U/L', '13', '30', 13.0, 30.0, 'H'),
    (8, 'GPT(ALT)', 'GPT(ALT)', '51', 51.0, 'U/L', '10', '42', 10.0, 42.0, 'H'),
    (9, 'γ-GTP', 'γ-GTP', '121', 121.0, 'U/L', '13', '64', 13.0, 64.0, 'H'),
    (10, 'ALP', 'ALP', '102', 102.0, 'U/L', '38', '113', 38.0, 113.0, null),
    (11, '総コレステロール', '総コレステロール', '238', 238.0, 'mg/dL', '130', '219', 130.0, 219.0, 'H'),
    (12, 'HDLコレステロール', 'HDLコレステロール', '39', 39.0, 'mg/dL', '40', null, 40.0, null, 'L'),
    (13, 'LDLコレステロール', 'LDLコレステロール', '156', 156.0, 'mg/dL', '60', '119', 60.0, 119.0, 'H'),
    (14, '空腹時中性脂肪', '空腹時中性脂肪', '214', 214.0, 'mg/dL', '30', '149', 30.0, 149.0, 'H'),
    (15, '空腹時血糖', '空腹時血糖', '131', 131.0, 'mg/dL', '73', '109', 73.0, 109.0, 'H'),
    (16, 'HbA1c(NGSP)', 'HbA1c(NGSP)', '6.8', 6.8, '%', '4.6', '6.2', 4.6, 6.2, 'H'),
    (17, 'クレアチニン', 'クレアチニン', '1.19', 1.19, 'mg/dL', '0.65', '1.07', 0.65, 1.07, 'H'),
    (18, 'eGFR', 'eGFR', '48', 48.0, 'mL/min/1.73m²', '60', null, 60.0, null, 'L'),
    (19, '尿酸', '尿酸', '8.5', 8.5, 'mg/dL', '3.7', '7.8', 3.7, 7.8, 'H'),
    (20, 'CRP', null, '0.24', 0.24, 'mg/dL', '0.00', '0.14', 0.0, 0.14, 'H'),
    (21, 'MCV', null, '94.6', 94.6, 'fL', '83.6', '98.2', 83.6, 98.2, null)
  ) as v(seq, item_name, canonical_name, value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag)
 where ta.diagnostic_user_id = 'd0000003-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2026-03-05';

-- 2026-07-15  (d0000003)
update diagnosis.test_artifacts set measurements = '[{"name": "白血球数", "value": "8000", "value_num": 8000.0, "unit": "/μL", "ref_low": "3300", "ref_high": "8600", "flag": null}, {"name": "赤血球数", "value": "436", "value_num": 436.0, "unit": "万/μL", "ref_low": "400", "ref_high": "539", "flag": null}, {"name": "血色素量", "value": "13.6", "value_num": 13.6, "unit": "g/dL", "ref_low": "13.7", "ref_high": "16.8", "flag": "L"}, {"name": "ヘマトクリット", "value": "41.2", "value_num": 41.2, "unit": "%", "ref_low": "40.7", "ref_high": "50.1", "flag": null}, {"name": "血小板数", "value": "20.1", "value_num": 20.1, "unit": "万/μL", "ref_low": "15.8", "ref_high": "34.8", "flag": null}, {"name": "総蛋白", "value": "6.7", "value_num": 6.7, "unit": "g/dL", "ref_low": "6.6", "ref_high": "8.1", "flag": null}, {"name": "アルブミン", "value": "3.8", "value_num": 3.8, "unit": "g/dL", "ref_low": "4.1", "ref_high": "5.1", "flag": "L"}, {"name": "GOT(AST)", "value": "43", "value_num": 43.0, "unit": "U/L", "ref_low": "13", "ref_high": "30", "flag": "H"}, {"name": "GPT(ALT)", "value": "58", "value_num": 58.0, "unit": "U/L", "ref_low": "10", "ref_high": "42", "flag": "H"}, {"name": "γ-GTP", "value": "139", "value_num": 139.0, "unit": "U/L", "ref_low": "13", "ref_high": "64", "flag": "H"}, {"name": "ALP", "value": "110", "value_num": 110.0, "unit": "U/L", "ref_low": "38", "ref_high": "113", "flag": null}, {"name": "総コレステロール", "value": "247", "value_num": 247.0, "unit": "mg/dL", "ref_low": "130", "ref_high": "219", "flag": "H"}, {"name": "HDLコレステロール", "value": "37", "value_num": 37.0, "unit": "mg/dL", "ref_low": "40", "ref_high": null, "flag": "L"}, {"name": "LDLコレステロール", "value": "163", "value_num": 163.0, "unit": "mg/dL", "ref_low": "60", "ref_high": "119", "flag": "H"}, {"name": "空腹時中性脂肪", "value": "236", "value_num": 236.0, "unit": "mg/dL", "ref_low": "30", "ref_high": "149", "flag": "H"}, {"name": "空腹時血糖", "value": "138", "value_num": 138.0, "unit": "mg/dL", "ref_low": "73", "ref_high": "109", "flag": "H"}, {"name": "HbA1c(NGSP)", "value": "7.1", "value_num": 7.1, "unit": "%", "ref_low": "4.6", "ref_high": "6.2", "flag": "H"}, {"name": "クレアチニン", "value": "1.26", "value_num": 1.26, "unit": "mg/dL", "ref_low": "0.65", "ref_high": "1.07", "flag": "H"}, {"name": "eGFR", "value": "44.9", "value_num": 44.9, "unit": "mL/min/1.73m²", "ref_low": "60", "ref_high": null, "flag": "L"}, {"name": "尿酸", "value": "8.9", "value_num": 8.9, "unit": "mg/dL", "ref_low": "3.7", "ref_high": "7.8", "flag": "H"}, {"name": "CRP", "value": "0.31", "value_num": 0.31, "unit": "mg/dL", "ref_low": "0.00", "ref_high": "0.14", "flag": "H"}, {"name": "MCV", "value": "94.7", "value_num": 94.7, "unit": "fL", "ref_low": "83.6", "ref_high": "98.2", "flag": null}]'::jsonb
 where diagnostic_user_id = 'd0000003-0000-0000-0000-000000000000' and test_type = 'blood' and test_date = '2026-07-15';
delete from diagnosis.measurement_values mv using diagnosis.test_artifacts ta
 where mv.artifact_id = ta.id and ta.diagnostic_user_id = 'd0000003-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2026-07-15';
insert into diagnosis.measurement_values
  (artifact_id, diagnostic_user_id, test_type, test_date, seq, item_name, canonical_name,
   value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag, source_file_kind)
select ta.id, ta.diagnostic_user_id, ta.test_type, ta.test_date, v.seq, v.item_name, v.canonical_name,
       v.value, v.value_num, v.unit, v.ref_low, v.ref_high, v.ref_low_num, v.ref_high_num, v.flag, 'raw_csv'
  from diagnosis.test_artifacts ta,
  (values
    (0, '白血球数', '白血球数', '8000', 8000.0, '/μL', '3300', '8600', 3300.0, 8600.0, null),
    (1, '赤血球数', '赤血球数', '436', 436.0, '万/μL', '400', '539', 400.0, 539.0, null),
    (2, '血色素量', '血色素量', '13.6', 13.6, 'g/dL', '13.7', '16.8', 13.7, 16.8, 'L'),
    (3, 'ヘマトクリット', 'ヘマトクリット', '41.2', 41.2, '%', '40.7', '50.1', 40.7, 50.1, null),
    (4, '血小板数', '血小板数', '20.1', 20.1, '万/μL', '15.8', '34.8', 15.8, 34.8, null),
    (5, '総蛋白', '総蛋白', '6.7', 6.7, 'g/dL', '6.6', '8.1', 6.6, 8.1, null),
    (6, 'アルブミン', null, '3.8', 3.8, 'g/dL', '4.1', '5.1', 4.1, 5.1, 'L'),
    (7, 'GOT(AST)', 'GOT(AST)', '43', 43.0, 'U/L', '13', '30', 13.0, 30.0, 'H'),
    (8, 'GPT(ALT)', 'GPT(ALT)', '58', 58.0, 'U/L', '10', '42', 10.0, 42.0, 'H'),
    (9, 'γ-GTP', 'γ-GTP', '139', 139.0, 'U/L', '13', '64', 13.0, 64.0, 'H'),
    (10, 'ALP', 'ALP', '110', 110.0, 'U/L', '38', '113', 38.0, 113.0, null),
    (11, '総コレステロール', '総コレステロール', '247', 247.0, 'mg/dL', '130', '219', 130.0, 219.0, 'H'),
    (12, 'HDLコレステロール', 'HDLコレステロール', '37', 37.0, 'mg/dL', '40', null, 40.0, null, 'L'),
    (13, 'LDLコレステロール', 'LDLコレステロール', '163', 163.0, 'mg/dL', '60', '119', 60.0, 119.0, 'H'),
    (14, '空腹時中性脂肪', '空腹時中性脂肪', '236', 236.0, 'mg/dL', '30', '149', 30.0, 149.0, 'H'),
    (15, '空腹時血糖', '空腹時血糖', '138', 138.0, 'mg/dL', '73', '109', 73.0, 109.0, 'H'),
    (16, 'HbA1c(NGSP)', 'HbA1c(NGSP)', '7.1', 7.1, '%', '4.6', '6.2', 4.6, 6.2, 'H'),
    (17, 'クレアチニン', 'クレアチニン', '1.26', 1.26, 'mg/dL', '0.65', '1.07', 0.65, 1.07, 'H'),
    (18, 'eGFR', 'eGFR', '44.9', 44.9, 'mL/min/1.73m²', '60', null, 60.0, null, 'L'),
    (19, '尿酸', '尿酸', '8.9', 8.9, 'mg/dL', '3.7', '7.8', 3.7, 7.8, 'H'),
    (20, 'CRP', null, '0.31', 0.31, 'mg/dL', '0.00', '0.14', 0.0, 0.14, 'H'),
    (21, 'MCV', null, '94.7', 94.7, 'fL', '83.6', '98.2', 83.6, 98.2, null)
  ) as v(seq, item_name, canonical_name, value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag)
 where ta.diagnostic_user_id = 'd0000003-0000-0000-0000-000000000000' and ta.test_type='blood' and ta.test_date = '2026-07-15';

-- ── ③ 健診パネル (真鍋 d0000001) : 人間ドックを年 1 回 x 3 年分 ────────────
-- 推移グラフは 2 回目の検査から引けるため、1 回分だと「グラフ」ボタンが無効のままになる。
-- クライアントに推移グラフと「表示項目の設定」を見てもらうため 3 回分を置く。
-- 値は医学的に成立させてある (BMI=体重/身長^2 / LDL+HDL<=TC / Friedewald TC=LDL+HDL+TG/5 /
-- eGFR=194*Cr^-1.094*Age^-0.287 の日本人向け推算式)。定性 3 項目 (尿蛋白/尿潜血/尿糖) は
-- value_num を持たないので推移の候補には出ない = 非数値経路の検証も兼ねる。

insert into diagnosis.test_artifacts
  (diagnostic_user_id, source, test_type, test_date, external_test_id, lab_name,
   schema_version, age_at_test, sex, display_mode, page_count, imported_at, imported_by, status) values
  ('d0000001-0000-0000-0000-000000000000', 'user_upload', 'health_checkup', '2024-06-14', 'HC-2024-000614', '某総合病院 (ユーザー UL)', '1.0', 54, 'male', 'three_mode', 8, '2024-06-14 14:30+09', 'user', 'active'),
  ('d0000001-0000-0000-0000-000000000000', 'user_upload', 'health_checkup', '2026-06-19', 'HC-2026-000619', '某総合病院 (ユーザー UL)', '1.0', 56, 'male', 'three_mode', 8, '2026-06-19 14:30+09', 'user', 'active')
on conflict (diagnostic_user_id, source, test_type, test_date, external_test_id) do nothing;

-- 2024-06-14
update diagnosis.test_artifacts set measurements = '[{"name": "身長", "value": "171.2", "value_num": 171.2, "unit": "cm", "ref_low": null, "ref_high": null, "flag": null}, {"name": "体重", "value": "71.6", "value_num": 71.6, "unit": "kg", "ref_low": null, "ref_high": null, "flag": null}, {"name": "BMI", "value": "24.4", "value_num": 24.4, "unit": null, "ref_low": "18.5", "ref_high": "24.9", "flag": null}, {"name": "腹囲", "value": "86.4", "value_num": 86.4, "unit": "cm", "ref_low": null, "ref_high": "85.0", "flag": "H"}, {"name": "最高血圧", "value": "131", "value_num": 131.0, "unit": "mmHg", "ref_low": null, "ref_high": "129", "flag": "H"}, {"name": "最低血圧", "value": "82", "value_num": 82.0, "unit": "mmHg", "ref_low": null, "ref_high": "84", "flag": null}, {"name": "裸眼視力右", "value": "0.8", "value_num": 0.8, "unit": null, "ref_low": "1.0", "ref_high": null, "flag": "L"}, {"name": "裸眼視力左", "value": "0.9", "value_num": 0.9, "unit": null, "ref_low": "1.0", "ref_high": null, "flag": "L"}, {"name": "総コレステロール", "value": "205", "value_num": 205.0, "unit": "mg/dL", "ref_low": "130", "ref_high": "219", "flag": null}, {"name": "HDLコレステロール", "value": "53", "value_num": 53.0, "unit": "mg/dL", "ref_low": "40", "ref_high": null, "flag": null}, {"name": "LDLコレステロール", "value": "124", "value_num": 124.0, "unit": "mg/dL", "ref_low": "60", "ref_high": "119", "flag": "H"}, {"name": "空腹時中性脂肪", "value": "140", "value_num": 140.0, "unit": "mg/dL", "ref_low": "30", "ref_high": "149", "flag": null}, {"name": "空腹時血糖", "value": "104", "value_num": 104.0, "unit": "mg/dL", "ref_low": "73", "ref_high": "109", "flag": null}, {"name": "HbA1c(NGSP)", "value": "5.8", "value_num": 5.8, "unit": "%", "ref_low": "4.6", "ref_high": "6.2", "flag": null}, {"name": "γ-GTP", "value": "58", "value_num": 58.0, "unit": "U/L", "ref_low": "13", "ref_high": "64", "flag": null}, {"name": "尿酸", "value": "7.0", "value_num": 7.0, "unit": "mg/dL", "ref_low": "3.7", "ref_high": "7.8", "flag": null}, {"name": "クレアチニン", "value": "0.91", "value_num": 0.91, "unit": "mg/dL", "ref_low": "0.65", "ref_high": "1.07", "flag": null}, {"name": "eGFR", "value": "68.5", "value_num": 68.5, "unit": "mL/min/1.73m²", "ref_low": "60", "ref_high": null, "flag": null}, {"name": "尿蛋白", "value": "(-)", "value_num": null, "unit": null, "ref_low": null, "ref_high": "(-)", "flag": null}, {"name": "尿潜血", "value": "(-)", "value_num": null, "unit": null, "ref_low": null, "ref_high": "(-)", "flag": null}, {"name": "尿糖", "value": "(-)", "value_num": null, "unit": null, "ref_low": null, "ref_high": "(-)", "flag": null}]'::jsonb
 where diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and test_type = 'health_checkup' and test_date = '2024-06-14';
delete from diagnosis.measurement_values mv using diagnosis.test_artifacts ta
 where mv.artifact_id = ta.id and ta.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and ta.test_type='health_checkup' and ta.test_date='2024-06-14';
insert into diagnosis.measurement_values
  (artifact_id, diagnostic_user_id, test_type, test_date, seq, item_name, canonical_name,
   value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag, source_file_kind)
select ta.id, ta.diagnostic_user_id, ta.test_type, ta.test_date, v.seq, v.item_name, v.canonical_name,
       v.value, v.value_num, v.unit, v.ref_low, v.ref_high, v.ref_low_num, v.ref_high_num, v.flag, 'scan_md'
  from diagnosis.test_artifacts ta,
  (values
    (0, '身長', '身長', '171.2', 171.2, 'cm', null, null, null, null, null),
    (1, '体重', '体重', '71.6', 71.6, 'kg', null, null, null, null, null),
    (2, 'BMI', 'BMI', '24.4', 24.4, null, '18.5', '24.9', 18.5, 24.9, null),
    (3, '腹囲', '腹囲', '86.4', 86.4, 'cm', null, '85.0', null, 85.0, 'H'),
    (4, '最高血圧', '最高血圧', '131', 131.0, 'mmHg', null, '129', null, 129.0, 'H'),
    (5, '最低血圧', '最低血圧', '82', 82.0, 'mmHg', null, '84', null, 84.0, null),
    (6, '裸眼視力右', '裸眼視力右', '0.8', 0.8, null, '1.0', null, 1.0, null, 'L'),
    (7, '裸眼視力左', '裸眼視力左', '0.9', 0.9, null, '1.0', null, 1.0, null, 'L'),
    (8, '総コレステロール', '総コレステロール', '205', 205.0, 'mg/dL', '130', '219', 130.0, 219.0, null),
    (9, 'HDLコレステロール', 'HDLコレステロール', '53', 53.0, 'mg/dL', '40', null, 40.0, null, null),
    (10, 'LDLコレステロール', 'LDLコレステロール', '124', 124.0, 'mg/dL', '60', '119', 60.0, 119.0, 'H'),
    (11, '空腹時中性脂肪', '空腹時中性脂肪', '140', 140.0, 'mg/dL', '30', '149', 30.0, 149.0, null),
    (12, '空腹時血糖', '空腹時血糖', '104', 104.0, 'mg/dL', '73', '109', 73.0, 109.0, null),
    (13, 'HbA1c(NGSP)', 'HbA1c(NGSP)', '5.8', 5.8, '%', '4.6', '6.2', 4.6, 6.2, null),
    (14, 'γ-GTP', 'γ-GTP', '58', 58.0, 'U/L', '13', '64', 13.0, 64.0, null),
    (15, '尿酸', '尿酸', '7.0', 7.0, 'mg/dL', '3.7', '7.8', 3.7, 7.8, null),
    (16, 'クレアチニン', 'クレアチニン', '0.91', 0.91, 'mg/dL', '0.65', '1.07', 0.65, 1.07, null),
    (17, 'eGFR', 'eGFR', '68.5', 68.5, 'mL/min/1.73m²', '60', null, 60.0, null, null),
    (18, '尿蛋白', '尿蛋白', '(-)', null, null, null, '(-)', null, null, null),
    (19, '尿潜血', '尿潜血', '(-)', null, null, null, '(-)', null, null, null),
    (20, '尿糖', '尿糖', '(-)', null, null, null, '(-)', null, null, null)
  ) as v(seq, item_name, canonical_name, value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag)
 where ta.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and ta.test_type='health_checkup' and ta.test_date = '2024-06-14';

-- 2025-06-15
update diagnosis.test_artifacts set measurements = '[{"name": "身長", "value": "171.2", "value_num": 171.2, "unit": "cm", "ref_low": null, "ref_high": null, "flag": null}, {"name": "体重", "value": "72.4", "value_num": 72.4, "unit": "kg", "ref_low": null, "ref_high": null, "flag": null}, {"name": "BMI", "value": "24.7", "value_num": 24.7, "unit": null, "ref_low": "18.5", "ref_high": "24.9", "flag": null}, {"name": "腹囲", "value": "87.5", "value_num": 87.5, "unit": "cm", "ref_low": null, "ref_high": "85.0", "flag": "H"}, {"name": "最高血圧", "value": "134", "value_num": 134.0, "unit": "mmHg", "ref_low": null, "ref_high": "129", "flag": "H"}, {"name": "最低血圧", "value": "84", "value_num": 84.0, "unit": "mmHg", "ref_low": null, "ref_high": "84", "flag": null}, {"name": "裸眼視力右", "value": "0.7", "value_num": 0.7, "unit": null, "ref_low": "1.0", "ref_high": null, "flag": "L"}, {"name": "裸眼視力左", "value": "0.8", "value_num": 0.8, "unit": null, "ref_low": "1.0", "ref_high": null, "flag": "L"}, {"name": "総コレステロール", "value": "210", "value_num": 210.0, "unit": "mg/dL", "ref_low": "130", "ref_high": "219", "flag": null}, {"name": "HDLコレステロール", "value": "51", "value_num": 51.0, "unit": "mg/dL", "ref_low": "40", "ref_high": null, "flag": null}, {"name": "LDLコレステロール", "value": "129", "value_num": 129.0, "unit": "mg/dL", "ref_low": "60", "ref_high": "119", "flag": "H"}, {"name": "空腹時中性脂肪", "value": "150", "value_num": 150.0, "unit": "mg/dL", "ref_low": "30", "ref_high": "149", "flag": "H"}, {"name": "空腹時血糖", "value": "107", "value_num": 107.0, "unit": "mg/dL", "ref_low": "73", "ref_high": "109", "flag": null}, {"name": "HbA1c(NGSP)", "value": "5.9", "value_num": 5.9, "unit": "%", "ref_low": "4.6", "ref_high": "6.2", "flag": null}, {"name": "γ-GTP", "value": "64", "value_num": 64.0, "unit": "U/L", "ref_low": "13", "ref_high": "64", "flag": null}, {"name": "尿酸", "value": "7.3", "value_num": 7.3, "unit": "mg/dL", "ref_low": "3.7", "ref_high": "7.8", "flag": null}, {"name": "クレアチニン", "value": "0.93", "value_num": 0.93, "unit": "mg/dL", "ref_low": "0.65", "ref_high": "1.07", "flag": null}, {"name": "eGFR", "value": "66.5", "value_num": 66.5, "unit": "mL/min/1.73m²", "ref_low": "60", "ref_high": null, "flag": null}, {"name": "尿蛋白", "value": "(-)", "value_num": null, "unit": null, "ref_low": null, "ref_high": "(-)", "flag": null}, {"name": "尿潜血", "value": "(-)", "value_num": null, "unit": null, "ref_low": null, "ref_high": "(-)", "flag": null}, {"name": "尿糖", "value": "(-)", "value_num": null, "unit": null, "ref_low": null, "ref_high": "(-)", "flag": null}]'::jsonb
 where diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and test_type = 'health_checkup' and test_date = '2025-06-15';
delete from diagnosis.measurement_values mv using diagnosis.test_artifacts ta
 where mv.artifact_id = ta.id and ta.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and ta.test_type='health_checkup' and ta.test_date='2025-06-15';
insert into diagnosis.measurement_values
  (artifact_id, diagnostic_user_id, test_type, test_date, seq, item_name, canonical_name,
   value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag, source_file_kind)
select ta.id, ta.diagnostic_user_id, ta.test_type, ta.test_date, v.seq, v.item_name, v.canonical_name,
       v.value, v.value_num, v.unit, v.ref_low, v.ref_high, v.ref_low_num, v.ref_high_num, v.flag, 'scan_md'
  from diagnosis.test_artifacts ta,
  (values
    (0, '身長', '身長', '171.2', 171.2, 'cm', null, null, null, null, null),
    (1, '体重', '体重', '72.4', 72.4, 'kg', null, null, null, null, null),
    (2, 'BMI', 'BMI', '24.7', 24.7, null, '18.5', '24.9', 18.5, 24.9, null),
    (3, '腹囲', '腹囲', '87.5', 87.5, 'cm', null, '85.0', null, 85.0, 'H'),
    (4, '最高血圧', '最高血圧', '134', 134.0, 'mmHg', null, '129', null, 129.0, 'H'),
    (5, '最低血圧', '最低血圧', '84', 84.0, 'mmHg', null, '84', null, 84.0, null),
    (6, '裸眼視力右', '裸眼視力右', '0.7', 0.7, null, '1.0', null, 1.0, null, 'L'),
    (7, '裸眼視力左', '裸眼視力左', '0.8', 0.8, null, '1.0', null, 1.0, null, 'L'),
    (8, '総コレステロール', '総コレステロール', '210', 210.0, 'mg/dL', '130', '219', 130.0, 219.0, null),
    (9, 'HDLコレステロール', 'HDLコレステロール', '51', 51.0, 'mg/dL', '40', null, 40.0, null, null),
    (10, 'LDLコレステロール', 'LDLコレステロール', '129', 129.0, 'mg/dL', '60', '119', 60.0, 119.0, 'H'),
    (11, '空腹時中性脂肪', '空腹時中性脂肪', '150', 150.0, 'mg/dL', '30', '149', 30.0, 149.0, 'H'),
    (12, '空腹時血糖', '空腹時血糖', '107', 107.0, 'mg/dL', '73', '109', 73.0, 109.0, null),
    (13, 'HbA1c(NGSP)', 'HbA1c(NGSP)', '5.9', 5.9, '%', '4.6', '6.2', 4.6, 6.2, null),
    (14, 'γ-GTP', 'γ-GTP', '64', 64.0, 'U/L', '13', '64', 13.0, 64.0, null),
    (15, '尿酸', '尿酸', '7.3', 7.3, 'mg/dL', '3.7', '7.8', 3.7, 7.8, null),
    (16, 'クレアチニン', 'クレアチニン', '0.93', 0.93, 'mg/dL', '0.65', '1.07', 0.65, 1.07, null),
    (17, 'eGFR', 'eGFR', '66.5', 66.5, 'mL/min/1.73m²', '60', null, 60.0, null, null),
    (18, '尿蛋白', '尿蛋白', '(-)', null, null, null, '(-)', null, null, null),
    (19, '尿潜血', '尿潜血', '(-)', null, null, null, '(-)', null, null, null),
    (20, '尿糖', '尿糖', '(-)', null, null, null, '(-)', null, null, null)
  ) as v(seq, item_name, canonical_name, value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag)
 where ta.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and ta.test_type='health_checkup' and ta.test_date = '2025-06-15';

-- 2026-06-19
update diagnosis.test_artifacts set measurements = '[{"name": "身長", "value": "171.2", "value_num": 171.2, "unit": "cm", "ref_low": null, "ref_high": null, "flag": null}, {"name": "体重", "value": "72.9", "value_num": 72.9, "unit": "kg", "ref_low": null, "ref_high": null, "flag": null}, {"name": "BMI", "value": "24.9", "value_num": 24.9, "unit": null, "ref_low": "18.5", "ref_high": "24.9", "flag": null}, {"name": "腹囲", "value": "88.2", "value_num": 88.2, "unit": "cm", "ref_low": null, "ref_high": "85.0", "flag": "H"}, {"name": "最高血圧", "value": "136", "value_num": 136.0, "unit": "mmHg", "ref_low": null, "ref_high": "129", "flag": "H"}, {"name": "最低血圧", "value": "85", "value_num": 85.0, "unit": "mmHg", "ref_low": null, "ref_high": "84", "flag": "H"}, {"name": "裸眼視力右", "value": "0.7", "value_num": 0.7, "unit": null, "ref_low": "1.0", "ref_high": null, "flag": "L"}, {"name": "裸眼視力左", "value": "0.7", "value_num": 0.7, "unit": null, "ref_low": "1.0", "ref_high": null, "flag": "L"}, {"name": "総コレステロール", "value": "214", "value_num": 214.0, "unit": "mg/dL", "ref_low": "130", "ref_high": "219", "flag": null}, {"name": "HDLコレステロール", "value": "50", "value_num": 50.0, "unit": "mg/dL", "ref_low": "40", "ref_high": null, "flag": null}, {"name": "LDLコレステロール", "value": "133", "value_num": 133.0, "unit": "mg/dL", "ref_low": "60", "ref_high": "119", "flag": "H"}, {"name": "空腹時中性脂肪", "value": "155", "value_num": 155.0, "unit": "mg/dL", "ref_low": "30", "ref_high": "149", "flag": "H"}, {"name": "空腹時血糖", "value": "110", "value_num": 110.0, "unit": "mg/dL", "ref_low": "73", "ref_high": "109", "flag": "H"}, {"name": "HbA1c(NGSP)", "value": "6.0", "value_num": 6.0, "unit": "%", "ref_low": "4.6", "ref_high": "6.2", "flag": null}, {"name": "γ-GTP", "value": "69", "value_num": 69.0, "unit": "U/L", "ref_low": "13", "ref_high": "64", "flag": "H"}, {"name": "尿酸", "value": "7.5", "value_num": 7.5, "unit": "mg/dL", "ref_low": "3.7", "ref_high": "7.8", "flag": null}, {"name": "クレアチニン", "value": "0.94", "value_num": 0.94, "unit": "mg/dL", "ref_low": "0.65", "ref_high": "1.07", "flag": null}, {"name": "eGFR", "value": "65.4", "value_num": 65.4, "unit": "mL/min/1.73m²", "ref_low": "60", "ref_high": null, "flag": null}, {"name": "尿蛋白", "value": "(-)", "value_num": null, "unit": null, "ref_low": null, "ref_high": "(-)", "flag": null}, {"name": "尿潜血", "value": "(-)", "value_num": null, "unit": null, "ref_low": null, "ref_high": "(-)", "flag": null}, {"name": "尿糖", "value": "(-)", "value_num": null, "unit": null, "ref_low": null, "ref_high": "(-)", "flag": null}]'::jsonb
 where diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and test_type = 'health_checkup' and test_date = '2026-06-19';
delete from diagnosis.measurement_values mv using diagnosis.test_artifacts ta
 where mv.artifact_id = ta.id and ta.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and ta.test_type='health_checkup' and ta.test_date='2026-06-19';
insert into diagnosis.measurement_values
  (artifact_id, diagnostic_user_id, test_type, test_date, seq, item_name, canonical_name,
   value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag, source_file_kind)
select ta.id, ta.diagnostic_user_id, ta.test_type, ta.test_date, v.seq, v.item_name, v.canonical_name,
       v.value, v.value_num, v.unit, v.ref_low, v.ref_high, v.ref_low_num, v.ref_high_num, v.flag, 'scan_md'
  from diagnosis.test_artifacts ta,
  (values
    (0, '身長', '身長', '171.2', 171.2, 'cm', null, null, null, null, null),
    (1, '体重', '体重', '72.9', 72.9, 'kg', null, null, null, null, null),
    (2, 'BMI', 'BMI', '24.9', 24.9, null, '18.5', '24.9', 18.5, 24.9, null),
    (3, '腹囲', '腹囲', '88.2', 88.2, 'cm', null, '85.0', null, 85.0, 'H'),
    (4, '最高血圧', '最高血圧', '136', 136.0, 'mmHg', null, '129', null, 129.0, 'H'),
    (5, '最低血圧', '最低血圧', '85', 85.0, 'mmHg', null, '84', null, 84.0, 'H'),
    (6, '裸眼視力右', '裸眼視力右', '0.7', 0.7, null, '1.0', null, 1.0, null, 'L'),
    (7, '裸眼視力左', '裸眼視力左', '0.7', 0.7, null, '1.0', null, 1.0, null, 'L'),
    (8, '総コレステロール', '総コレステロール', '214', 214.0, 'mg/dL', '130', '219', 130.0, 219.0, null),
    (9, 'HDLコレステロール', 'HDLコレステロール', '50', 50.0, 'mg/dL', '40', null, 40.0, null, null),
    (10, 'LDLコレステロール', 'LDLコレステロール', '133', 133.0, 'mg/dL', '60', '119', 60.0, 119.0, 'H'),
    (11, '空腹時中性脂肪', '空腹時中性脂肪', '155', 155.0, 'mg/dL', '30', '149', 30.0, 149.0, 'H'),
    (12, '空腹時血糖', '空腹時血糖', '110', 110.0, 'mg/dL', '73', '109', 73.0, 109.0, 'H'),
    (13, 'HbA1c(NGSP)', 'HbA1c(NGSP)', '6.0', 6.0, '%', '4.6', '6.2', 4.6, 6.2, null),
    (14, 'γ-GTP', 'γ-GTP', '69', 69.0, 'U/L', '13', '64', 13.0, 64.0, 'H'),
    (15, '尿酸', '尿酸', '7.5', 7.5, 'mg/dL', '3.7', '7.8', 3.7, 7.8, null),
    (16, 'クレアチニン', 'クレアチニン', '0.94', 0.94, 'mg/dL', '0.65', '1.07', 0.65, 1.07, null),
    (17, 'eGFR', 'eGFR', '65.4', 65.4, 'mL/min/1.73m²', '60', null, 60.0, null, null),
    (18, '尿蛋白', '尿蛋白', '(-)', null, null, null, '(-)', null, null, null),
    (19, '尿潜血', '尿潜血', '(-)', null, null, null, '(-)', null, null, null),
    (20, '尿糖', '尿糖', '(-)', null, null, null, '(-)', null, null, null)
  ) as v(seq, item_name, canonical_name, value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag)
 where ta.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and ta.test_type='health_checkup' and ta.test_date = '2026-06-19';

-- ── ④ ウェルネス年齢スコア (現状 0 行 = カードが何も表示できない状態の解消) ────
-- biological_age は UI 表示検証用の固定値であり CABA の実計算結果ではない。
-- 本番では src/lib/health-age.ts が算出して書き込む。
-- 3パターンを用意: 真鍋=横ばい(実年齢+) / 田中=改善(実年齢-) / 山田=悪化(実年齢+大)
--   ※「実年齢より上」の表示とフォローアップ文言は暫定機能の懸案 → 悪化パターンは必須。
insert into diagnosis.health_age_scores
  (diagnostic_user_id, source_kind, test_date, chronological_age, biological_age, delta, model_version, inputs) values
  ('d0000001-0000-0000-0000-000000000000', 'blood', '2025-01-20', 55.2, 56.8, 1.6, 'seed-fixture', '{"used_markers": ["albumin", "creatinine", "glucose", "crp", "lymph", "mcv", "rdw", "alp", "wbc"], "carried_markers": [], "imputed_markers": ["rdw", "lymph"], "note": "seed: UI表示検証用の固定値。CABA実計算ではない。"}'::jsonb),
  ('d0000001-0000-0000-0000-000000000000', 'blood', '2025-05-19', 55.5, 57.2, 1.7, 'seed-fixture', '{"used_markers": ["albumin", "creatinine", "glucose", "crp", "lymph", "mcv", "rdw", "alp", "wbc"], "carried_markers": [], "imputed_markers": ["rdw", "lymph"], "note": "seed: UI表示検証用の固定値。CABA実計算ではない。"}'::jsonb),
  ('d0000001-0000-0000-0000-000000000000', 'blood', '2025-09-14', 55.8, 57.0, 1.2, 'seed-fixture', '{"used_markers": ["albumin", "creatinine", "glucose", "crp", "lymph", "mcv", "rdw", "alp", "wbc"], "carried_markers": [], "imputed_markers": ["rdw", "lymph"], "note": "seed: UI表示検証用の固定値。CABA実計算ではない。"}'::jsonb),
  ('d0000001-0000-0000-0000-000000000000', 'blood', '2026-01-13', 56.1, 57.9, 1.8, 'seed-fixture', '{"used_markers": ["albumin", "creatinine", "glucose", "crp", "lymph", "mcv", "rdw", "alp", "wbc"], "carried_markers": [], "imputed_markers": ["rdw", "lymph"], "note": "seed: UI表示検証用の固定値。CABA実計算ではない。"}'::jsonb),
  ('d0000001-0000-0000-0000-000000000000', 'blood', '2026-05-18', 56.5, 57.4, 0.9, 'seed-fixture', '{"used_markers": ["albumin", "creatinine", "glucose", "crp", "lymph", "mcv", "rdw", "alp", "wbc"], "carried_markers": [], "imputed_markers": ["rdw", "lymph"], "note": "seed: UI表示検証用の固定値。CABA実計算ではない。"}'::jsonb),
  ('d0000002-0000-0000-0000-000000000000', 'blood', '2025-04-15', 41.1, 41.9, 0.8, 'seed-fixture', '{"used_markers": ["albumin", "creatinine", "glucose", "crp", "lymph", "mcv", "rdw", "alp", "wbc"], "carried_markers": [], "imputed_markers": ["rdw", "lymph"], "note": "seed: UI表示検証用の固定値。CABA実計算ではない。"}'::jsonb),
  ('d0000002-0000-0000-0000-000000000000', 'blood', '2025-12-19', 41.8, 40.2, -1.6, 'seed-fixture', '{"used_markers": ["albumin", "creatinine", "glucose", "crp", "lymph", "mcv", "rdw", "alp", "wbc"], "carried_markers": [], "imputed_markers": ["rdw", "lymph"], "note": "seed: UI表示検証用の固定値。CABA実計算ではない。"}'::jsonb),
  ('d0000002-0000-0000-0000-000000000000', 'blood', '2026-04-14', 42.1, 38.6, -3.5, 'seed-fixture', '{"used_markers": ["albumin", "creatinine", "glucose", "crp", "lymph", "mcv", "rdw", "alp", "wbc"], "carried_markers": [], "imputed_markers": ["rdw", "lymph"], "note": "seed: UI表示検証用の固定値。CABA実計算ではない。"}'::jsonb),
  ('d0000003-0000-0000-0000-000000000000', 'blood', '2025-03-06', 66.7, 70.4, 3.7, 'seed-fixture', '{"used_markers": ["albumin", "creatinine", "glucose", "crp", "lymph", "mcv", "rdw", "alp", "wbc"], "carried_markers": [], "imputed_markers": ["rdw", "lymph"], "note": "seed: UI表示検証用の固定値。CABA実計算ではない。"}'::jsonb),
  ('d0000003-0000-0000-0000-000000000000', 'blood', '2025-09-03', 67.2, 72.1, 4.9, 'seed-fixture', '{"used_markers": ["albumin", "creatinine", "glucose", "crp", "lymph", "mcv", "rdw", "alp", "wbc"], "carried_markers": [], "imputed_markers": ["rdw", "lymph"], "note": "seed: UI表示検証用の固定値。CABA実計算ではない。"}'::jsonb),
  ('d0000003-0000-0000-0000-000000000000', 'blood', '2026-03-05', 67.7, 73.8, 6.1, 'seed-fixture', '{"used_markers": ["albumin", "creatinine", "glucose", "crp", "lymph", "mcv", "rdw", "alp", "wbc"], "carried_markers": [], "imputed_markers": ["rdw", "lymph"], "note": "seed: UI表示検証用の固定値。CABA実計算ではない。"}'::jsonb),
  ('d0000003-0000-0000-0000-000000000000', 'blood', '2026-07-15', 68.0, 75.6, 7.6, 'seed-fixture', '{"used_markers": ["albumin", "creatinine", "glucose", "crp", "lymph", "mcv", "rdw", "alp", "wbc"], "carried_markers": [], "imputed_markers": ["rdw", "lymph"], "note": "seed: UI表示検証用の固定値。CABA実計算ではない。"}'::jsonb)
on conflict (diagnostic_user_id, test_date, source_kind) do nothing;


-- ── ⑥ がんリスク検査 (真鍋 d0000001・ALA-PDS) : canonical_name が付かない経路 ────
-- 項目名・単位・値のレンジは docs/scan/golden/scan_golden_cancer_alapds_20251226.md の
-- 実測 (元 PDF page2 から人手確定) に合わせる。
--
-- 【canonical_name は null のまま】standard-master.ts は健診標準フォーマット(KMAT)の
-- starter なので ALA-PDS の項目は収録されていない。当て推量で埋めない (捏造ゼロ)。
-- 推移グラフ側は **テストフェーズの暫定措置**として item_name をキーに拾う
-- (src/lib/measurement-queries.ts の seriesKey)。
--
-- 【インデックス値】ポルフィリン量からの算出式は検査機関の非公開仕様なので、こちらでは
-- 式を作らない。ゴールデンの実測ペア (972 → 0.8) の比をそのまま保った値を置いている
-- =表示確認用のテスト値であって、検査機関の算出結果ではない。
-- 【基準値・判定は入れない】「A: <2.0 / B: 2.0〜4.9 …」の目安表はゴールデンでも
-- 説明文 (非測定値) 扱い。アプリが基準値や判定を決めないため ref/flag は null。

insert into diagnosis.test_artifacts
  (diagnostic_user_id, source, test_type, test_date, external_test_id, lab_name,
   schema_version, age_at_test, sex, display_mode, page_count, imported_at, imported_by, status) values
  ('d0000001-0000-0000-0000-000000000000', 'wellfort_lab', 'cancer_urine', '2024-01-16', 'K0871', 'PREVENT メディカル', '1.0', 54, 'male', 'single', 3, '2024-01-16 10:00+09', 'wellfort_batch', 'active'),
  ('d0000001-0000-0000-0000-000000000000', 'wellfort_lab', 'cancer_urine', '2025-01-14', 'K0975', 'PREVENT メディカル', '1.0', 55, 'male', 'single', 3, '2025-01-14 10:00+09', 'wellfort_batch', 'active'),
  ('d0000001-0000-0000-0000-000000000000', 'wellfort_lab', 'cancer_urine', '2026-01-12', 'K1079', 'PREVENT メディカル', '1.0', 56, 'male', 'single', 3, '2026-01-12 10:00+09', 'wellfort_batch', 'active')
on conflict (diagnostic_user_id, source, test_type, test_date, external_test_id) do nothing;

-- 2024-01-16
update diagnosis.test_artifacts set measurements = '[{"name": "尿中ポルフィリン量", "value": "852", "value_num": 852.0, "unit": "nmol/g・CRE", "ref_low": null, "ref_high": null, "flag": null}, {"name": "インデックス値", "value": "0.7", "value_num": 0.7, "unit": null, "ref_low": null, "ref_high": null, "flag": null}, {"name": "リスクランク", "value": "A", "value_num": null, "unit": null, "ref_low": null, "ref_high": null, "flag": null}]'::jsonb
 where diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and test_type = 'cancer_urine' and test_date = '2024-01-16';
delete from diagnosis.measurement_values mv using diagnosis.test_artifacts ta
 where mv.artifact_id = ta.id and ta.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and ta.test_type='cancer_urine' and ta.test_date='2024-01-16';
insert into diagnosis.measurement_values
  (artifact_id, diagnostic_user_id, test_type, test_date, seq, item_name, canonical_name,
   value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag, source_file_kind)
select ta.id, ta.diagnostic_user_id, ta.test_type, ta.test_date, v.seq, v.item_name, v.canonical_name,
       v.value, v.value_num, v.unit, v.ref_low, v.ref_high, v.ref_low_num, v.ref_high_num, v.flag, 'scan_md'
  from diagnosis.test_artifacts ta,
  (values
    (0, '尿中ポルフィリン量', null, '852', 852.0, 'nmol/g・CRE', null, null, null::numeric, null::numeric, null),
    (1, 'インデックス値', null, '0.7', 0.7, null, null, null, null::numeric, null::numeric, null),
    (2, 'リスクランク', null, 'A', null, null, null, null, null::numeric, null::numeric, null)
  ) as v(seq, item_name, canonical_name, value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag)
 where ta.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and ta.test_type='cancer_urine' and ta.test_date = '2024-01-16';

-- 2025-01-14
update diagnosis.test_artifacts set measurements = '[{"name": "尿中ポルフィリン量", "value": "972", "value_num": 972.0, "unit": "nmol/g・CRE", "ref_low": null, "ref_high": null, "flag": null}, {"name": "インデックス値", "value": "0.8", "value_num": 0.8, "unit": null, "ref_low": null, "ref_high": null, "flag": null}, {"name": "リスクランク", "value": "A", "value_num": null, "unit": null, "ref_low": null, "ref_high": null, "flag": null}]'::jsonb
 where diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and test_type = 'cancer_urine' and test_date = '2025-01-14';
delete from diagnosis.measurement_values mv using diagnosis.test_artifacts ta
 where mv.artifact_id = ta.id and ta.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and ta.test_type='cancer_urine' and ta.test_date='2025-01-14';
insert into diagnosis.measurement_values
  (artifact_id, diagnostic_user_id, test_type, test_date, seq, item_name, canonical_name,
   value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag, source_file_kind)
select ta.id, ta.diagnostic_user_id, ta.test_type, ta.test_date, v.seq, v.item_name, v.canonical_name,
       v.value, v.value_num, v.unit, v.ref_low, v.ref_high, v.ref_low_num, v.ref_high_num, v.flag, 'scan_md'
  from diagnosis.test_artifacts ta,
  (values
    (0, '尿中ポルフィリン量', null, '972', 972.0, 'nmol/g・CRE', null, null, null::numeric, null::numeric, null),
    (1, 'インデックス値', null, '0.8', 0.8, null, null, null, null::numeric, null::numeric, null),
    (2, 'リスクランク', null, 'A', null, null, null, null, null::numeric, null::numeric, null)
  ) as v(seq, item_name, canonical_name, value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag)
 where ta.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and ta.test_type='cancer_urine' and ta.test_date = '2025-01-14';

-- 2026-01-12
update diagnosis.test_artifacts set measurements = '[{"name": "尿中ポルフィリン量", "value": "1094", "value_num": 1094.0, "unit": "nmol/g・CRE", "ref_low": null, "ref_high": null, "flag": null}, {"name": "インデックス値", "value": "0.9", "value_num": 0.9, "unit": null, "ref_low": null, "ref_high": null, "flag": null}, {"name": "リスクランク", "value": "A", "value_num": null, "unit": null, "ref_low": null, "ref_high": null, "flag": null}]'::jsonb
 where diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and test_type = 'cancer_urine' and test_date = '2026-01-12';
delete from diagnosis.measurement_values mv using diagnosis.test_artifacts ta
 where mv.artifact_id = ta.id and ta.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and ta.test_type='cancer_urine' and ta.test_date='2026-01-12';
insert into diagnosis.measurement_values
  (artifact_id, diagnostic_user_id, test_type, test_date, seq, item_name, canonical_name,
   value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag, source_file_kind)
select ta.id, ta.diagnostic_user_id, ta.test_type, ta.test_date, v.seq, v.item_name, v.canonical_name,
       v.value, v.value_num, v.unit, v.ref_low, v.ref_high, v.ref_low_num, v.ref_high_num, v.flag, 'scan_md'
  from diagnosis.test_artifacts ta,
  (values
    (0, '尿中ポルフィリン量', null, '1094', 1094.0, 'nmol/g・CRE', null, null, null::numeric, null::numeric, null),
    (1, 'インデックス値', null, '0.9', 0.9, null, null, null, null::numeric, null::numeric, null),
    (2, 'リスクランク', null, 'A', null, null, null, null, null::numeric, null::numeric, null)
  ) as v(seq, item_name, canonical_name, value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag)
 where ta.diagnostic_user_id = 'd0000001-0000-0000-0000-000000000000' and ta.test_type='cancer_urine' and ta.test_date = '2026-01-12';

-- ── ⑤ 空状態は既存 seed のまま (追加しない) ─────────────────────────────
--   鈴木 一郎  d0000004… : 契約直後・検査なし        → 「データが無いとき」の画面
--   中村 さくら d0000009… : 検査中 (lab_received・結果未) → 「進行中」の画面
--   キット進捗の未取得段階 (lab_received_at/lab_completed_at = null) は既存 14 件中 6 件で充足。
