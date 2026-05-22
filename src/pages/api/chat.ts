import type { APIRoute } from 'astro';
import {
  callGemini,
  extractText,
  GeminiError,
  type GeminiContent,
} from '../../lib/gemini';

export const prerender = false;

interface ChatRequestBody {
  messages: Array<{ role: 'user' | 'assistant' | 'system'; text: string }>;
  /** 任意：問診の中で患者が前回までに答えた要約など */
  systemHint?: string;
}

const SYSTEM_INSTRUCTION = `あなたは医療機関の問診補助 AI です。
- 日本語で簡潔・丁寧に対応してください。
- 診断や処方は行わず、症状の聞き取りと整理に専念してください。
- 危険兆候（胸痛・意識障害・激しい頭痛・呼吸困難・大量出血など）が疑われる場合は、ためらわず 119 への連絡や救急受診を促してください。
- 1 ターンで質問は 1 つまでに絞ってください。`;

export const POST: APIRoute = async ({ request }) => {
  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (!body?.messages?.length) {
    return json({ error: 'messages is required' }, 400);
  }

  const contents: GeminiContent[] = body.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.text }],
    }));

  try {
    const res = await callGemini(import.meta.env.GEMINI_API_KEY, {
      systemInstruction: {
        parts: [
          { text: SYSTEM_INSTRUCTION },
          ...(body.systemHint ? [{ text: `補足: ${body.systemHint}` }] : []),
        ],
      },
      contents,
      generationConfig: { temperature: 0.4, maxOutputTokens: 512 },
    });
    return json({ text: extractText(res) });
  } catch (err) {
    return handleGeminiError(err);
  }
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function handleGeminiError(err: unknown): Response {
  if (err instanceof GeminiError) {
    return json({ error: err.message, detail: err.body }, err.status >= 400 ? err.status : 500);
  }
  return json({ error: 'Unexpected error', detail: String(err) }, 500);
}
