/**
 * Elith 連携用エクスポート (共有サーバモジュール)。
 *
 * 画像 (検査結果) → AIスキャン(Gemini) → Elith エンベロープ(elith-handoff-v0.1) →
 * S3 に置く「JSON + 元画像(同名・拡張子替え)」のファイル群を生成する。
 *
 * - キー(GEMINI_API_KEY)は **サーバ環境変数からのみ**取得 (CLAUDE.md: Vercel 一元管理)。
 * - スキャンのプロンプト/設定は scan-prompt.ts を共用 (scan.ts と同一ロジック)。
 * - パス/命名は docs/elith_s3_data_handoff_spec.md に準拠。
 * - Vercel 実行モデルに合わせ **1 画像 = 1 呼び出し** (呼び出し側がループ)。
 *
 * サーバ専用 (GEMINI_API_KEY を読むため、クライアントから呼ばない)。
 */

import { callGemini, MODELS, extractText } from './gemini';
import {
  ANALYZE_SYSTEM,
  SCAN_GENERATION_CONFIG,
  buildScanUserText,
  EXAM_DATE_INSTRUCTION,
} from './scan-prompt';
import { parseScanRegions, type ScanRegionJson } from './scan-export';
import type { S3PutFile } from './s3';

export const ELITH_HANDOFF_SCHEMA_VERSION = 'elith-handoff-v0.1';

export const ELITH_FORMAT_IDS = [
  'CancerRiskAssessmentData',
  'HealthCheckupData',
  'GeneticTestResultData',
  'BloodTestData',
  'LifestyleQuestionnaireData',
  'Other',
] as const;
export type ElithFormatId = (typeof ELITH_FORMAT_IDS)[number];

export function isElithFormatId(v: unknown): v is ElithFormatId {
  return typeof v === 'string' && (ELITH_FORMAT_IDS as readonly string[]).includes(v);
}

// ── env (サーバ専用) ────────────────────────────────────────────
function env(name: string): string | undefined {
  const fromMeta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (fromMeta != null && fromMeta !== '') return fromMeta;
  const fromProc = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return fromProc != null && fromProc !== '' ? fromProc : undefined;
}
export function getGeminiApiKey(): string | undefined {
  return env('GEMINI_API_KEY');
}
export function isGeminiConfigured(): boolean {
  return !!getGeminiApiKey();
}

// ── MIME / 拡張子 ───────────────────────────────────────────────
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/tiff': '.tif',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
};
export function isSupportedMime(mime: string): boolean {
  return mime in MIME_TO_EXT;
}
export function extFromMime(mime: string): string {
  return MIME_TO_EXT[mime] ?? '.bin';
}

