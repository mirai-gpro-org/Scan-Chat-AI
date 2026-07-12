/**
 * 健康年齢 (生物学的年齢) の決定論計算 — CABA v4d (Levine 2018 Phenotypic Age ベース)。
 *
 * ロジックは `biological_age_calculator_v4d.html` (PMID 30596641 / Levine 2018 PMID 29676998)
 * をそのまま移植。LLM は使わない (血液CSVパーサ `elith-blood-csv.ts` と同思想)。
 *
 * - `computeHealthAge(markers)`  : 正規化済みマーカー → 生物学的年齢と内訳。
 * - `normalizeMarkers(items)`    : 人間ドック measurements[] / 血液 items[] の自由テキストを
 *                                  CABA 入力マーカーへ正規化 (名称同義語マッチ + 数値パース)。
 *
 * 必須9項目: age, albumin, creatinine, glucose, crp, lymph, mcv, alp, sbp
 * (wbc 未入力は 6.0 で補完 / RDW は特定健診に無いため 13.0 固定 / bmi・sex は年数補正)。
 */

export const HEALTH_AGE_MODEL_VERSION = 'CABA-v4d';

/** CABA 入力マーカー (すべて数値。sex は補正用)。 */
export interface HealthAgeMarkers {
  age: number;
  sex: 'male' | 'female' | null;
  albumin?: number | null;    // g/dL
  creatinine?: number | null; // mg/dL
  glucose?: number | null;    // mg/dL (空腹時)
  crp?: number | null;        // mg/dL (高感度)
  lymph?: number | null;      // %
  mcv?: number | null;        // fL
  alp?: number | null;        // U/L
  sbp?: number | null;        // mmHg (収縮期)
  bmi?: number | null;        // kg/m^2
  wbc?: number | null;        // ×10^3/μL (任意)
  fev1fvc?: number | null;    // % (任意)
}

export interface HealthAgeResult {
  ok: boolean;
  model_version: string;
  chronological_age: number;
  biological_age: number | null; // 小数第1位まで
  delta: number | null;          // biological - chronological
  mortality_risk: number | null; // 0..1 (Gompertz 10年)
  pheno_base: number | null;
  adjustments: { sbp: number; fev: number; bmi: number; sex: number; total: number } | null;
  used_markers: string[];        // 実測が入った必須マーカー
  carried_markers: string[];     // 据え置きされたマーカー (血液回の前回ドック値など。呼び出し側が設定)
  imputed_markers: string[];     // 測定値が無く標準値で補完したマーカー (crp 等 → 参考値)
  missing_required: string[];    // 欠落している必須マーカー (age 除く)
}

/**
 * ハード必須マーカー (これらが欠けると算出不可)。
 * CRP は標準的な人間ドックの血液パネルに含まれないことが多いため必須から外し、
 * 測定値が無い場合は健常者中央値で補完する (参考値。imputed_markers で明示)。
 */
const REQUIRED: (keyof HealthAgeMarkers)[] = [
  'albumin', 'creatinine', 'glucose', 'lymph', 'mcv', 'alp', 'sbp',
];
/** CRP 測定値が無いときの補完値 (健常者中央値 目安, mg/dL)。 */
const CRP_DEFAULT_MGDL = 0.1;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 適合チェック: CRP を除く必須マーカー (REQUIRED) の充足状況を返す。
 * CRP は補完前提のためここには含めない。`computable=true` なら算出可能 (CRPは補完)。
 */
export function requiredCoverage(
  m: Partial<HealthAgeMarkers>,
): { present: string[]; missing: string[]; computable: boolean } {
  const present: string[] = [];
  const missing: string[] = [];
  for (const k of REQUIRED) (num(m[k]) !== null ? present : missing).push(k as string);
  return { present, missing, computable: missing.length === 0 };
}

/**
 * 生物学的年齢を計算する。必須マーカーが欠ける場合は ok=false + missing_required を返す。
 * carriedMarkers は「据え置き/補完した」マーカー名 (時系列の透明性表示用)。
 */
