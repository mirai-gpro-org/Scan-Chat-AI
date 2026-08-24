#!/usr/bin/env node
/**
 * ホーム画面アイコン (PWA / apple-touch-icon) を Welltect ロゴから生成する。
 *
 * ロゴは**加工しない** — 正方形のキャンバスに配置するだけ (縦横比は維持)。
 * 元画像は public/welltect_logo.png (ブランド資産の原本)。
 *
 * 余白は **0 (ratio=1.0)**。PWABuilder Image Generator の出力 (2026-08 受領) を実測したところ
 * ロゴのインクが**横幅の 80.9%** を占めており、こちらの旧設定 (ratio 0.76 = インク 61.5%) より
 * 1.3 倍大きかった。小さいアイコンでの視認性はこの差が効くため、同じ大きさに合わせた。
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
console.log(`地の色: ${BG_HEX}`);

/** size 四方の地色に、ロゴを ratio の幅で中央配置する。 */
async function make(out, size, ratio) {
  const logo = await sharp(SRC)
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
await make('public/icons/icon-192.png', 192, 1.0);
await make('public/icons/icon-512.png', 512, 1.0);
// maskable: 端が円形に切られる前提なので、直径 80% のセーフゾーンに収める。
//   ratio r のときインク幅 = r * 0.809 / 高さ = 幅 * 0.673 (ロゴの縦横比)。
//   対角 = インク幅 * 1.205 ≦ 0.8 → r ≦ 0.82。余裕を見て 0.78 (対角 0.761)。
await make('public/icons/icon-maskable-512.png', 512, 0.78);
// iOS は角丸を OS 側で付ける。透過を残すと黒背景になることがあるので不透明で書き出す。
await make('public/apple-touch-icon.png', 180, 1.0);
