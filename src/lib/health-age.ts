/**
 * 健康年齢 (生物学的年齢) の決定論計算 — CABA v5.4 (Levine 2018 PhenoAge ベース)。
 *
 * ロジックは `biological_age_calculator_v5.4.html` (PMID 30596641 / Levine 2018) をそのまま移植。
 * LLM は使わない (血液CSVパーサ `elith-blood-csv.ts` と同思想)。
 *
 * v5.4 の v4d からの変更点:
 *  - 定数を原著実装に精緻化 (creat×88.42 / alp係数0.0019 / 切片-19.9067 / crp下限0.001)。
 *  - RDW を固定13.0でなく実測を使用 (無ければ中央値13.0で補完=imputed)。
 *  - 性別補正を「flat ±1.0歳」から「クレアチニンの性別正規化(位置シフト)」へ変更
 *    (男0.86/女0.63 → PhenoAge開発集団基準0.85 に一致させる shift。性差アーチファクト除去)。
 *  - CRP 未測定時は NLR(好中球%/リンパ球%)から対数線形で推定 → 無ければ中央値0.15で補完。
 *  - SBP/FEV1FVC は PhenoAge外の補助オーバーレイ (SBP:(sbp-120)*0.06±3 / FEV:(78-fev)*0.15∈[-2,3] / 合計±4)。
 *  - BMI 補正は廃止 (v5.4 では BMI は参考表示のみ・計算に使わない)。
 *  - 最終クランプ 18–95。
 *
 * 必須(ハード)9: age + albumin, creatinine, glucose, lymph, mcv, alp, wbc
 *   (RDW は無ければ13.0補完 / CRP は NLR or 0.15補完 / SBP・FEV1FVC・好中球 は任意)。
 */

export const HEALTH_AGE_MODEL_VERSION = 'CABA-v5.4';

/** CABA 入力マーカー (すべて数値。sex はクレアチニン正規化に使用)。 */
export interface HealthAgeMarkers {
  age: number;
  sex: 'male' | 'female' | null;
  albumin?: number | null;    // g/dL
  creatinine?: number | null; // mg/dL
  glucose?: number | null;    // mg/dL (空腹時)
  crp?: number | null;        // mg/dL (高感度)
  lymph?: number | null;      // %
  mcv?: number | null;        // fL
  rdw?: number | null;        // % (無ければ13.0補完)
  alp?: number | null;        // U/L (IFCC)
  wbc?: number | null;        // ×10^3/μL
  neut?: number | null;       // % (好中球。CRP未測定時の NLR 代用に使用)
  sbp?: number | null;        // mmHg (収縮期・オーバーレイ)
  fev1fvc?: number | null;    // % (1秒率・オーバーレイ)
  bmi?: number | null;        // kg/m^2 (参考表示のみ・計算に使わない)
}

export interface HealthAgeResult {
  ok: boolean;
  model_version: string;
  chronological_age: number;
  biological_age: number | null; // 小数第1位まで
  delta: number | null;          // biological - chronological
  mortality_risk: number | null; // 0..1 (Gompertz 10年 = 120か月)
  pheno_base: number | null;     // PhenoAge本体 (オーバーレイ前)
  crp_source: 'measured' | 'nlr' | 'imputed' | null; // CRP の由来
  adjustments: { sbp: number; fev: number; total: number; creat_sex_shift: number } | null;
  used_markers: string[];        // 実測が入った必須マーカー
  carried_markers: string[];     // 据え置きされたマーカー (呼び出し側が設定)
  imputed_markers: string[];     // 測定値が無く標準値で補完 (crp/rdw 等 → 参考値)
  missing_required: string[];    // 欠落している必須マーカー (age 除く)
}

/**
 * ハード必須マーカー (これらが欠けると算出不可)。
 * v5.4 の血液必須から RDW を除外し (人間ドック/特定健診に無いことが多く 13.0 補完で代替)、
 * SBP はオーバーレイ扱い(任意)。CRP は NLR/中央値補完前提のため必須に含めない。
 */
const REQUIRED: (keyof HealthAgeMarkers)[] = [
  'albumin', 'creatinine', 'glucose', 'lymph', 'mcv', 'alp', 'wbc',
];
// 以下の補完定数は Wellfort 確認済 (2026-08・確定・暫定でない)。詳細: docs/health_age_caba_v5.4_spec.md
const CRP_MEDIAN_MGDL = 0.15; // hs-CRP は任意入力。実測→NLR推定→この集団中央値で補完 (mg/dL・炎症寄与は中立)
const RDW_MEDIAN = 13.0;      // % RDW は検査機関により無し → 中央値13.0を代用 (Wellfort確認)
/**
 * クレアチニンの性別正規化: 各性別中央値を PhenoAge開発集団基準 ref に合わせる位置シフト。
 * Wellfort 確認 (2026-08): 男0.86/女0.63 は原著に無く性別選択時の基準として設定=**このまま使用(確定)**。
 */
