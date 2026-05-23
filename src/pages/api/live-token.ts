import type { APIRoute } from 'astro';
import { GoogleGenAI } from '@google/genai';
import { MODELS } from '../../lib/gemini';

export const prerender = false;

/**
 * Live API 用 ephemeral token 発行。
 * 30 分の session 有効期間 / 60 秒以内に新規セッション開始 / 1 回限り使用。
 */
export const POST: APIRoute = async () => {
  const apiKey = import.meta.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({ error: 'GEMINI_API_KEY is not configured' }, 500);
  }
  try {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
    const now = Date.now();
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
        httpOptions: { apiVersion: 'v1alpha' },
      },
    });
    return json({ token: token.name, model: MODELS.liveChat });
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
