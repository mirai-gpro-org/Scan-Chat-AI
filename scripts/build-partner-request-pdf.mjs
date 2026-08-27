/**
 * docs/lab/partner_demo_confirm_request.md → 送付用 PDF (宛先ごとに 1 通)
 *
 * 実行: node scripts/build-partner-request-pdf.mjs
 * 出力: docs/lab/partner_demo_confirm_request_laif.pdf
 *       docs/lab/partner_demo_confirm_request_prevent.pdf
 *
 * 【なぜ md 全体を PDF にしないか】
 *   md には §3「【社内メモ】LAiF とのフォーマット齟齬」や §0/§4/§5 の作業メモが入っている。
 *   これらは**社内用で、送信文面には含めない**(md の §0 / §3 冒頭に明記)。
 *   そのためこのスクリプトは **§1 / §2 の「件名」と「本文」だけ**を抜き出して組版する。
 *   md 側で §1/§2 の見出しや「### 件名」「### 本文」の構造を変えると、ここも直す必要がある
 *   (見つからなければ黙って空の PDF を出さず、エラーで止まる)。
 *
 * 【個人名を入れない】発注者指示 2026-08-25。宛名・差出人とも法人名 +「ご担当者様」で統一。
 *   このスクリプトは md をそのまま組版するだけなので、名前の有無は md 側が正。
 *
 * 差出日は既定で実行日。`--date 2026-08-25` で固定できる。
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SOURCE = resolve(ROOT, 'docs/lab/partner_demo_confirm_request.md');

const argDate = (() => {
  const i = process.argv.indexOf('--date');
  return i >= 0 ? process.argv[i + 1] : '';
})();

function todayJa(iso) {
  const d = iso ? new Date(`${iso}T00:00:00+09:00`) : new Date();
  if (Number.isNaN(d.getTime())) throw new Error(`--date が不正: ${iso}`);
  // 差出日は日本時間で書く (実行環境が UTC の Vercel/コンテナでも 1 日ずれない)
  const p = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}年${g('month')}月${g('day')}日`;
}

const LETTERS = [
  { slug: 'laif',    heading: '## 1. LAiF 株式会社 宛',   next: '## 2. ' },
  { slug: 'prevent', heading: '## 2. 株式会社プリベント 宛', next: '## 3. ' },
];

const md = readFileSync(SOURCE, 'utf8');
marked.setOptions({ gfm: true, breaks: true }); // 手紙なので改行はそのまま活かす

/**
 * 和文の `**強調**` を先に <strong> へ変換してから marked に渡す。
 *
 * CommonMark の right-flanking 規則では、閉じ `**` の**直前が約物**で**直後が約物でも空白でもない**
 * とき、その `**` は閉じ記号にならない。日本語では「**…（ダミー記入版）**を」のように
 * 括弧の直後で閉じる書き方が普通に出るため、**強調されず `**` がそのまま PDF に出る**
 * (実測 2026-08-25: LAiF 宛の ③ で 3 箇所)。相手に送る文書なので機械的に潰す。
 * 対象は 1 行内で閉じている非入れ子の `**…**` だけ (この文書の使い方に合わせた保守的な範囲)。
 */
function boldJa(text) {
  return text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}

/** md から 1 通分 (件名 / 本文) を切り出す。構造が変わっていたら例外で止める。 */
function extract({ heading, next }) {
  const start = md.indexOf(heading);
  if (start < 0) throw new Error(`見出しが見つからない: ${heading}`);
  const rest = md.slice(start + heading.length);
  const end = rest.indexOf(next);
  const section = end < 0 ? rest : rest.slice(0, end);

  const m = section.match(/### 件名\s*\n([\s\S]*?)\n### 本文\s*\n([\s\S]*)$/);
  if (!m) throw new Error(`「### 件名」「### 本文」を取り出せない: ${heading}`);

  const subject = m[1].trim();
  // 本文末尾の水平線 (--- = md のセクション区切り) は文面ではないので落とす
  const bodyRaw = m[2].replace(/\n-{3,}\s*$/, '').trim();

  // 日本語の書式に合わせ、先頭の宛名ブロック (最初の空行まで) を分けて置く
  const sep = bodyRaw.indexOf('\n\n');
  if (sep < 0) throw new Error(`宛名ブロックを分離できない: ${heading}`);
  return {
    subject,
    addressee: bodyRaw.slice(0, sep).trim(),
    body: bodyRaw.slice(sep).trim(),
  };
}

const CSS = `
  @page { size: A4; margin: 22mm 20mm 24mm 20mm; }
  html { font-size: 10.5pt; }
  body {
    margin: 0;
    color: #111827;
    background: #fff;
    /* 和文はコンテナに入っている IPAGothic を明示。実機(Mac/Win)では前の 2 つが当たる */
    font-family: "Hiragino Sans","Yu Gothic","Noto Sans JP","IPAGothic",sans-serif;
    line-height: 1.85;
  }
  .date { text-align: right; color: #374151; margin: 0 0 18px; }
  .addressee { font-size: 12pt; font-weight: 600; line-height: 1.7; margin: 0 0 22px; white-space: pre-line; }
  .subject {
    text-align: center;
    font-size: 13pt;
    font-weight: 700;
    margin: 0 0 24px;
    padding: 10px 12px;
    border-top: 2px solid #0f766e;
    border-bottom: 2px solid #0f766e;
  }
  p { margin: 0 0 10px; }
  ol, ul { margin: 4px 0 12px 22px; padding: 0; }
  li { margin: 0 0 4px; }
  strong { font-weight: 700; }
  a { color: #0f766e; word-break: break-all; }
  code {
    font-family: "SF Mono","Consolas","Menlo",monospace;
    background: #f3f4f6; padding: 1px 4px; border-radius: 3px; font-size: 0.92em;
  }
  /* 「■ ①」で始まる段落は小見出しとして扱う (md 側で見出し記法を使っていないため) */
  p { orphans: 2; widows: 2; }
  .foot { margin-top: 6px; }
`;

function renderHtml({ subject, addressee, body }, dateJa) {
  const html = marked.parse(boldJa(body));
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>${subject}</title>
<style>${CSS}</style></head>
<body>
<p class="date">${dateJa}</p>
<div class="addressee">${addressee}</div>
<div class="subject">${subject}</div>
${html}
</body></html>`;
}

const dateJa = todayJa(argDate);
// Playwright 同梱の Chromium が無い環境 (CI コンテナ等) 向けの逃げ道。
// 例: CHROMIUM_PATH=/opt/pw-browsers/chromium node scripts/build-partner-request-pdf.mjs
const executablePath = process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  for (const def of LETTERS) {
    const letter = extract(def);
    const out = resolve(ROOT, `docs/lab/partner_demo_confirm_request_${def.slug}.pdf`);
    const page = await browser.newPage();
    await page.setContent(renderHtml(letter, dateJa), { waitUntil: 'load' });
    await page.pdf({
      path: out,
      format: 'A4',
      printBackground: true,
      margin: { top: '22mm', bottom: '24mm', left: '20mm', right: '20mm' },
    });
    await page.close();
    console.log(`✓ ${out} (${(statSync(out).size / 1024).toFixed(1)} KB)`);
  }
} finally {
  await browser.close();
}
