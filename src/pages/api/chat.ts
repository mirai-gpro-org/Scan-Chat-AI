import type { APIRoute } from 'astro';
import {
  callGemini,
  extractText,
  GeminiError,
  MODELS,
  type GeminiContent,
} from '../../lib/gemini';

export const prerender = false;

interface ChatRequestBody {
  messages: Array<{ role: 'user' | 'assistant' | 'system'; text: string }>;
  /** スキャンで得られた所見・優先確認項目などの引継ぎコンテキスト */
  systemHint?: string;
  /** 現在のセクション ID（再開時にヒントとして渡す） */
  currentSection?: string;
}

/**
 * 提案書「機能3-①」で要求される構造化進捗のためのセクション定義。
 * AI 側にこのカタログを示し、回答ごとに section_id を確定させる。
 */
const SECTIONS = [
  { id: 'basic', title: '基本情報' },
  { id: 'diet', title: '食生活' },
  { id: 'exercise', title: '運動' },
  { id: 'sleep', title: '睡眠について' },
  { id: 'stimulants', title: '嗜好品（喫煙・飲酒）' },
  { id: 'stress', title: 'ストレス・メンタル' },
  { id: 'symptoms', title: '現在の症状' },
];

const SYSTEM_INSTRUCTION = `あなたは医療機関の問診補助 AI です。

【会話のルール】
- 日本語で簡潔・丁寧に対応してください。
- 診断や処方は行わず、症状の聞き取りと整理に専念してください。
- 危険兆候（胸痛・意識障害・激しい頭痛・呼吸困難・大量出血など）が疑われる場合は、ためらわず 119 への連絡や救急受診を促してください。
- 1 ターンで質問は 1 つまでに絞ってください。
- スキャン結果で priority_flags が指定されている場合は、それを優先的に確認してください。

【セクション】
以下のセクションを順に進めてください:
${SECTIONS.map((s, i) => `${i + 1}. ${s.title} (id: ${s.id})`).join('\n')}

【出力形式】
出力は以下の JSON スキーマに厳密に従ってください。JSON 以外の文字（コメント・code fence）は禁止です。
{
  "text": string,                  // ユーザーへの返答（質問は1つまで）
  "section": {
    "id": string,                  // 現在進行中のセクション id
    "title": string,               // セクション名
    "percent": number              // 全体進捗 0-100
  },
  "suggestions": string[],         // 直前の質問への回答候補チップ（最大4個、短文）
  "completed": boolean             // 全セクション完了したら true
}`;

export const POST: APIRoute = async ({ request }) => {
  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (!body?.messages?.length) {
    return json({ error: 'messages is required' }, 400);
  }

  const contents: GeminiContent[] = body.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.text }],
    }));

  const hintParts = [
    { text: SYSTEM_INSTRUCTION },
    ...(body.systemHint ? [{ text: `スキャン引継ぎ: ${body.systemHint}` }] : []),
    ...(body.currentSection
      ? [{ text: `直前のセクション id: ${body.currentSection}` }]
      : []),
  ];

  // 設計上は MODELS.liveChat (gemini-3.1-flash-live-preview) を使うが、
  // それは WebSocket 専用なので Live API エンドポイント実装までは REST 用の
  // MODELS.scan を流用する。
  try {
    const res = await callGemini(import.meta.env.GEMINI_API_KEY, {
      systemInstruction: { parts: hintParts },
      contents,
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 512,
        responseMimeType: 'application/json',
      },
    }, MODELS.scan);

    const raw = extractText(res);
    const parsed = safeParse(raw);
    // パース失敗時は最低限の fallback で返す
    const out =
      parsed && typeof parsed === 'object' && 'text' in parsed
        ? parsed
        : {
            text: raw || '（応答が空でした）',
            section: { id: body.currentSection ?? 'basic', title: '基本情報', percent: 0 },
            suggestions: [],
            completed: false,
          };
    return json(out);
  } catch (err) {
    return handleGeminiError(err);
  }
};

function safeParse(text: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

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
