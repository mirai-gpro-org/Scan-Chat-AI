#!/usr/bin/env node
/**
 * ホーム画面アイコン (PWA / apple-touch-icon) を Welltect ロゴから生成する。
 *
 * ロゴは**加工しない** — 正方形のキャンバスに余白付きで配置するだけ (縦横比は維持)。
 * 元画像は public/welltect_logo.png (ブランド資産の原本)。
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
/** 地の色。ロゴが淡いシアンなので白地に置く (ロゴ自体の色は変えない)。 */
const BG = { r: 255, g: 255, b: 255, alpha: 1 };

/** size 四方の白地に、ロゴを ratio の幅で中央配置する。 */
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
await make('public/icons/icon-192.png', 192, 0.76);
await make('public/icons/icon-512.png', 512, 0.76);
// maskable: 端が円形/角丸に切られる前提。中央 60% に収める (セーフゾーン 80% の内側)。
await make('public/icons/icon-maskable-512.png', 512, 0.58);
// iOS は角丸を OS 側で付ける。透過を残すと黒背景になることがあるので不透明で書き出す。
await make('public/apple-touch-icon.png', 180, 0.76);
