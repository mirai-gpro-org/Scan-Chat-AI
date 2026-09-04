/**
 * POST /api/scan/upload-ticket
 *
 * 大きいファイルを **ブラウザから S3 へ直接** 置くための presigned PUT を 1 回分発行する。
 * ここを通るのは数百バイトの JSON だけなので、Vercel の 4.5 MB 制限にかからない。
 * 設計と安全性の根拠は `src/lib/scan-upload-ticket.ts` の冒頭を参照。
 *
 * 入力  { contentType: string, bytes: number }
 * 出力  { ok: true, upload_url, key, headers, expires_in, max_bytes }
 *       S3 未設定なら 503 `s3_not_configured` (クライアントは圧縮経路へ落ちる)。
 */
import type { APIRoute } from 'astro';
import { createScanUploadTicket, MAX_SCAN_UPLOAD_BYTES } from '../../../lib/scan-upload-ticket';

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const r = await createScanUploadTicket({ contentType: body.contentType, bytes: body.bytes });
  if (!r.ok) return json({ ok: false, error: r.error, detail: r.detail }, r.status);

  return json({
    ok: true,
    upload_url: r.url,
    key: r.key,
    headers: r.headers,
    expires_in: r.expiresIn,
    max_bytes: MAX_SCAN_UPLOAD_BYTES,
  });
};
