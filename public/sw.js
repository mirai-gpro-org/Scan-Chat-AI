/*
 * Welltect — 最小の Service Worker (オフライン案内のみ)
 *
 * 正本: docs/elith/AI疾病予防報告書_仕様書.md §4.4 (発注者判断 2026-08-28)
 *
 * 【入れる理由】`manifest.webmanifest` が `display: standalone` なので、SW が無いと
 *   ホーム画面から起動したときに**アプリの見た目のままブラウザのエラー画面**が出る。
 *   それを 1 枚の案内ページに差し替えるためだけに置く。
 *
 * 【やらないこと — ここが本体】
 *   - **報告書 (`/report`) をキャッシュしない。** `/report` は SSR なので、キャッシュすると
 *     **認証を通さずに HTML を返す**ことになり、端末のロックが解ければ他人の結果が読める。
 *     オフラインで報告書を残す手段は「印刷ビュー → 共有 → PDF で『ファイル』へ保存」の方
 *     (仕様書 §4.4 の手段 A)。SW はその代わりにならないし、代わりにしてはいけない。
 *   - **ナビゲーション以外は一切横取りしない。** API・画像・CSS・JS は `respondWith` を
 *     呼ばずブラウザに任せる (= 挙動不変)。
 *   - **ネットワーク応答をキャッシュに入れない。** 保存するのは precache の静的 2 点だけ。
 *
 * 【更新】`CACHE` の版を上げれば古いキャッシュは activate で消える。
 */

const CACHE = 'welltect-offline-v1';
const OFFLINE_URL = '/offline.html';

/** キャッシュしてよいのは、個人のデータを含まない静的ファイルだけ。 */
const PRECACHE = [OFFLINE_URL];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      // 案内 1 枚が取れなくても install は失敗させない (SW ごと入らないと更新もできなくなる)。
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // ページ遷移だけを見る。それ以外は素通し (respondWith を呼ばない)。
  if (req.mode !== 'navigate' || req.method !== 'GET') return;

  event.respondWith(
    // **必ずネットワークが先。** キャッシュ済みの画面を先に返すことはしない
    // (古い結果や他人の結果を出さないため)。
    fetch(req).catch(() =>
      caches.match(OFFLINE_URL).then((res) => res || new Response(
        '通信できませんでした。電波の届く場所で、もう一度お試しください。',
        { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
      )),
    ),
  );
});
