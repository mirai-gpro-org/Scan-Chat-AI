/**
 * /scan のアップロード経路の回帰チェック。
 *
 * 【なぜ機械で見張るのか】
 * この経路の失敗は**アプリのログに出ない**。POST body が Vercel の上限
 * (4.5 MB・vercel.com/docs/functions/limitations「Request body size」) を超えると、
 * 関数に届く前にプラットフォームが 413 `FUNCTION_PAYLOAD_TOO_LARGE` を返すので、
 * `/api/scan` は呼ばれず、こちらのコードには何の痕跡も残らない。
 * 画面に出る上限 (10 MB) と、実際に送れる大きさは別物なので、
 * 「上限の数字を上げただけ」で壊れていないことをここで固定する。
 *
 * 前提: `npm run dev` が起動していること。URL は `VERIFY_URL` で差し替えられる。
 * /api/scan は route で握り潰すので Gemini キーは要らない。
 */
import { chromium } from 'playwright';

const BASE = process.env.VERIFY_URL ?? 'http://localhost:4321';
const EXEC = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

/** Vercel Functions のリクエストボディ上限 (src/scripts/scan-upload.ts と同じ根拠)。 */
const VERCEL_LIMIT = 4_500_000;

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MiB';

let browser;
try {
  browser = await chromium.launch({ executablePath: EXEC });
} catch {
  browser = await chromium.launch();
}
const page = await browser.newPage();

let lastBody = null;
await page.route('**/api/scan', async (route) => {
  lastBody = route.request().postData() ?? '';
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ markdown: '| a |\n|---|\n| 1 |', finishReason: 'STOP' }),
  });
});

await page.goto(`${BASE}/scan`, { waitUntil: 'networkidle' });

/**
 * ブラウザ内でファイルを作って #scan-file に流し込む。
 * 画像は**ノイズ**で描く — 単色だと圧縮が効きすぎて大きさの検証にならない。
 * ノイズは JPEG にとって最悪ケースなので、実際の検査票の写真はこれより小さくなる。
 */
async function upload({ name, type, w, h, bytes, quality = 1.0 }) {
  lastBody = null;
  await page.evaluate(
    async ({ name, type, w, h, bytes, quality }) => {
      let file;
      if (type === 'application/pdf') {
        file = new File([new Uint8Array(bytes)], name, { type });
      } else {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(w, h);
        for (let i = 0; i < img.data.length; i += 4) {
          img.data[i] = Math.random() * 255;
          img.data[i + 1] = Math.random() * 255;
          img.data[i + 2] = Math.random() * 255;
          img.data[i + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        file = new File([await new Promise((r) => c.toBlob(r, type, quality))], name, { type });
      }
      window.__lastFileSize = file.size;
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById('scan-file');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { name, type, w, h, bytes, quality },
  );
  await page.waitForTimeout(4000);
  return {
    size: await page.evaluate(() => window.__lastFileSize),
    err: await page.evaluate(() => {
      const el = document.getElementById('error-message');
      return el && el.offsetParent !== null ? el.textContent.trim() : '';
    }),
    body: lastBody,
  };
}

// ── ① 画面の表示と実装が食い違っていないか ──
{
  const label = await page.textContent('label[for="scan-file"]');
  ok('ラベルが 10 MB を名乗っている', /最大\s*10\s*MB/.test(label ?? ''), (label ?? '').trim());
}

// ── ② 大きな写真: 受け付けたうえで、上限内に収めて送る ──
{
  const r = await upload({ name: 'big.jpg', type: 'image/jpeg', w: 4032, h: 3024, quality: 0.82 });
  ok('大きな写真 (4032x3024) を受け付ける', !r.err, r.err || `file=${mb(r.size)}`);
  ok('POST が発生する', !!r.body, r.body ? `body=${mb(r.body.length)}` : 'POST なし');
  if (r.body) {
    ok(
      'POST body が Vercel の 4.5 MB 未満',
      r.body.length < VERCEL_LIMIT,
      `${r.body.length} < ${VERCEL_LIMIT} (元 ${mb(r.size)} → ${mb(r.body.length)})`,
    );
    ok('JPEG へ再エンコードされている', r.body.includes('data:image/jpeg;base64,'), '');
  }
}

// ── ③ 小さい画像は無変換 = 画質を落とさない (従来どおり) ──
{
  const r = await upload({ name: 'small.png', type: 'image/png', w: 500, h: 400 });
  ok('小さな画像を受け付ける', !r.err, r.err || `file=${mb(r.size)}`);
  ok(
    '小さな画像は無変換 (PNG のまま送る)',
    !!r.body && r.body.includes('data:image/png;base64,'),
    '',
  );
}

// ── ④ PDF は縮小できない。黙って 413 にせず理由を出す ──
{
  const r = await upload({ name: 'big.pdf', type: 'application/pdf', bytes: 5 * 1024 * 1024 });
  ok('予算超えの PDF は POST しない', !r.body, '');
  ok('予算超えの PDF は理由を表示する', /PDF は .+ までしか送信できません/.test(r.err), r.err);
}

// ── ⑤ 受付上限そのもの ──
{
  const r = await upload({ name: 'huge.pdf', type: 'application/pdf', bytes: 11 * 1024 * 1024 });
  ok('10 MB 超は POST しない', !r.body, '');
  ok('10 MB 超は上限を伝える', /10\.0 MB 以下にしてください/.test(r.err), r.err);
}

await browser.close();

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
