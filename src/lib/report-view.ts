/**
 * レポート本文の**和文組版**。内容には一切触れない (要約・言い換え・並べ替えをしない = ミッション④)。
 *
 * 正本: docs/elith/AI疾病予防報告書_仕様書.md  ※ § 番号は旧版 docs/旧版・ボツ/ai_prevention_report_generation_spec.md §4.3
 *
 * 【3 モードと `[pN]` は廃止】旧実装は a) サマリー / b) 要注意抜粋 / c) 全編 の 3 モードを
 *   切り替え、本文中の `[pN]` から原本 PDF の該当ページへ飛ばしていた。
 *   **新形式に `[pN]` は 0 件** (実測)。旧サンプルにあった `[pN]` はアプリが PDF 抽出時に
 *   付けたページマーカーで Elith 由来ではなかった (Stage2 PDF 原本も 0 件)。
 *   → ページジャンプは成立しないので廃止し、章の切り替えは表示モデル側が持つ (spec §5.1)。
 *
 * ここに残すのは組版だけ。`/report` から使う。
 */

import { marked } from 'marked';

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

export function renderReportMarkdown(text: string): string {
  if (!text) return '';
  return marked.parse(
    emphasizeTopicJa(paragraphizeJa(headingizeBoldLines(text))),
    { async: false },
  ) as string;
}
