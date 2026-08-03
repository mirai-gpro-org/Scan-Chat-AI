// src/lib/scramble-detect.ts
// Phase 2-1: 基準レンジ scramble 検知（監査のみ・決定論・delivery 不変・捏造ゼロ）。
//
// 狙い（人間ドック課題B・本丸）: ⑧-4 の高密度ブロック（肝酵素等）で、主パスが「値は読めているが
// ラベルと回転」させる（実測: 値78がγ-GTPへ＝本来ALP、γ-GTP実値28やLDH157が消失）。これを
// **基準レンジの適合**で疑い検知する。**自動改変は一切しない**（可視化のみ）。誤検知率を🎯で測り、
// 有効なら Phase 2-2（局所再読で再ペア）へ進む土台。
//
// 保守条件（誤検知抑制・捏造ゼロ）:
//   R がラベル A の値 v を持ち、
//     (1) v が A の基準に**不適合**、かつ
//     (2) v が別項目 B の基準に**適合**、かつ
//     (3) B が「再割当可能」= B が納品に**欠落** or B の納品値が B 基準に**不適合**
//   のときだけ scramble 疑いを立てる。→ 「真に高い γ-GTP=78 で ALP も正常在り」は (3) 不成立で**弾く**。
//
// レンジは golden 検体で検証済みの well-separated な実レンジのみ（捏造しない）。施設/性別で変動する
// ため **audit 限定**（delivery は変えない）。完全マスタ受領時に置換・拡張する。

import { findByAlias, normKey } from './standard-master';

export interface RangeDef {
  canonical: string;
  low: number;
  high: number;
  /** findByAlias で canonical に寄らない表記ゆれ（主パスの実測名）。 */
  aliases?: string[];
}

// starter: 人間ドック様式で検証済みの well-separated レンジのみ（肝酵素ブロック＝scramble 多発域）。
export const SCRAMBLE_RANGES: RangeDef[] = [
  { canonical: 'AST(GOT)', low: 13, high: 30, aliases: ['AST', 'GOT', 'GOT(AST)'] },
  { canonical: 'ALT(GPT)', low: 7, high: 23, aliases: ['ALT', 'GPT', 'GPT(ALT)'] },
  { canonical: 'LDH', low: 124, high: 222, aliases: ['LD'] },
  { canonical: 'ALP', low: 38, high: 113, aliases: ['アルカリフォスファターゼ'] },
  { canonical: 'γ-GTP', low: 9, high: 32, aliases: ['Y-GTP', 'YGTP', 'γGTP', 'ガンマGTP', 'GGT'] },
  { canonical: 'コリンエステラーゼ', low: 201, high: 421, aliases: ['ChE', 'CHE'] },
];

export interface ScrambleSuspect {
  name: string;        // 納品ラベル（そのまま）
  value: number;       // 該当値
  own: string;         // 判定に使った自ラベルの canonical
  likely: string[];    // v が適合し、かつ再割当可能な別項目 canonical
  reason: string;
}
export interface ScrambleAudit {
  suspects: ScrambleSuspect[];
  checked: number;     // レンジ対象として評価した行数
}

function inRange(v: number, r: RangeDef): boolean {
  return v >= r.low && v <= r.high;
}

/** RANGES を canonical + aliases の正規化キーで索引（NFKC 経由の normKey）。 */
function buildIndex(ranges: RangeDef[]): Map<string, RangeDef> {
  const idx = new Map<string, RangeDef>();
  for (const r of ranges) {
    idx.set(normKey(r.canonical), r);
    for (const a of r.aliases ?? []) idx.set(normKey(a), r);
  }
  return idx;
}

/** measurement 名 → RangeDef（別名/標準マスタ canonical 経由）。非対象は null。 */
function rangeOf(name: string | null | undefined, idx: Map<string, RangeDef>): RangeDef | null {
  if (!name) return null;
  const direct = idx.get(normKey(name));
  if (direct) return direct;
  // 標準マスタで canonical に寄せてから再照合（例: 'GPT(ALT)' → 'GPT(ALT)' canonical）。
  const hit = findByAlias(name);
  if (hit) {
    const viaCanon = idx.get(normKey(hit.canonical_name));
    if (viaCanon) return viaCanon;
  }
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

/**
 * scramble 疑い検知（監査のみ）。delivery は変更しない。
 * @param measurements 納品 measurement[]（sanitize/canonicalize/dedup 済み）
 */
export function detectScramble(
  measurements: unknown,
  opts?: { ranges?: RangeDef[] },
): ScrambleAudit {
  const ranges = opts?.ranges ?? SCRAMBLE_RANGES;
  const idx = buildIndex(ranges);
  const list: Record<string, unknown>[] = Array.isArray(measurements)
    ? (measurements as unknown[]).filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    : [];

  // pass1: 各 canonical について「その基準に適合する値が納品に存在するか」を集計（再割当可能性の判定用）。
  const hasInRange = new Map<string, boolean>(); // canonical → 適合値が存在
  for (const rec of list) {
    const r = rangeOf(typeof rec.name === 'string' ? rec.name : null, idx);
    if (!r) continue;
    const v = numOf(rec);
    if (v == null) continue;
    if (inRange(v, r)) hasInRange.set(r.canonical, true);
    else if (!hasInRange.has(r.canonical)) hasInRange.set(r.canonical, false);
  }

  // pass2: 自基準に不適合な値が、別項目の基準に適合し、その別項目が再割当可能なら疑い。
  const suspects: ScrambleSuspect[] = [];
  let checked = 0;
  for (const rec of list) {
    const name = typeof rec.name === 'string' ? rec.name : null;
    const r = rangeOf(name, idx);
    if (!r) continue;
    const v = numOf(rec);
    if (v == null) continue;
    checked++;
    if (inRange(v, r)) continue; // 自ラベル基準に適合＝正常/H・L の通常判定（scramble でない）
    const likely: string[] = [];
    for (const other of ranges) {
      if (other.canonical === r.canonical) continue;
      if (!inRange(v, other)) continue;
      // (3) 再割当可能 = other が納品に**欠落**のときのみ（誤検知抑制）。
      //     「other が在るが範囲外」= 連鎖(chain)は false-positive を生む(実測: 本物の高ALT=26 が γ-GTP へ
      //     誤疑い)ため Phase 2-1 では拾わない。連鎖する scramble は Phase 2-2 の局所再読で扱う。
      const status = hasInRange.get(other.canonical);
      const available = status === undefined; // 欠落のみ
      if (available) likely.push(other.canonical);
    }
    if (likely.length > 0) {
      suspects.push({
        name: name as string,
        value: v,
        own: r.canonical,
        likely,
        reason: `${v} は ${r.canonical} 基準(${r.low}〜${r.high})に不適合・${likely.join('/')} 基準に適合(該当項目が欠落)＝ラベル回転疑い`,
      });
    }
  }
  return { suspects, checked };
}
