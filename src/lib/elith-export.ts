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

import { callGemini, MODELS, extractText, stripJsonCodeFence } from './gemini';
import {
  ANALYZE_SYSTEM,
  SCAN_GENERATION_CONFIG,
  buildScanUserText,
  EXAM_DATE_INSTRUCTION,
  ANALYZE_SYSTEM_JSON,
  SCAN_JSON_GENERATION_CONFIG,
  buildScanUserTextJson,
  BOUNDARY_RECHECK_SYSTEM,
  BOUNDARY_RECHECK_GENERATION_CONFIG,
  buildBoundaryRecheckUser,
} from './scan-prompt';
import { parseScanRegions, type ScanRegionJson } from './scan-export';
import { canonicalize, canonAudit, type CanonAudit } from './canonicalize';
import { dedupObservations, dedupAudit, type DedupAudit } from './observation-dedup';
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
/**
 * スキャン出力形式。'json' で responseSchema 構造化出力、既定 'markdown' で従来の GFM 表経路。
 * env `SCAN_OUTPUT_FORMAT=json` で切替 (Vercel・再デプロイ要)。未検証のうちは既定 markdown のまま
 * にしておき、代表ページで 🎯 ゴールデン照合の回帰ゼロを確認してから json へ寄せる (Phase 2)。
 */
export function scanOutputFormat(): 'json' | 'markdown' {
  return env('SCAN_OUTPUT_FORMAT') === 'json' ? 'json' : 'markdown';
}
/**
 * 境界定性項目の2パス再読 (Phase 1) を有効にするか。env `SCAN_BOUNDARY_RECHECK=on` で有効 (既定 off)。
 * 一次パスで空だった境界項目 (尿蛋白/尿潜血/尿糖/免疫便潜血/K-W) だけを、その画像へ軽量再読し
 * ギャップ埋めする (既存値は上書きしない)。numeric は触らない。🎯 回帰ゼロ確認後に常用する想定。
 */
export function boundaryRecheckEnabled(): boolean {
  return env('SCAN_BOUNDARY_RECHECK') === 'on';
}
/**
 * ②正準化（標準マスタへの名寄せ/単位正準化・テンプレート穴埋め）を有効にするか。
 * env `SCAN_CANONICALIZE=on` で有効（既定 off）。off の間は挙動不変（現行と完全同一）。
 * 🎯 ゴールデンで numeric 全一致・False-Value 0・名寄せ Missing 減 を確認してから on にする（P2/P4）。
 * 実装: `canonicalize()`（src/lib/canonicalize.ts）。読取値(numeric)は変えない・非ヒットは元名のまま。
 */
export function canonicalizeEnabled(): boolean {
  return env('SCAN_CANONICALIZE') === 'on';
}
/**
 * ①読取後段の決定論 dedup（課題C 別名重複の統合／課題B 同名別値の競合検知）を有効にするか。
 * env `SCAN_OBS_DEDUP=on` で有効（既定 off）。off の間は挙動不変。
 * 同一概念・同一値のみ統合し、同一概念・別値は統合せず competition として監査に残す（自動採用しない）。
 * 実装: `dedupObservations()`（src/lib/observation-dedup.ts）。numeric は変えない・値の採否はしない。
 * 🎯 ゴールデンで numeric 全一致・別名重複減・実施済の非統合 を確認してから on（P-perc）。
 */
