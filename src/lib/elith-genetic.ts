/**
 * 遺伝子検査レポートの LLM 構造化 (サーバ専用)。
 *
 * 方針: **構造化の判断はすべて Gemini(LLM) に委ねる**。
 *   - プログラム側は正規表現/固定スキーマ/パターンマッチをしない (値を作らない・パースしない)。
 *   - 各ページ画像を Gemini に渡し「このページの各項目を構造化した JSON で返して」と依頼するだけ。
 *   - フィールド設計(キー名・粒度)・数値化・分類は LLM が判断する。
 *   - プログラムの責務は「複数ページ分の LLM 出力を集約して 1 つの JSON にし S3 へ置く」オーケストレーションのみ。
 *
 * 出力エンベロープだけは最小限固定 (集約のため): {"section": string|null, "items": [ ... ]}
 * items の各要素の構造は LLM 任せ。
 */

import { callGemini, MODELS, extractText, stripJsonCodeFence } from './gemini';
import { getGeminiApiKey, isSupportedMime } from './elith-export';

const GENETIC_SYSTEM =
  'あなたは遺伝子検査結果レポートを読み取り、項目ごとに構造化データへ変換する専門家です。書かれている情報だけを正確に構造化し、創作・推測はしません。';

const GENETIC_USER = `これは遺伝子検査結果レポートの1ページの画像です。
このページに含まれる各項目を、内容が正確に伝わるように構造化し、JSON で返してください。

出力仕様(最小限):
- 出力は必ず次の形の JSON オブジェクト1つ: {"section": <このページのセクション見出し文字列。無ければ null>, "items": [ <各項目のオブジェクト>, ... ]}
- **各項目オブジェクトのフィールド設計(キー名・粒度)はあなたが最適に判断**してください。そのページに実際にある情報(項目名・説明・リスク・判定・倍率など)を過不足なく構造化します。
- ページ全体を通して**同種の項目には同じキー名**を使い、一貫性を保ってください。
- 値の**創作・推測・補完はしない**。読み取れない/存在しない情報は含めない。
- グラフ/バー等の視覚要素は、数値ラベルがあればその数値を採用し、無ければ無理に数値化しない。
- **氏名・生年月日・住所などの個人情報は一切含めない**。
- 該当する項目が無いページ(表紙・説明ページ等)なら items は空配列 [] にする。
- JSON 以外の文章・注釈・コードフェンスは出力しない。`;

export interface GeneticPageResult {
  /** ページ見出し (LLM 判定)。無ければ null */
  section: string | null;
  /** 各項目 (構造は LLM 任せ) */
  items: unknown[];
  /** LLM 生出力 (監査用) */
  raw: string;
  finishReason: string | null;
  /** JSON として解釈できたか */
  parsed: boolean;
}

/** 1 ページを Gemini に渡し、構造化 JSON を得る (LLM 全面委任)。 */
export async function scanGeneticPage(input: {
  imageBase64: string;
  mimeType: string;
  hint?: string | null;
}): Promise<GeneticPageResult> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured (server env)');
  if (!isSupportedMime(input.mimeType)) throw new Error(`unsupported mime: ${input.mimeType}`);

  const res = await callGemini(
    apiKey,
    {
      systemInstruction: { parts: [{ text: GENETIC_SYSTEM }] },
      contents: [
        {
          role: 'user',
          parts: [
            { inline_data: { mime_type: input.mimeType, data: input.imageBase64 } },
            { text: GENETIC_USER + (input.hint ? `\n\n補足: ${input.hint}` : '') },
          ],
        },
      ],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    },
    MODELS.scan,
  );

  const raw = extractText(res);
  const finishReason = res.candidates?.[0]?.finishReason ?? null;
  let section: string | null = null;
  let items: unknown[] = [];
  let parsed = false;
  try {
    const obj = JSON.parse(stripJsonCodeFence(raw)) as unknown;
    parsed = true;
    if (Array.isArray(obj)) {
      items = obj;
    } else if (obj && typeof obj === 'object') {
      const o = obj as Record<string, unknown>;
      if (Array.isArray(o.items)) items = o.items as unknown[];
      const s = o.section;
      section = typeof s === 'string' && s.trim() ? s.trim() : null;
    }
  } catch {
    parsed = false; // raw は返す (呼び出し側で監査)
  }
  return { section, items, raw, finishReason, parsed };
}
