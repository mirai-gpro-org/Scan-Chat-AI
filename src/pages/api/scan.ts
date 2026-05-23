import type { APIRoute } from 'astro';
import {
  callGemini,
  MODELS,
  extractText,
  GeminiError,
  type GeminiContent,
} from '../../lib/gemini';

export const prerender = false;

type ScanMode = 'detect' | 'analyze';

interface ScanRequestBody {
  /** data: URL もしくは生 base64 */
  image: string;
  /** 補足プロンプト（部位・状況など） */
  hint?: string;
  /**
   * detect: AR 用の軽量 bbox 検知（連続呼出）
   * analyze: 撮影確定時のフル解析（既定）
   */
  mode?: ScanMode;
}

const DETECT_SYSTEM = `あなたは医療文書スキャン補助 AI です。
入力画像から検査値・項目ラベル・手書きメモを検知し、各バウンディングボックスを返してください。
出力は以下の JSON スキーマに厳密に従ってください:
{
  "items": [
    {
      "label": string,            // 項目名（例: 血圧、Hb、所見）
      "value": string,            // 認識した値（手書きで判読不能なら空文字）
      "bbox": [number, number, number, number], // [ymin, xmin, ymax, xmax] 0-1000 で正規化
      "confidence": "high" | "low", // low は手書き / かすれ等
      "kind": "printed" | "handwritten"
    }
  ]
}
JSON 以外の文字（前後のコメントや code fence）は出力しないこと。最大 12 項目まで。`;

const ANALYZE_SYSTEM = `あなたは医療画像補助 AI です。
画像から観察できる所見のみを記述し、診断や処方は行いません。
出力は以下の JSON スキーマに厳密に従ってください:
{
  "observations": string[],
  "regions": string[],
  "follow_up_questions": string[],
  "items": [
    {
      "label": string,
      "value": string,
      "bbox": [number, number, number, number], // [ymin, xmin, ymax, xmax] 0-1000 で正規化
      "confidence": "high" | "low",
      "kind": "printed" | "handwritten"
    }
  ],
  "priority_flags": string[], // 後続チャットで重点的に確認すべき項目（label 名）
  "urgent": boolean
}
JSON 以外の文字（前後のコメントや code fence）は出力しないこと。`;

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

  const mode: ScanMode = body.mode === 'detect' ? 'detect' : 'analyze';
  const { mime, data } = parseDataUrl(body.image);
  const userParts: GeminiContent['parts'] = [
    { inline_data: { mime_type: mime, data } },
    {
      text:
        mode === 'detect'
          ? '画像から項目を検知し bbox 配列を返してください。'
          : body.hint
            ? `補足: ${body.hint}`
            : '画像を解析してください。',
    },
  ];

  try {
    const res = await callGemini(import.meta.env.GEMINI_API_KEY, {
      systemInstruction: {
        parts: [{ text: mode === 'detect' ? DETECT_SYSTEM : ANALYZE_SYSTEM }],
      },
      contents: [{ role: 'user', parts: userParts }],
      generationConfig: {
        temperature: mode === 'detect' ? 0.1 : 0.2,
        maxOutputTokens: mode === 'detect' ? 512 : 1024,
        responseMimeType: 'application/json',
      },
    }, MODELS.scan);
    const raw = extractText(res);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 構造化失敗時は raw を返してフロントで対応
    }
    return json({ mode, raw, json: parsed });
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
