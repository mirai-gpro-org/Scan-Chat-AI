/**
 * admin: 運用パラメータ (app_config) の取得/更新 API。
 *
 * スキャン精度フラグ・使用モデル等の「運用パラメータ」を DB (diagnosis.app_config) で管理する。
 * 秘匿でない値のみ (キー類は env 据え置き)。wellfort-site admin モーダルから呼ぶ。
 *   GET  → { ok, items:[{key,type,group,label,description,options,value}] }（現在値つきカタログ）
 *   POST → { updates:{key:value,...}, updated_by? } を upsert → { ok, updated:[...] }
 * 認可: wellfort-site から Bearer ADMIN_API_KEY。env 未設定(dev)のみ省略。
 */
import type { APIRoute } from 'astro';
import { listConfig, setConfig } from '../../../lib/app-config';

export const prerender = false;

function envKey(name: string): string | undefined {
  const m = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (m != null && m !== '') return m;
  const p = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return p != null && p !== '' ? p : undefined;
}
function authorized(request: Request): boolean {
  const expected = envKey('ADMIN_API_KEY');
  if (!expected) return true; // dev
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return !!m && m[1] === expected;
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

export const GET: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  try {
    const items = await listConfig();
    return json({ ok: true, items });
  } catch (e) {
    return json({ ok: false, error: 'list_failed', detail: String((e as { message?: string })?.message ?? e) }, 500);
  }
};

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  let body: { updates?: Record<string, unknown>; updated_by?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  const updatesIn = body.updates;
  if (!updatesIn || typeof updatesIn !== 'object' || Array.isArray(updatesIn)) {
    return json({ ok: false, error: 'updates_required' }, 400);
  }
  const updates: Record<string, string> = {};
  for (const [k, v] of Object.entries(updatesIn)) updates[k] = String(v ?? '');
  const updatedBy = typeof body.updated_by === 'string' ? body.updated_by : undefined;
  const r = await setConfig(updates, updatedBy);
  return json(r, r.ok ? 200 : 400);
};
