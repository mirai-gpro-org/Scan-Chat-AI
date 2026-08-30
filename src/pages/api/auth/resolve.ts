import type { APIRoute } from 'astro';
import { getServerSupabase } from '../../../lib/supabase';
import { isHpEdgeConfigured, resolveCustomerByEmail } from '../../../lib/hp-edge';
import { VIEWER_COOKIE, signViewer, viewerCookieOptions } from '../../../lib/viewer';

export const prerender = false;

/**
 * Google One Tap サインイン後の本人解決 (サーバー側)。
 *
 * クライアントから Supabase アクセストークンを受け取り、本人を検証したうえで:
 *   1. email → diagnostic_user_id を解決
 *        - 本番: HP の resolve-customer Edge Function (email はブリッジに載せない)
 *        - dev : モック customer.customer_profiles を email で解決
 *   2. #2 diagnosis.app_users に本人連携 (google_sub ↔ diagnostic_user_id) を永続化
 *   3. { linked, diagnosticUserId } を返す
 *
 * 旧 GoogleOneTap.astro の DEMO_EMAIL_TO_UID ハードコードを置き換える。
 */
export const POST: APIRoute = async ({ request, cookies }) => {
  const body = (await request.json().catch(() => null)) as { accessToken?: unknown } | null;
  const accessToken = typeof body?.accessToken === 'string' ? body.accessToken : null;
  if (!accessToken) return json({ error: 'missing accessToken' }, 400);

  const sb = getServerSupabase();
  if (!sb) return json({ error: 'supabase not configured' }, 503);

  // アクセストークンから本人を検証 (email/sub をクライアント申告に頼らない)
  const { data: userData, error: userErr } = await sb.auth.getUser(accessToken);
  if (userErr || !userData?.user) return json({ error: 'invalid session' }, 401);
  const user = userData.user;
  const email = (user.email ?? '').trim().toLowerCase();
  const sub = (user.user_metadata as Record<string, string> | undefined)?.sub ?? null;
  const authId = user.id;
  if (!email) return json({ error: 'no email in Google account' }, 400);

  // 1) email → diagnostic_user_id + 表示名(姓)
  let diagnosticUserId: string | null = null;
  let bareName: string | null = null;

  if (isHpEdgeConfigured()) {
    const resolved = await resolveCustomerByEmail(email).catch((e: unknown) => {
      throw new Error(`resolve-customer: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (resolved) {
      diagnosticUserId = resolved.diagnostic_user_id;
      bareName = resolved.display_name;
    }
  } else {
    // dev フォールバック: モック customer_profiles を email で解決
    const { data: profile, error: profErr } = await sb
      .schema('customer')
      .from('customer_profiles')
      .select('diagnostic_user_id, family_name')
      .ilike('email', email)
      .maybeSingle();
    if (profErr) return json({ error: `profile lookup: ${profErr.message}` }, 500);
    if (profile?.diagnostic_user_id) {
      diagnosticUserId = profile.diagnostic_user_id;
      bareName = profile.family_name;
    }
  }

  // 未連携 (適格性なし)
  if (!diagnosticUserId) return json({ linked: false }, 200);

  // 2) #2 app_users に本人連携を永続化 (display_name_cache は「姓+様」規約)
  const nowIso = new Date().toISOString();
  const row = {
    diagnostic_user_id: diagnosticUserId,
    auth_user_id: authId,
    google_sub: sub,
    eligibility_checked_at: nowIso,
    updated_at: nowIso,
    ...(bareName ? { display_name_cache: `${bareName}様` } : {}),
  };
  const { error: upErr } = await sb
    .schema('diagnosis')
    .from('app_users')
    .upsert(row, { onConflict: 'diagnostic_user_id' });
  if (upErr) return json({ error: `app_users upsert: ${upErr.message}` }, 500);

  /*
   * 本人確認済みの uid を **HttpOnly Cookie** に載せる（2026-08-30）。
   * これ以降、画面側は `?u=` ではなくこの Cookie で本人を判定する
   * （`src/lib/viewer.ts`）。`?u=` は admin の代理表示のときだけ効く。
   * 署名鍵が無い環境では null が返るので Cookie を発行しない（fail-closed）。
   */
  const token = await signViewer(diagnosticUserId);
  if (token) cookies.set(VIEWER_COOKIE, token, viewerCookieOptions());

  return json({ linked: true, diagnosticUserId }, 200);
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
