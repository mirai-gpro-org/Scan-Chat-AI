/**
 * QR コード生成 (サーバ側)。
 *
 * 用途: PC でカメラ撮影ができない (要件 F-A5) ため、同じページをスマートフォンで
 *   開いてもらうための導線。URL を QR にして表示する。
 *
 * 実装方針:
 *   - ライブラリは qrcode-generator (MIT / 依存ゼロ) のみ。自前で符号化しない
 *     (誤り訂正やマスク選択を手書きすると検証できないため)。
 *   - SVG は自前で組む。塗り色・角丸・アクセシビリティ属性を UI 側に合わせるため。
 *   - 出力は 1 本の path にまとめる (モジュール数だけ rect を並べると DOM が膨らむ)。
 */

import qrcode from 'qrcode-generator';

export interface QrOptions {
  /** 1 モジュールの一辺 (SVG 座標系)。既定 4。 */
  cell?: number;
  /** 静穏帯のモジュール数。QR 規格の推奨は 4。 */
  margin?: number;
  /** 誤り訂正レベル。既定 'M' (約 15% 復元)。 */
  ec?: 'L' | 'M' | 'Q' | 'H';
}

export interface QrSvg {
  /** viewBox の一辺 (正方形)。 */
  size: number;
  /** 全モジュールをまとめた path の d 属性。 */
  path: string;
  /** 静穏帯を含まないモジュール数 (デバッグ・検証用)。 */
  moduleCount: number;
}

/** 文字列を QR の SVG パスへ変換する。 */
export function qrSvgPath(text: string, opts: QrOptions = {}): QrSvg {
  const { cell = 4, margin = 4, ec = 'M' } = opts;
  const qr = qrcode(0, ec); // 0 = 型番自動
  qr.addData(text);
  qr.make();

  const n = qr.getModuleCount();
  const size = (n + margin * 2) * cell;

  const parts: string[] = [];
  for (let r = 0; r < n; r += 1) {
    let runStart = -1;
    for (let c = 0; c <= n; c += 1) {
      const dark = c < n && qr.isDark(r, c);
      if (dark && runStart < 0) runStart = c;
      if (!dark && runStart >= 0) {
        // 横に連続する黒モジュールを 1 本の矩形にまとめる
        const x = (runStart + margin) * cell;
        const y = (r + margin) * cell;
        const w = (c - runStart) * cell;
        parts.push(`M${x} ${y}h${w}v${cell}h${-w}z`);
        runStart = -1;
      }
    }
  }
  return { size, path: parts.join(''), moduleCount: n };
}
