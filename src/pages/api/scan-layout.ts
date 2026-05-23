import type { APIRoute } from 'astro';
import {
  callGemini,
  MODELS,
  extractText,
  stripJsonCodeFence,
  GeminiError,
  type GeminiContent,
} from '../../lib/gemini';

export const prerender = false;

interface LayoutRequestBody {
  /** data: URL もしくは生 base64 */
  image: string;
}

/**
 * 並列分割パイプライン Phase 1: レイアウト検出。
 *
 * 紙面の主要な領域 (regions) だけを bbox 付きで返す。内容は転記しない。
 * 軽量・高速 (~1-2s) なので、続く Phase 2 でクライアント側がクロップして
 * /api/scan に並列で投げる。
 */

const LAYOUT_SYSTEM = `あなたは検査表・診断結果報告書の画像を見て、紙面の主要な領域 (regions)
を検出する仕事をします。**内容の転記はしません**（後続の別 AI が領域ごとに
詳細転記を行います）。

【検出する領域】
- 表（検査値の表など）。複数あれば全部別領域として返す。
- 手書きメモ・所見・コメント領域。
- ヘッダ・フッタ（識別番号、患者情報など）が独立した塊なら 1 領域。
- その他の独立した内容領域。

【判断はあなたに任せる】
- 紙面のレイアウトはあなたが画像を見て判断する。
- 領域の数や境界に決め打ちはしない。1 つでもよいし 5-6 個に分かれてもよい。
- 領域同士が重なってもよい（手書きメモが表に重なる等）。
- ただし**極端に細かく分けない**こと（行単位ではなく塊単位）。

【出力 JSON】
{
  "regions": [
    {
      "id": string,                                  // 一意な英数字 ID
      "label": string,                                // 人間が読む短い日本語ラベル
      "bbox": [number, number, number, number]       // [ymin, xmin, ymax, xmax] 0-1000 正規化
    }
  ]
}

JSON 以外（前置きの説明、code fence、後置きの注釈）は出力しないこと。`;

const LAYOUT_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    regions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          bbox: { type: 'array', items: { type: 'number' } },
        },
        required: ['id', 'label', 'bbox'],
      },
    },
  },
  required: ['regions'],
};

function parseDataUrl(input: string): { mime: string; data: string } {
  const m = /^data:([^;]+);base64,(.+)$/i.exec(input.trim());
  if (m) return { mime: m[1], data: m[2] };
  return { mime: 'image/jpeg', data: input.trim() };
}

export const POST: APIRoute = async ({ request }) => {
  let body: LayoutRequestBody;
  try {
    body = (await request.json()) as LayoutRequestBody;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (!body?.image) {
    return json({ error: 'image is required' }, 400);
  }

  const { mime, data } = parseDataUrl(body.image);
  const userParts: GeminiContent['parts'] = [
    { inline_data: { mime_type: mime, data } },
    { text: 'この紙面の主要領域 (regions) を bbox 付きで検出してください。内容の転記は不要です。' },
  ];

  try {
    const res = await callGemini(
      import.meta.env.GEMINI_API_KEY,
      {
        systemInstruction: { parts: [{ text: LAYOUT_SYSTEM }] },
        contents: [{ role: 'user', parts: userParts }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 0 },
          responseSchema: LAYOUT_RESPONSE_SCHEMA,
        },
      },
      MODELS.scan,
    );
    const raw = extractText(res);
    const cleaned = stripJsonCodeFence(raw);
    let parsed: unknown = null;
    try { parsed = JSON.parse(cleaned); } catch { /* noop */ }
    const finishReason = res.candidates?.[0]?.finishReason;
    return json({ raw, json: parsed, finishReason });
  } catch (err) {
    if (err instanceof GeminiError) {
      return json({ error: err.message, detail: err.body }, err.status >= 400 ? err.status : 500);
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
