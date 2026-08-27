/**
 * ウェルネス年齢 (旧称: 健康年齢) の算出オーケストレーター。
 *
 * 【段階フォールバック (2026-08 確定・発注者指示)】
 *   ① 正規版 (CABA v5.4 / `health-age.ts`) で算出する。入力項目が不足していても、
 *      合理的な方法で補填できるものは補填して算出する (実装済):
 *        ・MCV      … 欄が無くても 赤血球 + ヘマトクリット から算出 (`normalizeMarkers`)
 *        ・RDW      … 集団中央値 13.0 で補完
 *        ・hs-CRP   … 好中球%/リンパ球% (NLR) から推定 → 無ければ中央値 0.15
 *        ・WBC      … 検査機関ごとの桁 (/μL, ×10²/μL, ×10³/μL) を自動正規化
 *   ② ①でも算出できない (必須マーカーが埋まらない) 場合は、
 *      **簡易版 (CABA/PhenoAge v7.0 / `health-age-simple.ts`)** で算出する。
 *      血球分画・ALP・WBC・hs-CRP を持たない簡易血液検査書式向けで、
 *      実年齢・アルブミン・クレアチニン・(血糖 または HbA1c) があれば算出できる。
 *   ③ ②でも算出できない場合は算出しない。画面・API は
 *      `WELLNESS_AGE_UNAVAILABLE_MESSAGE` をそのまま提示する (値は作らない = 捏造ゼロ)。
 *
 * 呼び出し側は `method` を見て「どちらで算出したか」を必ず表示・記録すること
 * (簡易版は補助オーバーレイの係数が暫定・血糖が eAG 推定になり得るため)。
 */

import {
  computeHealthAge,
  requiredCoverage,
  HEALTH_AGE_MODEL_VERSION,
  type HealthAgeMarkers,
  type HealthAgeResult,
} from './health-age';
import {
  computeSimpleHealthAge,
  simpleRequiredCoverage,
  HEALTH_AGE_SIMPLE_MODEL_VERSION,
  type SimpleMarkers,
  type SimpleHealthAgeResult,
} from './health-age-simple';

/** 画面・帳票で使う名称。2026-08 に「健康年齢」から改称 (発注者指示)。 */
export const WELLNESS_AGE_LABEL = 'ウェルネス年齢';

/** ③ 算出不能時に提示する文言。**この文字列を変えない** (発注者指定の定型文)。 */
export const WELLNESS_AGE_UNAVAILABLE_MESSAGE =
  '算出に必要なデータが不足しています。詳細は事務局へお問合せ下さい。';

/** どの版で算出したか。 */
export type WellnessAgeMethod = 'full' | 'simple' | 'unavailable';

/** 表示用の版ラベル。 */
export const METHOD_LABEL: Record<WellnessAgeMethod, string> = {
  full: '正規版 (CABA v5.4)',
  simple: '簡易版 (CABA v7.0)',
  unavailable: '算出不能',
};

export interface WellnessAgeResult {
  ok: boolean;
  /** 'full' = 正規版 / 'simple' = 簡易版 / 'unavailable' = ③ */
  method: WellnessAgeMethod;
  model_version: string;
  chronological_age: number;
  biological_age: number | null;
  delta: number | null;
  /** 正規版のみ (簡易版は移植元が出さないため null)。 */
  mortality_risk: number | null;
  /** method='unavailable' のときだけ ③ の定型文。それ以外は null。 */
  message: string | null;
  /** 算出に至らなかった理由 (正規版で不足していた必須マーカー)。 */
  missing_full: string[];
  /** 簡易版でも足りなかった必須 (unavailable のときのみ非空)。 */
  missing_simple: string[];
  used_markers: string[];
  carried_markers: string[];
  imputed_markers: string[];
  /** 簡易版で血糖を HbA1c から推定した場合 'eag'。正規版・未算出は null。 */
  glucose_source: 'measured' | 'eag' | null;
  /** 監査用の生結果 (API 応答の inputs にそのまま入れて追跡できるようにする)。 */
  full: HealthAgeResult;
  simple: SimpleHealthAgeResult | null;
}

