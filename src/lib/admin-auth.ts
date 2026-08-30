/**
 * Scan-Chat-AI 内 admin ページの認証ガード。
 *
 * 隔離ポリシー:
 *   - admin_users (6 名) の email のみ通過
 *   - それ以外は 404 で「存在しないように見せる」(403 だと admin の存在が露呈する)
 *   - 認証情報は Google One Tap 経由で Supabase Auth セッションに保存済の email を使う
 *
 * ⚠️ サーバ側でしか呼ばないこと (browser に admin email リストを露出させない)
 */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 管理者メンバー登録 — **admin を足すときはここだけを直す**
 * ══════════════════════════════════════════════════════════════════════
 *
 * 正本: docs/elith/AI疾病予防報告書_仕様書.md §4.6
 *
 * 【なぜ 1 本にまとめたか】以前は `ADMIN_EMAILS` と `ADMIN_UIDS` の**2 つの手書きリスト**が
 *   並んでいて、対応が取れていなかった。しかも**アプリの admin 判定は uid 側しか見ておらず、
 *   `isAdminEmail` は参照ゼロの死んだコードだった** (実測 2026-08-30)。
 *   → **email 側に足しただけでは admin にならない**のに、足した人は登録したつもりになる。
 *   ローンチ後も管理者は追加登録されていく (発注者 2026-08-30) ので、この罠は潰しておく。
 *
 * 【追加のしかた】この配列に 1 行足すだけ。**uid が admin 判定の実体**なので uid は必須。
 *   uid は当人の `/dashboard` →「デバッグ (テストフェーズ確認用)」に出ている
 *   `diagnostic_user_id`。まだ分からないときは `uid: null` で登録してよい —
 *   **`npm run verify:demo-gate` が「uid 未登録」として名前を出す**ので、
 *   黙って admin にならないまま放置されることがない。
 *
 * 【この登録が効く範囲】admin 画面の入場 / `?u=` の代理表示 / **デモデータの表示**。
 *   一般顧客 (Google 認証・顧客DBに登録あり・admin でない) の経路とは**完全に分かれている**
 *   — 一般顧客はこの配列に一切触れず、自分の実データだけを見る (spec §4.6)。
 */
export interface AdminMember {
  /** 表示用のラベル (ログにも画面にも出さない。ここを読む人間のため)。 */
  label: string;
  /** Google アカウントのメール (小文字)。不明なら null。 */
  email: string | null;
  /**
   * `diagnostic_user_id`。**admin 判定の実体はこちら。**
   * 不明なら null で登録し、`verify:demo-gate` の「uid 未登録」で拾う。
   */
  uid: string | null;
}

/**
 * **登録済みの管理者メンバー。**
 *
 * email と uid の対応は、統合前の `ADMIN_UIDS` に元から付いていたコメントに従っている
 * (捏造していない)。対応が分からない 2 件は片側 null のまま残してある。
 */
export const ADMIN_MEMBERS: readonly AdminMember[] = [
  { label: '濱田',              email: 'unfix.hamada@gmail.com',  uid: '14410d5a-d515-4fe9-9a8e-bbb1040021ac' },
  { label: '宮澤',              email: 'miyazawa@wellfort.co.jp', uid: '1c1ded05-6cce-4880-a5d8-3f964a43ba54' },
  { label: '新藤',              email: 'shindo@wellfort.co.jp',   uid: '46b3651a-f14b-46bd-a24f-fe01256a1709' },
  { label: '大川',              email: 'ohkawa@wellfort.co.jp',   uid: '7cbe6588-5a99-4068-9c40-5fa2427c7122' },
  { label: '岡部',              email: 'okabe@wellfort.co.jp',    uid: 'f9d47b45-45ad-4ffc-bad3-1bf4de130a1c' },
  { label: '本田',              email: 'honda@wellfort.co.jp',    uid: 'c0000020-0000-0000-0000-000000000000' },
  { label: '開発用 (物部/真鍋)', email: null,                      uid: 'd0000001-0000-0000-0000-000000000000' },
  // **uid 未登録**。email 側にしか無かったので、この状態では admin 判定に効かない。
  // uid が分かったら埋める (verify:demo-gate が毎回この行を名指しする)。
  { label: '開発用バックアップ', email: 'hamada@eentry.co.jp',     uid: null },
];

/** 管理者のメール (小文字統一)。**`ADMIN_MEMBERS` から導出**。 */
const ADMIN_EMAILS: ReadonlySet<string> = new Set(
  ADMIN_MEMBERS.map((m) => m.email).filter((e): e is string => !!e).map((e) => e.toLowerCase()),
);

/** 管理者の diagnostic_user_id。**`ADMIN_MEMBERS` から導出**。判定の実体はこちら。 */
const ADMIN_UIDS: ReadonlySet<string> = new Set(
  ADMIN_MEMBERS.map((m) => m.uid).filter((u): u is string => !!u).map((u) => u.toLowerCase()),
);

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.has(email.trim().toLowerCase());
}

/**
 * 未認証 / 非 admin の場合に投げる 404 Response。
 * Astro page の frontmatter で:
 *   if (!viewer.isAdmin) return notFoundForNonAdmin();
 */
export function notFoundForNonAdmin(): Response {
  return new Response('Not found', { status: 404 });
}

export function isAdminUid(uid: string | null | undefined): boolean {
  if (!uid) return false;
  return ADMIN_UIDS.has(uid.trim().toLowerCase());
}

/** ?u= から admin かどうかを判定 (Astro page で使用) */
export function gateByUid(uid: string | null | undefined): { allowed: boolean; uid: string | null } {
  if (!uid) return { allowed: false, uid: null };
  // 短縮形 (8 文字) を許可
  const normalized = uid.length === 36
    ? uid
    : (/^[0-9a-f]{8}$/i.test(uid) ? `${uid.toLowerCase()}-0000-0000-0000-000000000000` : null);
  if (!normalized) return { allowed: false, uid: null };
  return { allowed: isAdminUid(normalized), uid: normalized };
}
