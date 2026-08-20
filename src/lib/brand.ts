/**
 * ブランド資産の解決 (サーバ側で 1 回だけ評価する)。
 *
 * 【ロゴの差し替え方法】`public/` に次のいずれかの名前で原本を置くだけで自動的に切り替わる。
 *   welltect_logo.svg (推奨) / welltect_logo.png / welltect-logo.svg / welltect-logo.png
 *
 * 置かれるまでは暫定で運営会社ロゴ (wellfort_logo.png) を表示する。
 * ロゴは**ブランド資産**なので、目視トレースした代替 SVG は作らない (原本のみを使う)。
 *
 * ※ この解決を .astro のフロントマターに置くと、Astro が `export const` を
 *   モジュールスコープへ巻き上げる一方でヘルパ関数はレンダ関数内に残るため
 *   `resolveLogo is not defined` で 500 になる (実測 2026-08)。独立モジュールに置く。
 */

import fs from 'node:fs';
import path from 'node:path';

const CANDIDATES = [
  'welltect_logo.svg',
  'welltect_logo.png',
  'welltect-logo.svg',
  'welltect-logo.png',
] as const;

/** 原本が置かれるまでの暫定表示。 */
const FALLBACK = '/wellfort_logo.png';

export interface BrandLogo {
  /** 表示に使う public 配下のパス。 */
  src: string;
  /** true = 原本が未配置でフォールバック中。 */
  pending: boolean;
}

function resolve(): BrandLogo {
  for (const name of CANDIDATES) {
    try {
      if (fs.existsSync(path.join(process.cwd(), 'public', name))) {
        return { src: `/${name}`, pending: false };
      }
    } catch {
      // public/ を読めない実行環境ではフォールバックする
    }
  }
  return { src: FALLBACK, pending: true };
}

export const LOGO: BrandLogo = resolve();
