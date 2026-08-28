/**
 * admin / partner API の Bearer 認可（唯一の実装）。
 *
 * 経緯 (2026-08-27・本番で実測して発覚):
 *   各 API が「`ADMIN_API_KEY` が未設定なら true を返す」dev 素通しを**14 ファイルに複製**しており、
 *   本番 Vercel に `ADMIN_API_KEY` が入っていなかったため **admin API が誰でも叩ける状態**だった。
 *   実測: `GET /api/admin/config` が認証ヘッダ無しで 200・設定一覧を返却。
 *   `config.ts` は POST も同じ関数なので設定の書き換えも通り得た。
 *
 * したがって **fail-closed** にする:
 *   ・キーが設定されている        → Bearer 完全一致のみ許可
 *   ・キー未設定 かつ 開発サーバ   → 許可 (ローカルの利便性は維持)
 *   ・キー未設定 かつ 本番        → **拒否** (env 入れ忘れが無防備に直結しない)
 *
 * 判定は `import.meta.env.DEV` (Astro/Vite が dev サーバでのみ true にする) を使う。
 * `NODE_ENV` は見ない — ビルド設定で容易に production 以外へ倒せてしまい、守りにならないため。
 */

export function adminApiKey(): string | undefined {
  const m = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.ADMIN_API_KEY;
  if (m != null && m !== '') return m;
  const p = typeof process !== 'undefined' ? process.env?.ADMIN_API_KEY : undefined;
  return p != null && p !== '' ? p : undefined;
}

/** 開発サーバ上か。`import.meta.env.DEV` は Vite が本番ビルドで false に静的置換する。 */
function isDevServer(): boolean {
  return import.meta.env.DEV === true;
}

/** 本番でキー未設定のときに一度だけ警告する (401 が続く原因を運用者が特定できるように)。 */
let warned = false;
function warnMisconfigOnce(): void {
  if (warned) return;
  warned = true;
  console.error(
    '[api-auth] ADMIN_API_KEY が未設定のため admin/partner API を全て拒否しています。' +
    ' Vercel の環境変数に ADMIN_API_KEY を設定して再デプロイしてください。',
  );
}

/**
 * Bearer 認可。**キー未設定の本番は拒否**する（素通ししない）。
 * 拒否理由を呼び出し側が出し分けられるよう、結果を判別できる形で返す。
 */
export type AuthResult = { ok: true } | { ok: false; reason: 'unauthorized' | 'server_misconfig' };

export function checkAdminAuth(request: Request): AuthResult {
  const expected = adminApiKey();
  if (!expected) {
    // ローカル開発だけ素通し。本番でここに来るのは env の入れ忘れ＝設定不備。
    if (isDevServer()) return { ok: true };
    warnMisconfigOnce();
    return { ok: false, reason: 'server_misconfig' };
  }
  const m = /^Bearer\s+(.+)$/i.exec((request.headers.get('authorization') || '').trim());
  return m && m[1] === expected ? { ok: true } : { ok: false, reason: 'unauthorized' };
}

/** 既存 API の `authorized(request): boolean` 差し替え用。 */
export function isAdminAuthorized(request: Request): boolean {
  return checkAdminAuth(request).ok;
}
