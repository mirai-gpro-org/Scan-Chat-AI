// src/lib/elith-verify.ts
// Elith「画像↔JSON 照合器」(検証機能の本体)。
//
// 目的 (docs/elith_check_phase_spec.md の最終ゴール):
//   元画像を「正解(ground truth)」、生成JSONを「検証対象」として、
//   ネイティブマルチモーダルで項目単位に突き合わせ、
//   missing(取りこぼし)/misread(誤読)/extra(捏造)/duplicate(重複) と一致率を返す。
//   → この差分を根拠に「プロンプト」と「後段プログラム」を反復改善する。
//
// checkNecessity(構造リント) と役割が違う:
//   - checkNecessity : JSON 単体の構造チェック(余剰キー/空/重複)。画像は見ない。安価な前段。
//   - verifyScanAgainstImages(本ファイル): 画像と突き合わせる本採点。missing/misread を検出できる。
//
// キー(GEMINI_API_KEY)はサーバ環境変数のみ。必ずサーバ(API/admin)から呼ぶ (CLAUDE.md)。

import { callGemini, MODELS, extractText, stripJsonCodeFence } from './gemini';
import { getGeminiApiKey, isSupportedMime } from './elith-export';

/** 1 件の食い違い。種別ごとに意味が違うので任意フィールドで表現する。 */
export interface VerifyDiscrepancy {
  /** 検査項目名 (画像/JSON いずれかで判明している名称)。 */
  name: string | null;
  /** JSON 側の値 (misread/extra/duplicate で使用)。 */
  json_value?: string | null;
  /** 画像「今回」列の値 (missing/misread で使用)。 */
  image_value?: string | null;
  /** 食い違ったフィールド (value/unit/ref_low/ref_high/flag)。misread で使用。 */
  field?: string | null;
  /** 補足 (根拠・疑い列ズレ 等)。 */
  note?: string | null;
}

export interface VerifyReport {
  /** 一致率 (0-100)。画像で実施済み(値あり)の項目のうち、JSON が正しく取れた割合。 */
  match_rate: number | null;
  /** 画像側で「今回」列に値がある(=実施済み)項目の概算数。 */
  items_image: number | null;
  /** JSON の measurements 件数。 */
  items_json: number;
  counts: { missing: number; misread: number; extra: number; duplicate: number };
  /** 画像に値があるのに JSON に無い/空 (取りこぼし)。 */
  missing: VerifyDiscrepancy[];
  /** JSON にあるが 値/単位/基準値/判定 が画像と食い違う (誤読)。 */
  misread: VerifyDiscrepancy[];
  /** JSON にあるが画像に該当が無い (捏造)。 */
  extra: VerifyDiscrepancy[];
  /** 同一項目の二重計上 (重複)。 */
  duplicate: VerifyDiscrepancy[];
  /** 採点の総評 (人間向け 1-2 文)。 */
  summary: string;
  model: string;
  finish_reason: string | null;
}

/** 採点対象を軽量な表に落とす (画像と突き合わせやすい形。監査フィールドは載せない)。 */
export function renderMeasurementsForGrader(json: unknown): { text: string; count: number } {
  const obj = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const data = (obj.data && typeof obj.data === 'object' ? obj.data : {}) as Record<string, unknown>;
  const ms: Record<string, unknown>[] = Array.isArray(data.measurements)
    ? (data.measurements as Record<string, unknown>[]).filter((m) => m && typeof m === 'object')
    : [];
  const lines = ms.map((m, i) => {
    const name = typeof m.name === 'string' ? m.name : '';
    const value = m.value == null ? '' : String(m.value);
    const unit = typeof m.unit === 'string' ? m.unit : '';
    const lo = m.ref_low == null ? '' : String(m.ref_low);
    const hi = m.ref_high == null ? '' : String(m.ref_high);
    const flag = m.flag == null ? '' : String(m.flag);
    return `${i + 1}\t${name}\t${value}\t${unit}\t${lo}~${hi}\t${flag}`;
  });
  const header = 'idx\tname\tvalue\tunit\tref_low~ref_high\tflag';
  return { text: [header, ...lines].join('\n'), count: ms.length };
}

const VERIFY_SYSTEM = `あなたは健診・人間ドックの結果表を採点する検査官です。
渡された「画像」が唯一の正解(ground truth)で、「抽出JSON」はその画像から機械抽出した検証対象です。
画像とJSONを項目単位で突き合わせ、抽出の誤り(取りこぼし/誤読/捏造/重複)だけを厳密に指摘してください。
医学的な良し悪しや助言は一切しません。抽出の正確性のみを判定します。`;

