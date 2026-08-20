/**
 * AI 診断結果レポートから「要点」を取り出す (決定論・抽出のみ)。
 *
 * 【原則】アプリは値を評価しない。
 *   ここで行うのは **レポート本文に書かれている「判定区分」を拾って並べ替える**ことだけ。
 *   値と基準値を比べて良し悪しを決めることはしない (ミッション④「独自に分析・解釈しない」)。
 *   文言も要約せず、レポートの一文をそのまま切り出す。
 *
 * 【抽出できる根拠】レポートの「検査値フィードバック」章は
 *   `【血圧】血圧は 136 / 84 mmHg（判定区分：注意・経過観察）です。…`
 *   の形で、カテゴリと判定区分が本文に明記されている (2026-08 Stage2 版で確認)。
 *
 * 【フォーマット依存】上記の書式に依存する。書式が変わったら拾えなくなるが、
 *   **拾えないときは何も出さない**ので、誤った要点が出ることはない (fail-safe)。
 */

import type { ElithSection } from './elith-parser';

/** レポートが使う判定区分。表示順は健診の判定ラダーに合わせる (アプリの判断ではない)。 */
const JUDGEMENT_ORDER = ['要治療', '要検査', '緊急', '注意・経過観察', '異常なし'] as const;

export interface ReportPoint {
  /** 【】で括られたカテゴリ名 (例: 血圧)。 */
  category: string;
  /** レポート本文からそのまま切り出した一文。 */
  text: string;
  /** レポートが記載した判定区分。記載が無ければ null。 */
  judgement: string | null;
  /** 原本 PDF の該当ページ。 */
  page: number;
}

const FEEDBACK_SECTION = '検査値フィードバック';

/** `[pN]` 先頭マーカーからページ番号を取り出す。 */
function pageOf(section: ElithSection, fallback: number): number {
  const m = /^\[p(\d+)\]/.exec(section.text.trim());
  return m ? Number(m[1]) : fallback;
}

/**
 * 「検査値フィードバック」から、判定区分が明記されたカテゴリを抜き出す。
 * 判定区分の記載が無いカテゴリ (＝良好と本文に書かれているもの) は返さない。
 */
export function extractReportPoints(
  sections: ElithSection[],
  pages: Record<string, number> = {},
): ReportPoint[] {
  const fb = sections.find((s) => s.section_name === FEEDBACK_SECTION);
  if (!fb) return [];
  const page = pageOf(fb, pages[FEEDBACK_SECTION] ?? 1);

  const points: ReportPoint[] = [];
  // 【カテゴリ】本文 …【次のカテゴリ】… の形で分割する
  const parts = fb.text.split(/【([^】]+)】/);
  for (let i = 1; i < parts.length; i += 2) {
    const category = parts[i].trim();
    // 改行だけを畳む (数値と単位の間の空白は残す)
    const bodyRaw = (parts[i + 1] ?? '').replace(/\n+/g, '').replace(/[ \t]{2,}/g, ' ').trim();
    if (!category || !bodyRaw) continue;

    const judgements = [...bodyRaw.matchAll(/判定区分[：:]\s*([^）)、。]+)/g)].map((m) => m[1].trim());
    if (judgements.length === 0) continue; // 判定区分の記載が無いものは要点にしない

    // 記載された判定のうち、ラダー上もっとも重いものを代表にする
    const judgement =
      JUDGEMENT_ORDER.find((j) => judgements.includes(j)) ?? judgements[0];

    // 「…です。」までを一文として切り出す (要約しない)
    const sentence = bodyRaw.split('です。')[0];
    const text = sentence ? `${sentence}です。` : bodyRaw.slice(0, 120);

    points.push({ category, text, judgement, page });
  }

  points.sort(
    (a, b) =>
      JUDGEMENT_ORDER.indexOf(a.judgement as (typeof JUDGEMENT_ORDER)[number]) -
      JUDGEMENT_ORDER.indexOf(b.judgement as (typeof JUDGEMENT_ORDER)[number]),
  );
  return points;
}

/** 「医療受診の目安」の最優先所見。見出し直後の本文をそのまま返す。 */
export function extractTopPriority(
  sections: ElithSection[],
  pages: Record<string, number> = {},
): { text: string; page: number } | null {
  const s = sections.find((x) => x.section_name === '医療受診の目安');
  if (!s) return null;
  const m = /\*\*最優先[^*]*\*\*\s*([\s\S]+?)(?=\n\n\*\*|$)/.exec(s.text);
  if (!m) return null;
  const body = m[1].trim();
  if (!body) return null;
  const sentence = body.split('です。')[0];
  return {
    text: sentence ? `${sentence}です。` : body.slice(0, 160),
    page: pageOf(s, pages['医療受診の目安'] ?? 1),
  };
}
