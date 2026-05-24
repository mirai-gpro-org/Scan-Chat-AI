/**
 * Gemini REST / Vision プロキシ用の薄い fetch ラッパ。
 * クライアントには公開しない（API キーが必要なため必ずサーバから呼ぶ）。
 */

export const MODELS = {
  // REST generateContent (画像解析・テキスト応答)
  scan: 'gemini-2.5-flash',
  // Live API 専用 (WebSocket / audio-to-audio)。REST には渡さないこと
  liveChat: 'gemini-3.1-flash-live-preview',
} as const;

const ENDPOINT_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models';

export interface GeminiPart {
  text?: string;
  inline_data?: {
    mime_type: string;
    data: string; // base64
  };
}

export interface GeminiContent {
  role?: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiGenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
}

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: GeminiGenerationConfig;
}

export interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
}

export interface GeminiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: unknown;
}

export class GeminiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

export async function callGemini(
  apiKey: string,
  request: GeminiRequest,
  model: string = MODELS.scan,
): Promise<GeminiResponse> {
  if (!apiKey) {
    throw new GeminiError('GEMINI_API_KEY is not configured', 500, '');
  }
  const url = `${ENDPOINT_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new GeminiError(`Gemini request failed: ${res.status}`, res.status, text);
  }
  try {
    return JSON.parse(text) as GeminiResponse;
  } catch (err) {
    throw new GeminiError('Gemini response is not valid JSON', 502, text);
  }
}

/** candidates から最初のテキストを取り出す。なければ空文字。 */
export function extractText(res: GeminiResponse): string {
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p) => p.text ?? '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Gemini が responseMimeType:'application/json' を無視して
 * ```json … ``` で包んでくることがあるので剥がす。
 * 何も包まれていなければそのまま返す。
 */
export function stripJsonCodeFence(text: string): string {
  const t = text.trim();
  const m = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i.exec(t);
  return m ? m[1].trim() : t;
}