function buildVerifyUserText(measurementTable: string, formatId?: string | null): string {
  return `# 対象
format_id: ${formatId || 'HealthCheckupData'}

# 抽出JSONの measurements (検証対象)
下表は抽出JSON中の data.measurements を1行1項目で表したもの(タブ区切り)。
列: idx / name / value(今回の読取値) / unit(単位) / ref_low~ref_high(参考基準値) / flag(判定 H/L/-)。
--------
${measurementTable}
--------

# 判定ルール (厳守)
- **画像の「今回」列の値のみ**を正解として比較する。**前回・前々回(受診日付きの過去列)・参考基準値の列は
  値として絶対に採用しない**。検査票は「今回 / 前回(例 2023/4/22) / 前々回(例 2020/8/3) / 単位」の順で
  数値が横に並ぶ。右側の過去列や基準値列の数値を「画像の値」として拾ってはならない。
- 画像に「※実施していない検査は空白で表示されます」等の注記がある通り、**空白=未実施**。
  画像で空白の項目が JSON に無いのは正しい(取りこぼしではない)。
- **missing(取りこぼし)**: 画像の**「今回」列に値がある**のに JSON に無い/空 の項目**のみ**。
  ⚠**「今回」列が空欄の項目は、前回・前々回列に値があっても missing にしない**(今回未実施のため JSON に
  無いのが正しい)。missing 候補として挙げる前に、その値が「今回」列のものか必ず確認する。
  **その値が前回・前々回・参考基準値と一致する場合は列の取り違えなので missing にしない。**
- **misread(誤読)**: JSON に項目はあるが、value / unit / ref_low / ref_high / flag のいずれかが
  画像の該当セルと食い違う。数値の桁・小数点・単位取り違え・列ズレ(隣の項目の値が入っている)を特に疑う。
  食い違ったフィールド名を field に入れ、image_value に画像の正しい値、json_value に JSON の値を入れる。
- **extra(捏造)**: JSON にあるが、画像に対応する検査項目が見当たらない。
- **duplicate(重複)**: 同一項目が JSON に2回以上、または隣接行が同名/同値で二重計上。
- 判定に迷う軽微な表記ゆれ(全角半角・記号)は指摘しない。実害のある食い違いだけ挙げる。

# 出力 (JSONのみ。前後に文章やコードフェンスを付けない)
{
  "items_image": <画像の「今回」列に値がある項目の概算数(整数)>,
  "match_rate": <0-100の整数。実施済み項目のうち JSON が正しく取れた割合>,
  "missing":   [{"name": "...", "image_value": "...", "note": "..."}],
  "misread":   [{"name": "...", "field": "value|unit|ref_low|ref_high|flag", "image_value": "...", "json_value": "...", "note": "..."}],
  "extra":     [{"name": "...", "json_value": "...", "note": "..."}],
  "duplicate": [{"name": "...", "note": "..."}],
  "summary": "<1-2文の総評(日本語)>"
}`;
}

function asArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : [];
}
function toDisc(o: Record<string, unknown>): VerifyDiscrepancy {
  const s = (k: string): string | null => (typeof o[k] === 'string' && (o[k] as string).trim() ? (o[k] as string).trim() : null);
  return { name: s('name'), json_value: s('json_value'), image_value: s('image_value'), field: s('field'), note: s('note') };
}

/**
 * 画像(複数可)と生成JSONを突き合わせて採点する。
 * 検診は「複数シート=1検査」なので、その検査を構成する全画像をまとめて渡す。
 */
export async function verifyScanAgainstImages(input: {
  images: { data: string; mime: string }[];
  json: unknown;
  formatId?: string | null;
  hint?: string | null;
}): Promise<VerifyReport> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured (server env)');
  const images = input.images.filter((im) => im && im.data && isSupportedMime(im.mime));
  if (images.length === 0) throw new Error('no supported image provided');

  const { text: table, count } = renderMeasurementsForGrader(input.json);

  const parts = [
    ...images.map((im) => ({ inline_data: { mime_type: im.mime, data: im.data } })),
    { text: buildVerifyUserText(table, input.formatId) + (input.hint ? `\n\n# 補足\n${input.hint}` : '') },
  ];

  const res = await callGemini(
    apiKey,
    {
      systemInstruction: { parts: [{ text: VERIFY_SYSTEM }] },
      contents: [{ role: 'user', parts }],
      // 採点は判断を要するので thinking はやや厚め。温度は既定(3.xでは自動除去)。
      generationConfig: { responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 4096 } },
    },
    MODELS.scan,
  );

  const finishReason = res.candidates?.[0]?.finishReason ?? null;
  const raw = stripJsonCodeFence(extractText(res));
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`grader returned non-JSON (finishReason=${finishReason}): ${raw.slice(0, 200)}`);
  }

  const missing = asArray(parsed.missing).map(toDisc);
  const misread = asArray(parsed.misread).map(toDisc);
  const extra = asArray(parsed.extra).map(toDisc);
  const duplicate = asArray(parsed.duplicate).map(toDisc);
  const items_image = typeof parsed.items_image === 'number' && Number.isFinite(parsed.items_image)
    ? Math.round(parsed.items_image)
    : null;
  let match_rate = typeof parsed.match_rate === 'number' && Number.isFinite(parsed.match_rate)
    ? Math.max(0, Math.min(100, Math.round(parsed.match_rate)))
    : null;
  // フォールバック: モデルが match_rate を返さない時は missing+misread から概算。
  if (match_rate == null && items_image != null && items_image > 0) {
    match_rate = Math.max(0, Math.min(100, Math.round((1 - (missing.length + misread.length) / items_image) * 100)));
  }

  return {
    match_rate,
    items_image,
    items_json: count,
    counts: { missing: missing.length, misread: misread.length, extra: extra.length, duplicate: duplicate.length },
    missing,
    misread,
    extra,
    duplicate,
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    model: MODELS.scan,
    finish_reason: finishReason,
  };
}