export function obsDedupEnabled(): boolean {
  return env('SCAN_OBS_DEDUP') === 'on';
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
  // 矢印マーカ除去 + 末尾の脚注記号(*＊※†‡ 等)除去 ((-)* → (-) 等。値の意味は変えない)。
  const s = raw.replace(/[↑↓⤴⤵➡→←]/g, '').replace(/[*＊※†‡]+$/, '').trim();
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
// 定性結果の列取り違えサルベージ (Phase 0・決定論・名称 allow-list スコープ)。
//   尿ディップ定性 (尿蛋白/尿潜血/尿糖) と免疫便潜血は run により結果 "(-)" が基準列(ref_high)へ
//   吸われ value 空→納品脱落する (2026-07 実測・非決定=Semantic Tie)。value 空のときだけ、括弧付き
//   定性記号 (-)/(+)/(±) や 陰性/陽性 を ref_high/ref_low/note から value へ移送して救済する。
//   **allow-list に限定** (他項目の「基準=(-)」を結果と誤読して埋める=False-Value 捏造を避けるため):
//     許可 = 免疫便潜血 / 尿蛋白(納品名=蛋白) / 尿潜血(潜血) / 尿糖 (検体があれば概ね必ず実施される項目)。
//     除外 = 血清 RPR/TP抗体/HBs/HCV・尿沈渣 細菌/円柱/結晶・総蛋白/血糖 等
//            (「基準=(-) だが今回空=未実施」が正当なため。埋めると False-Value)。
//            総蛋白/血糖は allow の ^…$ アンカーで、血清/沈渣は deny で二重に除外。
//   ※ 残リスク: 検体未採取で尿ディップ全欄が空の run では基準(-)を誤救済し得る → 恒久策は VQA 再読。
//     本 salvage は 🎯 4象限 (実施済(-)/(+)・未実施空) で False-Value=0 を確認してから常用する。
const QUAL_SALVAGE_ALLOW = /便潜血|^(?:尿蛋白|尿潜血|尿糖|蛋白|潜血)$/;
const QUAL_SALVAGE_DENY = /抗体|抗原|RPR|TP|HBs|HCV|HBV|CRP|梅毒|ピロリ|ペプシノーゲン|細菌|円柱|結晶|沈渣|総蛋白|血糖/;
const QUAL_RESULT_TOKEN = /^[(（]\s*[-+±]\s*[)）]$|^(陰性|陽性)$/;
export function salvageQualitativeResult(el: Record<string, unknown>): Record<string, unknown> {
  const name = typeof el.name === 'string' ? el.name : '';
  if (!QUAL_SALVAGE_ALLOW.test(name) || QUAL_SALVAGE_DENY.test(name)) return el;
  const base = typeof el.inferred === 'string' ? el.inferred : el.value;
  if (cleanDeliveryValue(base) != null) return el; // 既に value がある
  for (const key of ['ref_high', 'ref_low', 'note'] as const) {
    const c = typeof el[key] === 'string' ? (el[key] as string).trim() : '';
    if (QUAL_RESULT_TOKEN.test(c)) {
      // value と inferred の両方に入れる: leanMeasurement は inferred を優先するため
      // (value だけ埋めても inferred が空だと再び null 化され脱落する)。移送元 key は消す。
      return { ...el, value: c, inferred: c, [key]: null };
    }
  }
  return el;
}
/**
 * measurements[] を納品形へ正規化 (全書き出し経路共通)。
 *  0) 定性結果の列取り違えサルベージ (便潜血系のみ)
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
  for (const el0 of list as Array<Record<string, unknown>>) {
    if (!el0 || typeof el0 !== 'object') continue;
    const el = salvageQualitativeResult(el0);
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
  // 血圧の最高/最低は section/detail の当て方が run 毎に揺れる
  // (血圧|最高 / 最高血圧|最高 / 血圧|最大血圧 の実測)。納品名を 最高血圧/最低血圧 へ正規化し、
  // 列ゆれによる取りこぼしを断つ (納品名の一貫性=ゴール①にも寄与)。
  const sd = s + d;
  if (/血圧|収縮期|拡張期/.test(sd)) {
    if (/最高|最大|収縮期/.test(sd)) return '最高血圧';
    if (/最低|最小|拡張期/.test(sd)) return '最低血圧';
  }
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

// ── Gemini スキャン (1 画像・構造化 JSON / responseSchema) ───────────
// Phase 2: Markdown 表を経由せず responseSchema で直接 rows を返させる (列帰属の構造固定)。
const SCAN_TABLE_COLUMNS = [
  'No', '検査項目', '検査項目詳細', '読み取った値', '推論値', '単位', '下限値', '上限値', '判定', '備考',
] as const;

interface ScanJsonRow {
  item?: string; detail?: string; value?: string; inferred?: string;
  unit?: string; ref_low?: string; ref_high?: string; flag?: string; note?: string;
  anchor_confidence?: string;
}
interface ScanJsonRegion { title?: string; type?: string; rows?: ScanJsonRow[]; notes?: string[]; }
interface ScanJsonResult { exam_date?: string | null; regions?: ScanJsonRegion[]; }

/** 構造化 JSON の regions を、Markdown 経路と同一の ScanRegionJson[] へ写像 (toMeasurements 共用のため)。 */
function jsonToRegions(parsed: ScanJsonResult): ScanRegionJson[] {
  const out: ScanRegionJson[] = [];
  const regions = Array.isArray(parsed.regions) ? parsed.regions : [];
  regions.forEach((rg, index) => {
    const label = typeof rg.title === 'string' ? rg.title : `領域${index + 1}`;
    if (rg.type === 'notes') {
      const notes = Array.isArray(rg.notes) ? rg.notes.filter((n) => typeof n === 'string' && n.trim()) : [];
      out.push({ index, label, bbox: null, type: 'notes', notes });
      return;
    }
    // table (既定): 10 列に整列した cells/by_column を作る。空欄は "-" (Markdown 経路と同一挙動)。
    const rows = (Array.isArray(rg.rows) ? rg.rows : []).map((r) => {
      const s = (v: unknown): string => (typeof v === 'string' && v.trim() ? v.trim() : '-');
      const cells = [
        '-', s(r.item), s(r.detail), s(r.value), s(r.inferred), s(r.unit), s(r.ref_low), s(r.ref_high), s(r.flag), s(r.note),
      ];
      const by_column: Record<string, string> = {};
      SCAN_TABLE_COLUMNS.forEach((c, i) => { by_column[c] = cells[i]; });
      return { by_column, cells };
    });
    out.push({ index, label, bbox: null, type: 'table', columns: [...SCAN_TABLE_COLUMNS], rows });
  });
  return out;
}

async function scanImageJson(
  apiKey: string,
  imageBase64: string,
  mimeType: string,
  hint?: string | null,
): Promise<{ parsed: ScanJsonResult; raw: string; finishReason: string | null }> {
  const res = await callGemini(
    apiKey,
    {
      systemInstruction: { parts: [{ text: ANALYZE_SYSTEM_JSON }] },
      contents: [
        {
          role: 'user',
          parts: [
            { inline_data: { mime_type: mimeType, data: imageBase64 } },
            { text: buildScanUserTextJson(hint) },
          ],
        },
      ],
      generationConfig: { ...SCAN_JSON_GENERATION_CONFIG },
    },
    MODELS.scan,
  );
  const finishReason = res.candidates?.[0]?.finishReason ?? null;
  const raw = stripJsonCodeFence(extractText(res));
  if (!raw.trim()) throw new Error(`empty scan result (finishReason=${finishReason})`);
  let parsed: ScanJsonResult;
  try {
    parsed = JSON.parse(raw) as ScanJsonResult;
  } catch {
    throw new Error(`scan returned non-JSON (finishReason=${finishReason}): ${raw.slice(0, 200)}`);
  }
  return { parsed, raw, finishReason };
}

/** exam_date フィールドの正規化 (YYYY-MM-DD のみ採用)。 */
function normalizeSchemaExamDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/.exec(v.trim());
  return m ? isoDate(m[1], m[2], m[3]) : null;
}

