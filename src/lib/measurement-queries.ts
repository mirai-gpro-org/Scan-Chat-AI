/**
 * 検査値 (diagnosis.measurement_values) の取得。
 *
 * 【原則 — このモジュールの存在理由】
 *   アプリの使命は「各診断結果を整理して伝える」ことであり、**独自に分析・解釈しない**。
 *   したがってここでは:
 *     - 判定レベルを計算しない (基準値と実測値から H/L を導出しない)
 *     - 助言文・コメントを生成しない
 *     - 検査機関が付けた flag ('H'/'L') と assessment (判定コード) を**そのまま**渡す
 *   並べ替えだけは行う。flag が付いた行を先に出すのは「検査機関が既に印を付けたものを
 *   先に見せる」であって、アプリによる判定ではない。
 *
 * データの出所は STEP 1 のマイグレーション (20260820000010_measurement_values.sql)。
 * 原本忠実の全記録は test_artifacts.measurements (jsonb) 側にあり、本表はグラフ用の正規化層。
 */

import { getServerSupabase } from './supabase';
import { demoFallbackEnabled, demoMetricTrend } from './demo-data';
import type { MetricTrendPoint, MetricTrendSeries } from './dashboard-queries';

/** 1 項目の検査値。値・単位・基準値・判定はすべて検査票由来をそのまま持つ。 */
export interface MeasurementItem {
  /** 原本の表記 */
  name: string;
  /** 標準マスタ照合でヒットした概念 ID。非ヒットは null (当て推量で埋めない) */
  canonicalName: string | null;
  value: string | null;
  valueNum: number | null;
  unit: string | null;
  refLow: string | null;
  refHigh: string | null;
  refLowNum: number | null;
  refHighNum: number | null;
  /** 検査機関が付けた基準外マーカー。アプリは算出しない */
  flag: 'H' | 'L' | null;
  /** 検査機関由来の判定コード (血液CSV の F2/A3 等)。デコードしない */
  assessment: string | null;
}

/** 直近 1 回分の検査値。 */
export interface LatestMeasurements {
  artifactId: string;
  testType: string;
  testDate: string | null;
  items: MeasurementItem[];
  /** flag が付いている件数 (検査機関が印を付けた数)。 */
  flaggedCount: number;
}

interface Row {
  artifact_id: string;
  test_type: string;
  test_date: string | null;
  seq: number;
  item_name: string;
  canonical_name: string | null;
  value: string | null;
  value_num: number | string | null;
  unit: string | null;
  ref_low: string | null;
  ref_high: string | null;
  ref_low_num: number | string | null;
  ref_high_num: number | string | null;
  flag: string | null;
  assessment: string | null;
}

