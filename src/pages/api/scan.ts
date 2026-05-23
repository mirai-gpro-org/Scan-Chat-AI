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

const ANALYZE_SYSTEM = `あなたは検査表・診断結果報告書の画像を読み取り、紙面に書かれて
いる内容を圧縮された構造化 JSON として返します。出力速度を優先するため
短いキー名・配列形式を使います。

【ミッション（最重要）】
診断・解釈・要約はこの JSON を受け取る別の AI が行います。あなたの仕事は
「紙面を正しく読み取ること」だけ。人命に関わるため次の原則を守ってください:

- 紙面に書かれていることだけを、書かれている形で転記する。
- 不明・確信が持てない値は絶対に推測で埋めない。
  読めなければ値を空文字 "" / c を "l" にする。
  行ごと判読不能ならその行を出力しない。
- 紙面に存在しない項目・列・値を作り出さない（ハルシネーション禁止）。

【判断はあなたに任せる】
- 紙面のレイアウト（表構造・列の意味・項目の並び）はあなたが画像を見て判断。
- cols 配列の列名は紙面で使われている見出し語をそのまま使う（日本語可）。
- 検査種別（血液 / 尿 / 画像 / 心電図 等）や医療機関による違いは自身で吸収。

【出力 JSON（圧縮形式）】
{
  "cols": [...],          // 紙面で検出した表の列見出し配列（日本語そのまま）
  "items": [              // 表の各行
    {
      "r": [...],         // cols と同順の値配列
      "b": [y1,x1,y2,x2], // bbox 0-1000 正規化
      "c": "h" | "l",     // 信頼度 high/low
      "k": "p" | "w",     // 種別 printed/handwritten
      "x": true           // 赤丸・下線等の強調がある時のみ（無い時は省略）
    }
  ],
  "notes": [              // 表に属さない手書きメモ・所見・補足
    {
      "t": "...",         // メモの生テキスト
      "b": [y1,x1,y2,x2],
      "c": "h" | "l"
    }
  ]
}

JSON 以外（前置きの説明、code fence、後置きの注釈）は出力しない。
表に該当しない手書きメモは items ではなく notes に入れること。`;

/**
 * Gemini に出力構造を強制する responseSchema (OpenAPI 風サブセット)。
 * これによりモデルが「どう構造を組むか」に迷う時間が削減され、生成が安定&高速化。
 */
const ANALYZE_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    cols: {
      type: 'array',
      items: { type: 'string' },
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          r: { type: 'array', items: { type: 'string' } },
          b: { type: 'array', items: { type: 'number' } },
          c: { type: 'string', enum: ['h', 'l'] },
          k: { type: 'string', enum: ['p', 'w'] },
          x: { type: 'boolean' },
        },
        required: ['r', 'b', 'c', 'k'],
      },
    },
    notes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          t: { type: 'string' },
          b: { type: 'array', items: { type: 'number' } },
          c: { type: 'string', enum: ['h', 'l'] },
        },
        required: ['t'],
      },
    },
  },
  required: ['cols', 'items'],
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
