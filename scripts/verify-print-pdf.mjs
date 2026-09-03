/*
 * 印刷/PDF の紙面を実際に PDF に焼いて確かめる (spec §4.4)。
 *
 * **発端 (2026-09-03・発注者指摘「改ページ・余白が美しくない / ページ番号が欲しい」)**:
 * 印刷 CSS が カード・表・章 を丸ごと `break-inside: avoid` にしていたため、
 * 1 ページに入りきらない塊が丸ごと次ページへ送られ、**手前に巨大な空白**が残っていた
 * (実測: 32 ページ中 使用率 1.7% / 11.5% / 24.1% / 26.2% のページ)。
 * 加えて `@page` の余白指定が無く、本文が紙の上下端に触れていた。
 *
 * ここで見るのは「紙として読めるか」だけ:
 *   ① ページ番号が 2 ページ目以降の全ページに連番で出る (表紙には出ない)
 *   ② 本文領域がスカスカのページが無い (改ページの取りこぼし)
 *   ③ 上下に余白が在る (インクが紙の端に触れていない)
 * **色・書体・行送りは見ない** (紙面の中身は紙面契約 verify:sheet-contract の仕事)。
 *
 * 要 `npm run dev` と poppler-utils (pdftoppm / pdftotext)。
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';
import sharp from 'sharp';

const BASE = process.env.BASE ?? 'http://localhost:4321';
const URL_ = `${BASE}/report?preview=1&print=1`;
const OUT = '/tmp/verify-print';
const DPI = 40, MM = DPI / 25.4;
/** `@page` の余白 (report.astro の pageCss と合わせる)。 */
const MARGIN_TOP_MM = 16, MARGIN_BOTTOM_MM = 14;
/** 本文領域がこれを下回るページは「改ページの取りこぼし」とみなす。 */
const MIN_FILL = 50;

for (const bin of ['pdftoppm', 'pdftotext']) {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); } catch {
    console.log(`✗ ${bin} が見つかりません (poppler-utils)。`);
    console.log('  apt-get install -y poppler-utils  /  brew install poppler');
    process.exit(1);
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const pdf = `${OUT}/report.pdf`;

// verify-screen.mjs と同じ流儀: 環境の Chromium を先に試し、無ければ Playwright 同梱へ。
const EXEC = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
let browser;
try { browser = await chromium.launch({ executablePath: EXEC }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage();
await page.goto(URL_, { waitUntil: 'networkidle' });
// preferCSSPageSize = 紙の大きさと余白を紙面側の `@page` に従わせる
// (ブラウザの印刷ダイアログで 余白「既定」を選んだときと同じ状態)。
await page.pdf({ path: pdf, printBackground: true, preferCSSPageSize: true });
await browser.close();
if (!existsSync(pdf)) { console.log('✗ PDF を作れませんでした'); process.exit(1); }

const fails = [];

// ── ① ページ番号 ────────────────────────────────────────────
const total = +execSync(`pdfinfo "${pdf}" 2>/dev/null | awk '/^Pages/{print $2}'`).toString().trim()
  || readdirSync(OUT).length;
const textOf = (n) => execSync(`pdftotext -f ${n} -l ${n} -layout "${pdf}" -`).toString();
const cover = textOf(1);
const coverHasNum = new RegExp(`1\\s*/\\s*${total}`).test(cover);
console.log(`${coverHasNum ? '✗' : '✓'} 表紙にはページ番号を振らない`);
if (coverHasNum) fails.push('表紙にページ番号が出ている (見本 p1 は帯を持たない)');

let numbered = 0;
for (let n = 2; n <= total; n++) {
  if (new RegExp(`${n}\\s*/\\s*${total}`).test(textOf(n))) numbered++;
}
const numOk = numbered === total - 1;
console.log(`${numOk ? '✓' : '✗'} 2 ページ目以降に連番 (${numbered} / ${total - 1} ページ)`);
if (!numOk) {
  fails.push(`ページ番号が ${total - 1 - numbered} ページで出ていない`
    + ' — @page のマージンボックスが効いていない可能性');
}

// ── ②③ 本文領域の使用率と余白 ───────────────────────────────
execSync(`pdftoppm -r ${DPI} -gray -png "${pdf}" ${OUT}/p`);
const pngs = readdirSync(OUT).filter((f) => f.endsWith('.png')).sort();
const rows = [];
for (const f of pngs) {
  const { data, info } = await sharp(`${OUT}/${f}`).greyscale().raw().toBuffer({ resolveWithObject: true });
  const inkAt = (y) => {
    for (let x = 0; x < info.width; x++) if (data[y * info.width + x] < 245) return true;
    return false;
  };
  const top = Math.round(MARGIN_TOP_MM * MM);
  const bot = info.height - Math.round(MARGIN_BOTTOM_MM * MM);
  let last = top;
  for (let y = top; y < bot; y++) if (inkAt(y)) last = y;
  // 余白: 上端 6mm と下端 4mm は必ず白 (表紙は teal を紙の端まで出すので除く)
  const edge = Math.round(6 * MM), edgeB = Math.round(4 * MM);
  let edgeInk = false;
  for (let y = 0; y < edge; y++) if (inkAt(y)) { edgeInk = true; break; }
  for (let y = info.height - edgeB; y < info.height; y++) if (inkAt(y)) { edgeInk = true; break; }
  rows.push({
    page: +f.match(/p-?0*(\d+)/)[1],
    fill: +(100 * (last - top) / (bot - top)).toFixed(1),
    edgeInk,
  });
}
rows.sort((a, b) => a.page - b.page);

const avg = rows.reduce((s, r) => s + r.fill, 0) / rows.length;
// 最後のページは本文が尽きるので薄くて当たり前 — 途中のページだけを見る。
const thin = rows.filter((r) => r.page < rows.length && r.fill < MIN_FILL);
console.log(`${thin.length === 0 ? '✓' : '✗'} 改ページの取りこぼし `
  + `(${rows.length} ページ / 本文領域の平均使用率 ${avg.toFixed(1)}% / `
  + `${MIN_FILL}% 未満 ${thin.length} ページ)`);
if (thin.length) {
  fails.push(`スカスカのページ: ${thin.map((r) => `p${r.page}=${r.fill}%`).join(' ')}`
    + ' — 大きい塊に break-inside: avoid が掛かっていないか');
}

const bleed = rows.filter((r) => r.page > 1 && r.edgeInk);
console.log(`${bleed.length === 0 ? '✓' : '✗'} 上下の余白 (紙の端にインクが触れているページ ${bleed.length})`);
if (bleed.length) {
  fails.push(`本文が紙の端に触れている: ${bleed.map((r) => `p${r.page}`).join(' ')}`
    + ' — @page の margin が効いていない');
}

if (fails.length) {
  console.log(`\n✗ ${fails.length} 件`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`\n✓ 紙として読める状態です (${rows.length} ページ・平均使用率 ${avg.toFixed(1)}%)。`);