const num = (v: number | string | null): number | null => {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const toItem = (r: Row): MeasurementItem => ({
  name: r.item_name,
  canonicalName: r.canonical_name,
  value: r.value,
  valueNum: num(r.value_num),
  unit: r.unit,
  refLow: r.ref_low,
  refHigh: r.ref_high,
  refLowNum: num(r.ref_low_num),
  refHighNum: num(r.ref_high_num),
  flag: r.flag === 'H' || r.flag === 'L' ? r.flag : null,
  assessment: r.assessment,
});

/**
 * 時系列グラフに出す既定の項目 (canonical_name)。
 * どれをグラフ化するかは表示上の選択であって、値の解釈ではない。
 */
export const DEFAULT_TREND_ITEMS = [
  'HbA1c(NGSP)',
  '空腹時血糖',
  'LDLコレステロール',
  'γ-GTP',
  '尿酸',
  'eGFR',
] as const;

/**
 * テストフェーズ用のフォールバック。
 * demo-data.ts と同じ方針で、**実データが無いときだけ**サンプルを返す
 * (env PUBLIC_DEMO_FALLBACK=false で無効化)。総合テストで env を落とすと消える。
 */
function demoLatest(): LatestMeasurements {
  const series = demoMetricTrend();
  const items: MeasurementItem[] = series.map((s) => {
    const last = s.points[s.points.length - 1];
    const high = s.referenceUpper ?? null;
    return {
      name: s.label,
      canonicalName: s.label,
      value: last.raw,
      valueNum: last.value,
      unit: s.unit,
      refLow: null,
      refHigh: high == null ? null : String(high),
      refLowNum: null,
      refHighNum: high,
      flag: high != null && last.value > high ? 'H' : null,
      assessment: null,
    };
  });
  const flagged = items.filter((i) => i.flag != null);
  return {
    artifactId: 'demo',
    testType: 'blood',
    testDate: series[0]?.points.at(-1)?.date ?? null,
    items: [...flagged, ...items.filter((i) => i.flag == null)],
    flaggedCount: flagged.length,
  };
}

/** 直近 1 回分の検査値を取得する。無ければ null (テストフェーズはデモへ)。 */
export async function getLatestMeasurements(
  diagnosticUserId: string,
): Promise<LatestMeasurements | null> {
  const sb = getServerSupabase();
  if (!sb) return demoFallbackEnabled() ? demoLatest() : null;
  try {
    // 最新の test_date を持つ 1 検査分だけを取る。
    const { data, error } = await sb
      .schema('diagnosis')
      .from('measurement_values')
      .select(
        'artifact_id, test_type, test_date, seq, item_name, canonical_name, value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag, assessment',
      )
      .eq('diagnostic_user_id', diagnosticUserId)
      .order('test_date', { ascending: false })
      .order('seq', { ascending: true })
      .limit(400);

    const rows = (data ?? []) as unknown as Row[];
    if (error || rows.length === 0) return demoFallbackEnabled() ? demoLatest() : null;

    const newest = rows[0];
    const same = rows.filter(
      (r) => r.artifact_id === newest.artifact_id && r.test_date === newest.test_date,
    );
    const items = same.sort((a, b) => a.seq - b.seq).map(toItem);

    // 検査機関が印を付けた行を先頭へ (アプリの判定ではなく、既にある印での並べ替え)。
    const flagged = items.filter((i) => i.flag != null);
    const rest = items.filter((i) => i.flag == null);

    return {
      artifactId: newest.artifact_id,
      testType: newest.test_type,
      testDate: newest.test_date,
      items: [...flagged, ...rest],
      flaggedCount: flagged.length,
    };
  } catch {
    return demoFallbackEnabled() ? demoLatest() : null;
  }
}

/**
 * 「表示項目の設定」で選べる候補を返す。
 *
 * **候補はマスタではなく実データから作る**。この人の measurement_values に実在し、
 * かつ**日付の違う点が 2 つ以上ある** (＝線が引ける) canonical_name だけを返す。
 * どの項目を既定にするかの選定基準は未確定なので、こちらで 20 項目のマスタを
 * でっち上げない (ミッション④・捏造ゼロ)。
 *
 * 並び順は DEFAULT_TREND_ITEMS の順 → 残りを名前順。回ごとに並びが揺れないようにする。
 */
export async function getTrendCandidates(
  diagnosticUserId: string,
  testType?: string,
): Promise<string[]> {
  const sb = getServerSupabase();
  // 実データ層が無いテストフェーズでは、デモの系列名をそのまま候補にする。
  if (!sb) return demoFallbackEnabled() ? demoMetricTrend().map((x) => x.label) : [];
  try {
    let q = sb
      .schema('diagnosis')
      .from('measurement_values')
      .select('canonical_name, test_type, test_date, value_num')
      .eq('diagnostic_user_id', diagnosticUserId)
      .not('canonical_name', 'is', null)
      .not('value_num', 'is', null)
      .limit(4000);
    if (testType) q = q.eq('test_type', testType);
    const { data, error } = await q;
    const rows = (data ?? []) as unknown as { canonical_name: string | null; test_date: string | null }[];
    if (error || rows.length === 0) {
      if (testType) return [];
      return demoFallbackEnabled() ? demoMetricTrend().map((x) => x.label) : [];
    }

    const dates = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!r.canonical_name || !r.test_date) continue;
      const set = dates.get(r.canonical_name) ?? new Set<string>();
      set.add(String(r.test_date));
      dates.set(r.canonical_name, set);
    }
    const drawable = [...dates.entries()].filter(([, d]) => d.size >= 2).map(([name]) => name);

    const head = DEFAULT_TREND_ITEMS.filter((n) => drawable.includes(n)) as string[];
    const rest = drawable.filter((n) => !head.includes(n)).sort((a, b) => a.localeCompare(b, 'ja'));
    return [...head, ...rest];
  } catch {
    if (testType) return [];
    return demoFallbackEnabled() ? demoMetricTrend().map((x) => x.label) : [];
  }
}

