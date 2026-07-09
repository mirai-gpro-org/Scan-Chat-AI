-- 健康年齢 (生物学的年齢 / CABA v4d) の時系列スコア。
-- 人間ドック (1回/年) と血液検査 (経営幹部プラン 3回/年) のハンドオフ毎に 1 行記録し、
-- ダッシュボードで実年齢との差・推移を表示する。非PII (diagnosis スキーマ)。
--
-- diagnostic_user_id は diagnosis.app_users を指すが、デモ (任意の顧客に紐付け) でも
-- 壊れないよう敢えて FK を張らず、index 付き uuid として保持する
-- (ダッシュボードは diagnostic_user_id で読むため FK 無しでも整合)。

create table if not exists diagnosis.health_age_scores (
  id                 uuid primary key default gen_random_uuid(),
  diagnostic_user_id uuid not null,
  source_kind        text not null default 'health_checkup'
                       check (source_kind in ('health_checkup', 'blood')),
  test_date          date not null,                 -- 元データの取得日 (時系列の横軸)
  chronological_age  numeric(5,1) not null,          -- 実年齢
  biological_age     numeric(5,1),                   -- 生物学的年齢 (欠損時 null)
  delta              numeric(5,1),                   -- biological - chronological
  mortality_risk     numeric(6,5),                   -- Gompertz 10年死亡リスク
  model_version      text not null default 'CABA-v4d',
  inputs             jsonb not null default '{}'::jsonb, -- 使用/据え置き/欠損マーカーと値
  source_ref         text,                           -- 元データの S3 key など
  computed_at        timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  unique (diagnostic_user_id, test_date, source_kind)
);

create index if not exists ix_has_user_date
  on diagnosis.health_age_scores(diagnostic_user_id, test_date desc);

alter table diagnosis.health_age_scores enable row level security;
grant select on diagnosis.health_age_scores to anon, authenticated;
grant all    on diagnosis.health_age_scores to service_role;

-- dev ポリシー (既存テーブルと同方針: 読み取り全許可 / 認証済み書き込み)。
-- サーバ側書き込みは service_role (RLS バイパス) で行う。
create policy "dev_read_all"    on diagnosis.health_age_scores for select using (true);
create policy "dev_authn_write" on diagnosis.health_age_scores for all to authenticated using (true) with check (true);
