import type { APIRoute } from 'astro';
import {
  streamGemini,
  MODELS,
  stripJsonCodeFence,
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

const ANALYZE_SYSTEM = `あなたはネイティブマルチモーダル AI として、医療検査結果用紙の画像から
検査項目を読み取り、構造化 JSON として返してください。
これは OCR ではなく、表の罫線・列順・赤丸・下線・蛍光ペン・手書き追記を
視覚的に理解する仕事です。解釈・診断・要約は一切しません
（下流の別 AI が担当）。

【表の典型レイアウト】
左から右に: 項目番号 | 検査項目（略称）| 結果 | 検査項目詳細 | 下限値 | 上限値 | 単位

【守ること】
- value には「結果」列の値のみを入れる。下限値・上限値・単位を value に
  混入させない。例えば "23 Hgb 8.1 L ヘモグロビン量 13.7 16.8 g/dl" の行は
  value="8.1", flag="L", unit="g/dl", ref_low="13.7", ref_high="16.8" と分解。
- 紙面に存在しない値・項目は出力しない（ハルシネーション禁止）。
  読めなければ value="" / confidence="low" でよい。
- 印字も手書きもすべて漏らさず転記。手書きは kind="handwritten" で個別に格納。
- 赤丸・下線・蛍光ペン等の強調は marked: true として示す。
- 出力は最大 25 項目に抑える（重要・基準値外・手書き・強調を優先）。

【出力 JSON】
{
  "items": [
    {
      "label": string,            // 略称 (例: "Hgb")
      "label_detail": string,     // 詳細名（無ければ ""）
      "value": string,
      "unit": string,             // 単位（無ければ ""）
      "flag": string,             // "H" / "L" / ""
      "ref_low": string,          // 下限値（無ければ ""）
      "ref_high": string,         // 上限値（無ければ ""）
      "marked": boolean,
      "bbox": [number, number, number, number],  // [ymin, xmin, ymax, xmax] 0-1000 正規化
      "confidence": "high" | "low",
      "kind": "printed" | "handwritten"
    }
  ]
}
JSON 以外（コメント・説明・code fence）は出力しないこと。`;

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
        ? `補足: ${body.hint}`
        : '紙面の全項目を、画像理解で「結果列」を正確に弁別したうえで JSON に転記してください。',
    },
  ];

  // === 暫定: gemini-2.5-flash に戻す（billing/Tier 1 反映が未完のため） ===
  // 本来は MODELS.scanPrecise (gemini-2.5-pro) を使いたい。表構造の視覚理解
  // 精度が大きく違うので、Google 側で paid tier 1+ が反映され次第戻すこと。
  // flash の FreeTier 上限: 5 RPM / 20 RPD なので連打注意。
  const model = MODELS.scan;
  const apiKey = import.meta.env.GEMINI_API_KEY;
  const geminiRequest = {
    systemInstruction: { parts: [{ text: ANALYZE_SYSTEM }] },
    contents: [{ role: 'user' as const, parts: userParts }],
    generationConfig: {
      temperature: 0.0,
      maxOutputTokens: 16384,
      responseMimeType: 'application/json',
      // flash は thinking を完全停止できる (pro と違って) 。OCR 用途では充分。
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  // NDJSON でストリーミング (chunked)。
  // クライアントは 1 行ずつ JSON.parse して進捗 / 最終結果を扱う。
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const emit = (obj: unknown): void => {
        controller.enqueue(enc.encode(JSON.stringify(obj) + '\n'));
      };
      let acc = '';
      let lastFinish: string | undefined;
      try {
        emit({ type: 'start', model });
        for await (const ev of streamGemini(apiKey, geminiRequest, model)) {
          if (ev.text) {
            acc += ev.text;
            emit({ type: 'chunk', text: ev.text, totalLen: acc.length });
          }
          if (ev.finishReason) lastFinish = ev.finishReason;
        }
        const cleaned = stripJsonCodeFence(acc);
        let parsed: unknown = null;
        try { parsed = JSON.parse(cleaned); } catch { /* noop */ }
        emit({ type: 'done', raw: acc, json: parsed, finishReason: lastFinish });
      } catch (err) {
        if (err instanceof GeminiError) {
          emit({ type: 'error', error: err.message, detail: err.body, status: err.status });
        } else {
          emit({ type: 'error', error: 'Unexpected error', detail: String(err) });
        }
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no', // バッファリング無効化（プロキシ側）
    },
  });
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
