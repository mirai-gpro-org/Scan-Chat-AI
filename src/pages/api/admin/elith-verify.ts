/**
 * admin: 画像↔JSON 照合器 (検証機能)。
 *
 * 元画像(検診は複数シート可)と、生成済みの Elith JSON を受け取り、
 * ネイティブマルチモーダルで項目単位に採点する。
 *   missing(取りこぼし)/misread(誤読)/extra(捏造)/duplicate(重複) + 一致率
 * を返し、プロンプト/後段プログラム改善の反復(テストRUN→照合→修正)に使う。
 *
 * S3 への書き出しは一切しない(採点のみ)。キー(GEMINI_API_KEY)はサーバ環境変数のみ。
 * 認可: wellfort-site から Bearer ADMIN_API_KEY。env 未設定(dev)のみ省略。
 */

import type { APIRoute } from 'astro';
import { verifyScanAgainstImages } from '../../../lib/elith-verify';
import { refreshConfig } from '../../../lib/app-config';
import { isAdminAuthorized } from '../../../lib/api-auth';

export const prerender = false;

function authorized(request: Request): boolean {
  // 認可の実装は src/lib/api-auth.ts に集約 (キー未設定の本番は拒否＝fail-closed)。
  return isAdminAuthorized(request);
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
/** data:URL でも生 base64 でも受ける。mime が取れなければ既定を使う。 */
function parseImage(input: string, fallbackMime: string): { mime: string; data: string } {
  const m = /^data:([^;]+);base64,(.+)$/i.exec(input.trim());
  if (m) return { mime: m[1], data: m[2] };
  return { mime: fallbackMime, data: input.trim() };
}

interface Body {
  /** 複数画像(検診の複数シート)。data:URL か生 base64 の配列。 */
  images?: unknown;
  /** 単一画像 (images 未指定時)。 */
  image?: unknown;
  mimeType?: unknown;
  /** 検証対象の生成JSON (エンベロープ全体。data.measurements を採点)。 */
  json?: unknown;
  formatId?: unknown;
  hint?: unknown;
}

export const POST: APIRoute = async ({ request }) => {
  await refreshConfig(); // 運用パラメータ(app_config)を最新化してから処理
  if (!authorized(request)) {
    return json({ ok: false, error: 'unauthorized', detail: 'Invalid API key' }, 401);
  }
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const fallbackMime = str(body.mimeType) || 'image/jpeg';
  const rawImages: string[] = Array.isArray(body.images)
    ? (body.images as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : typeof body.image === 'string' && body.image.trim()
      ? [body.image]
      : [];
  if (rawImages.length === 0) {
    return json({ ok: false, error: 'images (or image) is required (data URL or base64)' }, 400);
  }
  if (body.json == null || typeof body.json !== 'object') {
    return json({ ok: false, error: 'json (generated Elith JSON object) is required' }, 400);
  }

  const images = rawImages.map((s) => parseImage(s, fallbackMime));

  try {
    const report = await verifyScanAgainstImages({
      images,
      json: body.json,
      formatId: str(body.formatId),
      hint: str(body.hint),
    });
    return json({ ok: true, image_count: images.length, verify: report });
  } catch (err) {
    return json({ ok: false, error: 'verify failed', detail: String(err instanceof Error ? err.message : err) }, 502);
  }
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
