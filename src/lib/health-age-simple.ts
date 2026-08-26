/**
 * ウェルネス年齢 (生物学的年齢) — **簡易版** CABA/PhenoAge v7.0。
 *
 * 正規版 (`health-age.ts` / CABA v5.4) が要求する血球分画 (リンパ球%・MCV・RDW)・ALP・WBC・
 * hs-CRP を**持たない検査書式**(「メタボリックシンドローム＆生活習慣病セルフチェック」型の
 * 簡易血液検査報告書 等) 向けに、Wellfort から提供された簡易版計算ツール
 * `welltect_bioage_v71_protected.html` (難読化された配布物) を**そのまま移植**したもの。
 *
 * 【出典 (R1/R3)】移植元は上記 HTML の JS。難読化されていたため文字列テーブル復号 +
 * 定数畳み込みで復元し、**係数・基準値・上限はすべて復元後の実コードから転記**した
 * (推測値は 1 つも入れていない)。挙動は移植後に元 HTML を実ブラウザで走らせて数値照合済み
 * (`docs/scan/health_age_simple_v7.0_spec.md` の照合表)。
 *
 * 【正規版との違い (元 HTML の免責文より)】
 *  - 血球3項目 (リンパ球%・MCV・RDW)・ALP・WBC・hs-CRP は **常に集団中央値で補完** (寄与中立)。
 *    → PhenoAge 本体は実質 **アルブミン・クレアチニン・血糖・実年齢の 4 項目**で駆動される。
 *  - 血糖が無い場合は HbA1c から **推定平均血糖 eAG** を算出して代用
 *    (Nathan DM et al. ADAG Study, Diabetes Care 2008;31:1473-1478: eAG = 28.7 x HbA1c - 46.7)。
 *    **実測の空腹時血糖ではない**ので、結果には推定である旨を必ず併記する。
 *  - 尿酸・eGFR・HbA1c・LDL・中性脂肪・γ-GT・尿素窒素・BMI・腹囲・血圧は PhenoAge 原著の
 *    構成要素ではない **非原著の補助オーバーレイ** (係数は暫定値・自院コホートでの再較正前提)。
 *  - 最終的に実年齢との差を **tanh で圧縮** し、実年齢 ±5 歳付近へなだらかに漸近させる。
 *
 * 必須は **実年齢・アルブミン・クレアチニン**、および **血糖 または HbA1c のいずれか**。
 */

import { phenoAgeCore } from './health-age';

export const HEALTH_AGE_SIMPLE_MODEL_VERSION = 'CABA-SIMPLE-v7.0';

/** 簡易版の入力マーカー。albumin/creatinine と (glucose|hba1c) 以外はすべて任意。 */
export interface SimpleMarkers {
  age: number;
  sex: 'male' | 'female' | null;
  albumin?: number | null;    // g/dL   必須
  creatinine?: number | null; // mg/dL  必須
  glucose?: number | null;    // mg/dL  glucose か hba1c のどちらかが必須
  hba1c?: number | null;      // % (NGSP)
  // ── 補助オーバーレイ (任意) ──
  ua?: number | null;         // mg/dL 尿酸
  egfr?: number | null;       // mL/分/1.73m^2
  ldl?: number | null;        // mg/dL
  tg?: number | null;         // mg/dL 中性脂肪
  ggt?: number | null;        // U/L γ-GT
  bun?: number | null;        // mg/dL 尿素窒素
  bmi?: number | null;        // kg/m^2
  waist?: number | null;      // cm 腹囲
  sbp?: number | null;        // mmHg 収縮期
  dbp?: number | null;        // mmHg 拡張期
}

export interface OverlayContribution {
  id: string;
  name: string;
  value: number;
  adj: number; // 歳 (キャップ適用後)
}

export interface SimpleHealthAgeResult {
  ok: boolean;
  model_version: string;
  chronological_age: number;
  biological_age: number | null;
  delta: number | null;
  pheno_base: number | null;              // PhenoAge本体 (オーバーレイ・圧縮前)
  glucose_source: 'measured' | 'eag' | null;
  glucose_used: number | null;            // 実際に式へ入れた血糖 (eAG のときは推定値)
  overlay_total: number | null;
  overlay_contributions: OverlayContribution[];
  creat_sex_shift: number;
  /** 常に中央値補完される項目 (寄与は中立)。参考値であることの表示に使う。 */
  imputed_markers: string[];
  missing_required: string[];
}

