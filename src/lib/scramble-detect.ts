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
  /** ブロック（同一表内のみで候補判定＝跨ブロック誤割当を防ぐ）。例: 肝酵素 vs 鉄代謝。 */
  block: string;
  /** findByAlias で canonical に寄らない表記ゆれ（主パスの実測名）。 */
  aliases?: string[];
}

// starter: 人間ドック様式で検証済みの実レンジのみ。**block 内でのみ候補判定**する（血清鉄 40-188 が
// ALP 38-113/LDH 124-222 と重複するため。block を分けないと γ-GTP=157 が LDH と血清鉄で曖昧化し肝修正が壊れる）。
export const SCRAMBLE_RANGES: RangeDef[] = [
  // 肝・胆・膵（block=liver）。157→LDH・78→ALP は liver 内で一意（他 liver レンジと非重複）。
  { canonical: 'AST(GOT)', low: 13, high: 30, block: 'liver', aliases: ['AST', 'GOT', 'GOT(AST)'] },
  { canonical: 'ALT(GPT)', low: 7, high: 23, block: 'liver', aliases: ['ALT', 'GPT', 'GPT(ALT)'] },
  { canonical: 'LDH', low: 124, high: 222, block: 'liver', aliases: ['LD'] },
  { canonical: 'ALP', low: 38, high: 113, block: 'liver', aliases: ['アルカリフォスファターゼ'] },
  { canonical: 'γ-GTP', low: 9, high: 32, block: 'liver', aliases: ['Y-GTP', 'YGTP', 'γGTP', 'ガンマGTP', 'GGT'] },
  { canonical: 'コリンエステラーゼ', low: 201, high: 421, block: 'liver', aliases: ['ChE', 'CHE'] },
  // 鉄代謝（block=iron）。TIBC↔血清鉄 は互いに非重複。liver とは block 分離で干渉させない。
  { canonical: 'TIBC', low: 246, high: 410, block: 'iron', aliases: ['総鉄結合能', '総鉄結合能(TIBC)'] },
  { canonical: '血清鉄', low: 40, high: 188, block: 'iron', aliases: ['鉄', 'Fe', '血清鉄(Fe)'] },
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
      if (other.block !== r.block) continue; // 同一ブロック内のみ（跨ブロック誤割当を防ぐ）
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

export interface ReassignEntry {
  from: string; // 元ラベル
  to: string;   // 付け替え先 canonical
  value: number;
}
export interface ReassignResult {
  delivery: Record<string, unknown>[];
  reassigned: ReassignEntry[];
}

/**
 * Phase 2-2: 基準レンジ再割当（検知→"修正"・単一 run・決定論・捏造ゼロ）。
 * 「値がラベル基準に不適合 かつ 別項目 B の基準に**唯一**適合 かつ B が納品に欠落」の行を、
 * **B へ付け替える**（値は実読値のまま・移動のみ＝新値を作らない）。跨run整合が不要＝名称ゆれ/union膨張なし。
 * 二重割当ガード: 同一 B へは1回だけ（filledTargets）。曖昧(複数候補)は触らない。numeric値は変えない。
 */
export function reassignScramble(measurements: unknown, opts?: { ranges?: RangeDef[] }): ReassignResult {
  const ranges = opts?.ranges ?? SCRAMBLE_RANGES;
  const idx = buildIndex(ranges);
  const list: Record<string, unknown>[] = Array.isArray(measurements)
    ? (measurements as unknown[]).filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    : [];

  // pass1: 各 canonical に適合値が存在するか（再割当可能性＝欠落判定用）。
  const hasInRange = new Map<string, boolean>();
  for (const rec of list) {
    const r = rangeOf(typeof rec.name === 'string' ? rec.name : null, idx);
    if (!r) continue;
    const v = numOf(rec);
    if (v == null) continue;
    if (inRange(v, r)) hasInRange.set(r.canonical, true);
    else if (!hasInRange.has(r.canonical)) hasInRange.set(r.canonical, false);
  }

  const delivery: Record<string, unknown>[] = [];
  const reassigned: ReassignEntry[] = [];
  const filledTargets = new Set<string>(); // 既に再割当で埋めた B（二重割当防止）
  for (const rec of list) {
    const name = typeof rec.name === 'string' ? rec.name : null;
    const r = rangeOf(name, idx);
    const v = r ? numOf(rec) : null;
    if (r && v != null && !inRange(v, r)) {
      const likely = ranges.filter(
        (o) => o.canonical !== r.canonical && o.block === r.block && inRange(v, o) && hasInRange.get(o.canonical) === undefined && !filledTargets.has(o.canonical),
      );
      if (likely.length === 1) {
        const to = likely[0].canonical;
        filledTargets.add(to);
        delivery.push({ ...rec, name: to }); // ラベルのみ付け替え（value/value_num 不変＝捏造ゼロ）
        reassigned.push({ from: name as string, to, value: v });
        continue;
      }
    }
    delivery.push(rec);
  }
  return { delivery, reassigned };
}
