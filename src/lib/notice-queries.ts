/**
 * お知らせ機能のデータ取得ヘルパ。
 *
 * 3 区分:
 *   1) 重要なお知らせ (user_notices) — ユーザー個別 / 既読・未読あり
 *   2) 一般のお知らせ (announcements.category='general') — 全ユーザー共通
 *   3) ニュース        (announcements.category='news')    — 全ユーザー共通
 *
 * dev profile では認証未連携のため `?u=<diagnostic_user_id>` でユーザーを識別する。
 */

import { getServerSupabase } from './supabase';
import type { UserNotice, Announcement } from '../types/supabase';
import { buildDemoNotices, demoFallbackEnabled, demoUnreadImportant } from './demo-data';

/** 一般のお知らせ / ニュースで初期表示する件数。 */
export const ANNOUNCEMENT_PREVIEW_LIMIT = 3;

export interface NoticesData {
  diagnosticUserId: string;
  /** app_users.display_name_cache 由来の表示名 (なければ「お客様」)。 */
  userName: string;
  /** 重要なお知らせ。expandImportant=false なら未読のみ。 */
  important: UserNotice[];
  /** 重要なお知らせの未読件数 (バッジ / 件数表示用)。 */
  importantUnreadCount: number;
  general: Announcement[];
  news: Announcement[];
}

export interface LoadNoticesOptions {
  /** true で重要なお知らせを既読含め全件、false で未読のみ。 */
  expandImportant?: boolean;
  /** true で一般のお知らせを全件、false で最新 ANNOUNCEMENT_PREVIEW_LIMIT 件。 */
  expandGeneral?: boolean;
  /** true でニュースを全件、false で最新 ANNOUNCEMENT_PREVIEW_LIMIT 件。 */
  expandNews?: boolean;
}

/** notices.astro から呼ぶ。 */
export async function loadNotices(
  diagnosticUserId: string,
  opts: LoadNoticesOptions = {},
): Promise<NoticesData | { error: string }> {
  const sb = getServerSupabase();
  if (!sb) return { error: 'Supabase が未設定です。.env.local を確認してください。' };

  const dsb = sb.schema('diagnosis');

  // 重要なお知らせ: 未読のみ or 既読含め全件
  let importantQuery = dsb
    .from('user_notices')
    .select('*')
    .eq('diagnostic_user_id', diagnosticUserId)
    .order('published_at', { ascending: false });
  if (!opts.expandImportant) {
    importantQuery = importantQuery.is('read_at', null);
  }

  // 一般のお知らせ / ニュース: プレビュー (3件) or 全件。
  // visible_on_web=true のみ表示 (HP 管理画面の掲載面トグルを尊重)。
  let generalQuery = dsb
    .from('announcements')
    .select('*')
    .eq('category', 'general')
    .eq('visible_on_web', true)
    .order('published_at', { ascending: false });
  if (!opts.expandGeneral) generalQuery = generalQuery.limit(ANNOUNCEMENT_PREVIEW_LIMIT);

  let newsQuery = dsb
    .from('announcements')
    .select('*')
    .eq('category', 'news')
    .eq('visible_on_web', true)
    .order('published_at', { ascending: false });
  if (!opts.expandNews) newsQuery = newsQuery.limit(ANNOUNCEMENT_PREVIEW_LIMIT);

  const [
    { data: appUser, error: userErr },
    { data: importantRaw, error: importantErr },
    { count: unreadCount, error: unreadErr },
    { data: generalRaw, error: generalErr },
    { data: newsRaw, error: newsErr },
  ] = await Promise.all([
    dsb.from('app_users').select('display_name_cache').eq('diagnostic_user_id', diagnosticUserId).maybeSingle(),
    importantQuery,
    dsb
      .from('user_notices')
      .select('id', { count: 'exact', head: true })
      .eq('diagnostic_user_id', diagnosticUserId)
      .is('read_at', null),
    generalQuery,
    newsQuery,
  ]);

  const userName = appUser?.display_name_cache ?? 'お客様';

  // テストフェーズ: お知らせテーブル未適用 (エラー) もしくは未投入 (空) の場合は
  // 共通のダミーお知らせを表示する。実データが入れば自動で実データに切替。
  const anyErr = importantErr || unreadErr || generalErr || newsErr;
  const allEmpty =
    (importantRaw?.length ?? 0) === 0 &&
    (generalRaw?.length ?? 0) === 0 &&
    (newsRaw?.length ?? 0) === 0;
  if (demoFallbackEnabled() && (anyErr || allEmpty)) {
    return buildDemoNotices(diagnosticUserId, userName);
  }

  if (userErr)      return { error: `app_users: ${userErr.message}` };
  if (importantErr) return { error: `user_notices: ${importantErr.message}` };
  if (unreadErr)    return { error: `user_notices(count): ${unreadErr.message}` };
  if (generalErr)   return { error: `announcements(general): ${generalErr.message}` };
  if (newsErr)      return { error: `announcements(news): ${newsErr.message}` };

  return {
    diagnosticUserId,
    userName,
    important: importantRaw ?? [],
    importantUnreadCount: unreadCount ?? 0,
    general: generalRaw ?? [],
    news: newsRaw ?? [],
  };
}

/**
 * ヘッダーのバッジ用 — 未読の重要なお知らせ件数。
 * Supabase 未設定や該当なしは 0 を返す (画面側でバッジ非表示)。
 */
export async function countUnreadImportant(diagnosticUserId: string): Promise<number> {
  const sb = getServerSupabase();
  if (!sb) return 0;
  const { count, error } = await sb
    .schema('diagnosis')
    .from('user_notices')
    .select('id', { count: 'exact', head: true })
    .eq('diagnostic_user_id', diagnosticUserId)
    .is('read_at', null);
  if (error) return demoFallbackEnabled() ? demoUnreadImportant() : 0;
  if ((count ?? 0) === 0 && demoFallbackEnabled()) return demoUnreadImportant();
  return count ?? 0;
}
