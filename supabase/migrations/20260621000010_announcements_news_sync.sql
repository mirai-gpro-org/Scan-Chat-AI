-- ============================================================
-- announcements 拡張 — HP/EC `news` → `announcements` 片方向同期 対応
--
-- HP/EC「web連携_IF仕様とマッピング_draft.md」§3 のマッピングを受け、
-- news 由来の項目を受け入れるための列を追加する。
--   - source_news_id : HP `news.id` との突合キー (冪等 upsert 用)
--   - image_url / link_text : news の表示項目
--   - visible_on_hp / visible_on_web : 掲載面フラグ (本テーブルは #2 所有のため Web 側で追加)
--   - published_until : 公開終了 (任意・期間指定があるニュース用)
--   - updated_at : 監査・差分同期用
--
-- 既定値の考え方 (本テーブルは Web アプリ #2 の所有物):
--   - visible_on_web default true  … Web ネイティブの一般お知らせは既定で Web 表示
--   - visible_on_hp  default false … HP 表示は明示フラグのみ
--   ※ HP `news` からの同期行は、同期処理が両フラグを明示的に設定する。
-- ============================================================

alter table diagnosis.announcements
  add column if not exists source_news_id  uuid,
  add column if not exists image_url       text,
  add column if not exists link_text       text,
  add column if not exists visible_on_hp   boolean not null default false,
  add column if not exists visible_on_web  boolean not null default true,
  add column if not exists published_until timestamptz,
  add column if not exists updated_at      timestamptz not null default now();

comment on column diagnosis.announcements.source_news_id is
  'HP/EC news.id。news→announcements 片方向同期の突合キー (NULL=Web ネイティブ作成)。';
comment on column diagnosis.announcements.visible_on_hp is
  'HP サイトに掲載するか。同期行は同期処理が設定。';
comment on column diagnosis.announcements.visible_on_web is
  'マイページ(Web)に掲載するか。既定 true。';
comment on column diagnosis.announcements.published_until is
  '公開終了日時 (任意)。NULL は無期限。';

-- news 由来行の冪等 upsert 用: source_news_id が非 NULL のときのみ一意
create unique index if not exists announcements_source_news_id_key
  on diagnosis.announcements(source_news_id)
  where source_news_id is not null;

-- Web 表示の絞り込み用
create index if not exists announcements_visible_on_web_published_idx
  on diagnosis.announcements(visible_on_web, published_at desc);

-- updated_at 自動更新トリガ (同期 upsert / 管理画面更新の両方に効かせる)
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
