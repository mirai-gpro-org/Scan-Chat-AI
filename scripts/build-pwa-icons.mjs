#!/usr/bin/env node
/**
 * ホーム画面アイコン (PWA / apple-touch-icon) を Welltect ロゴから生成する。
 *
 * ロゴは**加工しない** — 正方形のキャンバスに配置するだけ (縦横比は維持)。
 * 元画像は public/welltect_logo.png (ブランド資産の原本)。
 *
 * **アイコンにはロゴの「マーク」部分だけを使う** (2026-08・視認性の指摘を受けて)。
 * 原本を実測すると マーク(円+W)=100x78px / ワードマーク"welltect"=198x35px。
 * ロゴ全体を 60px のアイコンに収めると縮小率が 0.25 倍になり、ワードマークの線幅が
 * **1px を切って潰れる**。マークだけなら同じ 60px でも線幅が 2.3 倍残るため読める。
 * ホーム画面ではアイコンの下に「Welltect」という名前が別途出るので、絵柄に文字は要らない。
 * **切り出すだけで、ロゴの色も形も変えていない** (再描画・トレースはしない)。
 * ロゴ全体に戻すときは `node scripts/build-pwa-icons.mjs "#FFFFFF" full`。
 *
 * 地の色は既定で **白 #FFFFFF**。
 * 「ロゴが薄い」の指摘 (2026-08) を受けて一度 Executive Navy #102B3A にした
 * (ロゴ色 rgb(71,191,200) とのコントラストは 2.20:1 → 6.69:1)。**が、実機では
 * かえって視認性が落ちたため白へ差し戻した (発注者判断 2026-08)**。数値上の
 * コントラストと、ホーム画面の壁紙・並んだ他アイコンの中での見え方は別物。
 * 濃紺に戻すときは `node scripts/build-pwa-icons.mjs "#102B3A"`。
 * どちらの場合も**ロゴ自体の色は変えない** (ブランド資産は無加工)。
 *
 * 生成物:
 *   public/favicon-mark.png            ブラウザのタブ (favicon)。**マークのみ・背景は透過**
 *                                      → タブ 16px でワードマークは潰れて読めないため
 *                                        (ロゴ全体を使っていた頃の「小さくて分からない」の対処)
 *   public/icons/icon-192.png          manifest icons (purpose any)
 *   public/icons/icon-512.png          同上
 *   public/icons/icon-maskable-512.png manifest icons (purpose maskable)
 *                                      → 円形に切られても欠けないよう中央 60% に収める
 *   public/apple-touch-icon.png        iOS ホーム画面 (180x180・透過なし)
 *
 * 実行: node scripts/build-pwa-icons.mjs
 */
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

const SRC = 'public/welltect_logo.png';

/** '#RRGGBB' → sharp の背景色。 */
function hexToBg(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`地の色は #RRGGBB で指定してください: ${hex}`);
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, alpha: 1 };
}

/** 地の色。既定 = 白 (実機の見え方で白を採用・上のコメント参照)。 */
const BG_HEX = process.argv[2] ?? '#FFFFFF';
const BG = hexToBg(BG_HEX);
/** 'full' を渡すとロゴ全体を使う。既定はマークだけ。 */
const USE_FULL = process.argv[3] === 'full';
console.log(`地の色: ${BG_HEX} / 絵柄: ${USE_FULL ? 'ロゴ全体' : 'マークのみ'}`);

/**
 * ロゴ原本から**マークだけ**を切り出したバッファを返す。
 * インクのある行の連続帯を数え、2 本 (マーク / ワードマーク) なら上の帯を採る。
 * それ以外の構成の画像に差し替わったときは、判定を諦めて全体を返す (壊さない)。
 */
