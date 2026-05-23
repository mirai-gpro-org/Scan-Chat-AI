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

const ANALYZE_SYSTEM = `あなたは検査結果用紙の画像から、紙面に印字・記入されている内容を
全項目分そのまま構造化 JSON に転記します。解釈・診断・要約は行いません。

【あなたのミッション】
診断は、この JSON を受け取る別の AI が行います。あなたの仕事は「検査表を
正確に読み取ること」だけです。これは人命に関わる業務なので、次の原則を
絶対に守ってください:

1. **不明な点・確信が持てない値は、絶対に推論で埋めない**
   読めない・判別できない場合は value="" / confidence="low" として
   そのまま返してください。下流のシステムが「再スキャン」か「ユーザーの
   手入力」で補完します。

2. **推測で項目を生成しない**
   紙面に存在しない項目を「医療的に妥当そうだから」「補完しておこう」と
   いう理由で出力するのは禁止です（ハルシネーション禁止）。

3. **「不明は不明と返す」のが優秀な転記 AI**
   全項目を埋めようとして 1 つでも誤った値を入れる方が、空欄を残すより
   遥かに悪い結果になります。確信が持てないなら、confidence: "low" を
   躊躇なく使ってください。

【日本の検査表の典型レイアウト】
左から右へ:
  検査項目（略称）| 結果 | 検査項目詳細（フルネーム）| 下限値 | 上限値 | 単位名称
※ 用紙は左半分・右半分の 2 カラム構成のことが多い（同じレイアウトが 2 列並ぶ）。

【検査表独特の落とし穴 — ここを間違えないこと】
"value" には「結果」列の数値だけを入れる。
「下限値」「上限値」「単位」を value に混入させないこと。
紙面の H / L マーク（基準値超 / 下回）は "flag" に分ける。

【正しい解釈の例】
ある行が次のように印字されていたら:

  "23 Hgb 8.1 L ヘモグロビン量 13.7 16.8 g/dl"

正解は:
  {
    "no": "23",
    "label": "Hgb",
    "label_detail": "ヘモグロビン量",
    "value": "8.1",         ← 結果列
    "flag": "L",            ← 結果直後の H/L マーク
    "ref_low": "13.7",      ← 下限値
    "ref_high": "16.8",     ← 上限値
    "unit": "g/dl",
    "marked": false,
    "confidence": "high",
    "kind": "printed",
    "bbox": [...]
  }

誤り例:
  - value="16.8"（上限値を結果と取り違え）
  - value="13.7-16.8"（基準範囲を結果と取り違え）
  - value="8.1 g/dl"（単位を結果に混入）

【手書き・強調・読み取り不能】
- 手書きメモは kind="handwritten" として独立した item に分けて格納
- 赤丸・下線・蛍光ペン等で強調されている項目は marked: true
- 読み取り不能なら value="" / confidence="low"
- 紙面に存在しない値・項目は絶対に出力しない（ハルシネーション禁止）

【出力 JSON】
{
  "items": [
    {
      "no": string,              // 項目番号（無ければ ""）
      "label": string,           // 検査項目の略称
      "label_detail": string,    // 検査項目詳細（無ければ ""）
      "value": string,           // 結果列の値
      "unit": string,            // 単位（無ければ ""）
      "flag": string,            // "H" / "L" / ""
      "ref_low": string,         // 下限値（無ければ ""）
      "ref_high": string,        // 上限値（無ければ ""）
      "marked": boolean,         // 赤丸・下線・蛍光等の強調
      "bbox": [number, number, number, number],  // [ymin, xmin, ymax, xmax] 0-1000 正規化
      "confidence": "high" | "low",
      "kind": "printed" | "handwritten"
    }
  ]
}

JSON 以外（前置きの説明文、code fence、後置きの注釈）は一切出力しないこと。
表の全項目を漏らさず転記すること（行数を恐れない）。`;

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
            ? `補足: ${body.hint}\n紙面の全項目を、結果列・下限値・上限値を厳密に区別して JSON に転記してください。`
            : '紙面の全項目を、結果列・下限値・上限値を厳密に区別して JSON に転記してください。',
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