/**
 * 集団中央値 (移植元 `REF`)。簡易版は血球系・CRP を**常に**この値で埋める。
 * albumin/creatinine/glucose は「中央値に置換した場合との差分」表示用で、
 * 計算そのものには実測値を使う。
 */
const REF = {
  albumin: 4.4, creatinine: 0.85, glucose: 92,
  crp: 0.15, lymph: 32, mcv: 90, rdw: 13, alp: 65, wbc: 5.5,
} as const;

/** 常に中央値補完される (= 参考値扱いの根拠になる) マーカー。 */
const ALWAYS_IMPUTED = ['crp', 'lymph', 'mcv', 'rdw', 'alp', 'wbc'] as const;

/**
 * 性別正規化 (移植元 `SEX_NORM`)。**クレアチニンのみ有効** (`enabled: true`)。
 * アルブミンは移植元で `enabled: false` のため補正しない。
 */
const SEX_NORM_CREAT = { male: 0.86, female: 0.63, ref: 0.85 } as const;

/** 補助オーバーレイ (移植元 `OVERLAY_ITEMS`)。dir=higher は高値が加齢方向・lower は低値が加齢方向。 */
const OVERLAY_ITEMS: {
  id: keyof SimpleMarkers; name: string; ref: number; slope: number; cap: number; dir: 'higher' | 'lower';
}[] = [
  { id: 'sbp',   name: '収縮期血圧', ref: 120, slope: 0.06,  cap: 3,   dir: 'higher' },
  { id: 'dbp',   name: '拡張期血圧', ref: 80,  slope: 0.08,  cap: 2,   dir: 'higher' },
  { id: 'ua',    name: '尿酸',       ref: 6,   slope: 0.3,   cap: 2,   dir: 'higher' },
  { id: 'egfr',  name: 'eGFR',       ref: 90,  slope: 0.04,  cap: 3,   dir: 'lower'  },
  { id: 'hba1c', name: 'HbA1c',      ref: 5.5, slope: 1.2,   cap: 3,   dir: 'higher' },
  { id: 'ldl',   name: 'LDL-C',      ref: 120, slope: 0.02,  cap: 1.5, dir: 'higher' },
  { id: 'tg',    name: '中性脂肪',   ref: 100, slope: 0.008, cap: 1.5, dir: 'higher' },
  { id: 'ggt',   name: 'γ-GT',       ref: 30,  slope: 0.02,  cap: 1.5, dir: 'higher' },
  { id: 'bun',   name: '尿素窒素',   ref: 15,  slope: 0.05,  cap: 1.5, dir: 'higher' },
  { id: 'bmi',   name: 'BMI',        ref: 22,  slope: 0.15,  cap: 2,   dir: 'higher' },
];
/** 腹囲は基準値が性別で変わるため OVERLAY_ITEMS と別扱い (移植元も別ブロック)。 */
const WAIST = { refMale: 85, refFemale: 90, slope: 0.08, cap: 2 } as const;

/** 実年齢との差の圧縮幅 (歳)。移植元: `5 * Math.tanh(delta / 5)`。 */
const COMPRESS_SCALE = 5;
/** 最終クランプ (移植元と同値)。 */
const AGE_CLAMP = { lo: 18, hi: 95 } as const;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * 推定平均血糖 (eAG)。Nathan DM et al. ADAG Study, Diabetes Care 2008;31:1473-1478。
 * eAG(mg/dL) = 28.7 x HbA1c(%) - 46.7
 */
export function estimateGlucoseFromHbA1c(hba1c: number): number {
  return 28.7 * hba1c - 46.7;
}

/** 簡易版の必須充足チェック。`computable=true` なら算出可能。 */
export function simpleRequiredCoverage(
  m: Partial<SimpleMarkers>,
): { present: string[]; missing: string[]; computable: boolean } {
  const present: string[] = [];
  const missing: string[] = [];
  for (const k of ['albumin', 'creatinine'] as const) {
    (num(m[k]) !== null ? present : missing).push(k);
  }
  const hasGlucose = num(m.glucose) !== null;
  const hasHba1c = num(m.hba1c) !== null;
  if (hasGlucose) present.push('glucose');
  else if (hasHba1c) present.push('hba1c');
  else missing.push('glucose|hba1c');
  return { present, missing, computable: missing.length === 0 };
}