/** HealthAgeMarkers (正規版入力) から簡易版の入力を組み立てる。値の変換はしない。 */
export function toSimpleMarkers(m: HealthAgeMarkers): SimpleMarkers {
  return {
    age: m.age,
    sex: m.sex,
    albumin: m.albumin ?? null,
    creatinine: m.creatinine ?? null,
    glucose: m.glucose ?? null,
    hba1c: m.hba1c ?? null,
    ua: m.ua ?? null,
    egfr: m.egfr ?? null,
    ldl: m.ldl ?? null,
    tg: m.tg ?? null,
    ggt: m.ggt ?? null,
    bun: m.bun ?? null,
    bmi: m.bmi ?? null,
    waist: m.waist ?? null,
    sbp: m.sbp ?? null,
    dbp: m.dbp ?? null,
  };
}

/**
 * ①→②→③ の順にウェルネス年齢を算出する。
 * `carriedMarkers` は「据え置き/補完した」マーカー名 (時系列表示の透明性用・正規版に渡す)。
 */
export function computeWellnessAge(
  markers: HealthAgeMarkers,
  carriedMarkers: string[] = [],
): WellnessAgeResult {
  // ① 正規版 (不足分は computeHealthAge / normalizeMarkers 側で合理的に補填済み)
  const full = computeHealthAge(markers, carriedMarkers);
  const missingFull = requiredCoverage(markers).missing;

  if (full.ok) {
    return {
      ok: true,
      method: 'full',
      model_version: HEALTH_AGE_MODEL_VERSION,
      chronological_age: full.chronological_age,
      biological_age: full.biological_age,
      delta: full.delta,
      mortality_risk: full.mortality_risk,
      message: null,
      missing_full: [],
      missing_simple: [],
      used_markers: full.used_markers,
      carried_markers: full.carried_markers,
      imputed_markers: full.imputed_markers,
      glucose_source: null,
      full,
      simple: null,
    };
  }

  // ② 簡易版
  const simpleIn = toSimpleMarkers(markers);
  const simple = computeSimpleHealthAge(simpleIn);
  if (simple.ok) {
    return {
      ok: true,
      method: 'simple',
      model_version: HEALTH_AGE_SIMPLE_MODEL_VERSION,
      chronological_age: simple.chronological_age,
      biological_age: simple.biological_age,
      delta: simple.delta,
      mortality_risk: null,
      message: null,
      missing_full: missingFull,
      missing_simple: [],
      used_markers: simpleRequiredCoverage(simpleIn).present,
      carried_markers: carriedMarkers,
      imputed_markers: simple.imputed_markers,
      glucose_source: simple.glucose_source,
      full,
      simple,
    };
  }

  // ③ 算出不能 — 値を作らず定型文を返す。
  return {
    ok: false,
    method: 'unavailable',
    model_version: '',
    chronological_age: markers.age,
    biological_age: null,
    delta: null,
    mortality_risk: null,
    message: WELLNESS_AGE_UNAVAILABLE_MESSAGE,
    missing_full: missingFull,
    missing_simple: simple.missing_required,
    used_markers: full.used_markers,
    carried_markers: carriedMarkers,
    imputed_markers: [],
    glucose_source: null,
    full,
    simple,
  };
}

/**
 * 算出前の適合チェック (mode=check 用)。実際に算出せず、どの版になるかだけを返す。
 * `computeWellnessAge` と同じ判定順・同じ関数を使う (二重管理しない)。
 */
export function wellnessAgeCoverage(
  m: Partial<HealthAgeMarkers>,
): { method: WellnessAgeMethod; missing_full: string[]; missing_simple: string[] } {
  const full = requiredCoverage(m);
  if (full.computable) return { method: 'full', missing_full: [], missing_simple: [] };
  const simple = simpleRequiredCoverage(toSimpleMarkers({ ...m, age: m.age ?? NaN, sex: m.sex ?? null }));
  if (simple.computable) return { method: 'simple', missing_full: full.missing, missing_simple: [] };
  return { method: 'unavailable', missing_full: full.missing, missing_simple: simple.missing };
}
