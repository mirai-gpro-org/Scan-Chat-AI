/**
 * Gemini REST / Vision プロキシ用の薄い fetch ラッパ。
 * クライアントには公開しない（API キーが必要なため必ずサーバから呼ぶ）。
 */

/** env 読取 (import.meta.env → process.env の順。空文字は未設定扱い)。 */
function env(name: string): string | undefined {
  const m = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (m != null && m !== '') return m;
  const p = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return p != null && p !== '' ? p : undefined;
}

// スキャン/Live のモデルは env で差替え可能 (Vercel 環境変数)。env 反映は再デプロイ要 (コード変更は不要)。
//  - スキャン既定は gemini-3.1-flash-lite (軽量・安定)。精度を上げるなら
//    GEMINI_SCAN_MODEL=gemini-3.5-flash (GA・正式ID)。ただし混雑時に 503(model overloaded) が出やすく、
//    バッチ全滅の実績あり (2026-07) → 常用の既定は 3.1-flash-lite に据え置き。Tier1未開通/不具合時は gemini-2.5-flash。
//    ※ 末尾-preview無しの gemini-3-flash は Gemini API に無い (公式: Stable=gemini-3.5-flash / Preview=gemini-3-flash-preview)。
//  - Live は REST 非対応の専用プレビュー。GEMINI_LIVE_MODEL で更新に追従。
export const MODELS = {
  // REST generateContent (画像解析・テキスト応答)
  scan: env('GEMINI_SCAN_MODEL') || 'gemini-3.1-flash-lite',
  // Live API 専用 (WebSocket / audio-to-audio)。REST には渡さないこと
  liveChat: env('GEMINI_LIVE_MODEL') || 'gemini-3.1-flash-live-preview',
} as const;

/** モデルが Gemini 3 系 (3.x) か。生成設定の互換差 (thinkingLevel / 温度既定) の分岐に使う。 */
export function isGemini3Model(model: string): boolean {
  return /^gemini-3(\.|-)/i.test(model);
}

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
  /**
   * 構造化出力スキーマ (responseMimeType:'application/json' と併用)。
   * OpenAPI サブセット (type/properties/items/enum/nullable)。3.x でもそのまま透過する
   * (normalizeGenerationConfigForModel は temperature/topP/topK のみ除去し、これは ...rest で保持)。
   */
  responseSchema?: unknown;
  /**
   * Thinking 制御。
   *  - Gemini 2.x: `thinkingBudget` (token 数。0 で thinking 停止)。
   *  - Gemini 3.x: `thinkingLevel` ('low' | 'high')。thinkingBudget は非対応。
   * 呼び出し側は 2.x 形式 (thinkingBudget) で書けば、callGemini がモデルに応じ自動変換する。
   */
  thinkingConfig?: { thinkingBudget?: number; thinkingLevel?: 'low' | 'high' };
}

/** thinkingBudget(token) を Gemini 3 の thinkingLevel へ写像。低予算→low / 大予算→high。 */
function thinkingBudgetToLevel(budget?: number): 'low' | 'high' {
  return budget != null && budget > 8192 ? 'high' : 'low';
}

/**
 * 生成設定をモデルの流儀へ正規化する。
 * Gemini 3.x の場合のみ:
 *  - `temperature`/`topP`/`topK` を除去 (Gemini 3 はデフォルト推奨。明示すると精度低下し得る)。
 *  - `thinkingBudget` → `thinkingLevel` へ変換 (3.x は budget 非対応)。
 * Gemini 2.x はそのまま返す (呼び出し側の設定を尊重)。
 */
export function normalizeGenerationConfigForModel(
  config: GeminiGenerationConfig | undefined,
  model: string,
): GeminiGenerationConfig | undefined {
  if (!config || !isGemini3Model(model)) return config;
  const { temperature, topP, topK, thinkingConfig, ...rest } = config;
  const out: GeminiGenerationConfig = { ...rest };
  if (thinkingConfig?.thinkingLevel) {
    out.thinkingConfig = { thinkingLevel: thinkingConfig.thinkingLevel };
  } else if (thinkingConfig && thinkingConfig.thinkingBudget != null) {
    out.thinkingConfig = { thinkingLevel: thinkingBudgetToLevel(thinkingConfig.thinkingBudget) };
  }
  return out;
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

/** 一時的とみなしてバックオフ再試行するステータス (503=model overloaded / 429=rate / 500)。4xx は即失敗。 */
const GEMINI_RETRY_STATUSES = new Set([429, 500, 503]);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const intEnv = (name: string, def: number): number => {
  const n = parseInt(env(name) || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
};

export async function callGemini(
  apiKey: string,
  request: GeminiRequest,
  model: string = MODELS.scan,
): Promise<GeminiResponse> {
  if (!apiKey) {
    throw new GeminiError('GEMINI_API_KEY is not configured', 500, '');
  }
  // キーは URL クエリ(?key=)ではなく x-goog-api-key ヘッダで送る。
  //  - 新旧キー(AIza / AQ.)ともネイティブエンドポイントで正常動作 (Google 公式方式)。
  //  - URL/アクセスログにキーが残らない (漏洩リスク低減)。
  const url = `${ENDPOINT_BASE}/${encodeURIComponent(model)}:generateContent`;
  // 呼び出し側は 2.x 形式で設定を書ける。3.x へはここで自動変換 (thinkingLevel 化・温度既定化)。
  const normalized: GeminiRequest = {
    ...request,
    generationConfig: normalizeGenerationConfigForModel(request.generationConfig, model),
  };
  // 503(model overloaded)/429/500 を待って再試行 (サーバ側=キーのある Vercel でのみ意味を持つ)。
  //   3.5-flash 等の上位モデルは混雑時に 503 で「バッチ全滅」する実績があるため、ここで吸収する。
  //   既定は控えめ (3回×4s=最大12s待機・関数タイムアウト内)。検証時は env で強められる:
  //   GEMINI_MAX_RETRIES / GEMINI_RETRY_BASE_MS (例: 5 / 5000 = Gemini 提案の 5回×5s)。固定バックオフ。
  const maxRetries = intEnv('GEMINI_MAX_RETRIES', 3);
  const backoffMs = intEnv('GEMINI_RETRY_BASE_MS', 4000);
  let lastStatus = 0;
  let lastText = '';
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(normalized),
      });
    } catch (e) {
      // ネットワーク断も一時障害として再試行。
      lastStatus = 0;
      lastText = String(e);
      if (attempt < maxRetries) { await sleep(backoffMs + Math.floor(Math.random() * 1000)); continue; }
      throw new GeminiError(`Gemini fetch failed: ${lastText}`, 0, '');
    }
    const text = await res.text();
    if (!res.ok) {
      if (GEMINI_RETRY_STATUSES.has(res.status) && attempt < maxRetries) {
        lastStatus = res.status;
        lastText = text;
        // 固定バックオフ + ジッター(0〜1s)。0秒/同期リトライは Google のレートリミッタに
        // 悪質判定され 429/IPバンに悪化するため、待機とゆらぎを必ず入れる (Gemini 助言)。
        await sleep(backoffMs + Math.floor(Math.random() * 1000));
        continue;
      }
      throw new GeminiError(`Gemini request failed: ${res.status}`, res.status, text);
    }
    try {
      return JSON.parse(text) as GeminiResponse;
    } catch (err) {
      throw new GeminiError('Gemini response is not valid JSON', 502, text);
    }
  }
  throw new GeminiError(`Gemini request failed after ${maxRetries} retries: ${lastStatus}`, lastStatus || 503, lastText);
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
