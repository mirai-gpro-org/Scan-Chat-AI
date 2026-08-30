/**
 * **デモ用アカウントの「資格」** — 誰にダミーデータを見せるか。
 *
 * 正本: `docs/operations/デモ用アカウント_仕様書.md`
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【設計の要】デモ用アカウントと管理者アカウントは**別物**。混ぜない。
 * ══════════════════════════════════════════════════════════════════════
 *
 * デモの目的は **UI デザイン確認 / 機能確認 / ビジネスパートナーへのお披露目・PR**。
 * **PR 用のアカウントは社外に渡る**ので、管理者と同じ枠に置くことはできない。
 *
 *   デモの資格  = この一覧に uid があるか。**それだけ。**
 *   管理者権限  = Wellfort 側 `admin_users`（`admin-auth.ts`）。**まったく別系統。**
 *
 * この 2 つは**交わらない**:
 *   - デモ用アカウントは admin にならない（`admin_users` に載せない）
 *   - **admin だからといってダミーを見ない**（見たいなら uid を登録する）
 *   - admin 判定が壊れてもデモは動く（外部依存が無い）
 *   - デモ用アカウントを増やしても、管理権限は 1 ミリも増えない
 *
 * 【なぜこのファイルを分けたか】`demo-data.ts` は**ダミーデータそのもの**を持つ。
 * 「誰に見せるか（資格）」と「何を見せるか（データ）」は別の関心事で、
 * 混ぜていたために「admin なら見せる」という権限の話が
 * データ層に紛れ込んだ（2026-08-30）。**資格はここだけが決める。**
 *
 * 【保存先を差し替えるときもここだけ】将来 `diagnosis.demo_accounts` テーブル
 * （ラベル / 有効期限 / 監査）へ移すときも、変えるのは `demoAccountUids()` の中身だけで、
 * 呼び出し側（~30 箇所）は一切触らない。
 */

import { cfg } from './app-config';

/** uid の表記ゆれを吸収する（大文字・前後の空白）。 */
const norm = (uid?: string | null): string => (uid ?? '').trim().toLowerCase();

/**
 * **この uid はデモ用アカウントか。**
 *
 * 判定はこれ 1 つ。閲覧者が admin かどうかは**見ない**（見てはいけない）。
 *
 * @param uid **表示中の** `diagnostic_user_id`。
 *   admin が `?u=` で代理表示しているときは相手の uid になる ＝
 *   相手がデモ用アカウントでなければダミーは出ない（相手の実データが見える）。
 *   これは正しい挙動で、呼び出し側で場合分けする必要は無い。
 */
export function isDemoAccount(uid?: string | null): boolean {
  const u = norm(uid);
  return !!u && demoAccountUids().has(u);
}

/** デモ表示そのものが有効か（全停止スイッチ）。 */
export function demoDisabledGlobally(): boolean {
  return import.meta.env.PUBLIC_DEMO_FALLBACK === 'false';
}

/**
 * **デモ用アカウントの uid 一覧** = 3 つの供給元の**和**。
 *
 *   1. `BUILTIN_DEMO_UIDS`      … 消えない下限。用途が固定のデモ検体だけ
 *   2. env `DEMO_ALLOWED_UIDS`  … 要デプロイ。DB 障害に影響されない
 *   3. app_config `demo.account_uids` … **admin から即時**（TTL 45 秒・再デプロイ不要）
 *
 * **上書きでなく和。** 上書きにすると 1 件登録した瞬間に他が消え、
 * それまで見えていた画面が黙って空になる。**足せるが消せない**方が事故が軽い。
 * 全部止めるのは `PUBLIC_DEMO_FALLBACK=false` だけ。
 *
 * **キャッシュしない。** `cfg()` は TTL 45 秒で入れ替わるので、ここで固定すると
 * admin の登録が反映されない。文字列の分割だけなので毎回計算してよい。
 */
function demoAccountUids(): ReadonlySet<string> {
  return new Set([
    ...BUILTIN_DEMO_UIDS,
    ...splitUids(String(import.meta.env.DEMO_ALLOWED_UIDS ?? '')),
    ...splitUids(cfg('demo.account_uids')),
  ]);
}

function splitUids(raw: string): string[] {
  return raw.split(/[\s,]+/).map(norm).filter(Boolean);
}

/**
 * 組み込みのデモ用アカウント = **デプロイ無しでは消えない最小限**。
 *
 * - `d0000001…` … テストフェーズの標準デモ（真鍋）。`supabase/seed.sql` の投入先・`DEFAULT_USER`
 * - `da000001…` … OEM 相手先ブランド向けデモ（山田太郎）。`supabase/demo_oem_account.sql`
 * - `14410d5a…` / `186151f8…` … 社内の確認用（2026-08-30 登録）
 *
 * **すべて実顧客ではない。** 一般顧客の uid をここに書かない
 * （常設になり、外すのに再デプロイが要る）。
 *
 * **ここを名簿として育てないこと。** 増えるぶん（PR・お披露目・新しい担当者）は
 * app_config `demo.account_uids` を使う。ここに書き足す運用にすると、
 * アカウント 1 件ごとにデプロイが要る形に戻る。
 */
const BUILTIN_DEMO_UIDS: readonly string[] = [
  'd0000001-0000-0000-0000-000000000000',
  'da000001-0000-0000-0000-000000000000',
  '14410d5a-d515-4fe9-9a8e-bbb1040021ac',
  '186151f8-b4ec-4fcd-bbf5-2bf8aca09bdc',
];

/**
 * 監査・診断用。**uid そのものは返さない**（件数と供給元の内訳だけ）。
 * 「誰が登録されているか」は admin の設定画面で見る。
 */
export function demoAccountStats(): {
  total: number;
  builtin: number;
  fromEnv: number;
  fromConfig: number;
  disabledGlobally: boolean;
} {
  const fromEnv = splitUids(String(import.meta.env.DEMO_ALLOWED_UIDS ?? ''));
  const fromConfig = splitUids(cfg('demo.account_uids'));
  return {
    total: demoAccountUids().size,
    builtin: BUILTIN_DEMO_UIDS.length,
    fromEnv: fromEnv.length,
    fromConfig: fromConfig.length,
    disabledGlobally: demoDisabledGlobally(),
  };
}
