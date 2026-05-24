/**
 * docs/system_architecture_overview.md → PDF 変換スクリプト
 *
 * 実行: node scripts/build-architecture-pdf.mjs
 * 出力: docs/system_architecture_overview.pdf
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const SOURCE = resolve(ROOT, 'docs/system_architecture_overview.md');
const OUTPUT = resolve(ROOT, 'docs/system_architecture_overview.pdf');

const md = readFileSync(SOURCE, 'utf8');
marked.setOptions({ gfm: true, breaks: false });
const body = marked.parse(md);

const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>Scan-Chat Medical AI — システムアーキテクチャ概要</title>
<style>
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
  html { font-size: 11pt; }
  body {
    color: var(--fg);
    background: var(--bg);
    font-family: "Hiragino Sans","Noto Sans JP","Yu Gothic","Segoe UI","Helvetica Neue",sans-serif;
    line-height: 1.65;
    margin: 0;
  }
  h1 {
    font-size: 22pt;
    border-bottom: 3px solid var(--accent);
    padding-bottom: 6px;
    margin: 0 0 14px;
    color: #0f172a;
  }
  h2 {
    font-size: 16pt;
    margin: 22px 0 8px;
    color: #1f2937;
    border-left: 5px solid var(--accent);
    padding-left: 10px;
    page-break-after: avoid;
  }
  h3 {
    font-size: 13pt;
    margin: 16px 0 6px;
    color: #1f2937;
    page-break-after: avoid;
  }
  h4 {
    font-size: 11.5pt;
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
    font-size: 10pt;
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
  /* セクションごとに改ページしすぎないようバランス取り */
  h2 + p, h2 + pre, h2 + table { page-break-before: avoid; }
  table, pre, blockquote { page-break-inside: avoid; }

  /* 表紙的なメタ情報テーブルだけ少し締める */
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
</style>
</head>
<body>
${body}
</body>
</html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
await page.pdf({
  path: OUTPUT,
  format: 'A4',
  printBackground: true,
  margin: { top: '20mm', bottom: '22mm', left: '18mm', right: '18mm' },
});
await browser.close();

const stat = await import('node:fs').then((m) => m.statSync(OUTPUT));
console.log(`✓ PDF 生成完了: ${OUTPUT} (${(stat.size / 1024).toFixed(1)} KB)`);
