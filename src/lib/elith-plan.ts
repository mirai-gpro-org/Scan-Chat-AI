// src/lib/elith-plan.ts
// Elith 納品用 疑似データの「プラン定義」と 3年スケジュール展開（純粋・決定論）。
// 参照: docs/elith/elith_synthetic_timeseries_plan_spec.md §1-3, §7

import { addMonths } from './elith-synthetic';

export interface FormatCadence {
  formatId: string;
  perYear?: number;        // 年あたり回数
  intervalMonths?: number; // 回間の間隔(月)
  lifetimeOnce?: boolean;  // 生涯1回(初年 第1回のみ)
  kind?: string;           // Other 用ヒント (ai_prediction)
}
export interface PlanDef {
  key: string;
  name: string;
  formats: FormatCadence[];
}

// クライアント確定(2026-07)の2プラン。
export const PLANS: Record<string, PlanDef> = {
  executive: {
    key: 'executive',
    name: '経営層・幹部プラン',
    formats: [
      { formatId: 'HealthCheckupData', perYear: 1, intervalMonths: 12 },
      { formatId: 'BloodTestData', perYear: 3, intervalMonths: 4 },
      { formatId: 'CancerRiskAssessmentData', perYear: 3, intervalMonths: 4 },
      { formatId: 'Other', perYear: 1, intervalMonths: 12, kind: 'ai_prediction' },
      { formatId: 'GeneticTestResultData', lifetimeOnce: true },
    ],
  },
  middle: {
    key: 'middle',
    name: 'ミドルマネジメントプラン',
    formats: [
      { formatId: 'HealthCheckupData', perYear: 1, intervalMonths: 12 },
      { formatId: 'CancerRiskAssessmentData', perYear: 2, intervalMonths: 6 },
    ],
  },
};

export interface Occurrence {
  formatId: string;
  kind?: string;
  testDate: string;      // YYYY-MM-DD
  monthsFromBase: number;
  occIndex: number;      // その format 内の 0 始まり通番 (seed 用)
}

/**
 * プラン + 基準日(D0) + 年数 → 全 format の occurrence 一覧に展開する。
 *   - 年内の回は intervalMonths 刻み: monthsFromBase = yearIdx*12 + r*intervalMonths。
 *   - 年次(perYear=1,interval=12)は各年の第1回(月0/12/24)に載り、同月の他検査と同じ date に揃う。
 *   - lifetimeOnce は月0(初年 第1回)のみ。
 */
export function expandPlanSchedule(plan: PlanDef, baseDate: string, years: number): Occurrence[] {
  const out: Occurrence[] = [];
  for (const f of plan.formats) {
    if (f.lifetimeOnce) {
      out.push({ formatId: f.formatId, kind: f.kind, testDate: addMonths(baseDate, 0), monthsFromBase: 0, occIndex: 0 });
      continue;
    }
    const perYear = Math.max(1, f.perYear ?? 1);
    const interval = Math.max(1, f.intervalMonths ?? 12);
    let occIndex = 0;
    for (let y = 0; y < years; y++) {
      for (let r = 0; r < perYear; r++) {
        const monthsFromBase = y * 12 + r * interval;
        out.push({ formatId: f.formatId, kind: f.kind, testDate: addMonths(baseDate, monthsFromBase), monthsFromBase, occIndex: occIndex++ });
      }
    }
  }
  return out;
}
