import type { APIRoute } from 'astro';
import { MODELS } from '../../lib/gemini';

export const prerender = false;

/**
 * Gemini API への最小コール (1 トークン応答) を 1 回叩いて、
 * Tier 判定に必要なレスポンス情報を返す診断 endpoint。
 *
 * 使い方:  https://<deploy>.vercel.app/api/diag
 *
 * 何が分かるか:
 * - status: 200 なら現 Tier で gemini-2.5-pro が叩ける
 * - 429 でかつ body.error.details に GenerateRequestsPerDay...-FreeTier
 *   が並んでいれば billing 未反映バグ確定 → key 再発行
 * - rateLimit ヘッダがあれば現 Tier の実上限が読める
 *
 * 注意: 成功時は GenerateContent quota を 1 消費する。
 */
export const GET: APIRoute = async () => {
  const apiKey = import.meta.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({ error: 'GEMINI_API_KEY is not configured' }, 500);
  }
  const model = MODELS.scan;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: 'hi' }] }],
      generationConfig: { maxOutputTokens: 1, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });

  // x-ratelimit-* / x-goog-* 系のヘッダを全部拾う
  const interesting: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (
      k.toLowerCase().startsWith('x-ratelimit') ||
      k.toLowerCase().startsWith('x-goog') ||
      k.toLowerCase() === 'retry-after'
    ) {
      interesting[k] = v;
    }
  });

  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep as text */ }

  // Tier 判定ヒント
  const bodyObj = body as { error?: { details?: Array<{ violations?: Array<{ quotaId?: string }> }> } };
  const quotaIds = bodyObj?.error?.details
    ?.flatMap((d) => d.violations ?? [])
    .map((v) => v.quotaId)
    .filter(Boolean) ?? [];
  const tier = quotaIds.some((id) => id?.includes('FreeTier'))
    ? 'FreeTier'
    : quotaIds.some((id) => id?.includes('PaidTier3'))
      ? 'PaidTier3'
      : quotaIds.some((id) => id?.includes('PaidTier2'))
        ? 'PaidTier2'
        : quotaIds.some((id) => id?.includes('PaidTier1'))
          ? 'PaidTier1'
          : res.ok
            ? '(success - tier inference via rate-limit headers only)'
            : 'unknown';

  return json({
    status: res.status,
    model,
    detectedTier: tier,
    quotaIds,
    rateLimitHeaders: interesting,
    body,
  });
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
