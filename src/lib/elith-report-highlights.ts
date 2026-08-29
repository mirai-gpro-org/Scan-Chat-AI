/**
 * AI疾病予防報告書から「要点」を取り出す — **`report-adapter.ts` への薄い橋渡し**。
 *
 * 【なぜ薄いか】変換規則は 1 モジュールが所有する
 * (`docs/elith/ai_prevention_report_generation_spec.md` §1.3.4)。抽出の実体は
 * `report-adapter.ts` の `extractFindings()` / `extractTopPriority()` にあり、
 * ここは既存の呼び出し元 (`report.astro` の 3 モード表示) の形に合わせるだけ。
 * **P2 で `report.astro` を表示モデル駆動へ書き換えたら、このファイルは不要になる。**
 *
 * 【検出ルールを差し替えた (2026-08-29・spec §5.2)】
 *   旧: `（判定区分：X）` … Stage2 の書式。**新形式には 0 件**なので、
 *       放置すると新データで**無言で空になる**。
 *   新: **Elith 自身が書いた判定文** (`基準範囲を上回っています` 等) を原文のまま拾う。
 *   旧形式もサンプル表示のため引き続き読める (アダプタ側で両対応)。
 *
 * 【並べ替えをやめた】旧実装は判定区分のラダー (`要治療 > 要検査 > …`) で並べ替えていたが、
 *   どれが重いかを当社が決めることになる。**Elith が書いた順のまま**出す。
 *   最優先は Elith 自身が「医療受診の目安」に書いているので、そちらを使う (spec §4.2.1)。
 *
 * 【原則】アプリは値を評価しない。値と基準値を比べて良し悪しを決めない (ミッション④)。
 * 【fail-safe】拾えないときは何も出さない。誤った要点は出さない。
 */

import type { ElithSection } from './elith-parser';
import {
  extractFindings,
  extractTopPriority as adapterTopPriority,
  parseReportText,
} from './report-adapter';

export interface ReportPoint {
  /** 【】で括られたカテゴリ名 (例: 血圧)。 */
  category: string;
  /** レポート本文からそのまま切り出した一文。 */
  text: string;
  /** **Elith が書いた判定文**そのまま。記載が無ければ null。 */
  judgement: string | null;
  /** 原本 PDF の該当ページ。新形式に `[pN]` は無いので既定 1 (spec §5.1)。 */
  page: number;
}

const FEEDBACK_SECTION = '検査値フィードバック';
const VISIT_SECTION = '医療受診の目安';

/** `[pN]` 先頭マーカーからページ番号を取り出す (旧形式のみ)。 */
function pageOf(sections: ElithSection[], name: string, pages: Record<string, number>): number {
  const s = sections.find((x) => x.section_name === name);
  const m = s ? /^\[p(\d+)\]/.exec(s.text.trim()) : null;
  return m ? Number(m[1]) : pages[name] ?? 1;
}

/**
 * 「検査値フィードバック」から、Elith が判定文を書いたカテゴリを抜き出す。
 * 判定文の無いカテゴリは返さない。**並べ替えない。**
 */
export function extractReportPoints(
  sections: ElithSection[],
  pages: Record<string, number> = {},
): ReportPoint[] {
  const { byKey } = parseReportText(sections);
  const page = pageOf(sections, FEEDBACK_SECTION, pages);
  return extractFindings(byKey).map((f) => ({
    category: f.category,
    text: f.sentence,
    judgement: f.judgement,
    page,
  }));
}

/** 「医療受診の目安」の最優先所見。見出し直後の本文をそのまま返す。 */
export function extractTopPriority(
  sections: ElithSection[],
  pages: Record<string, number> = {},
): { text: string; page: number } | null {
  const { byKey } = parseReportText(sections);
  const found = adapterTopPriority(byKey);
  return found ? { text: found.text, page: pageOf(sections, VISIT_SECTION, pages) } : null;
}
