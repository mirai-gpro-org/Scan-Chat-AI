/**
 * 閲覧者の解決（**本番相当の入場制御**）。
 *
 * 【なぜ作ったか】従来は `?u=<diagnostic_user_id>` が**そのまま本人確認**になっていた
 * （`dashboard.astro` の `needsSignIn = authEnabled && !u`）。URL を知っていれば
 * サインインせずに他人の画面が開く。`CLAUDE.md` の
 * 「本番相当への切替（`?u=` 入場の廃止・`PUBLIC_DEMO_FALLBACK=false`・デバッグ表示の遮蔽）は
 * 総合テストの段階で行う」を、9/1 ローンチ前に実施したもの（2026-08-30）。
 *
 * 【方式】サインイン成功時にサーバが **HttpOnly Cookie** を発行し、以後はそれを本人とする。
 *   - Cookie は `uid.exp.HMAC-SHA256(uid.exp)`。**署名鍵はサーバ env のみ**。
 *   - `HttpOnly` なので JS から読めない。`SameSite=Lax` / `Secure`（本番）。
 *   - 発行は `POST /api/auth/resolve`（Supabase のアクセストークンを検証した後）。
 *
 * 【`?u=` の扱い】**Cookie の本人が admin のときだけ**尊重する（サポート/デモ用の代理表示）。
 *   非 admin の `?u=` は**黙って無視**して本人の uid を使う。
 *
 * 【緊急時の逃げ道】env `ALLOW_UID_ENTRY=on` で従来の `?u=` 入場に戻せる（既定 off）。
 *   ローンチ直前の切替で締め出された場合の復旧用。**本番では off のままにすること。**
 */

import type { APIContext, AstroGlobal } from 'astro';
import { isAdminUid } from './admin-auth';

/** Cookie 名。値は署名付きなので中身を書き換えても通らない。 */
export const VIEWER_COOKIE = 'welltect_v';

/** 有効期間（秒）。30 日。 */
const MAX_AGE_SEC = 30 * 24 * 60 * 60;

function env(name: string): string | undefined {
  const m = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (m != null && m !== '') return m;
  const p = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return p != null && p !== '' ? p : undefined;
}

/** 従来の `?u=` 入場を許すか（既定 off＝本番相当）。 */
export function uidEntryAllowed(): boolean {
  return (env('ALLOW_UID_ENTRY') ?? '').toLowerCase() === 'on';
}

/**
 * 署名鍵。
 *
 * `APP_SESSION_SECRET` があればそれを使う（ローテーション可能）。
 * 無ければ `SUPABASE_SERVICE_ROLE_KEY` から導出する — **サーバにしか無い秘密**であり、
 * これが無い環境では admin API も DB 書込も動かないため、追加の env 設定漏れで
 * 認証だけ静かに壊れる事故を避けられる。どちらも無ければ **null＝Cookie 発行も検証もしない**
 * （fail-closed。サインインできないことは気づけるが、誰でも入れる状態にはならない）。
 */
function secret(): string | null {
  return env('APP_SESSION_SECRET') ?? env('SUPABASE_SERVICE_ROLE_KEY') ?? null;
}

function b64url(bytes: ArrayBuffer): string {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(payload: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(payload)));
}

/** タイミング差で署名を推測されないように定数時間で比較する。 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cookie に載せる署名付きトークンを作る。鍵が無ければ null。 */
export async function signViewer(uid: string, now = Date.now()): Promise<string | null> {
  const key = secret();
  if (!key || !UUID_RE.test(uid)) return null;
  const exp = Math.floor(now / 1000) + MAX_AGE_SEC;
  const payload = `${uid.toLowerCase()}.${exp}`;
  return `${payload}.${await hmac(payload, key)}`;
}

/** 署名付きトークンを検証して uid を返す。不正・期限切れは null。 */
export async function verifyViewer(token: string | undefined | null, now = Date.now()): Promise<string | null> {
  const key = secret();
  if (!key || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [uid, expRaw, sig] = parts;
  if (!UUID_RE.test(uid)) return null;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp * 1000 < now) return null;
  const expected = await hmac(`${uid.toLowerCase()}.${expRaw}`, key);
  return timingSafeEqual(sig, expected) ? uid.toLowerCase() : null;
}

/** `Set-Cookie` に載せる属性。 */
export function viewerCookieOptions(): {
  httpOnly: true; secure: boolean; sameSite: 'lax'; path: string; maxAge: number;
} {
  return {
    httpOnly: true,
    // dev サーバは http なので Secure を付けると Cookie が保存されない。
    secure: import.meta.env.DEV !== true,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SEC,
  };
}

export interface Viewer {
  /** 表示対象の diagnostic_user_id。未サインインなら null。 */
  uid: string | null;
  /** サインイン済み本人の uid（代理表示中でも本人のまま）。 */
  selfUid: string | null;
  /** 本人が admin か。デモ表示・デバッグ表示・admin 画面の可否に使う。 */
  isAdmin: boolean;
  /** admin が `?u=` で他人を表示している状態か。 */
  impersonating: boolean;
}

const ANONYMOUS: Viewer = { uid: null, selfUid: null, isAdmin: false, impersonating: false };

/**
 * リクエストから閲覧者を解決する。**すべてのユーザー向けページはこれを通すこと。**
 *
 * 優先順位:
 *   1. Cookie（署名検証済み）= 本人
 *   2. 本人が admin なら `?u=` を尊重（代理表示）
 *   3. `ALLOW_UID_ENTRY=on` のときだけ、従来どおり `?u=` を本人として扱う（緊急用）
 */
export async function resolveViewer(ctx: AstroGlobal | APIContext): Promise<Viewer> {
  const url = new URL(ctx.request.url);
  const requested = normalizeUid(url.searchParams.get('u'));

  const selfUid = await verifyViewer(ctx.cookies.get(VIEWER_COOKIE)?.value);

  if (!selfUid) {
    if (uidEntryAllowed() && requested) {
      return { uid: requested, selfUid: requested, isAdmin: isAdminUid(requested), impersonating: false };
    }
    return ANONYMOUS;
  }

  const isAdmin = isAdminUid(selfUid);
  if (isAdmin && requested && requested !== selfUid) {
    return { uid: requested, selfUid, isAdmin, impersonating: true };
  }
  return { uid: selfUid, selfUid, isAdmin, impersonating: false };
}

/** `?u=` の短縮形（先頭8桁）も従来どおり受ける。 */
export function normalizeUid(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim().toLowerCase();
  if (!t) return null;
  if (UUID_RE.test(t)) return t;
  const m = /^([0-9a-f]{8})$/.exec(t);
  return m ? `${m[1]}-0000-0000-0000-000000000000` : null;
}