// ── 境界定性項目の2パス再読 (Phase 1) ──────────────────────────────
/** 照合キー正規化 (astro 側 gName と同一方針: 空白除去 + 末尾 数/量/値 除去)。 */
function normNameKey(s: string): string {
  return String(s || '').replace(/[\s　]/g, '').replace(/(数|量|値)$/, '');
}
/** 再読対象の境界項目 (name=納品名/ゴールデン名, label=再読プロンプト表記, hint=その画像にありそうか)。 */
// 各項目の「今回値として妥当な結果集合」。VQA トリガー(集合外=unexpected_token)と採用ガードに使う。
//   尿定性/便潜血: 括弧付き ±/-/+・陰性/陽性・(+-)・尿の程度 1+〜3+。K-W分類: 0〜4 のグレード。
const QUAL_URINE_ALLOW = /^([(（]?[-+±][)）]?|陰性|陽性|\(\+-\)|[1-3]\+)$/;
const KW_GRADE_ALLOW = /^[0-4]$/;
// VQA が陰性/陽性を素のサイン (-/−/＋) や各種ダッシュ・全角で返すと、cleanDeliveryValue が素の "-" を
// "値なし(null)" と扱うため充填が落ちる (実測 2026-08: 潜血 VQA=− ⇒ left_unresolved→Missing)。
// 定性トークンを括弧付き ((-)/(+)/(±)) へ正規化してから判定する。空文字は空のまま(=未実施を陰性と捏造しない)。
function normalizeQualToken(s: string): string {
  let t = String(s || '').trim();
  if (!t) return t;
  t = t
    .replace(/[‐‑‒–—―−ー－]/g, '-') // 各種ダッシュ/長音/全角ハイフン → '-'
    .replace(/[＋﹢]/g, '+') // 全角＋ → '+'
    .replace(/（/g, '(')
    .replace(/）/g, ')');
  if (t === '-') return '(-)';
  if (t === '+') return '(+)';
  if (t === '±' || t === '+-' || t === '(+-)') return '(±)';
  if (t === '陰性') return '(-)';
  if (t === '陽性') return '(+)';
  return t;
}
// aliases: 納品名の揺れ (pickDeliveryName により 尿蛋白/尿潜血 のまま納品される run がある) を吸収する候補。
//   これが無いと currentVal/idxOfAny が既存の尿蛋白行を見つけられず、VQA充填が別名の重複行を push してしまう
//   (実測 2026-08: 尿蛋白 と 蛋白 / 尿潜血 と 潜血 の二重計上)。allow/hint は据え置き。
const BOUNDARY_RECHECK_ITEMS: { name: string; label: string; hint: RegExp; allow: RegExp; aliases?: string[] }[] = [
  { name: '免疫便潜血反応 1日目', label: '免疫便潜血反応（検便）1日目', hint: /便潜血|検便/, allow: QUAL_URINE_ALLOW },
  { name: '免疫便潜血反応 2日目', label: '免疫便潜血反応（検便）2日目', hint: /便潜血|検便/, allow: QUAL_URINE_ALLOW },
  { name: '尿糖', label: '尿糖（尿定性）', hint: /尿糖/, allow: QUAL_URINE_ALLOW },
  { name: '蛋白', label: '尿蛋白（尿定性の蛋白。血液の総蛋白ではない）', hint: /蛋白/, allow: QUAL_URINE_ALLOW, aliases: ['尿蛋白'] },
  // hint は「便に前置されない潜血」に限定: boundaryRecheck は画像1枚ごとに走るため、hint=/潜血/ だと
  //   免疫便潜血のある検便ページ(③-4)にも誤マッチし、尿定性潜血の無いそのページへ VQA が新規「潜血」行を
  //   push → ③-2 の本物の尿定性潜血とマージ後に重複する(実測 2026-08)。(?<!便) で免疫便潜血を除外する。
  { name: '潜血', label: '尿潜血（尿定性の潜血。免疫便潜血ではない）', hint: /(?<!便)潜血/, allow: QUAL_URINE_ALLOW, aliases: ['尿潜血'] },
  { name: 'K-W分類右', label: 'K-W分類 右（眼底）', hint: /眼底|K.?W/i, allow: KW_GRADE_ALLOW },
  { name: 'K-W分類左', label: 'K-W分類 左（眼底）', hint: /眼底|K.?W/i, allow: KW_GRADE_ALLOW },
];

