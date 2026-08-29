/**
 * AI疾病予防報告書 (Elith の診断結果) の取得 — パイプライン⑥ の暫定実装。
 *
 * 【データの所在】diagnosis.diagnosis_results が「Elith の診断結果 1 回分」を表す。
 *   report              … セクション JSON (3 モードの a/b/c すべての本文)
 *   report_pdf_url      … レポート PDF (20260820000040 で追加)
 *   status              … received / extracted / published / superseded
 *
 * 【優先順位】実データ → サンプル。
 *   diagnosis_results に PDF 付きの行があればそれを表示し、無ければ
 *   Elith 提供のサンプル (2026-08-06 Stage2 版) にフォールバックする。
 *   demo-data.ts と同じ「実データが入れば自動で切り替わる」流儀に揃えている。
 *
 * 【未確定】受取仕様 (命名規則・出力トリガ・世代管理・ひも付け・受領確認) は
 *   docs/lab/lab_data_pipeline_master_spec.md:98 のとおり未確定。世代管理は
 *   暫定で status='superseded' と received_at の新しい順で代用する。
 */

import { getServerSupabase } from './supabase';
import { getOriginalSignedUrl } from './originals-storage';
import { demoFallbackEnabled } from './demo-data';
import { ELITH_REPORT_SAMPLE, ELITH_REPORT_PDF, ELITH_REPORT_PAGES } from './elith-report-sample';
import type { ElithSection } from './elith-parser';
import { AI_PREVENTION_REPORT_LABEL } from './display-names';

export interface ElithReportView {
  sections: ElithSection[];
  pdf: { url: string; label: string; pageCount: number; issuedOn: string } | null;
  /** 章名 → 原本 PDF の開始ページ。 */
  pages: Record<string, number>;
  /** true = Elith 提供のサンプルを表示している (実データ未受領)。 */
  isSample: boolean;
  /** 実データのとき、その受領日時。 */
  receivedAt: string | null;
}

/** サンプル (実データが無いときの表示)。 */
function sampleView(): ElithReportView {
  return {
    sections: ELITH_REPORT_SAMPLE,
    pdf: { ...ELITH_REPORT_PDF },
    pages: ELITH_REPORT_PAGES,
    isSample: true,
    receivedAt: null,
  };
}

/** セクション先頭の `[pN]` から章 → ページ の対応表を作る。 */
function pagesFromSections(sections: ElithSection[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sections) {
    const m = /^\s*\[p(\d+)\]/.exec(s.text ?? '');
    if (m) out[s.section_name] = Number(m[1]);
  }
  return out;
}

/**
 * 最新の AI疾病予防報告書を取得する。
 * 実データが無い / Supabase 未接続のときはサンプルへフォールバックする。
 */
export async function loadElithReport(diagnosticUserId: string | null): Promise<ElithReportView> {
  const sb = getServerSupabase();
  if (!sb || !diagnosticUserId) return sampleView();

  try {
    const { data, error } = await (sb.schema('diagnosis') as any)
      .from('diagnosis_results')
      .select('report, report_pdf_url, report_pdf_pages, received_at, status')
      .eq('diagnostic_user_id', diagnosticUserId)
      .neq('status', 'superseded')
      .not('report_pdf_url', 'is', null)
      .order('received_at', { ascending: false })
      .limit(1);

    const row = (data ?? [])[0] as
      | { report: unknown; report_pdf_url: string; report_pdf_pages: number | null; received_at: string }
      | undefined;
    if (error || !row) return demoFallbackEnabled() ? sampleView() : { ...sampleView(), sections: [], pdf: null };

    const url = await getOriginalSignedUrl(row.report_pdf_url);
    if (!url) return sampleView();

    const sections: ElithSection[] = Array.isArray(row.report) ? (row.report as ElithSection[]) : [];
    return {
      sections,
      pdf: {
        url,
        label: `${AI_PREVENTION_REPORT_LABEL} (Elith)`,
        pageCount: row.report_pdf_pages ?? 0,
        issuedOn: String(row.received_at).slice(0, 10),
      },
      pages: pagesFromSections(sections),
      isSample: false,
      receivedAt: row.received_at,
    };
  } catch {
    return sampleView();
  }
}
