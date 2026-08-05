// src/lib/canonicalize.ts
// ②正準化（Normalize）エンジン = テンプレート穴埋め方式 S1〜S3（P2）。
// 参照: docs/scan/基本設定書.md §3.6, docs/scan/修正仕様書_正準化エンジン.md, docs/scan/基本設定書_実装修正プラン.md(P2)
//
// 責務（層を混ぜない）:
//   - 入力は「①読取 + sanitizeMeasurementsForDelivery 済」の lean measurement（name/value/value_num/unit/…）。
//   - name をマスタの標準名へ寄せ、単位を標準へ正準化する（S2）。移植カバレッジを記録する（S3）。
//   - **読取値そのもの（value/value_num の数値）は変えない**。ただし単位換算(unit_convert)登録がある項目のみ換算する
//     （starter には換算登録が無いので現状は発火しない＝numeric 不変）。
//   - **捏造ゼロ・保守的**: マスタにヒットした時だけ正準化。非ヒットは元名のまま通す（捨てない・別項目に当てない）。
//   - S4(空スロット削除)は既存 sanitizeMeasurementsForDelivery が担うため、ここでは削除しない。
//
// 呼び出しは env SCAN_CANONICALIZE=on（elith-export.canonicalizeEnabled）のときだけ。off の間は挙動不変。

import { STANDARD_MASTER, buildAliasIndex, normKey, type StandardItem } from './standard-master';

export interface CanonMapEntry {
  from: string;            // 元の name（pickDeliveryName 出力）
  to: string;              // 正準名（canonical_name）
  unit_from: string | null;
  unit_to: string | null;
  converted?: boolean;     // 単位換算で value_num を変更したか
}
export interface CanonUnmapped {
  name: string | null;     // マスタ外（surplus 候補）。silent drop せず記録する。
  value: unknown;
}
export interface CanonicalizeResult {
  delivery: Record<string, unknown>[]; // 正準化後の measurement（順序保持・件数不変）
  mapped: CanonMapEntry[];             // S2: 何を正準化したか（監査）
  unmapped: CanonUnmapped[];           // S3: マスタ外（余剰候補・提示のみ。自動削除しない）
  deficient: string[];                 // S3: マスタにあるが値が来なかった標準名
}

/** 監査サマリ（delivery を除いた可視化用。Elith 納品 data には含めない）。 */
export interface CanonAudit {
  mapped: CanonMapEntry[];
  unmapped: CanonUnmapped[];
  deficient: string[];
}
export function canonAudit(r: CanonicalizeResult): CanonAudit {
  return { mapped: r.mapped, unmapped: r.unmapped, deficient: r.deficient };
}

/** 単位の照合用正規化（NFKC・小文字・空白除去。記号は保持=単位の区別に必要）。 */
function normUnit(s: unknown): string {
  return typeof s === 'string' ? s.normalize('NFKC').toLowerCase().replace(/[\s　]/g, '') : '';
}

/**
 * 単位を標準へ寄せ、必要なら換算する。保守的:
 *  - 定性項目(item.unit==null) は触らない。
 *  - 空単位 → 標準単位を補完。
 *  - 標準単位そのもの / 別名 → 標準表記へ寄せる（値は不変）。
 *  - 換算登録(unit_convert)があり数値があるときだけ換算（factor を掛ける）。
 *  - それ以外の未知単位は**触らない**（誤って標準名に付け替えて value と不整合を作らない）。
 */
function normalizeUnit(
  item: StandardItem,
  unit: unknown,
  valueNum: number | null,
): { unit: string | null; value_num: number | null; converted: boolean } {
  const cur = typeof unit === 'string' ? unit : null;
  if (item.unit == null) return { unit: cur, value_num: valueNum, converted: false }; // 定性: 触らない
  const nu = normUnit(unit);
  if (!nu) return { unit: item.unit, value_num: valueNum, converted: false }; // 空 → 標準補完
  const aliases = (item.unit_aliases ?? []).map(normUnit);
  if (nu === normUnit(item.unit) || aliases.includes(nu)) {
    return { unit: item.unit, value_num: valueNum, converted: false }; // 表記ゆれ → 標準表記
  }
  for (const c of item.unit_convert ?? []) {
    if (normUnit(c.from) === nu && typeof valueNum === 'number' && Number.isFinite(valueNum)) {
      return { unit: item.unit, value_num: valueNum * c.factor, converted: true };
    }
  }
  return { unit: cur, value_num: valueNum, converted: false }; // 未知単位 → 触らない
}

/**
 * lean measurement[] をマスタへ写像する（S1〜S3・決定論・保守的）。
 * @param measurements sanitizeMeasurementsForDelivery 済の measurement 配列
 * @param opts.master  差し替え用マスタ（既定 STANDARD_MASTER）
 */
export function canonicalize(
  measurements: unknown,
  opts?: { master?: StandardItem[] },
): CanonicalizeResult {
  const master = opts?.master ?? STANDARD_MASTER;
  const index = buildAliasIndex(master); // S1: 標準スロットの索引（1回だけ構築）
  const list: Record<string, unknown>[] = Array.isArray(measurements)
    ? (measurements as unknown[]).filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    : [];

  const delivery: Record<string, unknown>[] = [];
  const mapped: CanonMapEntry[] = [];
  const unmapped: CanonUnmapped[] = [];
  const present = new Set<string>();

  for (const rec of list) {
    const name = typeof rec.name === 'string' ? rec.name : null;
    const item = name ? index.get(normKey(name)) ?? null : null;
    if (!item) {
      // 非ヒット: 元のまま通す（捨てない・別項目に当てない）。surplus 候補として記録。
      delivery.push(rec);
      unmapped.push({ name, value: rec.value ?? rec.value_num ?? null });
      continue;
    }
    // S2: 正準名 + 単位正準化
    const unitBefore = typeof rec.unit === 'string' ? rec.unit : null;
    const vnumBefore = typeof rec.value_num === 'number' && Number.isFinite(rec.value_num) ? rec.value_num : null;
    const u = normalizeUnit(item, rec.unit, vnumBefore);
    const out: Record<string, unknown> = { ...rec, name: item.canonical_name, unit: u.unit };
    if (u.converted) {
      out.value_num = u.value_num;
      out.value = u.value_num == null ? rec.value : String(u.value_num); // value 文字列も換算後に合わせる
    }
    present.add(item.canonical_name);
    const unitChanged = (unitBefore ?? null) !== (u.unit ?? null);
    if (name !== item.canonical_name || unitChanged || u.converted) {
      mapped.push({
        from: name as string,
        to: item.canonical_name,
        unit_from: unitBefore,
        unit_to: u.unit ?? null,
        ...(u.converted ? { converted: true } : {}),
      });
    }
    delivery.push(out);
  }

  // S3: 不足（マスタにあるが値が来なかった標準名）。削除でなく記録。
  const deficient = master.map((m) => m.canonical_name).filter((n) => !present.has(n));

  return { delivery, mapped, unmapped, deficient };
}
