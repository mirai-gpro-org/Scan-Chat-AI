-- ============================================================
-- お知らせ機能 — 通知系テーブル (Phase 1.0 dev profile)
--
-- ヘッダーの「お知らせ」→ お知らせページ (/notices) で表示する 3 区分:
--   1) ユーザー個別の「重要なお知らせ」 — 既読/未読を管理 (user_notices)
--   2) 「一般のお知らせ」  — 全ユーザー共通の配信 (announcements.category='general')
--   3) 「ニュース」        — 全ユーザー共通の配信 (announcements.category='news')
--
-- いずれも PII を含まないため diagnosis schema に置く。
-- 個別お知らせは diagnostic_user_id で識別し、read_at の有無で未読/既読を判定する。
-- ============================================================

-- 1) user_notices — ユーザー個別の重要なお知らせ (既読/未読あり)
create table diagnosis.user_notices (
  id                 uuid primary key default gen_random_uuid(),
  diagnostic_user_id uuid not null references diagnosis.app_users(diagnostic_user_id),
  title              text not null,
  body               text not null,
  link_url           text,                                  -- 任意: 詳細ページ等へのリンク
  published_at       timestamptz not null default now(),
  read_at            timestamptz,                           -- null = 未読
  created_at         timestamptz not null default now()
);
comment on table diagnosis.user_notices is
  'ユーザー個別の重要なお知らせ。read_at が null なら未読。';
create index on diagnosis.user_notices(diagnostic_user_id, published_at desc);
create index on diagnosis.user_notices(diagnostic_user_id, read_at);

-- 2) announcements — 全ユーザー共通の配信 (一般のお知らせ / ニュース)
create table diagnosis.announcements (
  id            uuid primary key default gen_random_uuid(),
  category      text not null check (category in ('general','news')),
  title         text not null,
  body          text not null,
  link_url      text,
  published_at  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
comment on table diagnosis.announcements is
  '全ユーザー共通のお知らせ。category=general (一般) / news (ニュース)。';
create index on diagnosis.announcements(category, published_at desc);


-- ============================================================
-- RLS (既存 dev policy に揃える)
--   旧マイグレーションの do-block は適用済テーブルのみを対象にするため、
--   後発テーブルには本マイグレーションで個別に policy を付与する。
-- ============================================================
alter table diagnosis.user_notices  enable row level security;
alter table diagnosis.announcements  enable row level security;

grant select on diagnosis.user_notices to anon, authenticated;
grant select on diagnosis.announcements to anon, authenticated;
grant all on diagnosis.user_notices to service_role;
grant all on diagnosis.announcements to service_role;

create policy "dev_read_all"   on diagnosis.user_notices for select using (true);
create policy "dev_authn_write" on diagnosis.user_notices for all to authenticated using (true) with check (true);
create policy "dev_read_all"   on diagnosis.announcements for select using (true);
create policy "dev_authn_write" on diagnosis.announcements for all to authenticated using (true) with check (true);
