import type { APIRoute } from 'astro';
import {
  callGemini,
  streamGemini,
  MODELS,
  extractText,
  stripJsonCodeFence,
  uploadGeminiFile,
  GeminiError,
  type GeminiContent,
} from '../../lib/gemini';

export const prerender = false;

type ScanMode = 'detect' | 'analyze';

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
- 座標値（bbox）は出力しない。位置情報は不要、内容の転記に集中する。

【領域分け】
紙面を 2〜4 個の領域に分けて返す。表 1 つ / 手書きメモ等が 1 領域。
領域内の表構造（列の意味、項目並び）はあなたが画像を見て判断する。

【出力 JSON】
{
  "regions": [
    {
      "id": "left_table",                          // 英数字 ID
      "label": "左側検査値表",                      // 短い日本語ラベル
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
          kind: { type: 'string', enum: ['table', 'notes'] },
          cols: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
          uncertain_rows: { type: 'array', items: { type: 'number' } },
          text: { type: 'string' },
        },
        required: ['id', 'label', 'kind'],
      },
    },
  },
  required: ['regions'],
};

export const POST: APIRoute = async ({ request }) => {
  // クライアントは multipart/form-data でバイナリ直送。base64 inline は廃止。
  let bytes: Uint8Array;
  let mime: string;
  let hint = '';
  let mode: ScanMode = 'analyze';
  try {
    const ct = request.headers.get('content-type') ?? '';
    if (!ct.startsWith('multipart/form-data')) {
      return json({ error: 'expected multipart/form-data with binary image' }, 415);
    }
    const fd = await request.formData();
    const file = fd.get('image');
    if (!(file instanceof Blob)) {
      return json({ error: 'image field missing or not binary' }, 400);
    }
    bytes = new Uint8Array(await file.arrayBuffer());
    mime = file.type || 'image/jpeg';
    const rawMode = String(fd.get('mode') ?? 'analyze');
    mode = rawMode === 'detect' ? 'detect' : 'analyze';
    hint = String(fd.get('hint') ?? '').trim();
  } catch (err) {
    return json({ error: 'Invalid form data', detail: String(err) }, 400);
  }

  const apiKey = import.meta.env.GEMINI_API_KEY;

  try {
    // === 画像転送: Files API ===
    // バイナリ直送（base64 一切不使用）→ Files API resumable upload → fileUri 参照
    const file = await uploadGeminiFile(apiKey, bytes, mime, 'scan');

    const userParts: GeminiContent['parts'] = [
      { file_data: { mime_type: file.mimeType, file_uri: file.uri } },
      {
        text:
          mode === 'detect'
            ? '画像から項目を検知してください。'
            : hint
              ? `補足: ${hint}\nこの紙面を読み取って JSON に転記してください。`
              : 'この紙面を読み取って JSON に転記してください。',
      },
    ];

    const geminiRequest = {
      systemInstruction: {
        parts: [{ text: mode === 'detect' ? DETECT_SYSTEM : ANALYZE_SYSTEM }],
      },
      contents: [{ role: 'user' as const, parts: userParts }],
      generationConfig: {
        temperature: mode === 'detect' ? 0.1 : 0.2,
        maxOutputTokens: mode === 'detect' ? 2048 : 32768,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 },
        ...(mode === 'detect' ? {} : { responseSchema: ANALYZE_RESPONSE_SCHEMA }),
      },
    };

    // detect は一発返し
    if (mode === 'detect') {
      const res = await callGemini(apiKey, geminiRequest, MODELS.scan);
      const raw = extractText(res);
      const cleaned = stripJsonCodeFence(raw);
      let parsed: unknown = null;
      try { parsed = JSON.parse(cleaned); } catch { /* noop */ }
      const finishReason = res.candidates?.[0]?.finishReason;
      return json({ mode, raw, json: parsed, finishReason });
    }

    // analyze は NDJSON でストリーミング:
    //   {"type":"start"}
    //   {"type":"chunk","text":"...","totalLen":N}
    //   {"type":"done","raw":"...","json":{...},"finishReason":"STOP"}
    // → クライアントは進捗 UI で「何文字目」を表示できる。
    //   Vercel の単一レスポンスバッファリング詰まり (Gemini 推奨書の主因) も回避。
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        const emit = (obj: unknown): void => {
          controller.enqueue(enc.encode(JSON.stringify(obj) + '\n'));
        };
        let acc = '';
        let lastFinish: string | undefined;
        try {
          emit({ type: 'start', model: MODELS.scan });
          for await (const ev of streamGemini(apiKey, geminiRequest, MODELS.scan)) {
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
        'x-accel-buffering': 'no',
      },
    });
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