/** VQA 再読の監査記録 (可視化用・Elith 納品には含めない)。 */
export interface VqaAuditEntry {
  name: string;
  reason: 'missing_detection' | 'unexpected_token' | 'timeline_leak';
  before: string | null; // 主パスの今回値 (再読前)
  vqa: string | null;     // VQA が返した生の回答 (leak は today/past を要約)
  action: 'filled' | 'overwritten' | 'dropped' | 'left_unresolved' | 'vqa_error';
}

// Phase 2: 時系列軸リーク (過去列値→今回混入=False-Value) を後段で削除する対象。
//   「今回=空が正になりやすい」項目。値があっても VQA でダブルチェックし、③3条件を全満たす時だけドロップ。
//   names = 納品名の揺れ (pickDeliveryName 由来) を吸収する候補。
const TIMELINE_LEAK_ITEMS: { names: string[]; label: string; hint: RegExp }[] = [
  { names: ['眼圧右'], label: '眼圧 右', hint: /眼圧/ },
  { names: ['眼圧左'], label: '眼圧 左', hint: /眼圧/ },
  { names: ['その他右', '眼底その他右'], label: '眼底 その他 右（視神経陥凹等の所見欄）', hint: /眼底/ },
  { names: ['その他左', '眼底その他左'], label: '眼底 その他 左（視神経陥凹等の所見欄）', hint: /眼底/ },
  { names: ['RPR', 'PR'], label: '血清 RPR（梅毒定性）', hint: /RPR|梅毒|血清|ＰＲ/ },
  { names: ['TP抗体'], label: '血清 TP抗体', hint: /TP|梅毒|血清/ },
];

/**
 * 境界項目を VQA 再読して補正する。env SCAN_BOUNDARY_RECHECK=on のときだけ呼ばれる。監査を audit で返す。
 *  - Phase 1 (fill/overwrite): 定性の今回空を充填 / 許可集合外の誤読 (例 "1") を上書き。既存の妥当値・numeric は不変。
 *  - Phase 2 (leak drop): 今回=空が正の項目 (眼圧/眼底その他/血清) の過去列読みを、
 *    ③ (VQA今回空 & 過去列に値 & 現value==過去列値) 全満たしの時だけ削除。誤削除=Missing を構造的に防ぐ。
 */
