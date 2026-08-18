// src/lib/ai-prediction-consolidate.ts
// LAiF「AI疾病発症予測」(format_id=Other / data.items[]) の決定論統合。
//
// 課題: 元レポートは同一疾患を「発症予測ページ(5年/10年発症率・相対リスク比)」「アドバイスページ(文章)」
//   「用語解説ページ(詳細文)」「カテゴリのネスト配列(悪性腫瘍→乳がん 等)」に分けて載せる。
//   finalize が各ページの items を単純連結するだけなので、同一疾患が複数 item に膨張する
//   (実測 2026-08: 57件・重複多数)。elith_assembly_wrapping_spec §5.3「疾患ごとに1オブジェクト」に反する。
//
// 方針 (CLAUDE.md 確定・発注者判断 2026-08):
//  - **疾患名は印字どおり維持** (名称の言い換え/標準病名への正準化はしない)。
//    → **完全一致の項目名のみ統合**。糖尿病/2型糖尿病・高血圧/高血圧症・貧乏性貧血/鉄欠乏性貧血 等は
//      別 item のまま残す (それらは読取のゆれ=別レイヤーの課題。ここで名寄せ=創作しない)。
//  - **捏造ゼロ**: 新しい値を作らない。数値/文字フィールドは「最初の非空値」を採用し、
//    後続に異なる非空値が来たら競合として audit に記録する (自動上書きしない)。
//  - **漏れゼロ**: 未知フィールドも値は捨てない。アドバイスは複数の異なる印字文を全て保持 (重複排除して連結)。
//  - **カテゴリ見出し除去** (§5.3): ネスト `疾患[]` を持つ item は見出しを器として落とし、子疾患を昇格する。
//
// 監査 (audit) は API 応答で返し、Elith 納品 data には含めない。

export interface ConsolidateAudit {
  before: number;
  after: number;
  flattened: number; // ネスト配列から昇格した子疾患数
  dropped_headers: number; // 落としたカテゴリ見出し(器)数
  merged: { name: string; occurrences: number }[]; // 2回以上出現し統合された疾患
  conflicts: { name: string; field: string; kept: string; ignored: string }[]; // 異なる非空値(採用せず記録)
}

// §5.3 の推奨キー順。未知キーは末尾へ回す。
const FIELD_ORDER = [
  'section',
  '項目名',
  '5年発症率',
  '10年発症率',
  '相対リスク比',
  '昨年の相対リスク比',
  '現在の状況',
  '未来の状況',
  'アドバイス',
];

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function nameOf(o: Record<string, unknown>): string | null {
  const n = o['項目名'];
  return typeof n === 'string' && n.trim() ? n.trim() : null;
}
function nonEmpty(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}
function orderKeys(o: Record<string, unknown>): Record<string, unknown> {
  const res: Record<string, unknown> = {};
  for (const k of FIELD_ORDER) if (k in o) res[k] = o[k];
  // ネスト配列(疾患/項目詳細 等)は平坦化で消費済み。念のため出力からは落とす。
  for (const k of Object.keys(o)) if (!(k in res) && !Array.isArray(o[k])) res[k] = o[k];
  return res;
}
/**
 * ネストされた「子疾患の配列」を検出する。キー名は run 毎に揺れる (`疾患` / `項目詳細` 等) ため
 * キー名に依存せず「項目名を持つオブジェクトの配列」を持つフィールドを探す (捏造ゼロ=構造判定のみ)。
 */
function nestedDiseaseArray(it: Record<string, unknown>): Record<string, unknown>[] | null {
  for (const v of Object.values(it)) {
    if (Array.isArray(v)) {
      const objs = v.filter(isObj);
      if (objs.length && objs.some((o) => nameOf(o))) return objs;
    }
  }
  return null;
}

/**
 * LAiF items を疾患単位(完全一致名)で1オブジェクトへ統合する。
 * 名称は印字どおり維持・捏造ゼロ・漏れゼロ。監査を併せて返す。
 */
export function consolidateAiPredictionItems(rawItems: unknown[]): {
  items: Record<string, unknown>[];
  audit: ConsolidateAudit;
} {
  const conflicts: ConsolidateAudit['conflicts'] = [];
  let flattened = 0;
  let droppedHeaders = 0;

  // 1) 平坦化: ネストされた子疾患配列(キー名不問=疾患/項目詳細 等)を持つ item は
  //    見出しを器として落とし、子を昇格 (section は親名を継承)。
  const flat: Record<string, unknown>[] = [];
  for (const it of rawItems) {
    if (!isObj(it)) continue;
    const nested = nestedDiseaseArray(it);
    if (nested) {
      const parentSection =
        typeof it['section'] === 'string' && it['section'].trim() ? it['section'].trim() : nameOf(it);
      for (const child of nested) {
        const c: Record<string, unknown> = { ...child };
        if (!nonEmpty(c['section']) && parentSection) c['section'] = parentSection;
        flat.push(c);
        flattened++;
      }
      droppedHeaders++;
      continue;
    }
    flat.push({ ...it });
  }

  // 2) 完全一致 項目名 で group (初出順維持)。名称なしは統合せず素通し(捨てない)。
  const order: string[] = [];
  const groups = new Map<string, Record<string, unknown>[]>();
  const unnamed: Record<string, unknown>[] = [];
  for (const it of flat) {
    const nm = nameOf(it);
    if (!nm) {
      unnamed.push(it);
      continue;
    }
    if (!groups.has(nm)) {
      groups.set(nm, []);
      order.push(nm);
    }
    groups.get(nm)!.push(it);
  }

  // 3) group ごとに field 単位で統合。
  const merged: ConsolidateAudit['merged'] = [];
  const out: Record<string, unknown>[] = [];
  for (const nm of order) {
    const occ = groups.get(nm)!;
    if (occ.length > 1) merged.push({ name: nm, occurrences: occ.length });
    const acc: Record<string, unknown> = {};
    const adviceTexts: string[] = []; // アドバイスは異なる印字文を全て保持(漏れゼロ・重複排除)
    for (const o of occ) {
      for (const [k, v] of Object.entries(o)) {
        if (Array.isArray(v)) continue; // ネスト配列は平坦化で消費済み・値統合の対象外
        if (!nonEmpty(v)) continue;
        if (k === 'アドバイス' && typeof v === 'string') {
          const t = v.trim();
          if (t && !adviceTexts.includes(t)) adviceTexts.push(t);
          continue;
        }
        if (!nonEmpty(acc[k])) {
          acc[k] = v;
          continue;
        }
        // 既に非空: 同値ならスキップ、異なれば競合として記録し採用しない(捏造ゼロ)。
        if (String(acc[k]) !== String(v)) {
          conflicts.push({ name: nm, field: k, kept: String(acc[k]), ignored: String(v) });
        }
      }
    }
    if (adviceTexts.length) acc['アドバイス'] = adviceTexts.join('\n');
    out.push(orderKeys(acc));
  }
  for (const u of unnamed) {
    const c: Record<string, unknown> = { ...u };
    delete c['疾患'];
    out.push(orderKeys(c));
  }

  return {
    items: out,
    audit: {
      before: rawItems.length,
      after: out.length,
      flattened,
      dropped_headers: droppedHeaders,
      merged,
      conflicts,
    },
  };
}