const SEX_NORM_CREAT = { male: 0.86, female: 0.63, ref: 0.85 } as const;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * 適合チェック: 必須マーカー (REQUIRED) の充足状況を返す。
 * CRP/RDW は補完前提のためここに含めない。`computable=true` なら算出可能。
 */
export function requiredCoverage(
  m: Partial<HealthAgeMarkers>,
): { present: string[]; missing: string[]; computable: boolean } {
  const present: string[] = [];
  const missing: string[] = [];
  for (const k of REQUIRED) (num(m[k]) !== null ? present : missing).push(k as string);
  return { present, missing, computable: missing.length === 0 };
}

/** CRP を解決する (実測 → NLR推定 → 中央値補完)。 */
function resolveCRP(m: HealthAgeMarkers): { crp: number; source: 'measured' | 'nlr' | 'imputed' } {
  const crp = num(m.crp);
  if (crp !== null) return { crp, source: 'measured' };
  const neut = num(m.neut);
  const lymph = num(m.lymph);
  if (neut !== null && lymph !== null && lymph > 0) {
    const nlr = neut / lymph; // 好中球% / リンパ球%
    // 基準NLR≈2.0で中央値、上昇で炎症寄与増 (対数空間・減衰係数0.4)。
    return { crp: Math.exp(Math.log(CRP_MEDIAN_MGDL) + 0.4 * (nlr - 2.0)), source: 'nlr' };
  }
  return { crp: CRP_MEDIAN_MGDL, source: 'imputed' };
}

/** PhenoAge本体 (v5.4 定数)。入力: albumin g/dL, creat mg/dL, glucose mg/dL, crp mg/dL, 他は表示単位。 */
function phenoAgeCore(v: {
  albumin: number; creatinine: number; glucose: number; crp: number;
  lymph: number; mcv: number; rdw: number; alp: number; wbc: number; age: number;
}): { pheno: number; mortality: number } {
  const albumin_gL = v.albumin * 10;
  const creat_umol = v.creatinine * 88.42;
  const glucose_mmol = v.glucose / 18.0;
  const lncrp = Math.log(Math.max(v.crp, 0.001));

  const xb = -19.9067
    - 0.0336 * albumin_gL
    + 0.0095 * creat_umol
    + 0.1953 * glucose_mmol
    + 0.0954 * lncrp
    - 0.0120 * v.lymph
    + 0.0268 * v.mcv
    + 0.3306 * v.rdw
    + 0.0019 * v.alp
    + 0.0554 * v.wbc
    + 0.0804 * v.age;

  const g = 0.0076927;
  const M = 1 - Math.exp((-Math.exp(xb) * (Math.exp(g * 120) - 1)) / g);
  const Mc = Math.min(M, 0.999999);
  let pheno = 141.50225 + Math.log(-0.00553 * Math.log(1 - Mc)) / 0.090165;
  if (!Number.isFinite(pheno)) pheno = v.age;
  return { pheno, mortality: M };
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
    crp_source: null,
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
  const lymph = num(m.lymph)!;
  const mcv = num(m.mcv)!;
  const alp = num(m.alp)!;
  const wbc = num(m.wbc)!;

  // RDW: 実測優先。無ければ中央値補完 (参考値)。
  let rdw = num(m.rdw);
  if (rdw === null) { rdw = RDW_MEDIAN; imputed.push('rdw'); }

  // CRP: 実測 → NLR推定 → 中央値補完。
  const crpRes = resolveCRP(m);
  if (crpRes.source !== 'measured') imputed.push(crpRes.source === 'nlr' ? 'crp(nlr)' : 'crp');

  // クレアチニンの性別正規化 (位置シフト)。sex 未選択は無補正。
  let creatShift = 0;
  if (m.sex === 'male' || m.sex === 'female') creatShift = SEX_NORM_CREAT.ref - SEX_NORM_CREAT[m.sex];
  const creatAdj = creat + creatShift;

  const { pheno, mortality } = phenoAgeCore({
    albumin, creatinine: creatAdj, glucose, crp: crpRes.crp, lymph, mcv, rdw, alp, wbc, age,
  });

  // オーバーレイ (PhenoAge外・任意)。
  const sbp = num(m.sbp);
  const fev = num(m.fev1fvc);
  const sbpAdj = sbp === null ? 0 : clamp((sbp - 120) * 0.06, -3, 3);
  const fevAdj = fev === null ? 0 : clamp((78 - fev) * 0.15, -2, 3);
  const total = clamp(sbpAdj + fevAdj, -4, 4);

  const bioClamped = clamp(pheno + total, 18, 95);
  const bio = Math.round(bioClamped * 10) / 10;

  return {
    ...base,
    ok: true,
    biological_age: bio,
    delta: Math.round((bio - age) * 10) / 10,
    mortality_risk: mortality,
    pheno_base: Math.round(pheno * 10) / 10,
    crp_source: crpRes.source,
    adjustments: {
      sbp: Math.round(sbpAdj * 100) / 100,
      fev: Math.round(fevAdj * 100) / 100,
      total: Math.round(total * 100) / 100,
      creat_sex_shift: Math.round(creatShift * 100) / 100,
    },
  };
}