export function computeHealthAge(m: HealthAgeMarkers, carriedMarkers: string[] = []): HealthAgeResult {
  const age = num(m.age);
  const missing: string[] = [];
  for (const k of REQUIRED) if (num(m[k]) === null) missing.push(k);
  const imputed: string[] = [];

  const base: HealthAgeResult = {
    ok: false,
    model_version: HEALTH_AGE_MODEL_VERSION,
    chronological_age: age ?? NaN,
    biological_age: null,
    delta: null,
    mortality_risk: null,
    pheno_base: null,
    adjustments: null,
    used_markers: REQUIRED.filter((k) => num(m[k]) !== null && !carriedMarkers.includes(k)) as string[],
    carried_markers: carriedMarkers,
    imputed_markers: imputed,
    missing_required: missing,
  };
  if (age === null || missing.length > 0) return base;

  const albumin = num(m.albumin)!;
  const creat = num(m.creatinine)!;
  const glucose = num(m.glucose)!;
  // CRP は測定値が無ければ標準値で補完 (参考値扱い)。
  let crp = num(m.crp);
  if (crp === null) { crp = CRP_DEFAULT_MGDL; imputed.push('crp'); }
  const lymph = num(m.lymph)!;
  const mcv = num(m.mcv)!;
  const alp = num(m.alp)!;
  const sbp = num(m.sbp)!;
  const wbc = num(m.wbc) ?? 6.0;         // 未入力は 6.0
  const bmi = num(m.bmi);
  const fev1fvc = num(m.fev1fvc);

  // --- 単位換算 (Levine 原著の入力単位に合わせる) ---
  const albumin_gL = albumin * 10;       // g/dL -> g/L
  const creat_umol = creat * 88.4;       // mg/dL -> µmol/L
  const glucose_mmol = glucose / 18.0;   // mg/dL -> mmol/L
  const crp_ln = Math.log(Math.max(crp, 0.01)); // ln(mg/dL)
  const RDW = 13.0;                       // 特定健診に無い → 13.0% 近似

  // --- Levine 2018 線形予測子 ---
  const xb =
    -19.907 +
    (-0.0336 * albumin_gL) +
    (0.0095 * creat_umol) +
    (0.1953 * glucose_mmol) +
    (0.0954 * crp_ln) +
    (-0.0120 * lymph) +
    (0.0268 * mcv) +
    (0.3306 * RDW) +
    (0.00188 * alp) +
    (0.0554 * wbc) +
    (0.0804 * age);

  // --- Gompertz 10年死亡リスク ---
  const gamma = 0.0076927;
  const mortRisk = 1 - Math.exp((-Math.exp(xb) * (Math.exp(gamma * 120) - 1)) / gamma);
  const mortClamped = Math.min(mortRisk, 0.9999);

  // --- 逆変換 (原著定数) ---
  let phenoBase = 141.50225 + Math.log(-0.00553 * Math.log(1 - mortClamped)) / 0.090165;
  if (!Number.isFinite(phenoBase)) phenoBase = age;

  // --- CABA 独自の年数補正 (上限つき) ---
  const sbpAdj = Math.max(-4, Math.min(8, (sbp - 120) * 0.04));
  const fevAdj = fev1fvc === null ? 0 : Math.max(0, Math.min(6, (70 - fev1fvc) * 0.15));
  let bmiAdj = 0;
  if (bmi !== null) {
    if (bmi >= 25) bmiAdj = Math.min(8, (bmi - 25) * 0.5);
    else if (bmi < 18.5) bmiAdj = Math.min(6, (18.5 - bmi) * 0.6);
  }
  let sexAdj = 0;
  if (m.sex === 'female') sexAdj = -1.0;
  else if (m.sex === 'male') sexAdj = 1.0;

  let phenoAge = phenoBase + sbpAdj + fevAdj + bmiAdj + sexAdj;
  phenoAge = Math.max(18, Math.min(100, phenoAge));

  const bio = Math.round(phenoAge * 10) / 10;
  return {
    ...base,
    ok: true,
    biological_age: bio,
    delta: Math.round((bio - age) * 10) / 10,
    mortality_risk: mortRisk,
    pheno_base: Math.round(phenoBase * 10) / 10,
    adjustments: {
      sbp: sbpAdj, fev: fevAdj, bmi: bmiAdj, sex: sexAdj,
      total: Math.round((sbpAdj + fevAdj + bmiAdj + sexAdj) * 100) / 100,
    },
  };
}

// ── マーカー正規化 ──────────────────────────────────────────────
/** 人間ドック measurements[] / 血液 items[] 共通の最小フィールド。 */
export interface RawItem {
  name?: string | null;
  name_detail?: string | null;
  value?: string | number | null;
}

