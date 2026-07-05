import type { APIRoute } from 'astro';
import { ANALYZE_SYSTEM } from '../../lib/scan-prompt';
import {
  callGemini,
  MODELS,
  extractText,
  GeminiError,
  type GeminiContent,
} from '../../lib/gemini';

export const prerender = false;

interface ScanRequestBody {
  /** data: URL もしくは生 base64 */
  image: string;
  /** 補足プロンプト（部位・状況など） */
  hint?: string;
}

function parseDataUrl(input: string): { mime: string; data: string } {
  const m = /^data:([^;]+);base64,(.+)$/i.exec(input.trim());
  if (m) return { mime: m[1], data: m[2] };
  return { mime: 'image/jpeg', data: input.trim() };
}

export const POST: APIRoute = async ({ request }) => {
  let body: ScanRequestBody;
  try {
    body = (await request.json()) as ScanRequestBody;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (!body?.image) {
    return json({ error: 'image is required (data URL or base64)' }, 400);
  }

  const { mime, data } = parseDataUrl(body.image);
  const userParts: GeminiContent['parts'] = [
    { inline_data: { mime_type: mime, data } },
    {
      text: body.hint
        ? `補足: ${body.hint}\nこの紙面を Markdown に書き起こしてください。`
        : 'この紙面を Markdown に書き起こしてください。',
    },
  ];

  try {
    const res = await callGemini(
      import.meta.env.GEMINI_API_KEY,
      {
        systemInstruction: { parts: [{ text: ANALYZE_SYSTEM }] },
        contents: [{ role: 'user', parts: userParts }],
        generationConfig: {
          temperature: 0.0,
          maxOutputTokens: 32768,
          thinkingConfig: { thinkingBudget: 2048 },
        },
      },
      MODELS.scan,
    );
    const markdown = extractText(res);
    const finishReason = res.candidates?.[0]?.finishReason;
    return json({ markdown, finishReason });
  } catch (err) {
    if (err instanceof GeminiError) {
      return json(
        { error: err.message, detail: err.body },
        err.status >= 400 ? err.status : 500,
      );
    }
    return json({ error: 'Unexpected error', detail: String(err) }, 500);
  }
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