async function boundaryRecheck(
  apiKey: string,
  imageBase64: string,
  mimeType: string,
  rawFull: string,
  measurements: ElithMeasurement[],
): Promise<{ measurements: ElithMeasurement[]; audit: VqaAuditEntry[] }> {
  const currentVal = (name: string): string | null => {
    const m = measurements.find((mm) => normNameKey(mm.name || '') === normNameKey(name));
    return m ? cleanDeliveryValue(m.value) : null;
  };
  const currentValAny = (names: string[]): string | null => {
    for (const n of names) { const v = currentVal(n); if (v != null) return v; }
    return null;
  };
  const sameLoose = (a: string, b: string): boolean => a.replace(/\s/g, '') === b.replace(/\s/g, '');
  // Phase 1: 定性の補完/誤読上書き候補 (今回が空 or 定性許可集合外 例 免疫便潜血="1")。
  const fillCands = BOUNDARY_RECHECK_ITEMS
    .filter((it) => { if (!it.hint.test(rawFull)) return false; const c = currentValAny([it.name, ...(it.aliases || [])]); return c == null || !it.allow.test(c); })
    .map((it) => ({ kind: 'fill' as const, label: it.label, names: [it.name, ...(it.aliases || [])], allow: it.allow }));
  // Phase 2: 時系列軸リーク候補 (今回=空が正の項目に値がある=過去列読みの疑い)。値ありのみ対象。
  const leakCands = TIMELINE_LEAK_ITEMS
    .filter((it) => it.hint.test(rawFull) && currentValAny(it.names) != null)
    .map((it) => ({ kind: 'leak' as const, label: it.label, names: it.names }));
  const allCands: Array<
    | { kind: 'fill'; label: string; names: string[]; allow: RegExp }
    | { kind: 'leak'; label: string; names: string[] }
  > = [...fillCands, ...leakCands];
  if (allCands.length === 0) return { measurements, audit: [] };

  const audit: VqaAuditEntry[] = [];
  type VqaItem = { name?: string; value?: string; past_seen?: string; present?: boolean };
  let items: VqaItem[] = [];
  try {
    const res = await callGemini(
      apiKey,
      {
        systemInstruction: { parts: [{ text: BOUNDARY_RECHECK_SYSTEM }] },
        contents: [
          {
            role: 'user',
            parts: [
              { inline_data: { mime_type: mimeType, data: imageBase64 } },
              { text: buildBoundaryRecheckUser(allCands.map((c) => c.label)) },
            ],
          },
        ],
        generationConfig: { ...BOUNDARY_RECHECK_GENERATION_CONFIG },
      },
      MODELS.scan,
    );
    const parsed = JSON.parse(stripJsonCodeFence(extractText(res))) as { items?: VqaItem[] };
    if (Array.isArray(parsed.items)) items = parsed.items;
  } catch {
    // 再読失敗は補正なしで続行 (一次結果を壊さない)。監査に vqa_error を残す。
    for (const c of allCands) {
      const before = currentValAny(c.names);
      const reason: VqaAuditEntry['reason'] = c.kind === 'leak' ? 'timeline_leak' : before == null ? 'missing_detection' : 'unexpected_token';
      audit.push({ name: c.names[0], reason, before, vqa: null, action: 'vqa_error' });
    }
    return { measurements, audit };
  }

  // VQA 回答を候補ラベルへ対応付け (ラベル/正規化名/包含)。
  const vqaByLabel = new Map<string, VqaItem>();
  for (const it of items) {
    const cand =
      allCands.find((c) => c.label === it.name) ||
      allCands.find((c) => c.names.some((n) => normNameKey(n) === normNameKey(it.name || ''))) ||
      allCands.find((c) => c.names.some((n) => (it.name || '').includes(n)));
    if (cand) vqaByLabel.set(cand.label, it);
  }

  const out = measurements.slice();
  const idxOfAny = (names: string[]): number =>
    out.findIndex((m) => names.some((n) => normNameKey(m.name || '') === normNameKey(n)));

  for (const cand of allCands) {
    const vqa = vqaByLabel.get(cand.label);
    const before = currentValAny(cand.names);

    if (cand.kind === 'fill') {
      const reason: VqaAuditEntry['reason'] = before == null ? 'missing_detection' : 'unexpected_token';
      const rawv0 = !vqa || vqa.present === false ? '' : typeof vqa.value === 'string' ? vqa.value.trim() : '';
      // 素のサイン/ダッシュ (-/−/＋/全角) を括弧付き定性トークンへ正規化 (present:false=空 は rawv0='' で対象外)。
      const rawv = normalizeQualToken(rawv0);
      // fail-safe: 空/"?"(判定不能)/許可集合外 の VQA 回答は採用しない。
      const val = rawv === '' || rawv.includes('?') ? null : cleanDeliveryValue(rawv);
      if (val == null || !cand.allow.test(val)) { audit.push({ name: cand.names[0], reason, before, vqa: rawv0 || null, action: 'left_unresolved' }); continue; }
      const idx = idxOfAny(cand.names);
      if (idx < 0) {
        // 該当行が主パス結果に無い = この様式に当該項目が無い可能性 → 新規 push は捏造リスク
        //   (実測 2026-08: K-W の無い様式で VQA が 0 を push=捏造 / 潜血の検便ページ跨ぎ push=重複)。
        //   捏造ゼロのため push しない。充填は「主パスが行を作った=様式に存在が確認済」の空行のみに限定。
        audit.push({ name: cand.names[0], reason, before, vqa: val, action: 'left_unresolved' });
        continue;
      }
      const cur = cleanDeliveryValue(out[idx].value);
      if (cur == null) {
        // missing_detection: 空欄を VQA の妥当トークンで補完 (numeric には来ない=定性HIGHのみ)。
        out[idx] = tidyMeasurement({ ...(out[idx] as ElithMeasurement), value: val, value_num: null, note: 'vqa:missing_detection' });
        audit.push({ name: cand.names[0], reason, before, vqa: val, action: 'filled' });
      } else if (!cand.allow.test(cur)) {
        // unexpected_token: 許可集合外の誤読 (例 "1") を上書き。**既に妥当な値・numeric は不変**。
        out[idx] = tidyMeasurement({ ...(out[idx] as ElithMeasurement), value: val, value_num: null, note: 'vqa:unexpected_token' });
        audit.push({ name: cand.names[0], reason, before, vqa: val, action: 'overwritten' });
      } else {
        audit.push({ name: cand.names[0], reason, before, vqa: val, action: 'left_unresolved' }); // 既に妥当 → 触らない
      }
      continue;
    }

    // kind === 'leak' : ③ガード (VQA今回空 & 過去列に値 & 現value==過去列値) を全満たしの時だけ削除 (値→空)。
    const idx = idxOfAny(cand.names);
    const cur = idx >= 0 ? cleanDeliveryValue(out[idx].value) : null;
    const todayRaw = vqa && vqa.present !== false && typeof vqa.value === 'string' ? vqa.value.trim() : '';
    const vqaTodayEmpty = vqa != null && vqa.present !== false && !todayRaw.includes('?') && cleanDeliveryValue(todayRaw) == null; // VQAが今回空と明言
    const vqaPast = vqa && typeof vqa.past_seen === 'string' ? cleanDeliveryValue(vqa.past_seen) : null;
    const summary = vqa ? `today=${vqa.value ?? '-'} / past=${vqa.past_seen ?? '-'}` : null;
    if (idx >= 0 && cur != null && vqaTodayEmpty && vqaPast != null && sameLoose(cur, vqaPast)) {
      // ③全満たし → 過去列読みの False-Value と断定して削除。**誤削除防止のため value==過去値の一致を必須**。
      out[idx] = { ...(out[idx] as ElithMeasurement), value: null, value_num: null, note: 'vqa:timeline_leak_dropped' };
      audit.push({ name: cand.names[0], reason: 'timeline_leak', before, vqa: summary, action: 'dropped' });
    } else {
      audit.push({ name: cand.names[0], reason: 'timeline_leak', before, vqa: summary, action: 'left_unresolved' });
    }
  }
  return { measurements: out, audit };
}

