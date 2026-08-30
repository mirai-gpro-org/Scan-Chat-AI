/**
 * **admin 判定が成立しない原因を、推測せずに切り分けるための口。**
 *
 * 【なぜ戻したか】2026-08-30 に「原因が判明したので用済み」として撤去したが、
 * その直後に admin 判定の作り直し (ベタ書き名簿の撤去 → 管理者リスト参照) で
 * **本番の admin が復帰せず、観測手段が無いまま何往復も推測を重ねた**。
 * 判定は**静かに外れる**ので、口が無いと画面からは何も分からない。撤去が早計だった。
 *
 * 【認可】`?k=<PROBE_UPLOAD_TOKEN>`。**匿名では答えない** — 以前は認証なしで
 * env の設定有無と DB 行数が読めていた (2026-08-30 に指摘)。
 * 使い捨ての運用トークンなので、済んだら env ごと閉じられる。
 *
 * 【出すもの】値そのものは出さない。**在るか無いか / 判定の結果と根拠**だけ。
 *   - Cookie: 在るか / 検証を通るか / 何分割か / admin フラグ
 *   - viewer: uid / isAdmin / adminBy / cookieStale
 *   - env: 判定に要る設定が入っているか (値は出さない)
 *   - `?email=` を付けると **HP Edge の resolve-customer を実際に叩いて**
 *     `is_admin` が返るかを確認する (管理者リストまで届いているかの決定打)。
 */

import type { APIRoute } from 'astro';
import { VIEWER_COOKIE, resolveViewer, uidEntryAllowed, verifyViewer } from '../../../lib/viewer';
import { isHpEdgeConfigured, resolveCustomerWithAdmin } from '../../../lib/hp-edge';

export const prerender = false;

function env(name: string): string | undefined {
  const m = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (m != null && m !== '') return m;
  const p = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return p != null && p !== '' ? p : undefined;
}

const has = (n: string) => (env(n) ? '設定あり' : '(未設定)');

export const GET: APIRoute = async (ctx) => {
  const expected = env('PROBE_UPLOAD_TOKEN');
  if (!expected) {
    return json({ ok: false, error: 'disabled', detail: 'PROBE_UPLOAD_TOKEN 未設定 (既定 off)' }, 503);
  }
  if ((ctx.url.searchParams.get('k') ?? '').trim() !== expected) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const raw = ctx.cookies.get(VIEWER_COOKIE)?.value ?? null;
  const verified = await verifyViewer(raw);
  const viewer = await resolveViewer(ctx);

  /*
   * `?email=` があれば **HP Edge を実際に叩く**。
   * ここが「管理者リストまで届いているか」の決定打で、
   * Cookie の状態とは独立に確かめられる。
   */
  let edge: Record<string, unknown> | null = null;
  const email = (ctx.url.searchParams.get('email') ?? '').trim().toLowerCase();
  if (email) {
    if (!isHpEdgeConfigured()) {
      edge = { called: false, reason: 'HP_EDGE_BASE_URL 未設定' };
    } else {
      try {
        const r = await resolveCustomerWithAdmin(email);
        edge = {
          called: true,
          // 顧客が引けたか。**admin 判定とは独立** (管理者 ≠ EC の顧客)。
          customer_resolved: !!r.customer,
          customer_note: r.customer ? null : 'Wellfort 側 customer_profiles に該当なし / 退会',
          // 管理者リスト (admin_users) の答え。氏名や uid は出さない。
          is_admin: r.isAdmin,
        };
      } catch (e) {
        edge = { called: true, error: e instanceof Error ? e.message : String(e) };
      }
    }
  }

  return json({
    ok: true,
    build: (env('VERCEL_GIT_COMMIT_SHA') ?? 'local').slice(0, 7),
    cookie: {
      present: !!raw,
      valid: !!verified,
      parts: raw ? raw.split('.').length : 0,
      format: verified ? (verified.legacy ? '旧 3 分割 (admin フラグ無し)' : '4 分割') : null,
      admin_flag: verified ? verified.admin : null,
    },
    viewer: {
      uid: viewer.uid,
      self_uid: viewer.selfUid,
      is_admin: viewer.isAdmin,
      admin_by: viewer.adminBy,
      impersonating: viewer.impersonating,
      /** true なら GoogleOneTap が refresh-admin を呼ぶ (タブ + ビルド版ごとに 1 回)。 */
      cookie_stale: viewer.cookieStale,
    },
    env: {
      // admin 判定に要るもの。**値は出さない。**
      HP_EDGE_BASE_URL: has('HP_EDGE_BASE_URL'),
      RESOLVE_SHARED_SECRET: has('RESOLVE_SHARED_SECRET'),
      PUBLIC_GOOGLE_CLIENT_ID: has('PUBLIC_GOOGLE_CLIENT_ID'),
      APP_SESSION_SECRET: has('APP_SESSION_SECRET'),
      SUPABASE_SERVICE_ROLE_KEY: has('SUPABASE_SERVICE_ROLE_KEY'),
      PUBLIC_DEMO_FALLBACK: env('PUBLIC_DEMO_FALLBACK') ?? '(未設定)',
      ALLOW_UID_ENTRY: uidEntryAllowed() ? 'on' : '(off/未設定)',
    },
    edge,
    hint: '?email=<サインインに使っている Google アカウント> を足すと、'
      + '管理者リストまで届いているかを直接確認できる。',
  });
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
