/**
 * admin 判定 — **正は wellfort-site の管理者リスト (`public.admin_users`) だけ**。
 *
 * 正本: `docs/elith/AI疾病予防報告書_仕様書.md` §4.6「admin の正は `admin_users` テーブル」。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【2026-08-30・実測】ソースにベタ書きしていた管理者一覧は**全て削除した**
 * ══════════════════════════════════════════════════════════════════════
 *
 * 削除した理由は「重複していたから」ではない。**それが唯一動いている判定だったから**。
 *
 *   旧 `isAdminEmailAsync` の順序:
 *     ① ベタ書きの `ADMIN_EMAILS` に在れば true
 *     ② `${PUBLIC_SUPABASE_URL}/rest/v1/admin_users` を引く ← **参照先を間違えていた**
 *
 * **2 つのアプリは別の Supabase プロジェクト**で、顧客DB と管理者リストは
 * Wellfort 側にしか無い (実測):
 *
 *   Scan-Chat-AI  `https://nfubaioudhggqbzaussw.supabase.co`
 *   wellfort-site `https://nlydlveiokiivjwpnnaf.supabase.co`  ← `admin_users` はこちら
 *
 * Scan-Chat-AI 側で引くと **`HTTP 404 / PGRST205 Could not find the table
 * 'public.admin_users' in the schema cache`**。つまり ② は常に false で、
 * **Scan-Chat-AI は管理者リストを一度も読めていなかった**。
 * admin 画面で登録しても診断アプリには届かず、**ベタ書きの 8 行だけが admin 判定**だった。
 * 仕様書が「手で書き写した `ADMIN_MEMBERS` に依存するのをやめた」と宣言していたのに、
 * 実装ではやめられておらず、しかも「フォールバック」と書かれた側が本番の実体だった。
 *
 * さらに悪いことに、この構成では **`admin_users` から外しても admin のまま**になる
 * (ベタ書きに残っている限り true)。**管理者権限の剥奪が効かない。**
 *
 * 【いまの方式】**既存の経路で Wellfort 側へ聞く。新しい口は作らない。**
 *   顧客DB も管理者リストも **Wellfort 側の Supabase にしか無い**
 *   (個人情報は Wellfort 側でしか持たない取り決め)。Scan-Chat-AI からの解決経路は
 *   **HP Edge の `resolve-customer`** (`hp-edge.ts`・共有シークレット `x-resolve-secret`) で、
 *   これは既に email → `diagnostic_user_id` を解決している。
 *   → **同じ応答に `is_admin` を足した**。呼び出しも鍵も増えない。
 *
 * 【失敗したときは admin にしない (fail-closed)】
 *   引けなかったことを「admin である」と読み替えない。**代わりにサーバログへ理由を出す**ので、
 *   「静かに admin でなくなる」ことは無い。`/dashboard` のデバッグ欄にも根拠が出る。
 *
 * ⚠️ サーバ側でしか呼ばないこと。
 */

import { isHpEdgeConfigured, resolveCustomerWithAdmin } from './hp-edge';

/**
 * この email が**管理者リストに載っている現役の管理者**か。
 *
 * 問い合わせ先は **HP Edge の `resolve-customer`**（`hp-edge.ts`）。
 * Scan-Chat-AI から Wellfort 側 DB を読む経路はこれが正で、**新しい口を増やさない**。
 * 応答の `is_admin` をそのまま使う（`admin_users` を `is_active=true` で照会した結果）。
 *
 * **引けなかったときは false**（fail-closed）。引けないことを「admin である」と
 * 読み替えない。理由はサーバログに出るので、静かに admin でなくなることは無い。
 */
export async function isAdminEmailAsync(email: string | null | undefined): Promise<boolean> {
  const e = (email ?? '').trim().toLowerCase();
  if (!e) return false;
  if (!isHpEdgeConfigured()) {
    console.error('[admin-auth] HP_EDGE_BASE_URL 未設定のため管理者リストを引けません。admin として扱いません。');
    return false;
  }
  try {
    // **顧客が居なくても admin の可否は返る** (管理者 ≠ 顧客)。
    const { isAdmin } = await resolveCustomerWithAdmin(e);
    return isAdmin;
  } catch (err) {
    console.error('[admin-auth] 管理者リストの照会に失敗:', err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * 未認証 / 非 admin の場合に返す 404。
 * 403 だと admin 画面の存在が露呈するので 404 で「無いように見せる」。
 *
 * Astro page の frontmatter で:
 *   if (!viewer.isAdmin) return notFoundForNonAdmin();
 */
export function notFoundForNonAdmin(): Response {
  return new Response('Not found', { status: 404 });
}
