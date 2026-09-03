/**
 * 図つき HTML 原稿 → 提出用 PDF。
 *
 * 実行: node scripts/build-html-pdf.mjs docs/lab/genoplan_poc_report_20260901.html
 *       (出力は同じ場所の .pdf。第 2 引数で出力先を変えられる)
 *
 * 【HTML が正】このスクリプトは組版するだけで内容には触れない。
 *   直すときは HTML を直して再実行する (PDF を直接いじらない)。
 *   `build-lab-doc-pdf.mjs` と同じ方針だが、あちらは md → HTML、
 *   こちらは**図 (インライン SVG) があるので HTML そのものが原稿**。
 *   文書ごとにスクリプトを増やさない (以前 genoplan 専用だったものを一般化した)。
 *
 * 【背景のグラフィックを必ず出す】`printBackground: true` が要る。
 *   無いと帯・カード・図の塗りが全部落ちて、罫線と文字だけの紙面になる
 *   (報告書の紙面で同じ問題を踏んでいる。CLAUDE.md §4.4)。
 *
 * 【フォント】コンテナには IPAGothic しか無いことがある。HTML 側のスタック末尾に
 *   "IPAGothic"/"IPAPGothic" を残してあるので、ここでは何もしない。
 *   **欧文は Liberation Sans を先に置く** — IPAGothic は英数字が等幅で間延びする。
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { statSync } from 'node:fs';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const [srcArg, outArg] = process.argv.slice(2);
if (!srcArg) {
  console.error('使い方: node scripts/build-html-pdf.mjs <入力.html> [出力.pdf]');
  process.exit(1);
}
const SOURCE = resolve(ROOT, srcArg);
const OUTPUT = outArg ? resolve(ROOT, outArg) : SOURCE.replace(/\.html?$/i, '.pdf');
if (OUTPUT === SOURCE) {
  console.error('入力が .html ではありません (出力先を上書きしてしまいます)');
  process.exit(1);
}

/**
 * 環境の Chromium を明示できるようにしておく。
 * `@playwright/test` の版が上がると `/opt/pw-browsers` の版と食い違い、
 * 「Executable doesn't exist」でここだけ落ちる (実測 2026-09-01)。
 * 既定でも実在するパスを拾いに行き、無ければ Playwright の解決に任せる。
 * 例: PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
 */
const fallbacks = [
  process.env.PLAYWRIGHT_CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
].filter(Boolean);
const chromiumPath = fallbacks.find((p) => { try { return statSync(p).isFile(); } catch { return false; } });
const browser = await chromium.launch(chromiumPath ? { executablePath: chromiumPath } : {});
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(SOURCE).href, { waitUntil: 'networkidle' });
  await page.pdf({
    path: OUTPUT,
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
  });
} finally {
  await browser.close();
}

console.log(`OK: ${OUTPUT} (${statSync(OUTPUT).size.toLocaleString()} バイト)`);
