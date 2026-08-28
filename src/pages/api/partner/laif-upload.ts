/**
 * Partner Portal 上り（検査会社 → Wellfort）API。
 *
 * 正本: `docs/lab/laif_s3_secure_handoff_spec.md` §4 / §12。
 * 役割分担どおり **UI は wellfort-site、鍵と処理は Scan-Chat-AI**。
 * したがって本 API は **wellfort-site のサーバからのみ**呼ばれる（Bearer ADMIN_API_KEY）。
 * ブラウザから直接叩かせない（鍵がブラウザに出るため）。
 *
 * mode:
 *   'ticket'   … Presigned PUT を発行（ブラウザが S3 へ直接置く。アプリは中継しない）
 *   'list'     … quarantine/ の受領一覧（提出状況の表示・admin の取り込み待ち確認）
 *   'download' … 受領 1 件の Presigned GET（admin がスキャンへ回すため）
 *
 * ⚠️ 認証(§3 Passkey)・検疫(§6 GuardDuty)は未実装。
 *    そのため既定は無効で、env `LAIF_PORTAL_UPLOAD=on` のときだけ動く。
 */

import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../lib/api-auth';
import {
  createUploadTicket, listUploads, createDownloadUrl,
  isPortalUploadEnabled, normalizePartner,
  MAX_UPLOAD_BYTES, ACCEPTED_CONTENT_TYPE,
} from '../../../lib/laif-portal';

export const prerender = false;

function authorized(request: Request): boolean {
  // 認可の実装は src/lib/api-auth.ts に集約 (キー未設定の本番は拒否＝fail-closed)。
  return isAdminAuthorized(request);
}
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const mode = typeof body.mode === 'string' ? body.mode : 'ticket';
  const partner = normalizePartner(body.partner);

  if (mode === 'ticket') {
    const r = await createUploadTicket({
      partner,
      filename: body.filename,
      contentType: body.contentType,
      bytes: body.bytes,
    });
    if (!r.ok) return json({ ok: false, error: r.error, detail: r.detail }, r.status);
    return json({
      ok: true, mode: 'ticket', partner,
      upload_url: r.ticket.url,
      key: r.ticket.key,
      headers: r.ticket.headers,
      expires_in: r.ticket.expiresIn,
      max_bytes: MAX_UPLOAD_BYTES,
      accepted_content_type: ACCEPTED_CONTENT_TYPE,
    });
  }

  if (mode === 'list') {
    if (!isPortalUploadEnabled()) return json({ ok: true, mode: 'list', partner, uploads: [] });
    try {
      const uploads = await listUploads(partner, 20);
      return json({ ok: true, mode: 'list', partner, count: uploads.length, uploads });
    } catch (err) {
      return json({ ok: false, error: 'list_failed', detail: String(err instanceof Error ? err.message : err) }, 502);
    }
  }

  if (mode === 'download') {
    const key = typeof body.key === 'string' ? body.key : '';
    if (!key) return json({ ok: false, error: 'key is required' }, 400);
    try {
      const url = await createDownloadUrl(key);
      if (!url) return json({ ok: false, error: 'not_allowed', detail: 'quarantine 配下のキーのみ' }, 400);
      return json({ ok: true, mode: 'download', key, url });
    } catch (err) {
      return json({ ok: false, error: 'sign_failed', detail: String(err instanceof Error ? err.message : err) }, 502);
    }
  }

  return json({ ok: false, error: `unknown mode: ${mode}` }, 400);
};
