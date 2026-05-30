import type { APIRoute } from 'astro';
import { GoogleGenAI } from '@google/genai';
import { MODELS } from '../../lib/gemini';
import { buildUserContextForChat } from '../../lib/chat-context';

export const prerender = false;

/**
 * Live API 用 ephemeral token 発行。
 * 30 分の session 有効期間 / 60 秒以内に新規セッション開始 / 1 回限り使用。
 *
 * 任意で body `{ diagnosticUserId: "<uuid>" }` を受け、
 * その場合は当該ユーザーの検査文脈を `userContext` として返す。
 * クライアント側で system instruction の先頭に prepend する想定。
 */
export const POST: APIRoute = async ({ request }) => {
  const apiKey = import.meta.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({ error: 'GEMINI_API_KEY is not configured' }, 500);
  }

  let diagnosticUserId: string | null = null;
  try {
    const body = await request.json().catch(() => null) as { diagnosticUserId?: unknown } | null;
    if (body && typeof body.diagnosticUserId === 'string') {
      diagnosticUserId = body.diagnosticUserId;
    }
  } catch { /* body 無しは許可 */ }

  try {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
    const now = Date.now();
    const [token, userContext] = await Promise.all([
      ai.authTokens.create({
        config: {
          uses: 1,
          expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
          newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
          httpOptions: { apiVersion: 'v1alpha' },
        },
      }),
      buildUserContextForChat(diagnosticUserId).catch(() => null),
    ]);
    return json({ token: token.name, model: MODELS.liveChat, userContext });
  } catch (err) {
    return json({ error: 'token mint failed', detail: String(err) }, 500);
  }
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
