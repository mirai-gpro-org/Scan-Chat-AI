// src/lib/lipid-fix.ts
// Phase 2-2: 脂質 LDL↔TG 入替の物理制約修正（決定論・捏造ゼロ・施設非依存）。
//
// 不変量: LDL + HDL ≤ 総コレステロール(TC)（TC = LDL + HDL + VLDL, VLDL≥0 なので常に成立）。
// 主パスが LDL/TG の値を入替える run（実測: LDL=129/TG=82 が正 LDL=82/TG=129）では、
// 現状 LDL+HDL が TC を明確に超える（物理的に不能）。**LDL↔TG を入替えると解消する**ときだけ
// 両行の値を交換する。**実読値の入替のみ＝新値を作らない**（捏造ゼロ）。Friedewald の絶食仮定は不要。
//
// 保守ガード（誤修正防止）:
//   - TC/HDL/LDL/TG が全て数値で存在。
//   - 現状 (LDL+HDL) − TC > MARGIN（測定法間バイアス数 mg/dL を超える明確な違反のみ）。
//   - 入替後 (TG+HDL) − TC ≤ MARGIN（入替が物理的に成立＝これで直る場合のみ）。
//   → 両順序とも違反する検体は触らない（別問題）。
// env SCAN_LIPID_FIX=on のときだけ（既定 off）。

const MARGIN = 15; // mg/dL。測定法間の許容差を超える「明確な物理違反」の閾。

type Rec = Record<string, unknown>;

export interface LipidFixResult {
  delivery: Rec[];
  swapped: boolean;
  detail: { tc: number; hdl: number; ldl_before: number; tg_before: number; ldl_after: number; tg_after: number } | null;
}

type Kind = 'TC' | 'HDL' | 'LDL' | 'TG';
function lipidKind(name: string): Kind | null {
  const n = name.normalize('NFKC').toUpperCase().replace(/[\s　]/g, '');
  if (/NON-?HDL/.test(n)) return null; // non-HDL は別項目
  if (/総コレステロール|^TC$|^T-CHO/.test(n)) return 'TC';
  if (/HDLコレステロール|^HDL$|^HDL-C/.test(n)) return 'HDL';
  if (/中性脂肪|^TG$/.test(n)) return 'TG';
  if (/LDLコレステロール|^LDL$|^LDL-C/.test(n)) return 'LDL'; // LDL(F式) は「コレステロール/^LDL$」に非該当で除外
  return null;
}
function numOf(rec: Rec): number | null {
  const vn = rec.value_num;
  if (typeof vn === 'number' && Number.isFinite(vn)) return vn;
  const v = rec.value;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = /-?\d+(?:\.\d+)?/.exec(v.normalize('NFKC'));
    if (m) { const n = Number(m[0]); if (Number.isFinite(n)) return n; }
  }
  return null;
}

/**
 * 脂質 LDL↔TG 入替を物理制約で修正する（delivery を返す・値は入替のみ）。
 */
export function fixLipidSwap(measurements: unknown): LipidFixResult {
  const list: Rec[] = Array.isArray(measurements)
    ? (measurements as unknown[]).filter((m): m is Rec => !!m && typeof m === 'object')
    : [];

  // 各種の「最初の数値行」を拾う（idx 保持で入替する）。
  const idxOf: Partial<Record<Kind, number>> = {};
  for (let i = 0; i < list.length; i++) {
    const name = typeof list[i].name === 'string' ? (list[i].name as string) : '';
    const k = name ? lipidKind(name) : null;
    if (k && idxOf[k] === undefined && numOf(list[i]) != null) idxOf[k] = i;
  }
  const iTC = idxOf.TC, iHDL = idxOf.HDL, iLDL = idxOf.LDL, iTG = idxOf.TG;
  if (iTC === undefined || iHDL === undefined || iLDL === undefined || iTG === undefined) {
    return { delivery: list, swapped: false, detail: null };
  }
  const tc = numOf(list[iTC])!, hdl = numOf(list[iHDL])!, ldl = numOf(list[iLDL])!, tg = numOf(list[iTG])!;

  const currentInvalid = ldl + hdl - tc > MARGIN;      // 現状が明確な物理違反
  const swapValid = tg + hdl - tc <= MARGIN;           // 入替後は物理的に成立
  if (!currentInvalid || !swapValid) {
    return { delivery: list, swapped: false, detail: null };
  }

  // LDL 行と TG 行の値(value/value_num)を入替（ラベルは不変・実読値の交換のみ）。
  const delivery = list.map((r) => ({ ...r }));
  const ldlRec = delivery[iLDL], tgRec = delivery[iTG];
  const swap = (a: Rec, b: Rec) => {
    const av = a.value, avn = a.value_num;
    a.value = b.value; a.value_num = b.value_num;
    b.value = av; b.value_num = avn;
  };
  swap(ldlRec, tgRec);
  return {
    delivery,
    swapped: true,
    detail: { tc, hdl, ldl_before: ldl, tg_before: tg, ldl_after: tg, tg_after: ldl },
  };
}
