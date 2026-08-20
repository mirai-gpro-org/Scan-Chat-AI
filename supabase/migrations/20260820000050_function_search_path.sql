-- =====================================================================
-- 20260820000050_function_search_path.sql
--
-- Supabase database linter `0011_function_search_path_mutable` (WARN) の解消。
--   customer.touch_updated_at / diagnosis.touch_updated_at / diagnosis.set_updated_at
-- の 3 つが search_path 未固定で、呼び出しロールの search_path に依存する。
--
-- 中身はいずれも `new.updated_at = now(); return new;` だけで、スキーマ修飾が要る
-- 名前解決を一切していない (now() は pg_catalog にあり search_path='' でも常に解決する)。
-- したがって **search_path を空に固定しても挙動は変わらない**。
--   元の定義: 20260601000010_schemas_and_tables.sql:252,264 / 20260621000010_announcements_news_sync.sql:46
--
-- alter function ... set search_path は本体を書き換えないので、既存のトリガは
-- 張り直し不要 (トリガは関数 OID を参照している)。
-- =====================================================================

alter function customer.touch_updated_at()  set search_path = '';
alter function diagnosis.touch_updated_at() set search_path = '';
alter function diagnosis.set_updated_at()   set search_path = '';
