// src/lib/multi-run-merge.ts
// Phase 2-2: N-run 多数決マージ + レンジ tiebreak（課題B 汎用解）。
//
// 背景（2run 実証・同一データ）: scramble は run 毎に**別ブロック**で起きる（run A=肝が誤/身体が正、
// run B=肝が正/身体が誤）。どのブロックも「常に正/常に誤」でない。→ **各項目は過半の run で正しく読める**
// ので、canonical 項目ごとに N-run の値を突き合わせ**多数決**すれば scramble/入替/名称/脱落の全種に効く。
//
// 決定カスケード（捏造ゼロ = 出力値は必ずどれかの run で実際に読めた値のみ・新値は作らない）:
//   1. majority : 同一値が過半(>present/2)  → 採用
//   2. plurality: 最頻(タイでない)          → 採用
//   3. range    : 最頻がタイ → その項目の基準レンジに入る候補が唯一ならそれ
//   4. first    : なお決まらねば最初の run の値（実読値・監査で低信頼と明示）
//   空しか無い項目は出さない（脱落は多数決で埋まれば回収、全 run 欠落なら空のまま＝捏造しない）。
//
// レンジ tiebreak は scramble-detect の SCRAMBLE_RANGES を流用（well-separated ブロックのみ）。

import { semanticKey } from './observation-dedup';
import { SCRAMBLE_RANGES, type RangeDef } from './scramble-detect';

type Rec = Record<string, unknown>;

export interface MergeAuditEntry {
  key: string;
  name: string | null;
  chosen: string | null;
  method: 'majority' | 'plurality' | 'range' | 'first' | 'single';
  votes: Record<string, number>;
  runs_present: number;
  runs_total: number;
}
export interface MajorityResult {
  delivery: Rec[];
  audit: MergeAuditEntry[];
}

function valueToken(rec: Rec): string | null {
  const vn = rec.value_num;
  if (typeof vn === 'number' && Number.isFinite(vn)) return `#${vn}`;
  const v = rec.value;
  if (typeof v === 'number' && Number.isFinite(v)) return `#${v}`;
  if (typeof v === 'string') {
    const t = v.normalize('NFKC').trim().toLowerCase();
    return t === '' ? null : t;
  }
  return null;
}
function numOfToken(tok: string): number | null {
  if (tok.startsWith('#')) { const n = Number(tok.slice(1)); return Number.isFinite(n) ? n : null; }
  const m = /-?\d+(?:\.\d+)?/.exec(tok);
  if (m) { const n = Number(m[0]); return Number.isFinite(n) ? n : null; }
  return null;
}
function buildRangeIndex(ranges: RangeDef[]): Map<string, RangeDef> {
  const idx = new Map<string, RangeDef>();
  for (const r of ranges) {
    idx.set(semanticKey(r.canonical), r);
    for (const a of r.aliases ?? []) idx.set(semanticKey(a), r);
  }
  return idx;
}

/**
 * N-run の最終 measurements[] を多数決マージする。
 * @param runs run ごとの measurements[]（各 run は sanitize/canonicalize/dedup/trend 済み）
 */
export function majorityMerge(runs: unknown, opts?: { ranges?: RangeDef[] }): MajorityResult {
  const runArrays: Rec[][] = Array.isArray(runs)
    ? (runs as unknown[]).map((r) =>
        Array.isArray(r) ? (r as unknown[]).filter((m): m is Rec => !!m && typeof m === 'object') : [],
      )
    : [];
  const N = runArrays.length;
  const rangeIdx = buildRangeIndex(opts?.ranges ?? SCRAMBLE_RANGES);

  // key ごとに: run 別の代表 rec（各 run の最初の非空値）と、値トークンの投票を集計。
  interface Agg {
    key: string;
    name: string | null;
    order: number;                 // 初出順（安定ソート用）
    votes: Map<string, number>;    // token → 票数（run 単位）
    repByToken: Map<string, Rec>;  // token → 代表 rec（フィールド流用）
    firstToken: string | null;     // 最初の run の値（first フォールバック）
    present: number;               // 非空値を出した run 数
  }
  const aggs = new Map<string, Agg>();
  let orderCounter = 0;

  for (let ri = 0; ri < runArrays.length; ri++) {
    const seenThisRun = new Set<string>(); // 同一 run 内は 1 key 1 票（最初の非空を採る）
    for (const rec of runArrays[ri]) {
      const name = typeof rec.name === 'string' ? rec.name : null;
      if (!name) continue;
      const key = semanticKey(name);
      let a = aggs.get(key);
      if (!a) {
        a = { key, name, order: orderCounter++, votes: new Map(), repByToken: new Map(), firstToken: null, present: 0 };
        aggs.set(key, a);
      }
      const tok = valueToken(rec);
      if (tok == null) continue;          // 空値は投票しない
      if (seenThisRun.has(key)) continue; // この run のこの key は集計済み
      seenThisRun.add(key);
      a.present++;
      a.votes.set(tok, (a.votes.get(tok) ?? 0) + 1);
      if (!a.repByToken.has(tok)) a.repByToken.set(tok, rec);
      if (ri === 0 && a.firstToken == null) a.firstToken = tok;
    }
  }

  const delivery: Rec[] = [];
  const audit: MergeAuditEntry[] = [];
  const sorted = Array.from(aggs.values()).sort((x, y) => x.order - y.order);

  for (const a of sorted) {
    if (a.present === 0) continue; // 全 run 空 → 出さない（捏造しない）
    const entries = Array.from(a.votes.entries()); // [token, count]
    const maxCount = Math.max(...entries.map(([, c]) => c));
    const top = entries.filter(([, c]) => c === maxCount).map(([t]) => t);

    let chosen: string;
    let method: MergeAuditEntry['method'];
    if (a.present === 1) {
      chosen = top[0];
      method = 'single';
    } else if (top.length === 1 && maxCount * 2 > a.present) {
      chosen = top[0];
      method = 'majority';
    } else if (top.length === 1) {
      chosen = top[0]; // 最頻がタイでない（過半には満たないが単独最多）
      method = 'plurality';
    } else {
      // タイ → レンジ tiebreak: この項目の基準レンジに入る候補が唯一ならそれ
      const r = rangeIdx.get(a.key) ?? null;
      let ranged: string | null = null;
      if (r) {
        const fits = top.filter((t) => {
          const n = numOfToken(t);
          return n != null && n >= r.low && n <= r.high;
        });
        if (fits.length === 1) ranged = fits[0];
      }
      if (ranged != null) { chosen = ranged; method = 'range'; }
      else { chosen = a.firstToken ?? top[0]; method = 'first'; } // 実読値・低信頼
    }

    const rep = a.repByToken.get(chosen);
    if (rep) delivery.push(rep);
    audit.push({
      key: a.key,
      name: a.name,
      chosen: chosen.startsWith('#') ? chosen.slice(1) : chosen,
      method,
      votes: Object.fromEntries(entries.map(([t, c]) => [t.startsWith('#') ? t.slice(1) : t, c])),
      runs_present: a.present,
      runs_total: N,
    });
  }

  return { delivery, audit };
}

/** 監査サマリ（低信頼＝first/plurality/single・全run一致でない項目）を抽出。 */
export function mergeAuditSummary(r: MajorityResult): {
  total: number;
  majority: number;
  low_confidence: MergeAuditEntry[];
} {
  const low = r.audit.filter((e) => e.method === 'first' || e.method === 'plurality' || e.method === 'range');
  return {
    total: r.audit.length,
    majority: r.audit.filter((e) => e.method === 'majority').length,
    low_confidence: low,
  };
}
