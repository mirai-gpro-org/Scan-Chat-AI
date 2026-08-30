/**
 * サインアウト。本人 Cookie を消すだけ（Supabase 側のセッション破棄はクライアントが行う）。
 *
 * テスト時にアカウントを切り替えるために要る。
 * `viewer.ts` の Cookie は HttpOnly なので、JS からは消せずサーバ経由が必須。
 */
import type { APIRoute } from 'astro';
import { VIEWER_COOKIE } from '../../../lib/viewer';

export const prerender = false;

export const POST: APIRoute = async ({ cookies, redirect, request }) => {
  cookies.delete(VIEWER_COOKIE, { path: '/' });
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  if (wantsJson) {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  return redirect('/dashboard', 303);
};

/** ブラウザのアドレスバーから叩けるように GET も受ける（テスト用）。 */
export const GET: APIRoute = async ({ cookies, redirect }) => {
  cookies.delete(VIEWER_COOKIE, { path: '/' });
  return redirect('/dashboard', 303);
};
