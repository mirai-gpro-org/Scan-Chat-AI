// src/lib/elith-necessity-check.ts
// Elith「不要項目チェック（必要要素検証）」の純粋関数。
// Elith のアウトプットに必要な入力要素の観点で、生成JSONに不要項目/余剰フィールドが
// 無いかを検証する（モデル精度検証ではない）。参照: docs/elith_check_phase_spec.md
//
// - フィールド層: measurement に必要なキーのみか（allowlist）。マスタ不要で判定可能。
// - 項目層: 必要項目マスタ(Elith合意)があれば「マスタ外=余剰候補 / 不足」を判定。
//   マスタが無い間は空/重複/捏造(元データ照合)のみ稼働。

/** 納品 measurement に必要なキー（Phase1 lean 形と一致）。これ以外は余剰フィールド。 */
export const MEASUREMENT_ALLOWLIST = ['name', 'value', 'value_num', 'unit', 'ref_low', 'ref_high', 'flag'] as const;

/** 納品エンベロープの必要キー。これ以外(source_image/finish_reason/synthetic 等)は余剰候補(監査扱い)。 */
export const ENVELOPE_ALLOWLIST = [
  'format_id', 'schema_version', 'kind', 'client_id', 'diagnostic_id',
  'test_date', 'date_source', 'exported_at', 'subject', 'source', 'data',
] as const;

export interface NecessityReport {
  result: 'clean' | 'surplus' | 'deficient';
  counts: {
    items: number;
    surplus_fields: number;
    surplus_items: number;
    empty_items: number;
    duplicate_items: number;
    fabricated_items: number;
    missing_required: number;
    envelope_surplus: number;
  };
  surplus_fields: { item_name: string | null; field: string }[];
  surplus_items: { item_name: string | null; reason: string }[];
  empty_items: (string | null)[];
  duplicate_items: { item_name: string | null; reason: string }[];
  fabricated_items: (string | null)[];
  missing_required: string[];
  envelope_surplus: string[];
}

export interface CheckOpts {
  /** Elith が必要とする検査項目名の allowlist。未指定なら項目層(マスタ外/不足)は判定しない。 */
  requiredItemsMaster?: string[] | null;
  /** 元データ(画像/PDF)由来の項目名。指定時、JSONにあるが元データに無い=捏造 を検出。 */
  sourceItemNames?: string[] | null;
}

function norm(s: unknown): string {
  return typeof s === 'string' ? s.normalize('NFKC').trim().toLowerCase() : '';
}
function isEmptyValue(v: unknown): boolean {
  if (v == null) return true;
  const s = typeof v === 'string' ? v.trim() : String(v);
  return s === '' || s === '-';
}

/** 生成JSON(納品候補)を必要要素の観点で検証する。 */
export function checkNecessity(json: unknown, opts: CheckOpts = {}): NecessityReport {
  const obj = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const data = (obj.data && typeof obj.data === 'object' ? obj.data : {}) as Record<string, unknown>;
  const measurements: Record<string, unknown>[] = Array.isArray(data.measurements)
    ? (data.measurements as Record<string, unknown>[]).filter((m) => m && typeof m === 'object')
    : [];

  const allow = new Set<string>(MEASUREMENT_ALLOWLIST);
  const surplus_fields: NecessityReport['surplus_fields'] = [];
  const empty_items: (string | null)[] = [];
  const duplicate_items: NecessityReport['duplicate_items'] = [];
  const surplus_items: NecessityReport['surplus_items'] = [];
  const fabricated_items: (string | null)[] = [];

  const master = opts.requiredItemsMaster ? new Set(opts.requiredItemsMaster.map(norm)) : null;
  const sourceSet = opts.sourceItemNames ? new Set(opts.sourceItemNames.map(norm)) : null;
  const seenNames = new Map<string, number>();
  let prevValueNum: number | null = null;
  let prevName = '';

  for (const m of measurements) {
    const name = typeof m.name === 'string' ? m.name : null;
    // 余剰フィールド: allowlist 外のキー
    for (const k of Object.keys(m)) if (!allow.has(k)) surplus_fields.push({ item_name: name, field: k });
    // 空項目: value / value_num が共に空
    const vnum = typeof m.value_num === 'number' && Number.isFinite(m.value_num) ? m.value_num : null;
    if (isEmptyValue(m.value) && vnum == null) empty_items.push(name);
    // 重複: 同名 / 隣接同値(別名=行混線疑い)
    const key = norm(name);
    if (key) seenNames.set(key, (seenNames.get(key) ?? 0) + 1);
    if (vnum != null && vnum === prevValueNum && key && key !== norm(prevName)) {
      duplicate_items.push({ item_name: name, reason: `隣接項目「${prevName}」と同値(${vnum})＝行混線疑い` });
    }
    prevValueNum = vnum;
    prevName = name ?? '';
    // 捏造: 元データに無い項目
    if (sourceSet && key && !sourceSet.has(key)) fabricated_items.push(name);
    // 項目層: 必要マスタ外＝余剰候補
    if (master && key && !master.has(key)) surplus_items.push({ item_name: name, reason: '必要項目マスタ外' });
  }
  for (const [k, n] of seenNames) if (n > 1) duplicate_items.push({ item_name: k, reason: `同名が${n}回出現` });

  // 不足: 必要マスタにあるがJSONに無い
  const missing_required: string[] = [];
  if (master) {
    const present = new Set(measurements.map((m) => norm(m.name)));
    for (const req of opts.requiredItemsMaster ?? []) if (!present.has(norm(req))) missing_required.push(req);
  }

  // エンベロープ余剰
  const envAllow = new Set<string>(ENVELOPE_ALLOWLIST);
  const envelope_surplus = Object.keys(obj).filter((k) => !envAllow.has(k));

  const counts = {
    items: measurements.length,
    surplus_fields: surplus_fields.length,
    surplus_items: surplus_items.length,
    empty_items: empty_items.length,
    duplicate_items: duplicate_items.length,
    fabricated_items: fabricated_items.length,
    missing_required: missing_required.length,
    envelope_surplus: envelope_surplus.length,
  };
  const hasSurplus =
    counts.surplus_fields + counts.surplus_items + counts.empty_items + counts.duplicate_items + counts.fabricated_items + counts.envelope_surplus > 0;
  const result: NecessityReport['result'] = counts.missing_required > 0 ? 'deficient' : hasSurplus ? 'surplus' : 'clean';

  return { result, counts, surplus_fields, surplus_items, empty_items, duplicate_items, fabricated_items, missing_required, envelope_surplus };
}