/** マーカー → 名称同義語 (小文字化・記号除去して部分一致で判定)。 */
const SYNONYMS: Record<Exclude<keyof HealthAgeMarkers, 'age' | 'sex'>, string[]> = {
  albumin: ['アルブミン', 'albumin', 'alb'],
  // 'cr' は 'crp' に部分一致して誤爆するため入れない
  creatinine: ['クレアチニン', 'creatinine', 'crea', 'cre'],
  glucose: ['空腹時血糖', '血糖', 'グルコース', 'glucose', 'glu', 'fpg'],
  crp: ['高感度crp', 'hscrp', 'crp', 'c反応性蛋白'],
  lymph: ['リンパ球比率', 'リンパ球', 'リンパ', 'lympho', 'lymph'],
  mcv: ['平均赤血球容積', 'mcv'],
  alp: ['アルカリフォスファターゼ', 'アルカリホスファターゼ', 'alp'],
  // 「血圧(収縮期/拡張期) 127/82」形式も拾えるよう '収縮期' を含める (値は先頭数値=収縮期)。
  // '最低血圧'/'拡張期' は '収縮期' を含まないため誤爆しない。
  sbp: ['収縮期血圧', '収縮期', '最高血圧', '大血圧', 'sbp', '血圧上'],
  bmi: ['bmi', '体格指数'],
  wbc: ['白血球数', '白血球', 'wbc'],
  fev1fvc: ['fev1/fvc', 'fev1.0%', '1秒率', 'fev1fvc'],
};
const HEIGHT_SYN = ['身長', 'height'];
const WEIGHT_SYN = ['体重', 'weight'];
// MCV を赤血球+ヘマトクリットから算出する場合の同義語
const RBC_SYN = ['赤血球数', '赤血球', 'rbc'];
const HCT_SYN = ['ヘマトクリット', 'hct'];

/** 全角英数字・記号を半角へ、全角スペースを半角へ (検査票は ＣＲＰ 等が全角のことがある)。 */
function toHalfWidth(s: string): string {
  return s
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}
function canon(s: string | null | undefined): string {
  return toHalfWidth(s ?? '').toLowerCase().replace(/[\s（）()：:・,，]/g, '');
}
/** "8.1 L" / "104.1 H" / "1,234" → 先頭の数値。数値化不能は null。 */
function parseNumeric(v: string | number | null | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}
/** item の名称がマーカーの同義語に一致するか (name / name_detail のどちらでも)。 */
function matches(item: RawItem, syns: string[]): boolean {
  const a = canon(item.name);
  const b = canon(item.name_detail);
  return syns.some((s) => {
    const c = canon(s);
    return (a && a.includes(c)) || (b && b.includes(c));
  });
}

/**
 * 自由テキストの検査項目配列から CABA マーカーを抽出する。
 * 見つかった項目のみ設定 (age/sex は含まない — 呼び出し側が付与)。
 * BMI が無く身長・体重があれば BMI を算出。
 */
export function normalizeMarkers(items: RawItem[]): Partial<HealthAgeMarkers> {
  const out: Partial<HealthAgeMarkers> = {};
  const keys = Object.keys(SYNONYMS) as (keyof typeof SYNONYMS)[];
  for (const key of keys) {
    for (const it of items) {
      if (matches(it, SYNONYMS[key])) {
        const n = parseNumeric(it.value ?? null);
        if (n !== null) { out[key] = n; break; }
      }
    }
  }
  // BMI 補完 (身長cm・体重kg から)
  if (out.bmi == null) {
    let h: number | null = null, w: number | null = null;
    for (const it of items) {
      if (h === null && matches(it, HEIGHT_SYN)) h = parseNumeric(it.value ?? null);
      if (w === null && matches(it, WEIGHT_SYN)) w = parseNumeric(it.value ?? null);
    }
    if (h && w && h > 100 && h < 230) out.bmi = Math.round((w / ((h / 100) ** 2)) * 10) / 10;
  }
  // MCV 補完 (欄が空でも 赤血球 + ヘマトクリット から算出可)。
  // MCV(fL) = Ht(%) / RBC(10^6/µL) × 10。RBC は ×10^4 表記(例 482)と ×10^6 表記(例 4.82)が
  // 混在するため magnitude で吸収し、算出値が生理的範囲のときだけ採用する。
  if (out.mcv == null) {
    let rbc: number | null = null, hct: number | null = null;
    for (const it of items) {
      if (rbc === null && matches(it, RBC_SYN)) rbc = parseNumeric(it.value ?? null);
      if (hct === null && matches(it, HCT_SYN)) hct = parseNumeric(it.value ?? null);
    }
    if (rbc && hct) {
      const rbcM = rbc > 50 ? rbc / 100 : rbc; // 482→4.82 / 4.82→4.82
      if (rbcM > 2 && rbcM < 8) {
        const mcv = Math.round((hct / rbcM) * 10 * 10) / 10;
        if (mcv >= 60 && mcv <= 130) out.mcv = mcv;
      }
    }
  }
  return out;
}
