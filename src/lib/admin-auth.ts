/**
 * Scan-Chat-AI 内 admin ページの認証ガード。
 *
 * 隔離ポリシー:
 *   - admin_users (6 名) の email のみ通過
 *   - それ以外は 404 で「存在しないように見せる」(403 だと admin の存在が露呈する)
 *   - 認証情報は Google One Tap 経由で Supabase Auth セッションに保存済の email を使う
 *
 * ⚠️ サーバ側でしか呼ばないこと (browser に admin email リストを露出させない)
 */

/** 管理者として許可されたメールアドレス (小文字統一) */
const ADMIN_EMAILS: ReadonlySet<string> = new Set([
  'unfix.hamada@gmail.com',
  'miyazawa@wellfort.co.jp',
  'shindo@wellfort.co.jp',
  'ohkawa@wellfort.co.jp',
  'okabe@wellfort.co.jp',
  'honda@wellfort.co.jp',
  // 開発用バックアップ
  'hamada@eentry.co.jp',
]);

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.has(email.trim().toLowerCase());
}

/**
 * 未認証 / 非 admin の場合に投げる 404 Response。
 * Astro page の frontmatter で:
 *   if (!isAdminEmail(email)) return notFoundForNonAdmin();
 */
export function notFoundForNonAdmin(): Response {
  return new Response('Not found', { status: 404 });
}

/**
 * Supabase Auth session cookie の存在を簡易チェック (SSR で使用)。
 * デモ実装: ?u= が admin の diagnostic_user_id と一致するかで判定。
 * 本実装は @supabase/ssr で cookie 解決 (Phase 2.0)。
 */
const ADMIN_UIDS: ReadonlySet<string> = new Set([
  '14410d5a-d515-4fe9-9a8e-bbb1040021ac', // 濱田 (unfix.hamada@gmail.com)
  '1c1ded05-6cce-4880-a5d8-3f964a43ba54', // 宮澤
  '46b3651a-f14b-46bd-a24f-fe01256a1709', // 新藤
  '7cbe6588-5a99-4068-9c40-5fa2427c7122', // 大川
  'f9d47b45-45ad-4ffc-bad3-1bf4de130a1c', // 岡部
  'c0000020-0000-0000-0000-000000000000', // 本田
  'd0000001-0000-0000-0000-000000000000', // 開発用 (物部/真鍋)
]);

export function isAdminUid(uid: string | null | undefined): boolean {
  if (!uid) return false;
  return ADMIN_UIDS.has(uid.trim().toLowerCase());
}

/** ?u= から admin かどうかを判定 (Astro page で使用) */
export function gateByUid(uid: string | null | undefined): { allowed: boolean; uid: string | null } {
  if (!uid) return { allowed: false, uid: null };
  // 短縮形 (8 文字) を許可
  const normalized = uid.length === 36
    ? uid
    : (/^[0-9a-f]{8}$/i.test(uid) ? `${uid.toLowerCase()}-0000-0000-0000-000000000000` : null);
  if (!normalized) return { allowed: false, uid: null };
  return { allowed: isAdminUid(normalized), uid: normalized };
}