async function markBuffer() {
  const src = sharp(SRC);
  const { data, info } = await src.raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  const opaque = (x, y) => (C === 4 ? data[(y * W + x) * C + 3] : 255) > 30;

  const bands = [];
  let start = -1;
  for (let y = 0; y < H; y++) {
    let hasInk = false;
    for (let x = 0; x < W && !hasInk; x++) if (opaque(x, y)) hasInk = true;
    if (hasInk && start < 0) start = y;
    if (!hasInk && start >= 0) { bands.push([start, y - 1]); start = -1; }
  }
  if (start >= 0) bands.push([start, H - 1]);

  if (bands.length !== 2) {
    console.warn(`  ロゴのインク帯が ${bands.length} 本。マークを特定できないので全体を使う`);
    return sharp(SRC).toBuffer();
  }
  const [y0, y1] = bands[0];
  let minX = W, maxX = -1;
  for (let y = y0; y <= y1; y++) for (let x = 0; x < W; x++) if (opaque(x, y)) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
  console.log(`  マーク切り出し: x=${minX}..${maxX} y=${y0}..${y1} (${maxX - minX + 1}x${y1 - y0 + 1})`);
  return sharp(SRC).extract({ left: minX, top: y0, width: maxX - minX + 1, height: y1 - y0 + 1 }).toBuffer();
}

/** size 四方の地色に、絵柄を ratio の幅で中央配置する。 */
async function make(out, size, ratio) {
  const logo = await sharp(ART)
    .resize({ width: Math.round(size * ratio), fit: 'inside', withoutEnlargement: false })
    .toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: logo, gravity: 'center' }])
    // アルファを落として不透明にする。iOS は透過部分を黒で合成することがあるため。
    .flatten({ background: BG })
    .removeAlpha()
    .png()
    .toFile(out);
  const m = await sharp(out).metadata();
  console.log(`${out}  ${m.width}x${m.height}`);
}

await mkdir('public/icons', { recursive: true });
const ART = USE_FULL ? await sharp(SRC).toBuffer() : await markBuffer();

// マーク (100x78 = 縦横比 0.78) を横幅の 74% で置く。
// iOS/Android が角を丸く切っても、辺の中央付近は削られないので問題ない。
const R_ANY = USE_FULL ? 1.0 : 0.74;
await make('public/icons/icon-192.png', 192, R_ANY);
await make('public/icons/icon-512.png', 512, R_ANY);
// maskable: 直径 80% の円で切られる前提。
//   マークの対角 = 幅 * sqrt(1 + 0.78^2) = 幅 * 1.268 ≦ 0.8 → 幅 ≦ 0.63。余裕を見て 0.60。
//   (ロゴ全体を使う場合は 幅 * 1.205 ≦ 0.8 → 0.78)
await make('public/icons/icon-maskable-512.png', 512, USE_FULL ? 0.78 : 0.60);
// iOS は角丸を OS 側で付ける。透過を残すと黒背景になることがあるので不透明で書き出す。
await make('public/apple-touch-icon.png', 180, R_ANY);
/*
 * タブの favicon。64px を 1 枚置けばブラウザ側が 16/32 へ縮めてくれる。
 *
 * ・**ロゴ全体 (full) を指定したときも favicon はマークだけ**にする
 *   — 16px ではワードマークの線幅が 1px を切って潰れ、何のアイコンか分からなくなるため
 *     (発注者指摘 2026-08「ファビコンも小さいので文字を削除してマークだけに」)。
 * ・ホーム画面アイコンと違い OS のマスク (角丸・円形) が掛からないので余白は最小 (0.94)。
 * ・**背景は透過のまま**。白で塗るとダークテーマのタブに白い四角が出る。
 */
const FAVICON_ART = await markBuffer();
await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{
    input: await sharp(FAVICON_ART).resize({ width: Math.round(64 * 0.94), fit: 'inside' }).toBuffer(),
    gravity: 'center',
  }])
  .png()
  .toFile('public/favicon-mark.png');
console.log('public/favicon-mark.png  64x64 (透過・マークのみ)');
