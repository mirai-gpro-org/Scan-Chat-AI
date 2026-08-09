// src/lib/elith-verify.ts
// Elith「画像↔JSON 照合器」(検証機能の本体)。
//
// 目的 (docs/elith/elith_check_phase_spec.md の最終ゴール):
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
import { getGeminiApiKey, isSupportedMime, sanitizeMeasurementsForDelivery } from './elith-export';

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
  /** 画像上の bbox [ymin,xmin,ymax,xmax](0-1000正規化)。missing/misread の根拠付け=グラウンディング用。
   *  ※位置決め(クロップ座標)には使わない。捏造・見落とし抑止のための「指し示せるか」の証跡。 */
  image_bbox?: string | null;
  /** 読んだ値の真上の列見出し (今回 / 前回 日付 / 前々回 日付 / 基準値)。過去列・基準列の誤指摘を決定論で除外する。 */
  column_header?: string | null;
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
  // 照合は「納品後(sanitize後)」の measurements で行う。生のマーカ(↑↓)・空行・総合判定(A/B/C)は
  // 納品時に除去されるため、それらを含む生データで採点すると誤読/重複の過検出になる。
  const ms: Record<string, unknown>[] = sanitizeMeasurementsForDelivery(
    Array.isArray(data.measurements) ? data.measurements : [],
  ).kept;
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
- **疎ページ(今回列がほぼ空欄)での見落とし厳禁**: 今回列の大半が空のページでも、**今回セルに印字がある項目は
  必ず拾う**。「このページは今回列に値が無い」と早合点して、印字のある今回値(例: 尿酸)を missing から漏らさない。
- **行(row)で辿る**: 各項目は「項目名 → 同じ行の"今回"セル」を横一列に辿って確認する。列位置の当て推量で
  値を拾わない。今回セルに何が印字されているかを行単位で1つずつ確かめる(今回/前回/前々回の関係を保持したまま見る)。
- **グラウンディング(捏造・見落とし両抑止)**: missing/misread として値を主張するときは、その値が画像の
  **どこにあるか image_bbox [ymin,xmin,ymax,xmax](0-1000正規化)を必ず示す**。指し示せない値は主張しない。
- **列見出しの申告 (最重要・列取り違え防止)**: missing/misread で値を挙げる時は、その値の**真上にある列見出し**を
  column_header に必ず書く(例: "今回" / "前回 2023/4/22" / "前々回 2020/8/3" / "基準値")。
  **column_header が "今回" 以外(日付付きの過去列・基準値/参考値列)の値は絶対に挙げない**。迷ったら挙げない。
- **範囲/不等号は基準値**: "2.1〜7.0" "20未満" "80以上" "0.300未満" 等の範囲・不等号表記は**基準値**であって
  今回値ではない。これらを今回値として missing/misread に挙げない。
