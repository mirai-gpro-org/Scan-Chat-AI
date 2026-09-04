/**
 * 複数ページスキャンの回帰チェック (実ブラウザ)。
 *
 * 守りたい約束:
 *   ① 1 枚ごとに確認画面が出る (撮影・アップロードとも)
 *   ② **「全てを送信」を押すまで /api/scan を 1 回も呼ばない** — ここが唯一の確定点
 *   ③ 撮り直しは「いまの 1 枚」だけを捨てる (前のページへ戻らない)
 *   ④ 送信すると枚数ぶん順に呼ばれる (1 画像 = 1 リクエスト・Vercel 60 秒制限)
 *   ⑤ 最初からやり直すと全部捨てる
 *
 * 前提: `npm run dev` が起動していること。URL は `VERIFY_URL` で差し替えられる。
 */
import { chromium } from 'playwright';

const BASE = process.env.VERIFY_URL ?? 'http://localhost:4321';
const EXEC = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

let browser;
try {
  browser = await chromium.launch({ executablePath: EXEC });
} catch {
  browser = await chromium.launch();
}
const page = await browser.newPage();

let scanCalls = 0;
await page.route('**/api/scan', async (route) => {
  scanCalls += 1;
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      markdown: `## 検査結果\n\n| 項目 | 値 |\n|---|---|\n| AST | 22 |`,
      finishReason: 'STOP',
    }),
  });
});
// チケットは使わせない (小さい画像なので inline 経路に乗る)
await page.route('**/api/scan/upload-ticket', (r) =>
  r.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' }),
);

await page.goto(`${BASE}/scan`, { waitUntil: 'networkidle' });

const visible = (id) => page.evaluate((i) => {
  const el = document.getElementById(i);
  return !!el && !el.hidden;
}, id);
const text = (id) => page.evaluate((i) => document.getElementById(i)?.textContent?.trim() ?? '', id);

/** 小さな画像を 1 枚 #scan-file へ流し込む。 */
async function upload(name) {
  await page.evaluate(async (n) => {
    const c = document.createElement('canvas');
    c.width = 120; c.height = 90;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 120, 90);
    ctx.fillStyle = '#000'; ctx.fillText(n, 10, 40);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], n, { type: 'image/png' }));
    const input = document.getElementById('scan-file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, name);
  await page.waitForTimeout(700);
}

// ── ① 1 枚目 → 確認画面 ──
await upload('p1.png');
ok('1 枚目で確認画面が出る', await visible('panel-confirm'), '');
ok('  枚数の表示が 1 枚目', (await text('confirm-page-label')) === '1 枚目', await text('confirm-page-label'));
ok('  プレビュー画像が出ている', await visible('confirm-image'), '');
ok('② この時点で /api/scan を呼んでいない', scanCalls === 0, `calls=${scanCalls}`);

// ── ③ 撮り直し = いまの 1 枚だけ捨てる ──
await page.click('#confirm-retake');
await page.waitForTimeout(300);
await upload('p1b.png');
ok('③ 撮り直し後も 1 枚目のまま (増えていない)', (await text('confirm-page-label')) === '1 枚目', await text('confirm-page-label'));

// ── 2 枚目 ──
await page.click('#confirm-next');
await page.waitForTimeout(300);
await upload('p2.png');
ok('2 枚目で「2 枚目」と出る', (await text('confirm-page-label')) === '2 枚目', await text('confirm-page-label'));
ok('② まだ /api/scan を呼んでいない', scanCalls === 0, `calls=${scanCalls}`);

// ── 最終確認 ──
await page.click('#confirm-done');
await page.waitForTimeout(300);
ok('「これで全部」で最終確認へ', await visible('panel-review'), '');
ok('  送信枚数が 2', (await text('review-count')) === '2', await text('review-count'));
ok('  一覧に 2 件出る', (await page.locator('#review-thumbs li').count()) === 2, '');
ok('② 最終確認の時点でもまだ呼んでいない', scanCalls === 0, `calls=${scanCalls}`);

// ── ④ 全てを送信 ──
await page.click('#review-send');
await page.waitForTimeout(3000);
ok('④ 送信で 2 回呼ばれた (1 画像 = 1 リクエスト)', scanCalls === 2, `calls=${scanCalls}`);
ok('  結果画面へ進んだ', await visible('panel-result'), '');
const summary = await text('scan-result-summary');
ok('  複数ページの結果が束ねられている', /2\s*領域|領域/.test(summary), summary);

// ── ⑤ 最初からやり直す ──
page.on('dialog', (d) => d.accept());
await page.goto(`${BASE}/scan`, { waitUntil: 'networkidle' });
scanCalls = 0;
await upload('q1.png');
await page.click('#confirm-next');
await page.waitForTimeout(300);
await upload('q2.png');
await page.click('#confirm-restart');
await page.waitForTimeout(500);
ok('⑤ 最初からやり直すと最初の画面へ', await visible('panel-ready'), '');
await upload('r1.png');
ok('  破棄されて 1 枚目から数え直す', (await text('confirm-page-label')) === '1 枚目', await text('confirm-page-label'));
ok('  やり直しても送信していない', scanCalls === 0, `calls=${scanCalls}`);

await browser.close();
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
