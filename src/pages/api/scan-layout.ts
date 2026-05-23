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
- 領域の数や境界に決め打ちはしない。
- 極端に細かく分けない（行単位ではなく塊単位）。
- 斜め撮影や余白を考慮し、コンテンツが実在するエリアだけを矩形で囲む。

【領域数の上限 (重要)】
領域は **最大 3 つまで**に絞ってください（並列クォータ節約のため）。
紙面に明確な塊が 4 つ以上ある場合でも、近接するものは結合してください。
例: 左右に表が 2 つあり下部に手書きメモがあれば、3 領域。
表 + 手書きが 1 つの塊として見えるならまとめて 1 領域でもよい。

【1 つの表は 1 つの領域に (重要)】
表は左右や上下に分かれていても、**同じ表構造（同じ列見出しを持つもの）は
必ず 1 つの bbox に収める**こと。
左右に分かれた表は「左表」「右表」と別領域に分けてもよいが、その場合は
それぞれの bbox に**反対側を含めない**ように厳密に矩形を引く。

【重要: 領域のオーバーラップ】
隣接領域は境界線をまたぐ行・項目が「泣き別れ」になりがちです。
**隣接領域は意図的に 5〜10% 程度オーバーラップさせて**ください。
重複した行が両方の領域で転記されても、後段で重複排除します。

【task フィールド】
各領域には、後続の転記 AI 向けに**この領域で何を抽出すべきか**の
1 文ヒントを task に書いてください。例:
  - "上半分の検査値表 (No.1-20) の各行を抽出"
  - "右下の手書きメモ (CA19-9 前回値・改善傾向の記録) の文字起こし"
  - "ヘッダ部の患者情報・検査日付の抽出"

【出力 JSON】
{
  "regions": [
    {
      "id": string,                                  // 一意な英数字 ID
      "label": string,                                // 短い日本語ラベル
      "task": string,                                 // 転記 AI 向けのタスクヒント
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
          task: { type: 'string' },
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
