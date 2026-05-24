import type { APIRoute } from 'astro';
import {
  callGemini,
  MODELS,
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

const ANALYZE_SYSTEM = `検査表・診断結果報告書の画像を、紙面の内容そのまま **構造化 Markdown** に
書き起こしてください。
診断・解釈・要約はしません（下流の別 AI が行います）。

【出力フォーマット (厳守)】
紙面を意味のある領域 (regions) に分け、各領域を H2 見出しで始めます。
見出しの直後の行に、領域の正規化された bounding box を HTML コメントで埋めます。
表は GFM テーブル形式、自由テキストは段落 / 箇条書きとして書きます。

【座標系】
bbox は **0.0〜1.0 の小数** で **[ymin, xmin, ymax, xmax]** の順。
ピクセル単位は使わない（端末非依存にするため）。

【守ること】
- 紙面にあるものだけを、書かれている形で転記する。
- 不明な値は推測で埋めない。読めない値は \`(?)\` と書く。
- 紙面に無い項目・列を作らない（ハルシネーション禁止）。
- 領域は最大 4 つまで。極端に細かく分けない。
- 表の列見出しは紙面で使われている見出し語をそのまま使う。

【出力例】

## 左側検査値表
<!-- bbox: 0.05,0.05,0.95,0.50 -->

| No | 検査項目 | 結果 | 単位 | 基準値 |
|----|----------|------|------|--------|
| 1  | AST(GOT) | 18   | U/L  | 10-35  |
| 2  | ALT(GPT) | 12   | U/L  | 5-40   |

## 右側検査値表
<!-- bbox: 0.05,0.50,0.95,0.85 -->

| No | 検査項目 | 結果 | 単位 | 基準値 |
|----|----------|------|------|--------|
| 35 | CEA      | 7.1H | ng/ml| 0-5.0  |
| 36 | CA19-9   | 4048.7H | U/ml | 0-37 |

## 手書きメモ
<!-- bbox: 0.05,0.85,0.95,0.98 -->

- 古富先生
- CA19-9 (腫瘍マーカー)
- 前回 4981 / 今回 4048 / -933 改善

【出力する際の注意】
- 出力は **純粋な Markdown だけ**。前置きの説明文や code fence (\`\`\`) で
  全体を囲む等は絶対にしない（GFM テーブル内の \`code\` は OK）。
- 領域見出しの bbox HTML コメントは省略しないこと。
- 表が無い領域は notes として段落/箇条書きで書く。`;

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

  const { mime, data } = parseDataUrl(body.image);
  const userParts: GeminiContent['parts'] = [
    { inline_data: { mime_type: mime, data } },
    {
      text: body.hint
        ? `補足: ${body.hint}\nこの紙面を Markdown に書き起こしてください。`
        : 'この紙面を Markdown に書き起こしてください。',
    },
  ];

  try {
    const res = await callGemini(
      import.meta.env.GEMINI_API_KEY,
      {
        systemInstruction: { parts: [{ text: ANALYZE_SYSTEM }] },
        contents: [{ role: 'user', parts: userParts }],
        generationConfig: {
          temperature: 0.0,
          maxOutputTokens: 32768,
          thinkingConfig: { thinkingBudget: 0 },
        },
      },
      MODELS.scan,
    );
    const markdown = extractText(res);
    const finishReason = res.candidates?.[0]?.finishReason;
    return json({ markdown, finishReason });
  } catch (err) {
    if (err instanceof GeminiError) {
      return json(
        { error: err.message, detail: err.body },
        err.status >= 400 ? err.status : 500,
      );
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