- **別項目を重複/捏造としない**: 尿潜血(尿定性)と免疫便潜血(検便)、尿蛋白(尿定性)と総蛋白(血液)は**別の検査**。
  名前が似ていても duplicate/extra にしない。
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
  "missing":   [{"name": "...", "image_value": "...", "column_header": "今回|前回 …|前々回 …|基準値", "image_bbox": [ymin,xmin,ymax,xmax], "note": "..."}],
  "misread":   [{"name": "...", "field": "value|unit|ref_low|ref_high|flag", "image_value": "...", "column_header": "今回|前回 …|前々回 …|基準値", "image_bbox": [ymin,xmin,ymax,xmax], "json_value": "...", "note": "..."}],
  "extra":     [{"name": "...", "json_value": "...", "note": "..."}],
  "duplicate": [{"name": "...", "note": "..."}],
  "summary": "<1-2文の総評(日本語)>"
}`;
}

// ── LAiF「AI疾病発症予測」(format_id=Other / data.items[]) の照合 ──
// 健診の measurements と違い、疾患ごとの {項目名, 5年発症率, 10年発症率, 相対リスク比, 昨年の相対リスク比, アドバイス}。
// 元PDF画像を正解に、items の疾患名・発症率%・相対リスク比が印字どおりかを採点する。

/** data.items[] を採点用の軽量表に落とす。 */
export function renderItemsForGrader(json: unknown): { text: string; count: number } {
  const obj = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const data = (obj.data && typeof obj.data === 'object' ? obj.data : {}) as Record<string, unknown>;
  const items: Record<string, unknown>[] = Array.isArray(data.items)
    ? (data.items.filter((x) => x && typeof x === 'object') as Record<string, unknown>[])
    : [];
  const cell = (v: unknown): string => (v == null ? '' : String(v));
  const lines = items.map((it, i) => {
    const name = cell(it['項目名']);
    const y5 = cell(it['5年発症率']);
    const y10 = cell(it['10年発症率']);
    const rr = cell(it['相対リスク比']);
    const sec = cell(it['section']);
    const hasAdvice = typeof it['アドバイス'] === 'string' && (it['アドバイス'] as string).trim() ? 'あり' : '';
    return `${i + 1}\t${name}\t${y5}\t${y10}\t${rr}\t${sec}\t${hasAdvice}`;
  });
  const header = 'idx\t項目名\t5年発症率\t10年発症率\t相対リスク比\tsection\tアドバイス';
  return { text: [header, ...lines].join('\n'), count: items.length };
}

const AI_PREDICTION_VERIFY_SYSTEM = `あなたは「AI疾病発症予測」検査結果レポート(LAiF)を採点する検査官です。
渡された「画像(PDF各ページ)」が唯一の正解(ground truth)で、「抽出JSON(items)」はその画像から機械抽出した検証対象です。
画像とJSONを疾患項目単位で突き合わせ、抽出の誤り(取りこぼし/誤読/捏造/重複)だけを厳密に指摘してください。
医学的な良し悪しや助言はしません。抽出の正確性のみを判定します。`;

function buildItemsVerifyUserText(itemsTable: string): string {
  return `# 対象
format_id: Other (kind: ai_prediction / LAiF「AI疾病発症予測」)

# 抽出JSONの items (検証対象)
下表は抽出JSON中の data.items を1行1疾患で表したもの(タブ区切り)。
列: idx / 項目名(疾患名) / 5年発症率 / 10年発症率 / 相対リスク比 / section(カテゴリ) / アドバイス(有無)。
--------
${itemsTable}
--------

# 判定ルール (厳守)
- **画像に印字された疾患ごとの数値のみ**を正解とする。5年発症率・10年発症率は「X%」表記、相対リスク比は倍率の数値。
- **missing(取りこぼし)**: 画像の発症予測ページに疾患項目(発症率/相対リスク比)が印字されているのに JSON に無い項目。
- **misread(誤読)**: JSON に項目はあるが、5年発症率 / 10年発症率 / 相対リスク比 / 項目名(疾患名) のいずれかが画像と食い違う。
  食い違ったフィールド名を field に、image_value に画像の正しい値、json_value に JSON の値を入れる。
- **extra(捏造)**: JSON にあるが画像に対応する疾患項目が見当たらない(カテゴリ見出し・凡例を項目化した等)。
- **duplicate(重複)**: 同一疾患が2回以上計上(※発症予測ページとアドバイスページで同名が別itemになるのは重複ではない=別情報)。
- カテゴリ見出し(生活習慣病/循環器疾患/悪性腫瘍/神経疾患 等)・凡例・氏名等PII は項目ではない。
- グラウンディング: missing/misread は画像上の位置 image_bbox [ymin,xmin,ymax,xmax](0-1000正規化)を可能なら示す。
- 軽微な表記ゆれ(全角半角・「倍」有無・%の小数桁)は指摘しない。実害のある食い違いだけ挙げる。

