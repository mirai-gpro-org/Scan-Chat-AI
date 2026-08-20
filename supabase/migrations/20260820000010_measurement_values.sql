-- 検査値の永続化 (案A-3 ハイブリッド・発注者承認 2026-08-20)。
--
-- 背景: 血液検査の時系列グラフを出すには、検査値をアプリ側で保持している必要がある。
--   現状 elith-blood-csv.ts の解析結果は S3 へ書き出すだけで DB に残らず、
--   test_artifact_items (test_data_storage_and_db_design.md §6.4) も未作成のため、
--   グラフのデータ源がどこにも存在しない。
--
-- 採用: 案A-3 = 2層。
--   ① diagnosis.test_artifacts.measurements (jsonb)  … 原本忠実の全記録。欠損を後から悔やまないための層。
--   ② diagnosis.measurement_values (本表)            … 時系列グラフ用の正規化層。
--      jsonb を跨いで時系列を引くのは重く index も効かないため、グラフが読む先を分ける。
--
-- 【書き込み規律】両層に入れる値は src/lib/elith-export.ts の sanitizeMeasurementsForDelivery() を
--   通した後のものとする (CLAUDE.md「納品整形は決定論プログラムに集約」)。整形を二重管理しない。
--
-- 【列の型は lean measurement の実体に合わせる】(elith-export.ts:170-186 / leanMeasurement)
--   value / ref_low / ref_high は string|null、value_num のみ number|null、flag は 'H'|'L'|null。
--   → 原本表記は text で保持し、グラフが使う数値は *_num 列に分けて持つ (value/value_num と同じ流儀)。
--
-- 非PII (diagnosis スキーマ)。氏名・住所・生年月日は含めない。

-- ── ① 原本忠実の全記録 ─────────────────────────────────────────────
-- null = 未取込 / '[]'::jsonb = 取込済みで0件。この区別を残すため default は付けない。
alter table diagnosis.test_artifacts
  add column if not exists measurements jsonb;

comment on column diagnosis.test_artifacts.measurements is
  'sanitizeMeasurementsForDelivery() 適用後の measurement 配列 (原本忠実)。null=未取込 / []=取込済み0件。';

-- ── ② 時系列グラフ用の正規化層 ─────────────────────────────────────
create table if not exists diagnosis.measurement_values (
  id                 uuid primary key default gen_random_uuid(),
  artifact_id        uuid not null references diagnosis.test_artifacts(id) on delete cascade,

  -- test_artifacts からの複製。時系列クエリで join を挟まないため & index を効かせるため。
  diagnostic_user_id uuid not null,
  test_type          text not null
                       check (test_type in ('health_checkup','blood','genetics','cancer_urine','ai_prediction')),
  test_date          date,

  -- measurements 配列内の位置 (0 始まり)。行の同定に使う。
  -- unique を (artifact_id, item_name) にしない理由: 同名別値は observation-dedup が
  -- 「競合記録」として残す仕様 (自動採用しない) のため、名前で一意にすると取込時に
  -- 行が黙って落ちる。CLAUDE.md「サイレント脱落ゼロ」に反するので seq で一意にする。
  seq                int  not null,

  item_name          text not null,                 -- 原本の表記そのまま (lean の name)
  canonical_name     text,                          -- standard-master.ts findByAlias のヒット結果。
                                                    -- 非ヒットは null のまま (当て推量で埋めない = 捏造ゼロ)

  value              text,                          -- クリーン済みの読み取り値 (定性値もここ)
  value_num          numeric,                       -- 数値化できた場合のみ。グラフはこれだけを使う
  unit               text,
  ref_low            text,                          -- 原本表記 ("7.0" / "7.0 以下" 等)
  ref_high           text,
  ref_low_num        numeric,                       -- 基準線描画用に数値化できた場合のみ
  ref_high_num       numeric,
  flag               text check (flag is null or flag in ('H','L')),
  assessment         text,                          -- 検査機関由来の判定コード (血液CSVの F2/A3 等)。
                                                    -- デコードしない生コード (elith-export.ts:181-186)
  source_file_kind   text,                          -- raw_csv | scan_md 等、由来の記録

  created_at         timestamptz not null default now(),

  unique (artifact_id, seq)
);

comment on table diagnosis.measurement_values is
  '検査値の正規化層 (時系列グラフ用)。原本忠実の全記録は test_artifacts.measurements (jsonb) 側。';

-- 時系列クエリ: 「あるユーザーのある項目を日付順に」
create index if not exists ix_mv_user_canon_date
  on diagnosis.measurement_values(diagnostic_user_id, canonical_name, test_date);

-- 原本表記でしか引けない項目 (canonical_name が null) 向け
create index if not exists ix_mv_user_item_date
  on diagnosis.measurement_values(diagnostic_user_id, item_name, test_date);

-- 再取込時の総入れ替え (delete → insert) 用
create index if not exists ix_mv_artifact
  on diagnosis.measurement_values(artifact_id);

alter table diagnosis.measurement_values enable row level security;
grant select on diagnosis.measurement_values to anon, authenticated;
grant all    on diagnosis.measurement_values to service_role;

-- 読み取り全許可 / 認証済み書き込み (サーバは service_role で RLS バイパス)。既存テーブルと同方針。
-- ホスト環境へは手動適用するため、部分失敗後の再実行で詰まらないよう冪等にしておく。
drop policy if exists "dev_read_all"    on diagnosis.measurement_values;
drop policy if exists "dev_authn_write" on diagnosis.measurement_values;
create policy "dev_read_all"    on diagnosis.measurement_values for select using (true);
create policy "dev_authn_write" on diagnosis.measurement_values for all to authenticated using (true) with check (true);
