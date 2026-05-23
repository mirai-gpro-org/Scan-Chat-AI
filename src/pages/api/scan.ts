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
   * analyze: 撮影確定時のネイティブマルチモーダル抽出（既定）
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

const ANALYZE_SYSTEM = `あなたはネイティブマルチモーダル AI として、医療検査結果用紙の画像を
「視覚」と「言語」を同時に用いて理解し、紙面に存在する値だけを構造化 JSON
として忠実に転記してください。
これは OCR ではありません。表の罫線・列順・赤丸・下線・蛍光ペン・手書き
追記といった**視覚的な手掛かり**を活用して、どの数字が「結果」列でどれが
「下限/上限」かを正しく弁別することがあなたの強みです。
解釈・診断・要約・観察所見・問診質問・優先度判定などは下流の別 AI が担当
するため、このアプリでは一切出力しないでください。

【表の典型レイアウト】
左から右に: No | 検査項目（略称）| 結果 | 検査項目詳細（フルネーム） | 下限値 | 上限値 | 単位名称
- "結果" 列の数値直後に H / L マークが付くことがあります（基準値超 / 下回）。
- 行末に "L" "H" の文字や ▼▲ 等の記号が見える場合は flag に "L" "H" を入れます。
- 用紙は左右 2 カラム構成のことが多い（左半分・右半分それぞれが同じレイアウト）。

【絶対に守ること】
1. value には "結果" 列の値のみを入れてください。下限値・上限値・単位を value に
   混入させないでください。たとえば次のような行:
     "23 Hgb 8.1 L ヘモグロビン量 13.7 16.8 g/dl"
   は value="8.1", flag="L", ref_low="13.7", ref_high="16.8", unit="g/dl" と
   分解して格納します。value="16.8" のように上限値を結果欄に入れるのは誤りです。
2. 紙面に存在しない値・項目を出力しないでください（ハルシネーション禁止）。
   読めなければ value="" / confidence="low" で構いません。
3. 全項目（印刷値・手書き追記すべて）を漏らさず転記してください。truncate 禁止。
   手書きメモは kind="handwritten" で 1 項目ずつ独立に格納します。
4. 赤丸・下線・蛍光ペン等で強調されている項目は marked: true としてください。
5. 解釈や臨床コメントは絶対に出力しない（observations / urgent / priority などは
   このアプリのスキーマには存在しません）。

【出力 JSON】
{
  "items": [
    {
      "no": string,            // 検査項目番号 ("23" 等)。無ければ ""
      "label": string,         // 検査項目の略称 ("Hgb" 等)
      "label_detail": string,  // 検査項目の詳細名 ("ヘモグロビン量" 等)。無ければ ""
      "value": string,         // 結果列の値（数値・テキスト・空文字）
      "flag": string,          // "H" / "L" / "" のいずれか
      "unit": string,          // 単位 ("g/dl" 等)。無ければ ""
      "ref_low": string,       // 下限値。無ければ ""
      "ref_high": string,      // 上限値。無ければ ""
      "marked": boolean,       // 赤丸・下線・蛍光等の強調マークの有無
      "bbox": [number, number, number, number], // [ymin, xmin, ymax, xmax] 0-1000 正規化
      "confidence": "high" | "low",
      "kind": "printed" | "handwritten"
    }
  ]
}
JSON 以外の文字（前後のコメント・説明・code fence）は一切出力しないこと。`;

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
            : '紙面の全項目を、画像理解で「結果列」を正確に弁別したうえで JSON に転記してください。',
    },
  ];

  try {
    // analyze は表構造の視覚理解精度を優先して gemini-2.5-pro、
    // detect は連続検知用に軽量 flash を継続使用。
    // pro の思考予算を絞ることで応答速度を確保（典型 8-15s 想定）。
    const model = mode === 'detect' ? MODELS.scan : MODELS.scanPrecise;
    const res = await callGemini(import.meta.env.GEMINI_API_KEY, {
      systemInstruction: {
        parts: [{ text: mode === 'detect' ? DETECT_SYSTEM : ANALYZE_SYSTEM }],
      },
      contents: [{ role: 'user', parts: userParts }],
      generationConfig: {
        temperature: mode === 'detect' ? 0.1 : 0.0,
        maxOutputTokens: mode === 'detect' ? 2048 : 16384,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: mode === 'detect' ? 0 : 1024 },
      },
    }, model);
    const raw = extractText(res);
    const cleaned = stripJsonCodeFence(raw);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // 構造化失敗時は raw を返してフロントで対応
    }
    const finishReason = res.candidates?.[0]?.finishReason;
    return json({ mode, model, raw, json: parsed, finishReason });
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
