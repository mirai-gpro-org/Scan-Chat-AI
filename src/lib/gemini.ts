/**
 * Gemini REST / Vision プロキシ用の薄い fetch ラッパ。
 * クライアントには公開しない（API キーが必要なため必ずサーバから呼ぶ）。
 */

export const MODELS = {
  // 撮影画像のネイティブマルチモーダル転記（OCR + 構造化）。
  // 解釈や臨床推論は下流の診断 AI が担当するため、ここでは速度を優先。
  // flash は thinking を完全停止できる点でも転記タスクに最適。
  scan: 'gemini-2.5-flash',
  // Live API 専用 (WebSocket / audio-to-audio)。REST には渡さないこと
  liveChat: 'gemini-3.1-flash-live-preview',
} as const;

const ENDPOINT_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models';
const FILES_UPLOAD_ENDPOINT =
  'https://generativelanguage.googleapis.com/upload/v1beta/files';

export interface GeminiPart {
  text?: string;
  inline_data?: {
    mime_type: string;
    data: string; // base64
  };
  /** Files API 経由でアップロード済みファイルへの参照 */
  file_data?: {
    mime_type: string;
    file_uri: string;
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
  /** Thinking 予算 (token)。0 で無効化 (flash/lite のみ)、pro は最小 128 程度。 */
  thinkingConfig?: { thinkingBudget?: number };
  /**
   * 出力 JSON の構造を OpenAPI 風スキーマで強制する。
   * responseMimeType: "application/json" と併用すると、モデルがフォーマットに
   * 迷う時間が削れ、生成速度と安定性が改善する。
   */
  responseSchema?: Record<string, unknown>;
}

export interface GeminiSafetySetting {
  category:
    | 'HARM_CATEGORY_HARASSMENT'
    | 'HARM_CATEGORY_HATE_SPEECH'
    | 'HARM_CATEGORY_SEXUALLY_EXPLICIT'
    | 'HARM_CATEGORY_DANGEROUS_CONTENT'
    | 'HARM_CATEGORY_CIVIC_INTEGRITY';
  threshold:
    | 'BLOCK_NONE'
    | 'BLOCK_ONLY_HIGH'
    | 'BLOCK_MEDIUM_AND_ABOVE'
    | 'BLOCK_LOW_AND_ABOVE';
}

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: GeminiGenerationConfig;
  safetySettings?: GeminiSafetySetting[];
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

/**
 * streamGenerateContent を SSE で叩き、chunk ごとに { text, finishReason? } を yield する。
 * AsyncGenerator なので呼び出し側で `for await (const ev of streamGemini(...))` できる。
 */
export async function* streamGemini(
  apiKey: string,
  request: GeminiRequest,
  model: string = MODELS.scan,
): AsyncGenerator<{ text: string; finishReason?: string }> {
  if (!apiKey) {
    throw new GeminiError('GEMINI_API_KEY is not configured', 500, '');
  }
  const url = `${ENDPOINT_BASE}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw new GeminiError(`Gemini stream failed: ${res.status}`, res.status, body);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE は "data: {...}\n\n" 区切り。\n\n が来た部分まで処理し、未完は buf に残す。
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (!frame.startsWith('data:')) continue;
      const json = frame.slice(5).trim();
      if (!json || json === '[DONE]') continue;
      try {
        const obj = JSON.parse(json) as GeminiResponse;
        const parts = obj.candidates?.[0]?.content?.parts ?? [];
        const text = parts.map((p) => p.text ?? '').join('');
        const finishReason = obj.candidates?.[0]?.finishReason;
        if (text || finishReason) yield { text, finishReason };
      } catch {
        // 部分パース失敗は無視（次フレームで揃う）
      }
    }
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

export interface GeminiFileRef {
  uri: string;
  mimeType: string;
  name: string;
}

/**
 * 画像バイナリを Gemini Files API にアップロードして file URI を返す。
 * Base64 inline と比べ:
 *   - JSON body 経由でない（バイナリ直送）
 *   - リクエストボディが 1/4 程度（base64 拡張なし）
 *   - Gemini 側の入力パースが早い（メディア専用パイプライン）
 * Files は 48h 後に自動失効するので明示削除は不要。
 */
export async function uploadGeminiFile(
  apiKey: string,
  bytes: Uint8Array,
  mimeType: string,
  displayName = 'scan',
): Promise<GeminiFileRef> {
  if (!apiKey) {
    throw new GeminiError('GEMINI_API_KEY is not configured', 500, '');
  }
  // resumable upload: start でセッション URL を取得 → finalize でバイナリ送信
  const startRes = await fetch(
    `${FILES_UPLOAD_ENDPOINT}?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(bytes.byteLength),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
    },
  );
  if (!startRes.ok) {
    const text = await startRes.text().catch(() => '');
    throw new GeminiError(`File upload start failed: ${startRes.status}`, startRes.status, text);
  }
  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new GeminiError('File upload start: missing X-Goog-Upload-URL', 502, '');
  }

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(bytes.byteLength),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    // Uint8Array.buffer は ArrayBuffer なので BodyInit として受理される
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  });
  if (!uploadRes.ok) {
    const text = await uploadRes.text().catch(() => '');
    throw new GeminiError(`File upload failed: ${uploadRes.status}`, uploadRes.status, text);
  }
  const meta = (await uploadRes.json()) as {
    file?: { uri?: string; mimeType?: string; name?: string };
  };
  if (!meta?.file?.uri) {
    throw new GeminiError('File upload: no uri in response', 502, JSON.stringify(meta));
  }
  return {
    uri: meta.file.uri,
    mimeType: meta.file.mimeType ?? mimeType,
    name: meta.file.name ?? '',
  };
}
