/**
 * admin: デメカル自動DLの状態 (last_to) を S3 で管理する。
 *
 * RPA(専用PC) が「前回取得済みの最終日 last_to」を読み、次回範囲 from=last_to+1 を決める。
 * 取り込み成功後に last_to を前進させる (docs/lab/demecal_auto_download_overview_spec.md §4)。
 *   - GET  : { ok, last_to, updated_at, note }
 *   - POST : { last_to: "YYYY-MM-DD" } を保存 (単調前進のみ。過去日付は無視して現状維持)
 * 状態は S3 の `{prefix}state/demecal_last_to.json` に置く (鍵はサーバ側のみ)。
 * 認可: Bearer ADMIN_API_KEY (env 未設定 dev のみ省略)。
 */

import type { APIRoute } from 'astro';
import { getS3Config, isS3Configured, getObjectText, putFiles } from '../../../lib/s3';
import { isLabIntakeEndpointAuthorized } from '../../../lib/api-auth';

export const prerender = false;

function authorized(request: Request): boolean {
  // 認可の実装は src/lib/api-auth.ts に集約 (キー未設定の本番は拒否＝fail-closed)。
  // **取り込み 3 口のひとつ**。admin キー (wellfort-site の画面用) に加えて、
  // 専用PC が持つ**取り込み専用キー** `x-intake-key` も通す。
  // ADMIN_API_KEY を PC に置かないための分離 (`demecal_unattended_spec §3.1`)。用途=状態(last_to)
  return isLabIntakeEndpointAuthorized(request);
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function utf8Bytes(s: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : Buffer.byteLength(s, 'utf-8');
}
function stateKey(prefix: string): string {
  const clean = prefix ? prefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
  return `${clean}state/demecal_last_to.json`;
}

async function readState(prefix: string): Promise<{ last_to: string | null; updated_at: string | null }> {
  try {
    const txt = await getObjectText(stateKey(prefix));
    const obj = JSON.parse(txt) as { last_to?: unknown; updated_at?: unknown };
    return {
      last_to: typeof obj.last_to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(obj.last_to) ? obj.last_to : null,
      updated_at: typeof obj.updated_at === 'string' ? obj.updated_at : null,
    };
  } catch {
    return { last_to: null, updated_at: null }; // 未作成 (初回)
  }
}

export const GET: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!isS3Configured()) return json({ ok: false, error: 's3_not_configured' }, 400);
  const cfg = getS3Config();
  const st = await readState(cfg?.prefix ?? '');
  return json({ ok: true, last_to: st.last_to, updated_at: st.updated_at, note: '前回取得済みの最終日。次回 from = last_to + 1日。' });
};

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!isS3Configured()) return json({ ok: false, error: 's3_not_configured' }, 400);
  let body: { last_to?: unknown; force?: unknown };
  try {
    body = (await request.json()) as { last_to?: unknown; force?: unknown };
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }
  const next = str(body.last_to);
  if (!next || !/^\d{4}-\d{2}-\d{2}$/.test(next)) {
    return json({ ok: false, error: 'last_to (YYYY-MM-DD) is required' }, 400);
  }
  const cfg = getS3Config();
  const prefix = cfg?.prefix ?? '';
  const cur = await readState(prefix);
  // 単調前進のみ (欠損/巻き戻しを防ぐ)。過去へ戻すには force=true。
  if (cur.last_to && next < cur.last_to && body.force !== true) {
    return json({ ok: true, updated: false, last_to: cur.last_to, note: `既存 ${cur.last_to} より過去のため据置 (force=true で上書き可)` });
  }
  const payload = JSON.stringify({ last_to: next, updated_at: new Date().toISOString(), previous: cur.last_to }, null, 2);
  try {
    await putFiles([{ key: stateKey(prefix), contentType: 'application/json; charset=utf-8', body: payload, bytes: utf8Bytes(payload) }]);
    return json({ ok: true, updated: true, last_to: next, previous: cur.last_to });
  } catch (err) {
    return json({ ok: false, error: 'state write failed', detail: String(err instanceof Error ? err.message : err) }, 502);
  }
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
