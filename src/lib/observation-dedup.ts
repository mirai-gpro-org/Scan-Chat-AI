// src/lib/observation-dedup.ts
// ①読取の後段・決定論 dedup（課題C：多テーブル様式の別名重複／概念-実体ID分離）。
// 参照: docs/基本設定書.md §3.4（追補: 画像証拠ベース後段補修）, docs/基本設定書_実装修正プラン.md §3（P-perc）
//
// 背景（人間ドックの実測課題）:
//   - 課題C: 同一項目が複数テーブル（総合判定＋詳細表＋推移グラフ）に現れる様式で「別名の重複行」が量産される
//     （最高血圧×2 / 尿蛋白定性 vs 蛋白 / 尿潜血定性 vs 潜血 等。rows 88〜109 の高密度様式で顕著）。
//   - 課題B: 推移グラフから拾った前回値が、詳細表の今回値と「同名・別値」の競合になる（LDL 102 vs 129 等）。
//
// 設計（Gemini/ChatGPT 再レビュー収束・2026-08）:
//   - 同一性キー = 概念ID（canonical_name via findByAlias）。左右/日目/空腹時 は standard-master が
//     別 canonical_name として保持済み → **意味上別物は別キーになり統合されない**（眼圧右≠眼圧左、
//     免疫便潜血 1日目≠2日目、白血球数(血液)≠尿中白血球）。
//   - **table_id/row 等の物理来歴は意味キーに含めない**（同一検査の詳細表/サマリ表の重複掲載を別実体にしない）。
//   - **同一キー・同一値のみ統合**（複数の出典が1 Observation を指す＝別名重複を1件に）。
//   - **同一キー・別値は統合せず CONFLICT として記録**（自動採用しない＝捏造ゼロ。課題B の検知。
//     どちらを採るかは画像の今回セル証拠が要る＝後段の証拠ゲート層[P-perc・env・🎯]に委ね、ここでは決めない）。
//   - **値一致は重複の十分条件ではない**（左右同値/別日同値）が、区別は canonical_name（左右）と
//     単回納品（別日は今回のみ）で構造的に担保されるため、同一キー内の同値統合は安全。
//
// env `SCAN_OBS_DEDUP=on` のときだけ発火（既定 off = 挙動不変）。🎯回帰ゼロ確認後に on。

import { findByAlias, normKey } from './standard-master';

/** 別名重複として統合した監査エントリ（同一キー・同一値が n 件 → 1 件へ）。 */
export interface DedupMerge {
  key: string;
  name: string;
  value: string | null;
  occurrences: number;
}
/** 同一キー・別値の競合（統合せず全て残す。解決は証拠ゲート層に委ねる）。 */
export interface DedupConflict {
  key: string;
  name: string;
  values: (string | null)[];
}
export interface DedupResult {
  /** dedup 後の measurement（順序保持・別名重複のみ除去・競合は全件保持）。 */
  delivery: Record<string, unknown>[];
  merged: DedupMerge[];
  conflicts: DedupConflict[];
}
/** 監査サマリ（delivery を除いた可視化用。Elith 納品 data には含めない）。 */
export interface DedupAudit {
  merged: DedupMerge[];
  conflicts: DedupConflict[];
}
export function dedupAudit(r: DedupResult): DedupAudit {
  return { merged: r.merged, conflicts: r.conflicts };
}

/**
 * 意味上の同一性キー（概念ID）。マスタにヒットすれば canonical_name の正規化、非ヒットは名の正規化。
 * 物理来歴（table_id/row）は含めない。
 */
export function semanticKey(name: string | null | undefined): string {
  if (!name) return '';
  const hit = findByAlias(name);
  return hit ? normKey(hit.canonical_name) : normKey(String(name));
}

/** 値トークン（value_num があれば数値、無ければ正規化した value 文字列）。空値は null。 */
function valueToken(rec: Record<string, unknown>): string | null {
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
/** 監査表示用に value トークンの先頭 '#'（数値印）を外す。 */
function displayValue(token: string): string {
  return token.startsWith('#') ? token.slice(1) : token;
}

/**
 * lean measurement[] を意味上の Observation で dedup する（決定論・保守的）。
 *   - 同一キー・同一値 → 1 件へ統合（別名重複除去）。
 *   - 同一キー・別値 → 全件保持＋ conflict 記録（自動採用しない）。
 *   - 名前なし/値なしの行は対象外で素通し（順序保持）。
 * @param opts.keyFn 同一性キー関数の差し替え（既定 semanticKey）。テスト/将来拡張用。
 */
export function dedupObservations(
  measurements: unknown,
  opts?: { keyFn?: (name: string | null | undefined) => string },
): DedupResult {
  const keyOf = opts?.keyFn ?? semanticKey;
  const list: Record<string, unknown>[] = Array.isArray(measurements)
    ? (measurements as unknown[]).filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    : [];

  const delivery: Record<string, unknown>[] = [];
  const merged: DedupMerge[] = [];
  const conflicts: DedupConflict[] = [];

  // key -> (valueToken -> 既に delivery に入れた代表の有無)
  const seenValue = new Map<string, Set<string>>();
  const meta = new Map<string, { name: string; values: string[]; count: Map<string, number> }>();

  for (const rec of list) {
    const name = typeof rec.name === 'string' ? rec.name : null;
    const key = keyOf(name);
    const token = valueToken(rec);
    if (!key || token == null) {
      // dedup 対象外（名前なし or 値なし＝未測定は本来 sanitize 済）→ そのまま通す。
      delivery.push(rec);
      continue;
    }
    let values = seenValue.get(key);
    if (!values) {
      values = new Set<string>();
      seenValue.set(key, values);
      meta.set(key, { name: name ?? '', values: [], count: new Map() });
    }
    const m = meta.get(key)!;
    if (!m.name && name) m.name = name;
    const c = m.count;
    c.set(token, (c.get(token) ?? 0) + 1);
    if (values.has(token)) {
      // 同一キー・同一値 = 別名重複 → 代表は既に delivery にある。この行は落とす。
      continue;
    }
    values.add(token);
    m.values.push(token);
    delivery.push(rec); // この (キー,値) の初出＝代表として残す（順序保持）。
  }

  for (const [key, m] of meta) {
    for (const [token, count] of m.count) {
      if (count > 1) {
        merged.push({ key, name: m.name, value: displayValue(token), occurrences: count });
      }
    }
    if (m.values.length > 1) {
      conflicts.push({ key, name: m.name, values: m.values.map(displayValue) });
    }
  }

  return { delivery, merged, conflicts };
}