// ── ① 行クロップ独立VQA (env SCAN_VQA_ROWCROP=on・既定off・Vercel🎯検証前提) ──────────────
// 目的: timeline_leak(今回=空が正)なのに、主パスも全画像VQAも今回セルに過去値を読む「相関失敗」の救済。
//   実測(2026-08): 眼圧 右/左=16 を主パス+全画像VQA が両方 today=16 と読み、Phase2の削除3条件を満たせず
//   False-Value が残存。対策=全画像でなく「その行だけを切り出した独立画像」で今回セルを読み直す
//   (=ページ全体の"今回列は空"バイアス/過去列の引力を物理的に排除。ReaderとRepairの失敗モードを非相関化)。
// 安全設計: sharp は遅延 import + 全 try/catch。失敗時は一切変更しない(フォールバック=現挙動)。既定 off。
export function rowCropEnabled(): boolean {
  return String(process.env.SCAN_VQA_ROWCROP || '').toLowerCase() === 'on';
}
const ROWCROP_LOCATE_SYSTEM = `あなたは健診結果表の座標特定器です。指定された行と、表の列見出し行の位置だけを答えます。`;
function buildRowLocateUser(label: string): string {
  return `画像から次の2領域の位置(0-1000正規化 [ymin,xmin,ymax,xmax])を求めよ:
1) row_bbox = 「${label}」の行(項目名〜単位までの横一列)。
2) header_bbox = その表の列見出し行(「今回」「前回(受診日)」「前々回(受診日)」等の見出しが横に並ぶ行)。
出力はJSONのみ: {"row_bbox":[...],"header_bbox":[...]}。見つからない領域は null。`;
}
const ROWCROP_CONFIRM_SYSTEM = `あなたは健診結果表の監査役です。渡された画像は上段に「列見出し行」、下段に対象の「1行」を
縦に並べたものです。上段の見出しで列位置を合わせ、下段の行の「今回」列セルだけを厳密に確認します。推測は禁止。`;
function buildRowConfirmUser(label: string): string {
  return `この画像は上段=列見出し行(今回/前回/前々回 等)、下段=「${label}」の行。上下は同じ横位置で揃っている。
上段の見出し「今回」の真下の列だけを読め。前回・前々回(受診日付きの見出し)の下の値を今回として拾わない。
・今回列セルが空欄なら today は空文字にする。
・past_seen には前回/前々回列に見えた値を必ず報告する(複数あれば代表1つ。無ければ空)。
出力はJSONのみ:
{"today":"<今回セルの値。空欄なら空文字>","past_seen":"<前回/前々回列の値。無ければ空>","present":<今回セルに印字があれば true, 空欄なら false>}`;
}
function pickBbox(b: unknown): number[] | null {
  return Array.isArray(b) && b.length >= 4 && b.every((x) => typeof x === 'number' && Number.isFinite(x))
    ? (b.slice(0, 4) as number[]) : null;
}
function parseLocateBboxes(text: string): { row: number[] | null; header: number[] | null } {
  try {
    const o = JSON.parse(stripJsonCodeFence(text)) as { row_bbox?: unknown; header_bbox?: unknown };
    return { row: pickBbox(o.row_bbox), header: pickBbox(o.header_bbox) };
  } catch { return { row: null, header: null }; }
}
// ヘッダ帯(あれば)+ 対象行帯 を全幅で切り出し縦連結して PNG base64 で返す。
//   全幅=今回/前回/前々回 列を保持し、上にヘッダを付けることで切り出し画像でも列を対応付けられる
//   (実測: ヘッダ無しの行のみだと今回/前回の取り違えが残る=眼圧右 today=16)。
async function cropRowStripBase64(imageBase64: string, headerBbox: number[] | null, rowBbox: number[]): Promise<string | null> {
  try {
    const sharpMod = (await import('sharp')).default;
    const buf = Buffer.from(imageBase64, 'base64');
    const meta = await sharpMod(buf).metadata();
    const W = meta.width, H = meta.height;
    if (!W || !H) return null;
    const bandOf = async (bbox: number[] | null, pad: number): Promise<{ buf: Buffer; h: number } | null> => {
      if (!bbox) return null;
      const [ymin, , ymax] = bbox;
      if (!(ymax > ymin) || ymin < 0 || ymax > 1000) return null;
      const p = Math.round(pad * H);
      const top = Math.max(0, Math.round((ymin / 1000) * H) - p);
      const bottom = Math.min(H, Math.round((ymax / 1000) * H) + p);
      const h = bottom - top;
      if (h < 6) return null;
      return { buf: await sharpMod(buf).extract({ left: 0, top, width: W, height: h }).toBuffer(), h };
    };
    const row = await bandOf(rowBbox, 0.02);
    if (!row) return null;
    const header = await bandOf(headerBbox, 0.006); // ヘッダは取れなくても行のみで続行
    const bands = header ? [header, row] : [row];
    const gap = header ? 8 : 0;
    const totalH = bands.reduce((s, b) => s + b.h, 0) + gap * (bands.length - 1);
    const comps: { input: Buffer; top: number; left: number }[] = [];
    let y = 0;
    for (const b of bands) { comps.push({ input: b.buf, top: y, left: 0 }); y += b.h + gap; }
    const outBuf = await sharpMod({ create: { width: W, height: totalH, channels: 3, background: '#ffffff' } })
      .composite(comps).png().toBuffer();
    return outBuf.toString('base64');
  } catch {
    return null;
  }
}
/** timeline_leak が left_unresolved のまま値を保持する行を、行クロップ独立VQAで再確認して削除する。 */
async function rowCropLeakRescue(
  apiKey: string, imageBase64: string, mimeType: string,
  out: ElithMeasurement[], audit: VqaAuditEntry[],
): Promise<void> {
  const idxOf = (names: string[]): number =>
    out.findIndex((m) => names.some((n) => normNameKey(m.name || '') === normNameKey(n)));
  for (const it of TIMELINE_LEAK_ITEMS) {
    const idx = idxOf(it.names);
    if (idx < 0) continue;
    const cur = cleanDeliveryValue(out[idx].value);
    if (cur == null) continue; // 既に空(削除済/未読)なら対象外
    try {
      const loc = await callGemini(apiKey, {
        systemInstruction: { parts: [{ text: ROWCROP_LOCATE_SYSTEM }] },
        contents: [{ role: 'user', parts: [
          { inline_data: { mime_type: mimeType, data: imageBase64 } },
          { text: buildRowLocateUser(it.label) },
        ] }],
        generationConfig: { responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
      }, MODELS.scan);
      const loc2 = parseLocateBboxes(extractText(loc));
      if (!loc2.row) { audit.push({ name: it.names[0], reason: 'timeline_leak', before: cur, vqa: 'rowcrop:locate_failed', action: 'left_unresolved' }); continue; }
      const strip = await cropRowStripBase64(imageBase64, loc2.header, loc2.row);
      if (!strip) { audit.push({ name: it.names[0], reason: 'timeline_leak', before: cur, vqa: 'rowcrop:crop_failed', action: 'left_unresolved' }); continue; }
      const conf = await callGemini(apiKey, {
        systemInstruction: { parts: [{ text: ROWCROP_CONFIRM_SYSTEM }] },
        contents: [{ role: 'user', parts: [
          { inline_data: { mime_type: 'image/png', data: strip } }, // 連結クロップは PNG
          { text: buildRowConfirmUser(it.label) },
        ] }],
        generationConfig: { responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
      }, MODELS.scan);
      const ans = JSON.parse(stripJsonCodeFence(extractText(conf))) as { today?: string; past_seen?: string; present?: boolean };
      const todayRaw = ans && typeof ans.today === 'string' ? ans.today.trim() : '';
      // 今回空の判定: present:false(印字なし) か today値が空 のいずれか。'?'(判定不能)は空扱いにしない。
      const todayEmpty = ans != null && !todayRaw.includes('?') && (ans.present === false || cleanDeliveryValue(todayRaw) == null);
      const past = ans && typeof ans.past_seen === 'string' ? cleanDeliveryValue(ans.past_seen) : null;
      const summary = `rowcrop today=${ans?.today ?? '-'} / past=${ans?.past_seen ?? '-'}`;
      // ③3条件 (行クロップVQAが今回空 & 過去列に値 & 現value==過去値) 全満たしの時だけ削除。誤削除防止。
      if (todayEmpty && past != null && cur.replace(/\s/g, '') === past.replace(/\s/g, '')) {
        out[idx] = { ...(out[idx] as ElithMeasurement), value: null, value_num: null, note: 'vqa:rowcrop_leak_dropped' };
        audit.push({ name: it.names[0], reason: 'timeline_leak', before: cur, vqa: summary, action: 'dropped' });
      } else {
        audit.push({ name: it.names[0], reason: 'timeline_leak', before: cur, vqa: summary, action: 'left_unresolved' });
      }
    } catch {
      // フォールバック: 失敗は本経路を壊さない (現値を維持)。
    }
  }
}

/**
 * スキャン取得の統一入口。env で Markdown / JSON を切替え、両経路とも
 * 「監査用 raw・regions・measurements・notes・(schema由来)検査日」を同じ形で返す。
 * これにより scanImageToParsed / buildElithScanBundle は取得形式を意識せず共用できる。
 */
interface ScanArtifacts {
  rawFull: string;       // 検査日抽出用 (Markdown はコメント込み全文 / JSON は生JSON)
  cleanedRaw: string;    // 納品 raw_markdown 用 (bbox/exam コメント除去済)
  finishReason: string | null;
  regions: ScanRegionJson[];
  measurements: ElithMeasurement[];
  notes: string[];
  examDateFromScan: string | null; // JSON の exam_date (Markdown 経路は null → 本文抽出に委ねる)
  vqaAudit: VqaAuditEntry[];       // VQA 再読の監査 (可視化用・Elith 納品には含めない)
}
async function scanArtifacts(
  apiKey: string,
  imageBase64: string,
  mimeType: string,
  hint?: string | null,
): Promise<ScanArtifacts> {
  let art: ScanArtifacts;
  if (scanOutputFormat() === 'json') {
    const { parsed, raw, finishReason } = await scanImageJson(apiKey, imageBase64, mimeType, hint);
    const regions = jsonToRegions(parsed);
    art = {
      rawFull: raw,
      cleanedRaw: raw,
      finishReason,
      regions,
      measurements: toMeasurements(regions),
      notes: collectNotes(regions),
      examDateFromScan: normalizeSchemaExamDate(parsed.exam_date),
      vqaAudit: [],
    };
  } else {
    const { markdown, finishReason } = await scanImage(apiKey, imageBase64, mimeType, hint);
    if (!markdown.trim()) throw new Error(`empty scan result (finishReason=${finishReason})`);
    const regions = parseScanRegions(markdown);
    art = {
      rawFull: markdown,
      cleanedRaw: stripBboxComments(stripExamComment(markdown)),
      finishReason,
      regions,
      measurements: toMeasurements(regions),
      notes: collectNotes(regions),
      examDateFromScan: null,
      vqaAudit: [],
    };
  }
  // Phase 1/2: 境界定性項目の VQA 再読 (env で有効時のみ・定性HIGHのみ・numeric不変)。監査も回収。
  if (boundaryRecheckEnabled()) {
    const r = await boundaryRecheck(apiKey, imageBase64, mimeType, art.rawFull, art.measurements);
    art = { ...art, measurements: r.measurements, vqaAudit: r.audit };
  }
  // ① 行クロップ独立VQA (env SCAN_VQA_ROWCROP=on・既定off): timeline_leak の相関失敗残りを
  //   「行だけ切り出した独立画像」で読み直して削除。sharp遅延import+全try/catchで本経路は不変(フォールバック)。
  if (rowCropEnabled()) {
    const measurements = art.measurements.slice();
    const audit = (art.vqaAudit || []).slice();
    await rowCropLeakRescue(apiKey, imageBase64, mimeType, measurements, audit);
    art = { ...art, measurements, vqaAudit: audit };
  }
  return art;
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
  vqaAudit: VqaAuditEntry[]; // VQA 再読の監査 (可視化用・Elith 納品には含めない)
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

  const a = await scanArtifacts(apiKey, input.imageBase64, input.mimeType, input.hint);

  const todayIso = input.today || jstTodayIso();
  const provided = input.examDate && /^\d{4}-\d{2}-\d{2}$/.test(input.examDate) ? input.examDate : null;
  const { date: testDate, source: dateSource } = provided
    ? { date: provided, source: 'provided' }
    : a.examDateFromScan
      ? { date: a.examDateFromScan, source: 'exam_date' }
      : extractExamDate(a.rawFull, todayIso);

  return {
    // 納品用 raw_markdown は版面座標 (bbox) を含めない。regions(bbox付) は内部 (レビュー) 用に別途返す。
    markdown: a.cleanedRaw,
    finishReason: a.finishReason,
    testDate,
    dateSource,
    measurements: a.measurements,
    regions: a.regions,
    notes: a.notes,
    vqaAudit: a.vqaAudit,
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
  /** ②正準化の監査 (SCAN_CANONICALIZE=on のときのみ非 null)。Elith 納品 json には含めない (可視化用)。 */
  canon: CanonAudit | null;
  /** 後段 dedup の監査 (SCAN_OBS_DEDUP=on のときのみ非 null)。統合した別名重複と同名別値の競合。納品 json には含めない。 */
  dedup: DedupAudit | null;
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

  const a = await scanArtifacts(apiKey, input.imageBase64, input.mimeType, input.hint);
  const finishReason = a.finishReason;

  const todayIso = input.today || jstTodayIso();
  let testDate: string;
  let dateSource: string;
  const provided = input.examDate && /^\d{4}-\d{2}-\d{2}$/.test(input.examDate) ? input.examDate : null;
  if (provided) {
    testDate = provided;
    dateSource = 'provided';
  } else if (a.examDateFromScan) {
    testDate = a.examDateFromScan;
    dateSource = 'exam_date';
  } else {
    const ex = extractExamDate(a.rawFull, todayIso);
    testDate = ex.date;
    dateSource = ex.source;
  }
  const dateFolder = testDate.replace(/-/g, '_');

  const diagnosticId = input.diagnosticId || randomUuid();
  // 決定論整形（S4/S5）→ ②正準化（S1〜S3・SCAN_CANONICALIZE=on のときだけ）。監査は bundle.canon に返す。
  const keptMeasurements = sanitizeMeasurementsForDelivery(a.measurements).kept;
  const canonResult = canonicalizeEnabled() ? canonicalize(keptMeasurements) : null;
  const canonMeasurements = canonResult ? canonResult.delivery : keptMeasurements;
  // ①読取後段の決定論 dedup（課題C/B・SCAN_OBS_DEDUP=on のときだけ）。canonicalize 後に通す
  // （概念キーが canonical_name に揃った状態で別名重複を統合できる）。監査は bundle.dedup に返す。
  const dedupResult = obsDedupEnabled() ? dedupObservations(canonMeasurements) : null;
  const deliveryMeasurements = dedupResult ? dedupResult.delivery : canonMeasurements;
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
      // 書き出し時点の決定論整形（S4/S5）。SCAN_CANONICALIZE=on のとき②正準化（S1〜S3）を後段で通す。
      measurements: deliveryMeasurements,
      notes: a.notes,
    },
    raw_markdown: a.cleanedRaw,
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
    markdown: a.cleanedRaw,
    finishReason,
    files,
    canon: canonResult ? canonAudit(canonResult) : null,
    dedup: dedupResult ? dedupAudit(dedupResult) : null,
  };
}