/**
 * 指定項目の時系列を取得する。
 * 各系列には検査票由来の基準値をそのまま添える (グラフの基準線に使う)。
 *
 * `testType` を渡すと、その検査種別 (health_checkup / blood / …) の測定値だけに絞る。
 * 検査結果セクションの「グラフ」は 1 種別ずつ開くので、その絞り込みに使う。
 * 絞り込んだ結果が空になったときは**デモへフォールバックしない** — 別種別のサンプルが
 * 出ると「この検査の推移」を誤って見せることになるため。
 */
export async function getMeasurementTrend(
  diagnosticUserId: string,
  canonicalNames: readonly string[] = DEFAULT_TREND_ITEMS,
  maxPoints = 12,
  testType?: string,
): Promise<MetricTrendSeries[]> {
  const sb = getServerSupabase();
  // 旧 getMetricTrend が持っていたデモフォールバックを踏襲する
  // (テストフェーズでクライアントに推移グラフを見てもらうために必要)。
  if (!sb || canonicalNames.length === 0) return demoFallbackEnabled() ? demoMetricTrend() : [];
  try {
    const { data, error } = await sb
      .schema('diagnosis')
      .from('measurement_values')
      .select(
        'artifact_id, test_type, test_date, seq, item_name, canonical_name, value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag, assessment',
      )
      .eq('diagnostic_user_id', diagnosticUserId)
      .in('canonical_name', canonicalNames as string[])
      .not('value_num', 'is', null)
      .order('test_date', { ascending: true })
      .limit(600);

    const all = (data ?? []) as unknown as Row[];
    const rows = testType ? all.filter((r) => r.test_type === testType) : all;
    if (error || rows.length === 0) {
      if (testType) return [];
      return demoFallbackEnabled() ? demoMetricTrend() : [];
    }

    const byName = new Map<string, Row[]>();
    for (const r of rows) {
      if (!r.canonical_name || !r.test_date) continue;
      const list = byName.get(r.canonical_name) ?? [];
      list.push(r);
      byName.set(r.canonical_name, list);
    }

    const out: MetricTrendSeries[] = [];
    // 指定順を保つ (表示順が run ごとに揺れないように)。
    for (const name of canonicalNames) {
      const list = byName.get(name);
      if (!list || list.length === 0) continue;
      const sorted = list
        .slice()
        .sort((a, b) => String(a.test_date).localeCompare(String(b.test_date)))
        .slice(-maxPoints);
      const points: MetricTrendPoint[] = [];
      for (const r of sorted) {
        const v = num(r.value_num);
        if (v == null) continue;
        points.push({
          date: String(r.test_date),
          value: v,
          raw: r.value ?? String(v),
          flag: r.flag === 'H' || r.flag === 'L' ? r.flag : null,
        });
      }
      if (points.length === 0) continue;
      const last = sorted[sorted.length - 1];
      out.push({
        label: name,
        unit: last.unit ?? '',
        referenceUpper: num(last.ref_high_num) ?? undefined,
        referenceLower: num(last.ref_low_num) ?? undefined,
        points,
      });
    }
    if (out.length === 0 && !testType && demoFallbackEnabled()) return demoMetricTrend();
    return out;
  } catch {
    if (testType) return [];
    return demoFallbackEnabled() ? demoMetricTrend() : [];
  }
}
