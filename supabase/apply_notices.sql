-- ============================================================
-- お知らせ機能テーブル 適用スクリプト (冪等) — 診断系 #2 (diagnosis スキーマ)
--
-- 目的: マイグレ未適用により発生する
--   "Could not find the table 'diagnosis.user_notices' in the schema cache"
--   を解消する。既存マイグレ
--     20260620000010_notices.sql
--     20260621000010_announcements_news_sync.sql
--     20260621000020_announcements_visibility_align.sql
--   を 1 ファイルに統合し、create/add ... if not exists で冪等化したもの。
--
-- 適用対象: Web アプリ (#2) が参照する Supabase の diagnosis スキーマ。
-- 前提: diagnosis.app_users が存在すること (FK 参照先)。
-- 注意: デモ用シードは含めない (DDL のみ)。テーブル作成だけでエラーは解消する。
-- ============================================================

-- 1) user_notices — ユーザー個別の重要なお知らせ (既読/未読)
create table if not exists diagnosis.user_notices (
  id                 uuid primary key default gen_random_uuid(),
  diagnostic_user_id uuid not null references diagnosis.app_users(diagnostic_user_id),
  title              text not null,
  body               text not null,
  link_url           text,
  published_at       timestamptz not null default now(),
  read_at            timestamptz,
  created_at         timestamptz not null default now()
);
create index if not exists user_notices_user_pub_idx
  on diagnosis.user_notices(diagnostic_user_id, published_at desc);
create index if not exists user_notices_user_read_idx
  on diagnosis.user_notices(diagnostic_user_id, read_at);

-- 2) announcements — 全ユーザー共通 (一般のお知らせ / ニュース)
create table if not exists diagnosis.announcements (
  id            uuid primary key default gen_random_uuid(),
  category      text not null check (category in ('general','news')),
  title         text not null,
  body          text not null,
  link_url      text,
  published_at  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- 2-1) news 同期 / 掲載面トグル用の後追い列 (冪等)
alter table diagnosis.announcements
  add column if not exists source_news_id  uuid,
  add column if not exists image_url       text,
  add column if not exists link_text       text,
  add column if not exists visible_on_hp   boolean not null default true,
  add column if not exists visible_on_web  boolean not null default false,
  add column if not exists published_until timestamptz,
  add column if not exists updated_at      timestamptz not null default now();

-- 既定値を最終仕様へ明示 (再実行安全): visible_on_hp=true / visible_on_web=false
alter table diagnosis.announcements alter column visible_on_hp  set default true;
alter table diagnosis.announcements alter column visible_on_web set default false;

create index if not exists announcements_cat_pub_idx
  on diagnosis.announcements(category, published_at desc);
create unique index if not exists announcements_source_news_id_key
  on diagnosis.announcements(source_news_id) where source_news_id is not null;
create index if not exists announcements_visible_on_web_published_idx
  on diagnosis.announcements(visible_on_web, published_at desc);

-- 2-2) updated_at 自動更新トリガ
create or replace function diagnosis.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists trg_announcements_updated_at on diagnosis.announcements;
create trigger trg_announcements_updated_at
  before update on diagnosis.announcements
  for each row execute function diagnosis.set_updated_at();

-- 3) RLS / grant / policy (既存マイグレと同じ dev policy。本番は要強化)
alter table diagnosis.user_notices  enable row level security;
alter table diagnosis.announcements enable row level security;

grant select on diagnosis.user_notices  to anon, authenticated;
grant select on diagnosis.announcements to anon, authenticated;
grant all    on diagnosis.user_notices  to service_role;
grant all    on diagnosis.announcements to service_role;

drop policy if exists "dev_read_all"    on diagnosis.user_notices;
drop policy if exists "dev_authn_write" on diagnosis.user_notices;
drop policy if exists "dev_read_all"    on diagnosis.announcements;
drop policy if exists "dev_authn_write" on diagnosis.announcements;

create policy "dev_read_all"    on diagnosis.user_notices  for select using (true);
create policy "dev_authn_write" on diagnosis.user_notices  for all to authenticated using (true) with check (true);
create policy "dev_read_all"    on diagnosis.announcements for select using (true);
create policy "dev_authn_write" on diagnosis.announcements for all to authenticated using (true) with check (true);

-- 4) PostgREST スキーマキャッシュ再読込 (作成直後の "schema cache" エラー対策)
notify pgrst, 'reload schema';

-- 確認:
--   select to_regclass('diagnosis.user_notices'), to_regclass('diagnosis.announcements');
--   → 両方が NULL でなければ適用成功。
