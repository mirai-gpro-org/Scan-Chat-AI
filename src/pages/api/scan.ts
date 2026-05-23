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

const ANALYZE_SYSTEM = `検査表・診断結果報告書の画像を、紙面の内容そのまま JSON にしてください。
診断・解釈・要約はしません（下流の別 AI が行います）。

【守ること】
- 紙面にあるものだけを、書かれている形で転記する。
- 不明な値は推測で埋めない。読めなければ値を "" にし、その行 index を
  uncertain_rows に入れる。行ごと判読不能なら出力しない。
- 紙面に無い項目・列を作らない（ハルシネーション禁止）。

【領域分け】
紙面を 2〜4 個の領域に分けて返す。表 1 つ / 手書きメモ等が 1 領域。
領域内の表構造（列の意味、項目並び）はあなたが画像を見て判断する。

【出力 JSON】
{
  "regions": [
    {
      "id": "left_table",                          // 英数字 ID
      "label": "左側検査値表",                      // 短い日本語ラベル
      "bbox": [ymin, xmin, ymax, xmax],            // 領域 bbox 0-1000 正規化
      "kind": "table" | "notes",                   // 表 or 自由テキスト
      "cols": ["列1","列2", ...],                  // table のとき紙面の列見出し
      "rows": [["値","値", ...], ...],             // table のとき各行 cols 順
      "uncertain_rows": [3, 7],                    // table のとき自信なし行 index
      "text": "..."                                // notes のとき自由テキスト（改行 \\n）
    }
  ]
}

【注意】
- 各行は cols と同じ要素数の文字列配列。
- table 領域は cols / rows / uncertain_rows のみ（text なし）。
- notes 領域は text のみ（cols / rows / uncertain_rows なし）。

JSON 以外（前置き、code fence、後置きの説明）は出力しないこと。`;

/**
 * Gemini に出力構造を強制する responseSchema (OpenAPI 風サブセット)。
 * シンプルに保つ: per-row metadata を削ったので空間推論コストも消える。
 */
const ANALYZE_RESPONSE_SCHEMA: Record<string, unknown> = {
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
          kind: { type: 'string', enum: ['table', 'notes'] },
          cols: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
          uncertain_rows: { type: 'array', items: { type: 'number' } },
          text: { type: 'string' },
        },
        required: ['id', 'label', 'bbox', 'kind'],
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
            ? `補足: ${body.hint}\nこの紙面を読み取って JSON に転記してください。`
            : 'この紙面を読み取って JSON に転記してください。',
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
        maxOutputTokens: mode === 'detect' ? 2048 : 32768,
        responseMimeType: 'application/json',
        // 転記タスクに thinking は不要。ON にすると 32k 予算の大半を
        // 思考過程が食い、出力が早期に MAX_TOKENS で切られる。
        thinkingConfig: { thinkingBudget: 0 },
        // responseSchema で出力構造を強制 → モデルが「どう書くか」に
        // 迷わなくなり、生成が安定 & 高速化する (detect はシンプルなので付けない)。
        ...(mode === 'detect' ? {} : { responseSchema: ANALYZE_RESPONSE_SCHEMA }),
      },
    }, MODELS.scan);
    const raw = extractText(res);
    const cleaned = stripJsonCodeFence(raw);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // 構造化失敗時は raw を返してフロントで対応
    }
    const finishReason = res.candidates?.[0]?.finishReason;
    return json({ mode, raw, json: parsed, finishReason });
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
