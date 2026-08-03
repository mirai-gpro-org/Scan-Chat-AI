// src/lib/collapsed-row.ts
// Phase 2-2: 眼科 collapsed-row resolver（右眼/左眼つぶれ → 測定種別へ付け替え・決定論・捏造ゼロ）。
//
// 実測(2026-08 人間ドック): 主パスが視力・眼圧・眼底の**測定種別ラベルを落とし**「右眼/左眼」だけにする
// run がある（🎯 同名異値 右眼[0.4, 10.0, 異常なし]）。値は読めているので、**値域で種別へ付け替える**。
// 眼科は値域が非重複（裸眼視力 0.01–2.0 / 眼圧 5–30 mmHg）＝安全。定性(異常なし)は眼底。
//   数値 0.01–2.0 → 裸眼視力{右/左}
//   数値 5–30     → 眼圧{右/左}
//   定性(異常なし/正常/所見なし) → 眼底所見{右/左}
//   それ以外 → 触らない（付け替えない＝推測しない＝捏造ゼロ）
// ガード: ラベルが「右眼/左眼」**ちょうど**（測定種別を持たない）ときのみ。付け替え先が既に納品に在れば作らない。
// env SCAN_EYE_RESOLVE=on のときだけ（既定 off）。

export interface EyeResolveEntry {
  from: string; // 元ラベル（右眼/左眼）
  to: string;   // 付け替え先（裸眼視力右 等）
  value: string;
}
export interface EyeResolveResult {
  delivery: Record<string, unknown>[];
  resolved: EyeResolveEntry[];
}

const SIDE_RE = /^(右眼|左眼)$/;
const QUAL_OK_RE = /^(異常なし|異常無し|正常|所見なし)$/;

function sideOf(name: string): '右' | '左' | null {
  if (name === '右眼') return '右';
  if (name === '左眼') return '左';
  return null;
}
function numOf(rec: Record<string, unknown>): number | null {
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
function textVal(rec: Record<string, unknown>): string {
  return typeof rec.value === 'string' ? rec.value.normalize('NFKC').trim() : '';
}

/**
 * 眼科 collapsed-row を種別へ付け替える（delivery を返す・値は不変）。
 */
export function resolveEyeCollapsed(measurements: unknown): EyeResolveResult {
  const list: Record<string, unknown>[] = Array.isArray(measurements)
    ? (measurements as unknown[]).filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    : [];

  // 既存の種別名（付け替え先の重複作成を防ぐ）。正規化して集合化。
  const present = new Set<string>();
  for (const rec of list) {
    const nm = typeof rec.name === 'string' ? rec.name.normalize('NFKC').replace(/[\s　()（）]/g, '') : '';
    if (nm) present.add(nm);
  }
  const has = (n: string) => present.has(n.normalize('NFKC').replace(/[\s　()（）]/g, ''));

  const delivery: Record<string, unknown>[] = [];
  const resolved: EyeResolveEntry[] = [];
  const filled = new Set<string>(); // このパスで付け替え済みの種別（同側同種の二重作成防止）
  for (const rec of list) {
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    const side = SIDE_RE.test(name) ? sideOf(name) : null;
    if (side) {
      const n = numOf(rec);
      let to: string | null = null;
      if (n != null && n >= 0.01 && n <= 2.0) to = `裸眼視力${side}`;
      else if (n != null && n >= 5 && n <= 30) to = `眼圧${side}`;
      else if (QUAL_OK_RE.test(textVal(rec))) to = `眼底所見${side}`;
      if (to && !has(to) && !filled.has(to)) {
        filled.add(to);
        delivery.push({ ...rec, name: to }); // ラベルのみ付け替え（value 不変＝捏造ゼロ）
        resolved.push({ from: name, to, value: typeof rec.value === 'string' ? rec.value : String(rec.value ?? '') });
        continue;
      }
    }
    delivery.push(rec);
  }
  return { delivery, resolved };
}
