/**
 * 遺伝子検査レポートの LLM 構造化 (サーバ専用)。
 *
 * 方針 (案A-lite・2026-08 更新): 構造化は基本 Gemini(LLM) に委ねるが、**照合(🎯)を成立させるため
 * 最小3フィールドだけプロンプトで固定**する (プログラム側は依然 正規表現/パースをしない)。
 *   - 固定キー(印字があれば必須): `項目名` / `発症リスク倍率`(「X倍」文字列) / `発症率`(％or定性)。
 *   - それ以外(説明文・判定など)は従来どおり LLM が自由にキー設計してよい。
 *   - 背景: 案B(完全自由スキーマ)では LLM が一般疾患セクションで「倍率」を run 毎に落とし、
 *     🎯倍率照合が 30〜60% に低迷 (実測 2026-08)。倍率は捏造ゼロ前提で「印字があれば必ず拾う」よう固定。
 *   - プログラムの責務は「複数ページ分の LLM 出力を集約して 1 つの JSON にし S3 へ置く」オーケストレーションのみ。
 *
 * 出力エンベロープは固定 (集約のため): {"section": string|null, "items": [ ... ]}
 * items の各要素は上記3固定キー + LLM 自由キー。
 */

import { callGemini, MODELS, extractText, stripJsonCodeFence } from './gemini';
import { getGeminiApiKey, isSupportedMime } from './elith-export';

const GENETIC_SYSTEM =
  'あなたは遺伝子検査結果レポートを読み取り、項目ごとに構造化データへ変換する専門家です。書かれている情報だけを正確に構造化し、創作・推測はしません。';

const GENETIC_USER = `これは遺伝子検査結果レポートの1ページの画像です。
このページに含まれる各項目を、内容が正確に伝わるように構造化し、JSON で返してください。

出力仕様:
- 出力は必ず次の形の JSON オブジェクト1つ: {"section": <このページのセクション見出し文字列。無ければ null>, "items": [ <各項目のオブジェクト>, ... ]}
- **各項目オブジェクトには、印字されていれば必ず次の3フィールドを含めてください**(それ以外の情報＝説明文・判定など は任意のキーで自由に追加してよい):
  1. \`項目名\`: 「分析項目名」の文字列 (例「乳がん」「潰瘍性大腸炎」「統合失調症」)。
  2. \`発症リスク倍率\`: 「平均と比べたあなたの発症リスク」の倍率。**印字されていれば必ず「X倍」の文字列**にする (例「1.54倍」「0.99倍」「5倍」)。
     - **重要**: 一般疾患・がん等ほぼ全項目に「◯◯倍」が印字されています。**この倍率を絶対に落とさないでください**。
     - 「倍率無し」等で数値が印字されていない項目のみ、このフィールドを省略する (創作しない)。
  3. \`発症率\`: 「あなたの予想発症率」。**％表記 (例「40.6%」) または定性 (例「少し高い」「少し低い」「高い」「低い」)** を印字どおり。
- 体質系など倍率が印字されない項目は \`発症リスク倍率\` を省略し、\`発症率\`(傾向)のみ入れる (創作しない)。
- ページ全体を通して**同種の項目には同じキー名**を使い、一貫性を保ってください。
- 値の**創作・推測・補完はしない**。読み取れない/存在しない情報は含めない。**印字されている倍率だけは必ず拾う**。
- グラフ/バー等の視覚要素は、数値ラベルがあればその数値を採用し、無ければ無理に数値化しない。
- **氏名・生年月日・住所などの個人情報は一切含めない**。
- セクション見出し行 (例「がん > 女性」「一般疾患 > 代謝疾患」) は項目ではないので items に入れない。
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

// ── LAiF「AI 疾病発症予測」レポート (format_id=Other / kind=ai_prediction) ──
// 遺伝子と同じく多ページの画像レポートで、構造は LLM 全面委任 (専用 format 無し=自由構造)。
const AI_PREDICTION_SYSTEM =
  'あなたは「AI 疾病発症予測」検査結果レポートを読み取り、項目ごとに構造化データへ変換する専門家です。書かれている情報だけを正確に構造化し、創作・推測はしません。';
const AI_PREDICTION_USER = `これは LAiF社「AI 疾病発症予測」検査結果レポートの1ページの画像です。
このページに含まれる各疾患の予測項目を、内容が正確に伝わるように構造化し、JSON で返してください。

このレポートの構成:
- 発症予測ページ … 疾患ごとに「5年発症率(%)」「10年発症率(%)」「相対リスク比」「昨年の相対リスク比」が並ぶ。
  疾患は「生活習慣病 / 循環器疾患 / 悪性腫瘍 / 神経疾患」等のカテゴリに分かれる。
- リスク因子・予防策ページ … 疾患ごとに「AIのアドバイス(予防策の文章)」が並ぶ。
- 表紙・説明ページ … 予測項目は無い。

出力仕様:
- 出力は必ず次の形の JSON オブジェクト1つ: {"section": <このページのカテゴリ見出し。無ければ null>, "items": [ <各疾患のオブジェクト>, ... ]}
- **各項目オブジェクトには、印字されていれば必ず次のフィールドを含めてください**(他の情報は任意キーで自由に追加してよい):
  1. \`項目名\`: 疾患名の文字列 (例「糖尿病」「脳梗塞」「肺がん」)。
  2. 発症予測ページなら \`5年発症率\`・\`10年発症率\`(いずれも「X%」文字列)・\`相対リスク比\`(数値)・\`昨年の相対リスク比\`(数値, 印字があれば)。
  3. リスク因子・予防策ページなら \`アドバイス\`(予防策の文章そのまま)。
- **数値・文章は印字どおりに写す。創作・推測・補完はしない**。印字が無い項目は省略する。
- **氏名・生年月日・住所などの個人情報(「様」の付く氏名等)は一切含めない**。
- カテゴリ見出し(「生活習慣病」等)や凡例は項目ではないので items に入れない。
- 予測項目が無いページ(表紙・説明ページ)なら items は空配列 [] にする。
- JSON 以外の文章・注釈・コードフェンスは出力しない。`;

/** 1 ページを Gemini で構造化 (LLM 全面委任・system/user 差替でレポート種別に対応)。 */
async function scanReportPage(
  input: { imageBase64: string; mimeType: string; hint?: string | null },
  systemText: string,
  userText: string,
): Promise<GeneticPageResult> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured (server env)');
  if (!isSupportedMime(input.mimeType)) throw new Error(`unsupported mime: ${input.mimeType}`);

  const res = await callGemini(
    apiKey,
    {
      systemInstruction: { parts: [{ text: systemText }] },
      contents: [
        {
          role: 'user',
          parts: [
            { inline_data: { mime_type: input.mimeType, data: input.imageBase64 } },
            { text: userText + (input.hint ? `\n\n補足: ${input.hint}` : '') },
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

/** 遺伝子検査 1 ページを構造化 (項目名/発症リスク倍率/発症率 を固定・案A-lite)。 */
export function scanGeneticPage(input: { imageBase64: string; mimeType: string; hint?: string | null }): Promise<GeneticPageResult> {
  return scanReportPage(input, GENETIC_SYSTEM, GENETIC_USER);
}
/** LAiF「AI 疾病発症予測」1 ページを構造化 (項目名/発症予測 を固定・自由構造)。 */
export function scanAiPredictionPage(input: { imageBase64: string; mimeType: string; hint?: string | null }): Promise<GeneticPageResult> {
  return scanReportPage(input, AI_PREDICTION_SYSTEM, AI_PREDICTION_USER);
}
