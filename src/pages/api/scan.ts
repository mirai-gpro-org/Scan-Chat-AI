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
書き起こしてください。診断・解釈・要約・分類整理は一切しません
（下流の別 AI が担当）。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【最優先ルール (違反は医療判断を狂わせる致命的失敗)】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

■ ルール 1: 視覚情報至上主義 (ハルシネーション絶対禁止)
  - 画像に映っていない検査項目を、絶対に出力に追加してはならない。
  - 知識ベース・一般的健診テンプレート・常識からの補完を厳禁。
    例) 紙面に HbA1c / 血糖 / LDL / HDL / Ca / P / Fe / CK / CK-MB / BNP /
        NT-proBNP / D-ダイマー が無いのに「健診ならあるはず」で
        勝手に追加することは絶対にしない。
  - 行が読めない場合は推測で埋めず、その行は次のように構造だけ保つ:
    \`| (?) | (読取不能) | (?) | (?) | (?) | (?) |\`
  - 数値の一部だけ読めるなら、読めた部分を書き、不明部分のみ \`(?)\`。

■ ルール 2: 異常値マーカは絶対に消さない
  - 結果値の隣に印字された \`H\` \`L\` \`*\` 等の異常値記号は、
    値とセットで原文通り保持する (例: \`8.1 L\`, \`1.22 H\`)。
  - 赤字・ピンクマーカ・丸囲み・下線などの視覚的強調は、
    行末に \`[強調]\` と注記して保持する。
  - 数値が不鮮明でもマーカが見えるなら、\`(?) H\` のように
    マーカを必ず残す (マーカ消失は出力不正と判定される)。
  - 「正常値に見えるからマーカは不要」と勝手に判断しない。

■ ルール 3: 系統分類カテゴリの自動生成禁止
  - 「肝機能」「腎機能」「心臓マーカー」「腫瘍マーカー」「電解質」
    「脂質異常」「炎症反応」「貧血」のような医学カテゴリ分類を、
    紙面にそう書かれていない限り **絶対に作らない**。
  - 領域分割の根拠は、紙面の物理レイアウト (左/右カラム、上/下、
    印字 vs 手書き) のみ。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【表 (印字) と 手書きメモ の分離処理】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

A) 印字された表 (定型データ):
   - 紙面の列見出し (No / 検査項目 / 結果 / 検査項目詳細 / 下限値 /
     上限値 / 単位名称 など) をそのまま列名として GFM テーブルで再現。
   - 「下限値」「上限値」が別カラムで分かれている紙面は、出力でも
     2 列に分ける (\`10-30\` 等にまとめない)。
   - 紙面の No 列が連番なら、その番号を必ず保持。
   - 全行転記する。20 行で打ち切らない。

B) 手書きメモ (非定型情報):
   - 赤字・手書き・余白の矢印・記号などを、書かれているそのまま箇条書きに。
   - 「次回 8/4」「改善」「減少」「-933」等の動的な所見・予定文言を
     最優先で拾う (これらは臨床的に重要)。
   - 系統分類リストは生成しない。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【領域分割と座標】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- 領域は最大 4 つまで。極端に細かく分けない。
- 各領域は H2 見出しで始め、直後の行に bbox を HTML コメントで埋める。
- bbox は **0.0〜1.0 の小数** で **[ymin, xmin, ymax, xmax]** の順。
- 表が無い領域は段落 / 箇条書きで書く。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【出力例】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 左側検査表
<!-- bbox: 0.05,0.05,0.95,0.65 -->

| No | 検査項目 | 結果 | 検査項目詳細 | 下限値 | 上限値 | 単位 |
|----|----------|------|--------------|--------|--------|------|
| 1  | AST      | 18   | AST(GOT)     | 13     | 30     | U/L  |
| 19 | ALB定量  | 3.34 L | アルブミン定量 | 4.10 | 5.10 | g/dl |
| 23 | Hgb      | 8.1 L | ヘモグロビン量 | 13.7 | 16.8 | g/dl |
| 28 | 旧 PLT   | 8.3 L [強調] | 旧 血小板数 | 15.8 | 34.8 | x10^4/ul |

## 右側手書きメモ
<!-- bbox: 0.50,0.20,0.95,0.85 -->

- 古富先生
- CA19-9 (腫瘍マーカー) 前回 4981 → 今回 4048 = -933 改善
- ヘモグロビン 0.7 (-)
- 白血球 改善
- 旧血小板数 前 13.0 / 今回 8.3 = (-4.6)
- アルブミン 3.34 と減少
- 次回 8/4 (金) は代診 ◯◯ 先生が担当

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【出力フォーマット】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- 出力は **純粋な Markdown だけ**。前置きの説明文や code fence (\`\`\`) で
  全体を囲まない (GFM テーブル内の \`code\` は OK)。
- 領域見出しの bbox HTML コメントは省略しない。`;

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
