-- ============================================================
-- announcements 可視性フラグの整合 — HP/EC お知らせ管理 (notices-admin) 仕様に合わせる
--
-- 引継ぎ文書「お知らせ機能_Web引継ぎ.md」の要件:
--   visible_on_hp  default true
--   visible_on_web default false
-- 先行マイグレ (20260621000010) では逆の既定値だったため、ここで揃える。
--
-- 表示マッピング (引継ぎ文書):
--   general (一般のお知らせ) → Web のみ表示
--   news    (ニュース)        → HP + Web 双方表示
-- 既存行を上記マッピングでバックフィル (冪等)。新規行は admin/同期が明示設定する。
-- ============================================================

alter table diagnosis.announcements alter column visible_on_hp  set default true;
alter table diagnosis.announcements alter column visible_on_web set default false;

-- 既存行のバックフィル
update diagnosis.announcements
  set visible_on_web = true, visible_on_hp = false
  where category = 'general';

update diagnosis.announcements
  set visible_on_web = true, visible_on_hp = true
  where category = 'news';
