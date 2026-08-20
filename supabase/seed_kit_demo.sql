-- 検査キット進捗の表示確認用データ (STEP 4 / 表示確認のため追加)。
--
-- 目的: /kit ページで 6 段階すべてと「未取得」表示を実機確認できるようにする。
--   既存 seed.sql の 14 件は step 2/3/6 に偏っており、
--     - step 1 (出荷準備) … 該当なし
--     - step 4 (返送済で止まっている状態) … 該当なし
--     - 完了しているのに受取日が無い不整合行が 1 件
--   という穴があった。ここを埋める。
--
-- 冪等: id 固定 + on conflict do nothing / 明示 update。何度流しても同じ結果。
-- PII は含まない (customer スキーマの既存顧客に紐づけるだけ)。

-- ── 1) 不整合の是正 ──────────────────────────────────────────────
-- 山田 (d0000003) の 60000006 は「検査完了」なのに受取・返送・会社受領が空で、
-- タイムラインが「完了だが途中が未到達」という現実に無い形になる。
-- 中間段階の日時を補って一貫させる (完了日は変えない)。
update customer.kit_shipments set
  user_received_at = coalesce(user_received_at, shipped_at + interval '2 days'),
  user_returned_at = coalesce(user_returned_at, shipped_at + interval '4 days'),
  lab_received_at  = coalesce(lab_received_at,  shipped_at + interval '6 days')
where id = '60000006-0000-0000-0000-000000000000';

-- ── 2) 不足している段階を追加 ────────────────────────────────────
insert into customer.kit_shipments
  (id, order_id, customer_id, lab_company_id, test_type, subscription_id,
   subscription_year, subscription_seq, warehouse,
   shipped_at, tracking_no, carrier, carrier_tracking_url,
   expected_arrival_date, user_received_at, user_returned_at,
   lab_received_at, lab_completed_at, notes)
values
  -- step 1: 出荷準備 (発送前)。真鍋の次回分。
  ('60000101-0000-0000-0000-000000000000', 'ORD-2026-0101',
   'c0000001-0000-0000-0000-000000000000', '1a000001-0000-0000-0000-000000000000',
   'blood', null, 2026, 3, 'タカセ倉庫',
   null, null, null, null,
   null, null, null, null, null, '出荷準備中 (表示確認用)'),

  -- step 4: 返送済で止まっている状態。ここで段階 5/6 が「未取得」と出る。
  ('60000102-0000-0000-0000-000000000000', 'ORD-2026-0102',
   'c0000001-0000-0000-0000-000000000000', '1a000002-0000-0000-0000-000000000000',
   'cancer_urine', null, 2026, 2, 'タカセ倉庫',
   '2026-07-21 10:00+09', 'YT-1234-5678-9101', 'ヤマト運輸',
   'https://track.example.com/YT-1234-5678-9101',
   '2026-07-23', '2026-07-23 18:00+09', '2026-07-27 09:00+09',
   null, null, '返送済 / 検査会社側の日時は未連携 (表示確認用)'),

  -- step 5: 検査会社受領まで到達し、結果待ち。段階 6 のみ「未取得」。
  ('60000103-0000-0000-0000-000000000000', 'ORD-2026-0103',
   'c0000003-0000-0000-0000-000000000000', '1a000001-0000-0000-0000-000000000000',
   'blood', null, 2026, 2, 'タカセ倉庫',
   '2026-07-06 10:00+09', 'YT-1234-5678-9102', 'ヤマト運輸',
   'https://track.example.com/YT-1234-5678-9102',
   '2026-07-08', '2026-07-08 19:00+09', '2026-07-11 09:00+09',
   '2026-07-14 11:00+09', null, '検査会社受領 / 結果待ち (表示確認用)'),

  -- step 2: 発送済 (追跡リンクあり)。田中の次回分。
  ('60000104-0000-0000-0000-000000000000', 'ORD-2026-0104',
   'c0000002-0000-0000-0000-000000000000', '1a000001-0000-0000-0000-000000000000',
   'blood', null, 2026, 2, 'タカセ倉庫',
   '2026-08-17 10:00+09', 'YT-1234-5678-9103', 'ヤマト運輸',
   'https://track.example.com/YT-1234-5678-9103',
   '2026-08-19', null, null, null, null, '発送済 (表示確認用)')
on conflict (id) do nothing;

-- ── 3) 既存の一部に配送業者リンクを補完 (追跡導線の表示確認用) ────
update customer.kit_shipments
   set carrier = coalesce(carrier, 'ヤマト運輸'),
       carrier_tracking_url = coalesce(carrier_tracking_url, 'https://track.example.com/' || tracking_no)
 where tracking_no is not null
   and carrier_tracking_url is null;
