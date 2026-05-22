import type { APIRoute } from 'astro';
import {
  callGemini,
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

const SCAN_SYSTEM = `あなたは医療画像補助 AI です。
画像から観察できる所見のみを記述し、診断や処方は行いません。
出力は以下の JSON スキーマに厳密に従ってください:
{
  "observations": string[],     // 観察された所見（短文の配列）
  "regions": string[],          // 注目すべき体表部位（例: 右前腕、口腔内）
  "follow_up_questions": string[], // 医療者が次に確認すべき質問
  "urgent": boolean             // 緊急性が示唆される場合 true
}
JSON 以外の文字（前後のコメントや code fence）は出力しないこと。`;

function parseDataUrl(input: string): { mime: string; data: string } {
  const m = /^data:([^;]+);base64,(.+)$/i.exec(input.trim());
  if (m) return { mime: m[1], data: m[2] };
  // 生 base64 として扱う（既定 image/jpeg）
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
    { text: body.hint ? `補足: ${body.hint}` : '画像を解析してください。' },
  ];

  try {
    const res = await callGemini(import.meta.env.GEMINI_API_KEY, {
      systemInstruction: { parts: [{ text: SCAN_SYSTEM }] },
      contents: [{ role: 'user', parts: userParts }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1024,
        responseMimeType: 'application/json',
      },
    });
    const raw = extractText(res);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // フォールバック：生テキストも返す
    }
    return json({ raw, json: parsed });
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