# 出力 (JSONのみ。前後に文章やコードフェンスを付けない)
{
  "items_image": <画像に発症予測が印字された疾患の概算数(整数)>,
  "match_rate": <0-100の整数。印字項目のうち JSON が正しく取れた割合>,
  "missing":   [{"name": "疾患名", "image_value": "5年X% / 10年Y% / RR z", "image_bbox": [ymin,xmin,ymax,xmax], "note": "..."}],
  "misread":   [{"name": "疾患名", "field": "項目名|5年発症率|10年発症率|相対リスク比", "image_value": "...", "json_value": "...", "image_bbox": [ymin,xmin,ymax,xmax], "note": "..."}],
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
  // bbox は配列でも文字列でも来うる。表示・監査用に文字列化して素通し(位置決めには使わない)。
  const bbox = Array.isArray(o.image_bbox) ? (o.image_bbox as unknown[]).join(',') : s('image_bbox');
  return { name: s('name'), json_value: s('json_value'), image_value: s('image_value'), field: s('field'), image_bbox: bbox, column_header: s('column_header'), note: s('note') };
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

  // LAiF(AI疾病発症予測)は data.items[] を照合。それ以外(健診/血液/がん等)は data.measurements を照合。
  const jdata = ((input.json && typeof input.json === 'object' ? (input.json as Record<string, unknown>).data : null) || {}) as Record<string, unknown>;
  const isItems = input.formatId === 'Other' || (Array.isArray(jdata.items) && !Array.isArray(jdata.measurements));

  const { text: table, count } = isItems ? renderItemsForGrader(input.json) : renderMeasurementsForGrader(input.json);
  const systemText = isItems ? AI_PREDICTION_VERIFY_SYSTEM : VERIFY_SYSTEM;
  const userText = isItems ? buildItemsVerifyUserText(table) : buildVerifyUserText(table, input.formatId);

  const parts = [
    ...images.map((im) => ({ inline_data: { mime_type: im.mime, data: im.data } })),
    { text: userText + (input.hint ? `\n\n# 補足\n${input.hint}` : '') },
  ];

  const res = await callGemini(
    apiKey,
    {
      systemInstruction: { parts: [{ text: systemText }] },
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

  const missingRaw = asArray(parsed.missing).map(toDisc);
  const misreadRaw = asArray(parsed.misread).map(toDisc);
  const extra = asArray(parsed.extra).map(toDisc);
  const duplicate = asArray(parsed.duplicate).map(toDisc);

  // 決定論フィルタ: grader が過去列(日付付き 前回/前々回)・基準値列 を「今回」と誤読した指摘を除外する。
  //   実測 2026-08: 尿沈渣(前回列)・眼圧(基準"20未満")・K-W 等を誤って取りこぼし/捏造に挙げた(採点LLMも
  //   列帰属の弱点を持つ)。column_header が過去/基準 を指す、または image_value が範囲/不等号(=基準値表記)
  //   の指摘を落とす。見出し未申告(空)は過剰除外を避けて残す。決定論ゴールデンが主指標・本フィルタは補助。
  const PAST_OR_REF_HDR = /前回|前々回|過去|基準|参考|範囲|正常|\d{4}\s*[/.年]\s*\d{1,2}/;
  const REF_VALUE = /(未満|以上|以下|超える|\d+(?:\.\d+)?\s*[〜~]\s*\d+)/;
  const isTodayFinding = (d: VerifyDiscrepancy): boolean => {
    const h = (d.column_header || '').trim();
    if (h && PAST_OR_REF_HDR.test(h)) return false;
    const v = (d.image_value || '').trim();
    if (REF_VALUE.test(v)) return false;
    return true;
  };
  // 過去列/基準列フィルタは健診(measurements)の時系列表専用。LAiF(items)には過去列が無いため適用しない。
  const missing = isItems ? missingRaw : missingRaw.filter(isTodayFinding);
  const misread = isItems ? misreadRaw : misreadRaw.filter(isTodayFinding);
  const filteredOut = (missingRaw.length - missing.length) + (misreadRaw.length - misread.length);

  const items_image = typeof parsed.items_image === 'number' && Number.isFinite(parsed.items_image)
    ? Math.round(parsed.items_image)
    : null;
  // match_rate は「フィルタ後の指摘」と整合させて再計算する(grader 生の値は過去列誤指摘込みで過小)。
  let match_rate = typeof parsed.match_rate === 'number' && Number.isFinite(parsed.match_rate)
    ? Math.max(0, Math.min(100, Math.round(parsed.match_rate)))
    : null;
  if (items_image != null && items_image > 0) {
    match_rate = Math.max(0, Math.min(100, Math.round((1 - (missing.length + misread.length) / items_image) * 100)));
  }
  const baseSummary = typeof parsed.summary === 'string' ? parsed.summary : '';
  const summary = filteredOut > 0
    ? `${baseSummary}${baseSummary ? ' ' : ''}（過去列/基準列の誤指摘 ${filteredOut} 件を自動除外）`
    : baseSummary;

  return {
    match_rate,
    items_image,
    items_json: count,
    counts: { missing: missing.length, misread: misread.length, extra: extra.length, duplicate: duplicate.length },
    missing,
    misread,
    extra,
    duplicate,
    summary,
    model: MODELS.scan,
    finish_reason: finishReason,
  };
}
