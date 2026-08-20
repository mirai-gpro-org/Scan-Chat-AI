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
import { ICON_SVG } from './icon-svg';

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

/**
 * 長い一続きの本文を、文の切れ目で段落に割る。
 *
 * Elith のレポートは 1 章がまるごと 1 段落 (改行なし・実測 600 字超) で届くため、
 * そのまま出すと「文字の壁」になり読む気にならない。**内容には一切触れず**、
 * 「。」の後ろに空行を入れて段落化するだけ (要約・言い換え・並べ替えはしない)。
 *
 * 触らない行:
 *   - 見出し / 箇条書き / 表 / 引用 など Markdown の構造を持つ行
 *   - 「。」が SENTENCES_PER_PARA 個以下しかない短い行
 */
const SENTENCES_PER_PARA = 2;

export function paragraphizeJa(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      // Markdown の構造行はそのまま (# 見出し / - * + 箇条書き / 1. / | 表 / > 引用)
      if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>)/.test(t)) return line;
      // 太字だけの行 = 小見出し扱いなので割らない
      if (/^\*\*.*\*\*$/.test(t)) return line;
      const sentences = t.split(/(?<=。)/).filter(Boolean);
      if (sentences.length <= SENTENCES_PER_PARA) return line;
      const out: string[] = [];
      for (let i = 0; i < sentences.length; i += SENTENCES_PER_PARA) {
        out.push(sentences.slice(i, i + SENTENCES_PER_PARA).join(''));
      }
      return out.join('\n\n');
    })
    .join('\n');
}


/**
 * 文頭の「主題」を太字にする。
 *
 * 目的: 長文が均一な灰色の塊に見えて、何の話かが目に飛び込んでこない状態を避ける。
 *
 * 【内容の解釈はしない】どこが重要かを判断するのではなく、**日本語の文法構造**
 * (文頭に置かれる主題提示部) を機械的に拾うだけ。
 *   「現在の健康状態について、…」        → 「現在の健康状態について」
 *   「また、がんリスク評価については…」   → 「がんリスク評価については」
 *   「一方で、今回の検査結果では…」       → 「今回の検査結果では」
 * 主題マーカーが無い文 (「まずは無理のない範囲で…」等) は何もしない。
 * 文字は 1 つも増減させず、`**` を挿し込むだけ (ミッション④: 要約・加工しない)。
 */

/** 文頭に来る接続語。主題はこの後ろから始まる。 */
const CONJ = '(?:また|一方(?:で)?|さらに|加えて|そのため|したがって|ただし|なお|次に|続いて|あわせて|しかし|そして|一般に|特に)';
/** 主題を示す助詞。長いものから順に見る。 */
const TOPIC_MARK = '(?:については|について|に関しては|に関して|としては|における|におけるは|では|は)';
/** 指示語だけの主題 (「これは」「その点は」等) は太字にしても情報が無いので除外。 */
const DEMONSTRATIVE = /^(?:これ|それ|あれ|この|その|あの|ここ|そこ|以上|以下|なお|そのため)/;

const TOPIC_RE = new RegExp(
  `^(\\s*(?:${CONJ}[、,]\\s*)?)([^、。！？\\n]{3,20}?)(${TOPIC_MARK})(?=[、。]|[^、。])`,
);

/** 1 文を受け取り、主題があれば `**` で囲んで返す。無ければそのまま。 */
function emphasizeSentence(sentence: string): string {
  // 先頭の [pN] マーカーは主題判定の対象外 (後段でリンクに変換される)
  const lead = /^\s*\[p\d+\]\s*/.exec(sentence);
  const head = lead ? lead[0] : '';
  const rest = sentence.slice(head.length);

  const m = TOPIC_RE.exec(rest);
  if (!m) return sentence;
  const [, prefix, topic, mark] = m;
  if (DEMONSTRATIVE.test(topic)) return sentence;
  const at = prefix.length + topic.length + mark.length;
  return `${head}${prefix}**${topic}${mark}**${rest.slice(at)}`;
}

export function emphasizeTopicJa(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      // Markdown の構造行 / すでに強調のある行は触らない (`**` の入れ子を作らない)
      if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>)/.test(t)) return line;
      if (line.includes('**')) return line;
      // **1 段落につき 1 箇所だけ**。全文がボールドだらけになると強調の意味が消え、
      // かえって読みにくくなるため、最初に主題が見つかった文でおしまいにする。
      let done = false;
      return line
        .split(/(?<=。)/)
        .map((sentence) => {
          if (done) return sentence;
          const out = emphasizeSentence(sentence);
          if (out !== sentence) done = true;
          return out;
        })
        .join('');
    })
    .join('\n');
}


/**
 * `**小見出し**` だけの行を、本物の見出し (h4) にする。
 *
 * Elith のレポートは章の中の小見出しを「その行が丸ごと太字」で表現してくる。
 * これを段落 (`<p><strong>…</strong></p>`) のまま出すと、CSS 側で
 * 「太字だけの段落＝小見出し」を判定する必要があり、`p:has(> strong:first-child:last-child)`
 * のような選択子になる。**これは text ノードを数えないため誤爆する** —
 * 文中に 1 箇所だけ強調を入れた段落まで小見出し扱いになり、段落全体が太字になった
 * (実測 2026-08)。構造は構造として出しておく方が安全なので、ここで見出しに変換する。
 */
export function headingizeBoldLines(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const m = /^\s*\*\*(.+?)\*\*\s*$/.exec(line);
      return m ? `#### ${m[1]}` : line;
    })
    .join('\n');
}

export function renderReportMarkdown(text: string, opts: LinkOpts = {}): string {
  if (!text) return '';
  const linked = emphasizeTopicJa(paragraphizeJa(headingizeBoldLines(text))).replace(/\[p(\d+)\]/g, (_m, n: string) => {
    const qs = new URLSearchParams();
    if (opts.u) qs.set('u', opts.u);
    qs.set('mode', 'full');
    qs.set('page', n);
    const cls =
      'pdf-page-link inline-flex min-h-touch items-center gap-1.5 rounded-full border border-brand-300 '
      + 'bg-brand-50 px-3 py-0.5 text-sm font-medium text-brand-800 no-underline hover:bg-brand-100';
    // ページ番号は読み手には意味が無いので出さない (飛び先の指定には引き続き使う)。
    // 絵文字は本番素材に使わない規則があるため、アイコンは Lucide の SVG を使う。
    return `<a href="${opts.basePath ?? ''}?${qs.toString()}#pdf-viewer" class="${cls}"`
      + ` data-pdf-page="${n}" title="原本レポートの該当ページを開く">${ICON_SVG.report}説明</a>`;
  });
  return marked.parse(linked, { async: false }) as string;
}

/** `?page=` を 1 以上の整数に正規化する。 */
export function normalizePage(v: string | null | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}
