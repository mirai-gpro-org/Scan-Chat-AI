/**
 * docs/funding_application/*.md → PDF 変換スクリプト
 *
 * 実行: node scripts/build-funding-pdf.mjs
 * 出力: docs/funding_application/要件定義書.pdf, 見積書.pdf
 *
 * Playwright (chromium) で MD→HTML→PDF。日本語フォント (Hiragino Sans / Noto)
 * を直接指定し、A4 縦・印刷品質。
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const FUNDING_DIR = resolve(ROOT, 'docs/funding_application');

const TARGETS = [
  { md: resolve(FUNDING_DIR, '要件定義書.md'),  pdf: resolve(FUNDING_DIR, '要件定義書.pdf'),  title: 'Scan-Chat Medical AI — 要件定義書 v2.1' },
  { md: resolve(FUNDING_DIR, '見積書.md'),    pdf: resolve(FUNDING_DIR, '見積書.pdf'),    title: 'Scan-Chat Medical AI — 見積書 v2.1' },
];

const CSS = `
  @page {
    size: A4;
    margin: 20mm 18mm 22mm 18mm;
    @bottom-center {
      content: counter(page) " / " counter(pages);
      font-family: "Hiragino Sans","Noto Sans JP","Yu Gothic",sans-serif;
      font-size: 9pt;
      color: #888;
    }
  }
  :root {
    --fg: #111827;
    --muted: #6b7280;
    --line: #e5e7eb;
    --bg: #ffffff;
    --accent: #2563eb;
    --code-bg: #f3f4f6;
  }
  html { font-size: 10.5pt; }
  body {
    color: var(--fg);
    background: var(--bg);
    font-family: "Hiragino Sans","Noto Sans JP","Yu Gothic","Segoe UI","Helvetica Neue",sans-serif;
    line-height: 1.6;
    margin: 0;
  }
  h1 {
    font-size: 20pt;
    border-bottom: 3px solid var(--accent);
    padding-bottom: 6px;
    margin: 0 0 14px;
    color: #0f172a;
  }
  h2 {
    font-size: 14pt;
    margin: 22px 0 8px;
    color: #1f2937;
    border-left: 5px solid var(--accent);
    padding-left: 10px;
    page-break-after: avoid;
  }
  h3 {
    font-size: 12pt;
    margin: 16px 0 6px;
    color: #1f2937;
    page-break-after: avoid;
  }
  h4 {
    font-size: 11pt;
    margin: 12px 0 4px;
    color: #374151;
  }
  p { margin: 6px 0; }
  ul, ol { margin: 6px 0 6px 20px; padding: 0; }
  li { margin: 2px 0; }
  strong { color: #111827; }
  code {
    font-family: "JetBrains Mono","SF Mono","Consolas","Menlo",monospace;
    background: var(--code-bg);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 0.92em;
  }
  pre {
    background: var(--code-bg);
    border-left: 3px solid var(--accent);
    padding: 10px 12px;
    border-radius: 4px;
    overflow-x: auto;
    font-family: "JetBrains Mono","SF Mono","Consolas","Menlo",monospace;
    font-size: 9pt;
    line-height: 1.4;
    page-break-inside: avoid;
    white-space: pre-wrap;
    word-break: break-word;
  }
  pre code { background: transparent; padding: 0; }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 8px 0 12px;
    font-size: 9.5pt;
    page-break-inside: avoid;
  }
  thead { background: #f9fafb; }
  th, td {
    border: 1px solid var(--line);
    padding: 5px 8px;
    text-align: left;
    vertical-align: top;
  }
  th { font-weight: 600; color: #1f2937; }
  blockquote {
    border-left: 3px solid #94a3b8;
    margin: 8px 0;
    padding: 4px 12px;
    color: var(--muted);
    background: #f9fafb;
  }
  hr {
    border: none;
    border-top: 1px solid var(--line);
    margin: 18px 0;
  }
  h2 + p, h2 + pre, h2 + table { page-break-before: avoid; }
  table, pre, blockquote { page-break-inside: avoid; }
  body > table:first-of-type {
    margin-top: 4px;
    width: 75%;
  }
  body > table:first-of-type td:first-child {
    width: 28%;
    background: #f9fafb;
    color: var(--muted);
    font-weight: 500;
  }
`;

marked.setOptions({ gfm: true, breaks: false });

const browser = await chromium.launch();
const page = await browser.newPage();

for (const { md, pdf, title } of TARGETS) {
  const source = readFileSync(md, 'utf8');
  const body = marked.parse(source);
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
${body}
</body>
</html>`;

  await page.setContent(html, { waitUntil: 'load' });
  await page.pdf({
    path: pdf,
    format: 'A4',
    printBackground: true,
    margin: { top: '20mm', bottom: '22mm', left: '18mm', right: '18mm' },
  });

  const size = statSync(pdf).size;
  console.log(`✓ ${basename(pdf)} (${(size / 1024).toFixed(1)} KB)`);
}

await browser.close();
console.log('完了');
