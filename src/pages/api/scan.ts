import type { APIRoute } from 'astro';
import {
  streamGemini,
  MODELS,
  uploadGeminiFile,
  GeminiError,
  type GeminiContent,
} from '../../lib/gemini';

export const prerender = false;

/**
 * 検査表画像 → 構造化 Markdown (見出し + GFM テーブル + bbox HTML コメント)。
 * 下流の診断 AI も Markdown のまま消費する設計のため、JSON 強制を完全撤廃。
 * LLM のネイティブ生成形式に寄せたことで、JSON 構文オーバーヘッド分の
 * 生成時間・トークンが削減される。
 */
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

export const POST: APIRoute = async ({ request }) => {
  // multipart/form-data でバイナリ直送 (base64 は一切経由しない)
  let bytes: Uint8Array;
  let mime: string;
  let hint = '';
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
    hint = String(fd.get('hint') ?? '').trim();
  } catch (err) {
    return json({ error: 'Invalid form data', detail: String(err) }, 400);
  }

  const apiKey = import.meta.env.GEMINI_API_KEY;

  // ★ Response を**即座**に開いて Safari の "Load failed" を回避する。
  //   Files API upload や Gemini への接続は ReadableStream.start() の
  //   中に押し込み、ストリーム開始直後の {type:'start'} で Safari に
  //   「コネクションは生きてる」と早期に伝える。
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const emit = (obj: unknown): void => {
        controller.enqueue(enc.encode(JSON.stringify(obj) + '\n'));
      };
      let acc = '';
      let lastFinish: string | undefined;
      try {
        // 1. まず "start" を即送 (これで Safari の Load failed 回避)
        emit({ type: 'start', model: MODELS.scan });

        // 2. Files API アップロード (この間 1〜3 秒。Safari はストリーム開いて待つ)
        const file = await uploadGeminiFile(apiKey, bytes, mime, 'scan');
        emit({ type: 'uploaded' });

        // 3. Gemini に渡す request を組む
        const userParts: GeminiContent['parts'] = [
          { file_data: { mime_type: file.mimeType, file_uri: file.uri } },
          {
            text: hint
              ? `補足: ${hint}\nこの紙面を Markdown に書き起こしてください。`
              : 'この紙面を Markdown に書き起こしてください。',
          },
        ];
        const geminiRequest = {
          systemInstruction: { parts: [{ text: ANALYZE_SYSTEM }] },
          contents: [{ role: 'user' as const, parts: userParts }],
          generationConfig: {
            temperature: 0.0,
            maxOutputTokens: 32768,
            // Markdown を直生成させる用途。text/plain を明示することで
            // モデルが「フォーマット推測」で迷う時間を消す。
            responseMimeType: 'text/plain',
            thinkingConfig: { thinkingBudget: 0 },
          },
          // 医療検査表は DANGEROUS_CONTENT などに引っかかって SAFETY で
          // 空応答になることがある。本アプリは医療従事者向けの転記用途
          // (診断・処方は下流) なので最緩設定にする。
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
          ] as const,
        };

        // 4. Gemini ストリーミング: chunk を NDJSON で client に流す
        for await (const ev of streamGemini(apiKey, geminiRequest, MODELS.scan)) {
          if (ev.text) {
            acc += ev.text;
            emit({ type: 'chunk', text: ev.text, totalLen: acc.length });
          }
          if (ev.finishReason) lastFinish = ev.finishReason;
        }

        // 5. 完了
        emit({ type: 'done', markdown: acc, finishReason: lastFinish });
      } catch (err) {
        if (err instanceof GeminiError) {
          emit({
            type: 'error',
            error: err.message,
            detail: err.body,
            status: err.status,
          });
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
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

