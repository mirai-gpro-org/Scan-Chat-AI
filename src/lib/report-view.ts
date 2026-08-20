/**
 * レポート表示 (3 モード + PDF deep-link) の共通ロジック。
 *
 * 正本: docs/architecture/test_data_storage_and_db_design.md §6.4
 *   a) サマリー / b) 要注意抜粋 / c) 全編 の 3 モードを切り替え、
 *   a/b の各項目に置かれた `[pN]` から c) の PDF 該当ページへ飛ぶ。
 *
 * この変換を /result/[id] と /report で二重管理しないため、ここに集約する。
 */

import { marked } from 'marked';

export type ReportMode = 'summary' | 'highlights' | 'full';

export const REPORT_MODES: { key: ReportMode; label: string; note: string }[] = [
  { key: 'summary',    label: 'サマリー',   note: '要点だけを 1 画面で' },
  { key: 'highlights', label: '要注意',     note: '優先度の高い項目' },
  { key: 'full',       label: '全編',       note: '原本レポートの全文' },
];

export function isReportMode(v: string | null | undefined): v is ReportMode {
  return v === 'summary' || v === 'highlights' || v === 'full';
}

interface LinkOpts {
  /** テストフェーズの ?u= を引き継ぐ。 */
  u?: string | null;
  /** 遷移先パス (既定は現在のページ = 空文字)。 */
  basePath?: string;
}

/** モード切替リンク。 */
export function modeHref(mode: ReportMode, opts: LinkOpts = {}): string {
  const qs = new URLSearchParams();
  if (opts.u) qs.set('u', opts.u);
  qs.set('mode', mode);
  return `${opts.basePath ?? ''}?${qs.toString()}`;
}

/**
 * 本文 Markdown を HTML 化し、`[pN]` を「原本 PDF の N ページ目へ飛ぶリンク」に変換する。
 * クリック時はページ遷移せず iframe を直接更新する (ページ側のスクリプトが拾う)。
 */
export function renderReportMarkdown(text: string, opts: LinkOpts = {}): string {
  if (!text) return '';
  const linked = text.replace(/\[p(\d+)\]/g, (_m, n: string) => {
    const qs = new URLSearchParams();
    if (opts.u) qs.set('u', opts.u);
    qs.set('mode', 'full');
    qs.set('page', n);
    const cls =
      'pdf-page-link inline-flex min-h-touch items-center gap-1 rounded-full border border-brand-300 '
      + 'bg-brand-50 px-2.5 py-0.5 text-sm font-medium text-brand-800 no-underline hover:bg-brand-100';
    return `<a href="${opts.basePath ?? ''}?${qs.toString()}#pdf-viewer" class="${cls}"`
      + ` data-pdf-page="${n}" title="原本レポートの ${n} ページ目を見る">原本 p${n}</a>`;
  });
  return marked.parse(linked, { async: false }) as string;
}

/** `?page=` を 1 以上の整数に正規化する。 */
export function normalizePage(v: string | null | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}
