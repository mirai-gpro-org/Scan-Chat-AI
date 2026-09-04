/**
 * 「ブラウザから見える URL」を求める。
 *
 * 【なぜ要るか】
 * SSR の `Astro.request.url` は **プロキシの内側の URL** になることがある。
 * Vercel 本番の `/scan` で実測 (2026-09-04): QR の一辺が 132px = 25 モジュール =
 * **約 26 バイトしか入らない QR** が出ていた。公開 URL
 * `https://scan-chat-ai.vercel.app/scan` は 36 バイトで 29 モジュール (148px) に
 * なるはずなので、**符号化されていたのは公開 URL ではない** (localhost 等の内側 URL)。
 * → QR を読んでも開けない、という不具合になっていた。
 *
 * クエリやパスは `Astro.request.url` のままで正しい (プロキシは書き換えない)。
 * **ずれるのは origin だけ**なので、ここでは origin を差し替える。
 *
 * 判定は標準的な転送ヘッダ。Vercel はこれらを付ける。
 *   x-forwarded-proto  … https
 *   x-forwarded-host   … scan-chat-ai.vercel.app   (無ければ host)
 * どちらも無いローカル開発では `request.url` の origin をそのまま使う。
 */

/** ヘッダはカンマ区切りで複数連なることがある (プロキシ多段)。**先頭が最も外側**。 */
function firstValue(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw.split(',')[0]?.trim();
  return v || null;
}

/**
 * ホスト名として妥当か。**ヘッダは利用者が詐称できる**ので、
 * 変な値をそのまま QR や画面に出さないよう最小限の形だけ見る。
 */
function looksLikeHost(host: string): boolean {
  return /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host) && host.length <= 253;
}

/** 公開 origin (`https://example.com`)。末尾にスラッシュは付けない。 */
export function publicOrigin(request: Request): string {
  const fallback = new URL(request.url).origin;
  const host = firstValue(request.headers.get('x-forwarded-host')) ?? firstValue(request.headers.get('host'));
  if (!host || !looksLikeHost(host)) return fallback;

  const proto =
    firstValue(request.headers.get('x-forwarded-proto')) ??
    (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
  if (proto !== 'http' && proto !== 'https') return fallback;

  return `${proto}://${host}`;
}

/** 公開 URL。パスとクエリは `request.url` のものを保つ (origin だけ差し替える)。 */
export function publicUrl(request: Request): string {
  const u = new URL(request.url);
  return `${publicOrigin(request)}${u.pathname}${u.search}`;
}