/** 簡易版でウェルネス年齢を算出する。必須不足なら ok=false + missing_required。 */
export function computeSimpleHealthAge(m: SimpleMarkers): SimpleHealthAgeResult {
  const age = num(m.age);
  const cov = simpleRequiredCoverage(m);

  const base: SimpleHealthAgeResult = {
    ok: false,
    model_version: HEALTH_AGE_SIMPLE_MODEL_VERSION,
    chronological_age: age ?? NaN,
    biological_age: null,
    delta: null,
    pheno_base: null,
    glucose_source: null,
    glucose_used: null,
    overlay_total: null,
    overlay_contributions: [],
    creat_sex_shift: 0,
    imputed_markers: [...ALWAYS_IMPUTED],
    missing_required: cov.missing,
  };
  if (age === null || !cov.computable) return base;

  const albumin = num(m.albumin)!;
  const creat = num(m.creatinine)!;

  // 血糖: 実測優先。無ければ HbA1c から eAG を推定して代用する。
  const glucoseMeasured = num(m.glucose);
  const hba1c = num(m.hba1c);
  const glucoseSource: 'measured' | 'eag' = glucoseMeasured !== null ? 'measured' : 'eag';
  const glucose = glucoseMeasured !== null ? glucoseMeasured : estimateGlucoseFromHbA1c(hba1c!);

  // クレアチニンの性別正規化 (位置シフト)。sex 未選択は無補正 (移植元 normalizeBySex と同じ)。
  const creatShift =
    m.sex === 'male' || m.sex === 'female' ? SEX_NORM_CREAT.ref - SEX_NORM_CREAT[m.sex] : 0;

  // PhenoAge 本体。血球系・CRP は常に中央値 (= 寄与中立)。
  const { pheno } = phenoAgeCore({
    albumin,
    creatinine: creat + creatShift,
    glucose,
    crp: REF.crp,
    lymph: REF.lymph,
    mcv: REF.mcv,
    rdw: REF.rdw,
    alp: REF.alp,
    wbc: REF.wbc,
    age,
  });

  // 補助オーバーレイ (PhenoAge 外)。空欄は加算しない。
  const contributions: OverlayContribution[] = [];
  let overlayTotal = 0;
  for (const it of OVERLAY_ITEMS) {
    const v = num(m[it.id] as unknown);
    if (v === null) continue;
    const dev = (it.dir === 'higher' ? v - it.ref : it.ref - v) * it.slope;
    const adj = clamp(dev, -it.cap, it.cap);
    overlayTotal += adj;
    contributions.push({ id: it.id as string, name: it.name, value: v, adj });
  }
  const waist = num(m.waist);
  if (waist !== null) {
    const ref = m.sex === 'female' ? WAIST.refFemale : WAIST.refMale;
    const adj = clamp((waist - ref) * WAIST.slope, -WAIST.cap, WAIST.cap);
    overlayTotal += adj;
    contributions.push({ id: 'waist', name: '腹囲', value: waist, adj });
  }

  // 実年齢との差を tanh で圧縮 (急なカットオフではなく連続的に ±COMPRESS_SCALE へ漸近)。
  const rawDelta = pheno + overlayTotal - age;
  const compressed = COMPRESS_SCALE * Math.tanh(rawDelta / COMPRESS_SCALE);
  const bio = Math.round(clamp(age + compressed, AGE_CLAMP.lo, AGE_CLAMP.hi) * 10) / 10;

  return {
    ...base,
    ok: true,
    biological_age: bio,
    delta: Math.round((bio - age) * 10) / 10,
    pheno_base: Math.round(pheno * 10) / 10,
    glucose_source: glucoseSource,
    glucose_used: Math.round(glucose * 10) / 10,
    overlay_total: Math.round(overlayTotal * 100) / 100,
    overlay_contributions: contributions.map((c) => ({ ...c, adj: Math.round(c.adj * 100) / 100 })),
    creat_sex_shift: Math.round(creatShift * 100) / 100,
    missing_required: [],
  };
}