// ── 日付 ────────────────────────────────────────────────────────
export function jstTodayIso(now: Date = new Date()): string {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())}`;
}
function isoDate(y: string, mo: string, d: string): string | null {
  const Y = +y, M = +mo, D = +d;
  if (M < 1 || M > 12 || D < 1 || D > 31) return null;
  return `${String(Y).padStart(4, '0')}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}`;
}
/** 検査日: 先頭コメント <!-- exam_date --> → 本文の日付 → today */
export function extractExamDate(markdown: string, todayIso: string): { date: string; source: string } {
  const m = /<!--\s*exam_date:\s*(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/i.exec(markdown);
  if (m) {
    const d = isoDate(m[1], m[2], m[3]);
    if (d) return { date: d, source: 'exam_date' };
  }
  const re = /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/g;
  let g: RegExpExecArray | null;
  while ((g = re.exec(markdown))) {
    const d = isoDate(g[1], g[2], g[3]);
    if (d) return { date: d, source: 'markdown' };
  }
  return { date: todayIso, source: 'today' };
}
function stripExamComment(md: string): string {
  return md.replace(/^\s*<!--\s*exam_date:[^>]*-->\s*\n?/i, '');
}

// ── 計測値 (表領域 → measurements[]) ────────────────────────────
// Elith 納品用の共通スキーマ (docs/elith_s3_data_handoff_spec.md §7.1)。
// 検査値型 (HealthCheckup / Cancer / Blood) で同じキー名を使う。
//   - 構造化 (項目名/単位/判定の分離) は LLM が担う (スキャンは表カラムに出力済み)。
//   - value は「数値のみ」を目標にし、単位は unit / 判定は flag に分離する。
//   - bbox 等の版面座標や監査専用列 (No/推論値) は納品 JSON に含めない。
export interface ElithMeasurement {
  /**
   * 区分 (任意)。血液CSVの「項目区分」(生化学/血液学 等の医学的分類) にのみ付与する。
   * スキャン由来 (検診/がん) は付与しない: スキャンの category は版面レイアウトの見出し
   * ("左側検査表"/"今回の検査の判定結果" 等) で医学的分類ではなく、Elith 側で region 相当の
   * 不要データになるため納品しない (キー自体を出さない)。
   */
  category?: string | null;
  name: string | null;
  name_detail: string | null;
  /** 読み取り値 (数値のみを目標。単位/判定マーカは含めない) */
  value: string | null;
  /** 数値化できる場合のみ (できなければ null) */
  value_num: number | null;
  unit: string | null;
  ref_low: string | null;
  ref_high: string | null;
  /** "H"(高) | "L"(低) | "-"(基準内) | null */
  flag: string | null;
  note: string | null;
  /**
   * 値の判定/説明 (任意)。血液CSVの「判)」判定コード (F2/A3 等) を対応する検査値へ付与する。
   * 検査機関由来の生コード (デコードしない)。該当が無ければ付与しない (キーを出さない)。
   */
  assessment?: string | null;
}

/** "26" / "1,234" / "8.1" → 数値。数値化不能 (範囲値 "127/82"・定性値 "陰性" 等) は null。 */
export function toValueNum(v: string | null): number | null {
  if (!v) return null;
  const t = v.replace(/,/g, '').trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(t)) return null; // 純粋な単一数値のみ (スラッシュ/文字混じりは null)
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * 後段の保険 (条件付き・LLM 出力が既にクリーンなら no-op)。
 * value に判定マーカ/強調注記/単位カラムと同一の単位が「混入」した場合だけ最小限そぎ落とす。
 * - 数値そのものは書き換えない (誤りは決して混ぜない)。範囲値 "127/82" 等は触らない。
 * - LLM がきれいに分離できていれば何もしない (＝走らない)。
 */
export function tidyMeasurement(m: ElithMeasurement): ElithMeasurement {
  if (m.value == null) return { ...m, value_num: m.value_num ?? null };
  let v = m.value.trim();
  let flag = m.flag;
  // [強調] / 【要確認】等の括弧注記を value から除く (監査情報は note / raw_markdown 側に残る)
  const noBracket = v.replace(/[[【][^\]】]*[\]】]/g, '').trim();
  if (noBracket !== v) v = noBracket;
  // 末尾の判定マーカ (H/L/HH/LL) を分離。数値+空白+マーカの形のときだけ。
  const fm = /^([+-]?[\d.,]+)\s+(HH|LL|H|L)$/.exec(v);
  if (fm) {
    v = fm[1];
    if (!flag || flag === '-' || flag === '') flag = fm[2];
  }
  // value 末尾に unit カラムと同じ単位が付いていれば除去 (単位はあくまで unit 側)
  if (m.unit && m.unit.length > 0) {
    const u = m.unit.trim();
    if (v.length > u.length && v.slice(-u.length) === u) {
      const cut = v.slice(0, v.length - u.length).trim();
      if (/^[+-]?[\d.,]+$/.test(cut)) v = cut;
    }
  }
  return { ...m, value: v || null, value_num: toValueNum(v), flag: flag || null };
}

/** raw_markdown から版面座標コメント (<!-- bbox: ... -->) を除去する (納品には不要)。 */
export function stripBboxComments(md: string): string {
  return md
    .split('\n')
    .filter((l) => !/^\s*<!--\s*bbox:[^>]*-->\s*$/i.test(l))
    .join('\n');
}

// ── 納品用 lean 正規化 (Elith 要望 2026-07・全書き出し経路共通) ──────────────
// 「元データはリッチで監査可能 → 決定論プログラムで lean 納品」。scan / hc-merge / batch /
// assemble のどの経路でも同じ関数を通し、納品 measurements を統一する (二重管理しない)。

/** 除外した測定値の記録 (納品物には含めない・監査用)。 */
export interface MeasurementAnomaly {
  name: string | null;
  value: string | null;
  value_num: number | null;
  unit: string | null;
  reason: string;
}

/** "-"/"" は null。それ以外は trim。 */
export function normDeliveryStr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' || s === '-' ? null : s;
}
/** 表示値クリーン化: 矢印(↑↓)等の記号・空白を除去。"-"/""/"/"(斜線=値なし) は null。 */
export function cleanDeliveryValue(v: unknown): string | null {
  const raw = typeof v === 'string' ? v : v == null ? null : String(v);
  if (raw == null) return null;
  const s = raw.replace(/[↑↓⤴⤵➡→←]/g, '').trim();
  // 単独の斜線(半角/全角)は検査票で「該当なし/値なし」を意味する → 空扱い。
  // ("127/82" 等の複合値は s==='/' に一致しないので影響しない。)
  return s === '' || s === '-' || s === '/' || s === '／' ? null : s;
}
/**
 * 納品用 lean measurement を作る。
 * 残す: name / value(クリーン) / value_num / unit / ref_low / ref_high / flag。
 * 除去: region / no / inferred / name_detail / note / category / bbox / assessment。
 * flag 未確定時は値の ↑/↓ を H/L として拾う (基準外の取りこぼし防止)。
 */
export function leanMeasurement(el: Record<string, unknown>): Record<string, unknown> {
  const base = typeof el.inferred === 'string' ? el.inferred : el.value;
  const rawStr = typeof base === 'string' ? base : base == null ? '' : String(base);
  const value = cleanDeliveryValue(base);
  const value_num =
    typeof el.value_num === 'number' && Number.isFinite(el.value_num) ? el.value_num : toValueNum(value);
  const flagRaw = typeof el.flag === 'string' ? el.flag.trim() : '';
  let flag = flagRaw === 'H' || flagRaw === 'L' ? flagRaw : null;
  if (!flag) {
    if (/[↑⤴]/.test(rawStr)) flag = 'H';
    else if (/[↓⤵]/.test(rawStr)) flag = 'L';
  }
  return {
    name: typeof el.name === 'string' ? el.name : null,
    value,
    value_num,
    unit: normDeliveryStr(el.unit),
    ref_low: normDeliveryStr(el.ref_low),
    ref_high: normDeliveryStr(el.ref_high),
    flag,
  };
}
/**
 * 総合判定(A/B/C…)欄か (「項目別判定」欄はランク文字のみで測定値でない → 納品しない)。
 * 条件: value が単独ランク文字(A〜E) かつ 数値/単位/基準値なし。
 * 例外: 血液型(ABO/Rh)等 name に「型」を含む定性結果は残す ("A"/"B" が正当なため)。
 */
export function isJudgementSummaryRow(m: Record<string, unknown>): boolean {
  const v = typeof m.value === 'string' ? m.value.trim() : '';
  const name = typeof m.name === 'string' ? m.name : '';
  if (/型|ABO|Rh|血液型/.test(name)) return false;
  return /^[A-EＡ-Ｅ]$/.test(v) && m.value_num == null && m.unit == null && m.ref_low == null && m.ref_high == null;
}
/**
 * 妥当性ガード (誤配信防止): 明らかに壊れた測定値の除外理由。null=正常。
 *  - 単位が純数値 = 列ズレ疑い (例: HDL 行で unit="40")。
 *  - 割合(%)が 0–100 の範囲外 = 物理的にあり得ない (例: 体脂肪率 105%)。
 */
export function measurementAnomalyReason(m: Record<string, unknown>): string | null {
  const unit = typeof m.unit === 'string' ? m.unit.trim() : '';
  const vn = typeof m.value_num === 'number' && Number.isFinite(m.value_num) ? m.value_num : null;
  if (unit && /^\d+(\.\d+)?$/.test(unit)) return 'unit_is_numeric（列ズレ疑い）';
  if (unit === '%' && vn != null && (vn < 0 || vn > 100)) return 'percent_out_of_range（0–100外）';
  return null;
}
/**
 * measurements[] を納品形へ正規化 (全書き出し経路共通)。
 *  1) lean 化 (↑↓→flag・value_num 数値化)   2) 未測定(値なし)除外
 *  3) 総合判定(A/B/C)欄 除外              4) 妥当性ガードで壊れた値を除外 (anomalies)
 */
export function sanitizeMeasurementsForDelivery(list: unknown): {
  kept: Record<string, unknown>[];
  anomalies: MeasurementAnomaly[];
} {
  const kept: Record<string, unknown>[] = [];
  const anomalies: MeasurementAnomaly[] = [];
  if (!Array.isArray(list)) return { kept, anomalies };
  for (const el of list as Array<Record<string, unknown>>) {
    if (!el || typeof el !== 'object') continue;
    const m = leanMeasurement(el);
    if (m.value == null && m.value_num == null) continue; // 未測定(値なし)は納品しない
    if (isJudgementSummaryRow(m)) continue; // 総合判定(A/B/C)欄は測定値でない
    const reason = measurementAnomalyReason(m);
    if (reason) {
      anomalies.push({
        name: (m.name as string | null) ?? null,
        value: (m.value as string | null) ?? null,
        value_num: (m.value_num as number | null) ?? null,
        unit: (m.unit as string | null) ?? null,
        reason,
      });
      continue; // 壊れた値は納品しない
    }
    kept.push(m);
  }
  return { kept, anomalies };
}

function pickCol(cols: string[], names: string[]): number {
  for (const n of names) {
    const i = cols.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}
/** 詳細が汎用語(実際の分析項目名でない)のとき true → セクション名(検査項目)を採用する。 */
const GENERIC_DETAIL = new Set(['所見', '像', 'コメント', '結果', '判定', '']);
/**
 * 納品 name の決定: 「検査項目詳細(分析項目名)」を優先し、詳細が汎用語/空ならセクション名。
 * 詳細が左右など位置語のみなら「セクション+位置」で結合(左右重複の防止)。
 *   例: 痛風/尿酸→尿酸, 肝炎/HBs抗原→HBs抗原, 白血球/尿中白血球→尿中白血球,
 *       胸部X線/所見→胸部X線, 眼圧/右→眼圧右
 */
export function pickDeliveryName(section: string, detail: string): string | null {
  const s = (section || '').trim();
  const d = (detail || '').trim();
  if (!d || d === '-' || GENERIC_DETAIL.has(d) || /撮影区分|所見/.test(d)) return s || null;
  if (/^(右|左|両)$/.test(d)) return s ? `${s}${d}` : d;
  return d;
}
function toMeasurements(regions: ScanRegionJson[]): ElithMeasurement[] {
  const out: ElithMeasurement[] = [];
  for (const r of regions) {
    if (r.type !== 'table' || !r.columns || !r.rows) continue;
    const c = r.columns;
    const idx = {
      name: pickCol(c, ['検査項目']),
      detail: pickCol(c, ['検査項目詳細']),
      value: pickCol(c, ['読み取った値', '結果', '値']),
      unit: pickCol(c, ['単位', '単位名称']),
      low: pickCol(c, ['下限値']),
      high: pickCol(c, ['上限値']),
      flag: pickCol(c, ['判定']),
      note: pickCol(c, ['備考']),
    };
    for (const row of r.rows) {
      const g = (i: number): string => (i >= 0 && i < row.cells.length ? row.cells[i] : '') || '';
      const section = g(idx.name);   // 検査項目 (見出し/分類のことがある)
      const detail = g(idx.detail);  // 検査項目詳細 (実際の分析項目名のことが多い)
      if (!section && !detail && !g(idx.value)) continue;
      // 納品 name は分析項目名を優先 (痛風→尿酸 等)。詳細は監査用に name_detail に残す。
      out.push(
        tidyMeasurement({
          name: pickDeliveryName(section, detail),
          name_detail: detail || null,
          value: g(idx.value) || null,
          value_num: null,
          unit: g(idx.unit) || null,
          ref_low: g(idx.low) || null,
          ref_high: g(idx.high) || null,
          flag: g(idx.flag) || null,
          note: g(idx.note) || null,
        }),
      );
    }
  }
  return out;
}
function collectNotes(regions: ScanRegionJson[]): string[] {
  const out: string[] = [];
  for (const r of regions) if (r.type === 'notes' && r.notes?.length) out.push(...r.notes);
  return out;
}

// ── Gemini スキャン (1 画像) ────────────────────────────────────
async function scanImage(
  apiKey: string,
  imageBase64: string,
  mimeType: string,
  hint?: string | null,
): Promise<{ markdown: string; finishReason: string | null }> {
  const res = await callGemini(
    apiKey,
    {
      systemInstruction: { parts: [{ text: ANALYZE_SYSTEM }] },
      contents: [
        {
          role: 'user',
          parts: [
            { inline_data: { mime_type: mimeType, data: imageBase64 } },
            { text: buildScanUserText(hint) + EXAM_DATE_INSTRUCTION },
          ],
        },
      ],
      generationConfig: { ...SCAN_GENERATION_CONFIG },
    },
    MODELS.scan,
  );
  return { markdown: extractText(res), finishReason: res.candidates?.[0]?.finishReason ?? null };
}

// ── 1 画像スキャン → 解析結果 (S3 書き込みなし) ──────────────────
// 複数画像を 1 検査へマージする用途 (人間ドック複数シート)。呼び出し側で連番画像を書き、
// 全 part の measurements/regions/notes をマージして 1 つの JSON を書き出す。
export interface ParsedScan {
  markdown: string;
  finishReason: string | null;
  testDate: string;
  dateSource: string;
  measurements: ElithMeasurement[];
  regions: ScanRegionJson[];
  notes: string[];
}

export async function scanImageToParsed(input: {
  imageBase64: string;
  mimeType: string;
  hint?: string | null;
  /** 明示検査日 (YYYY-MM-DD)。未指定なら画像抽出→today */
  examDate?: string | null;
  today?: string;
}): Promise<ParsedScan> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured (server env)');
  if (!isSupportedMime(input.mimeType)) throw new Error(`unsupported mime: ${input.mimeType}`);

  const { markdown, finishReason } = await scanImage(apiKey, input.imageBase64, input.mimeType, input.hint);
  if (!markdown.trim()) throw new Error(`empty scan result (finishReason=${finishReason})`);

  const todayIso = input.today || jstTodayIso();
  const provided = input.examDate && /^\d{4}-\d{2}-\d{2}$/.test(input.examDate) ? input.examDate : null;
  const { date: testDate, source: dateSource } = provided
    ? { date: provided, source: 'provided' }
    : extractExamDate(markdown, todayIso);

  const regions = parseScanRegions(markdown);
  return {
    // 納品用 raw_markdown は版面座標 (bbox) を含めない。regions(bbox付) は内部 (レビュー) 用に別途返す。
    markdown: stripBboxComments(stripExamComment(markdown)),
    finishReason,
    testDate,
    dateSource,
    measurements: toMeasurements(regions),
    regions,
    notes: collectNotes(regions),
  };
}

// ── バンドル生成 ────────────────────────────────────────────────
export interface ElithScanInput {
  formatId: ElithFormatId;
  clientId: string;
  imageBase64: string;
  mimeType: string;
  sourceFileName?: string | null;
  /** 呼び出し側が検査日を明示する場合 (YYYY-MM-DD)。未指定なら画像から抽出→today */
  examDate?: string | null;
  /** 検査日不明時の today (YYYY-MM-DD, JST)。未指定なら実行時 JST */
  today?: string;
  /** バケット内共通プレフィックス */
  prefix?: string;
  diagnosticId?: string;
  hint?: string | null;
}

export interface ElithScanBundle {
  formatId: ElithFormatId;
  clientId: string;
  testDate: string;
  dateSource: string;
  dateFolder: string;
  folder: string;
  jsonKey: string;
  imageKey: string;
  json: unknown;
  markdown: string;
  finishReason: string | null;
  files: S3PutFile[];
}

function utf8Bytes(s: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : Buffer.byteLength(s, 'utf-8');
}
function randomUuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

/**
 * 1 画像を Elith 形式で S3 に置くためのバンドル (JSON + 元画像) を生成する。
 * Gemini 呼び出しを含む (サーバ側)。S3 への put は呼び出し側で行う (s3.putFiles)。
 */
export async function buildElithScanBundle(input: ElithScanInput): Promise<ElithScanBundle> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured (server env)');
  if (!isSupportedMime(input.mimeType)) throw new Error(`unsupported mime: ${input.mimeType}`);

  const { markdown, finishReason } = await scanImage(apiKey, input.imageBase64, input.mimeType, input.hint);
  if (!markdown.trim()) throw new Error(`empty scan result (finishReason=${finishReason})`);

  const todayIso = input.today || jstTodayIso();
  let testDate: string;
  let dateSource: string;
  const provided = input.examDate && /^\d{4}-\d{2}-\d{2}$/.test(input.examDate) ? input.examDate : null;
  if (provided) {
    testDate = provided;
    dateSource = 'provided';
  } else {
    const ex = extractExamDate(markdown, todayIso);
    testDate = ex.date;
    dateSource = ex.source;
  }
  const dateFolder = testDate.replace(/-/g, '_');

  const regions = parseScanRegions(markdown);
  const diagnosticId = input.diagnosticId || randomUuid();
  const json = {
    format_id: input.formatId,
    schema_version: ELITH_HANDOFF_SCHEMA_VERSION,
    kind: 'scan',
    client_id: input.clientId,
    diagnostic_id: diagnosticId,
    source_image: input.sourceFileName ?? null,
    test_date: testDate,
    date_source: dateSource,
    exported_at: new Date().toISOString(),
    subject: { sex: null, age: null },
    source: {
      origin: 'scan-chat-ai',
      app: 'scan-chat-ai',
      model: MODELS.scan,
      note: 'admin バッチ (AIスキャン)。命名/フォーマットは暫定。',
      lab_name: null,
      finish_reason: finishReason,
    },
    // 納品 data は共通 measurements[] + notes のみ。版面座標 (regions/bbox) は含めない (§7.1)。
    // 書き出し時点で lean 正規化 (↑↓→flag/value_num・空行/総合判定欄 除外・妥当性ガード)。
    data: {
      measurements: sanitizeMeasurementsForDelivery(toMeasurements(regions)).kept,
      notes: collectNotes(regions),
    },
    raw_markdown: stripBboxComments(stripExamComment(markdown)),
  };

  const prefix = input.prefix ? input.prefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
  const folder = `${prefix}user/${input.clientId}/date/${dateFolder}/`;
  const stem = `${input.formatId}_date_${dateFolder}_user_${input.clientId}`;
  const jsonKey = `${folder}${stem}.json`;
  const imageKey = `${folder}${stem}${extFromMime(input.mimeType)}`;

  const jsonBody = JSON.stringify(json, null, 2);
  const imageBytes = Uint8Array.from(Buffer.from(input.imageBase64, 'base64'));

  const files: S3PutFile[] = [
    { key: jsonKey, contentType: 'application/json; charset=utf-8', body: jsonBody, bytes: utf8Bytes(jsonBody) },
    { key: imageKey, contentType: input.mimeType, body: imageBytes, bytes: imageBytes.length },
  ];

  return {
    formatId: input.formatId,
    clientId: input.clientId,
    testDate,
    dateSource,
    dateFolder,
    folder,
    jsonKey,
    imageKey,
    json,
    markdown,
    finishReason,
    files,
  };
}
