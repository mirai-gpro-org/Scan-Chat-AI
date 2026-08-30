/**
 * 個人化された SSR ページのキャッシュ指示。
 *
 * 【なぜ要るか】Vercel の既定は `cache-control: public, max-age=0, must-revalidate` で、
 * `public` は**共有キャッシュ (CDN・企業プロキシ) に保存を許す**。この 8 ページは
 * Cookie (`viewer.ts` の署名付き uid) で中身が変わるのに `Vary` も付かないため、
 * 経路上のキャッシュが**ある閲覧者の紙面を別の閲覧者へ配り得る**。
 * PII 分離 (CLAUDE.md「PII / データ分離」) の前提が壊れるので塞ぐ。
 *
 * `private, no-store` = 共有キャッシュに置かない・ブラウザにも保存させない。
 * 報告書は「最新版 1 件を正しく伝える」ことがミッションなので、
 * 戻る操作で古い紙面が出ないほうが仕様に合う。
 */
export function noStore(res: { headers: Headers }): void {
  res.headers.set('cache-control', 'private, no-store');
}
