// src/lib/blood-reference-master.ts
// 血液検査(デメカル)の「基準値/単位」マスタ と、測定値への付与ロジック。
// Elith 要望(2026-07): 検査項目→基準値/単位 を我々側で保持し、取り込み時に付与。
//   さらに value_num と基準の比較で flag(H/L) を自動で埋める。
//
// ⚠️ 重要（R3・医療データ）: 基準値・単位は「デメカルの公式基準値」を一次資料として登録すること。
//   記憶や一般的な臨床値で埋めない（デメカルの方法・機器で基準が異なり得るため）。
//   BLOOD_REFERENCE が空の項目は従来どおり unit/ref/flag = null（＝付与しない・挙動不変）。
//   登録後は取り込み時に unit/ref_low/ref_high を付与し、flag(H/L) を自動算出する。

import type { ElithMeasurement } from './elith-export';

export interface BloodRef {
  unit: string | null;
  /** 男女共通の基準範囲。 */
  low?: number | null;
  high?: number | null;
  /** 男女別がある項目のみ（sex に応じて優先。無ければ low/high を使用）。 */
  male?: { low?: number | null; high?: number | null };
  female?: { low?: number | null; high?: number | null };
}

/** 照合キー正規化（elith-blood-csv の norm と同方針: NFKC・小文字・空白/記号除去）。 */
function normKey(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[\s　・（）()]/g, '');
}

// キー = 標準項目名（elith-blood-csv の headerStdName が返す値。例 "総タンパク" / "ＴＰ"）。
// ↓ デメカルの公式基準値表で埋める。未登録の間は付与しない（安全側）。
// 例（数値はデメカル値で要確認のため未登録のまま）:
//   [normKey('総タンパク')]: { unit: 'g/dL', low: 6.5, high: 8.0 },
//   [normKey('ヘモグロビン')]: { unit: 'g/dL', male: { low: 13.5, high: 17.0 }, female: { low: 11.5, high: 15.0 } },
export const BLOOD_REFERENCE: Record<string, BloodRef> = {
  // TODO(デメカル一次資料): 検査項目・単位・基準範囲（男女別があれば男女別）をここに登録する。
};

function pickRange(ref: BloodRef, sex: string | null): { low: number | null; high: number | null } {
  const s = sex === 'male' ? ref.male : sex === 'female' ? ref.female : undefined;
  const low = (s && s.low != null ? s.low : ref.low) ?? null;
  const high = (s && s.high != null ? s.high : ref.high) ?? null;
  return { low, high };
}

/**
 * 測定値に 単位/基準値 を付与し、value_num と基準の比較で flag(H/L) を算出する（in-place）。
 * マスタ未登録・name 無しなら何もしない（unit/ref/flag は元の null のまま＝挙動不変）。
 * 既に値が入っている項目（CSVに単位/基準がある将来書式）は上書きしない。
 */
export function applyBloodReference(meas: ElithMeasurement, sex: string | null): void {
  if (!meas.name) return;
  const ref = BLOOD_REFERENCE[normKey(meas.name)];
  if (!ref) return;

  if (meas.unit == null && ref.unit != null) meas.unit = ref.unit;

  const { low, high } = pickRange(ref, sex);
  if (meas.ref_low == null && low != null) meas.ref_low = String(low);
  if (meas.ref_high == null && high != null) meas.ref_high = String(high);

  // flag: 数値かつ基準があるときのみ。範囲外を H/L。範囲内/不明は付与しない（null のまま）。
  if (meas.flag == null && typeof meas.value_num === 'number') {
    if (high != null && meas.value_num > high) meas.flag = 'H';
    else if (low != null && meas.value_num < low) meas.flag = 'L';
  }
}