// ── マーカー正規化 ──────────────────────────────────────────────
/** 人間ドック measurements[] / 血液 items[] 共通の最小フィールド。 */
export interface RawItem {
  name?: string | null;
  name_detail?: string | null;
  value?: string | number | null;
  category?: string | null; // 区分/セクション名 (例 '血圧' '身体計測')。SBP 検出の文脈に使う (§7.1)
  region?: string | null; // 旧フィールド名。過去 JSON 互換のため読み込みは両対応
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
  rdw: ['赤血球分布幅', 'rdw-cv', 'rdwcv', 'rdw'],
  alp: ['アルカリフォスファターゼ', 'アルカリホスファターゼ', 'alp'],
  wbc: ['白血球数', '白血球', 'wbc'],
  // 好中球% (NLR代用)。'好中球' に一致 (分葉核球のみの様式は総好中球でないため拾わない=保守的)。
  neut: ['好中球比率', '好中球', 'neut'],
  // 「血圧(収縮期/拡張期) 127/82」「来院時 110/60」等も拾う。値は先頭数値=収縮期。
  sbp: ['収縮期血圧', '収縮期', '最高血圧', '大血圧', '来院時', '診察室血圧', '家庭血圧', 'sbp', '血圧上'],
  fev1fvc: ['fev1/fvc', 'fev1.0%', '1秒率', 'fev1fvc'],
  bmi: ['bmi', '体格指数'],
};
/**
 * WBC を PhenoAge 式が要求する ×10³/μL へスケール正規化する。
 * Wellfort 確認 (2026-08): 白血球(赤血球・血小板も同様)の**桁数は検査機関でバラバラ**で
 * 決まっていないため、**読み取り都度オーダー(桁)で判断**して正規化する必要がある。
 *   ・/μL 表記       例 6700 (人間ドック) → ÷1000 = 6.7   (値 ≥ 1000)
 *   ・×10²/μL 表記   例 45.2 (検診)       → ÷10   = 4.52  (正常域 ≒ 33〜95)
 *   ・×10³/μL 表記   例 6.7               → そのまま        (正常域 ≒ 3.3〜9.5)
 * 冪等 (正規化後の値を再投入しても不変)。しきい値30は ×10³/μL の臨床上限(高度白血球増多でも
 * ≒20-30)と ×10²/μL の正常下限(≒33)の境界。※極端な白血球増多(≥30×10³/μL)は稀で桁判定の
 * 対象外(その値は臨床的に別途フラグされる)。RBC は MCV 補完側で別途スケール処理済・血小板は式に不使用。
 */
export function normalizeWbcScale(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return v;
  if (v >= 1000) return v / 1000; // /μL → ×10³/μL
  if (v >= 30) return v / 10;     // ×10²/μL → ×10³/μL
  return v;                        // 既に ×10³/μL
}

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
  // WBC 桁正規化 (検査機関で /μL・×10²/μL・×10³/μL が混在 → 式が要求する ×10³/μL へ)。
  // Wellfort 確認 (2026-08): 桁は都度判断が必要。normalizeWbcScale は冪等。
  if (out.wbc != null) out.wbc = normalizeWbcScale(out.wbc);
  // BMI 補完 (身長cm・体重kg から)。※ v5.4 では計算に使わないが参考表示用に保持。
  if (out.bmi == null) {
    let h: number | null = null, w: number | null = null;
    for (const it of items) {
      if (h === null && matches(it, HEIGHT_SYN)) h = parseNumeric(it.value ?? null);
      if (w === null && matches(it, WEIGHT_SYN)) w = parseNumeric(it.value ?? null);
    }
    if (h && w && h > 100 && h < 230) out.bmi = Math.round((w / ((h / 100) ** 2)) * 10) / 10;
  }
  // MCV 補完 (欄が空でも 赤血球 + ヘマトクリット から算出可)。
  // MCV(fL) = Ht(%) / RBC(10^6/µL) × 10。RBC は ×10^4 表記(例 482)と ×10^6 表記(例 4.82)が混在。
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
  // SBP fallback: 「NNN / NN」(収縮期/拡張期) 形式の値を、血圧文脈の行から収縮期として拾う。
  if (out.sbp == null) {
    for (const it of items) {
      const v = typeof it.value === 'string' ? it.value : '';
      const m = v.match(/^\s*(\d{2,3})\s*[/／]\s*(\d{2,3})\s*$/);
      if (!m) continue;
      const ctx = canon(it.name) + canon(it.name_detail) + canon(it.category) + canon(it.region);
      if (ctx.includes('血圧') || ctx.includes('来院時') || ctx.includes('診察室') || ctx.includes('脈波')) {
        const sys = parseFloat(m[1]);
        if (Number.isFinite(sys) && sys >= 60 && sys <= 260) { out.sbp = sys; break; }
      }
    }
  }
  return out;
}
