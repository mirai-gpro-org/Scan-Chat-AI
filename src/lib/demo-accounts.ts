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

/**
 * 一覧の文字列を uid の配列にする。
 *
 * **`#` から行末までは注釈**として捨てる。admin の管理画面で
 * 「この uid が誰用か」を書けるようにするため (PR・お披露目で増えるので、
 * uid の羅列だけだと後から誰も分からなくなる)。
 *
 *   bbbbbbbb-...  # パートナーA お披露目 2026-09
 *   cccccccc-...  # 展示会デモ
 *
 * 注釈が無ければ従来どおりカンマ / 空白 / 改行 区切りで並べてよい。
 */
function splitUids(raw: string): string[] {
  return parseEntries(raw).map((e) => e.uid);
}

/** 一覧の 1 行 = uid ＋ 注釈。admin の管理画面が使う。 */
export interface DemoAccountEntry {
  uid: string;
  /** `#` 以降。無ければ空。**PII は書かないこと** (誰用かが分かる短い語で足りる)。 */
  label: string;
}

/** 注釈つきで解析する。**uid の形をしていない語は捨てる** (打ち間違いで壊さない)。 */
export function parseEntries(raw: string): DemoAccountEntry[] {
  const out: DemoAccountEntry[] = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const hash = line.indexOf('#');
    const label = hash >= 0 ? line.slice(hash + 1).trim() : '';
    const body = hash >= 0 ? line.slice(0, hash) : line;
    for (const tok of body.split(/[\s,]+/)) {
      const uid = tok.trim().toLowerCase();
      if (UUID_RE.test(uid)) out.push({ uid, label });
    }
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** uid として妥当か (admin 画面の入力チェックと共有する)。 */
export function isUuid(v: string): boolean {
  return UUID_RE.test(v.trim().toLowerCase());
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

/** 管理画面に「何用か」を出すための説明。**PII は書かない**。 */
const BUILTIN_LABELS: Readonly<Record<string, string>> = {
  'd0000001-0000-0000-0000-000000000000': 'テストフェーズの標準デモ (seed.sql の投入先)',
  'da000001-0000-0000-0000-000000000000': 'OEM 相手先ブランド向けデモ',
  '14410d5a-d515-4fe9-9a8e-bbb1040021ac': '社内の確認用 (2026-08-30 登録)',
  '186151f8-b4ec-4fcd-bbf5-2bf8aca09bdc': '社内の確認用 (2026-08-30 登録)',
};

/**
 * **admin の管理画面が見る一覧。** どの供給元から来たかを付けて返す。
 *
 * uid は `diagnostic_user_id` で **PII を含まない**ので admin には見せてよい
 * (むしろ見えないと「誰が登録されているか分からない」= 棚卸しできない)。
 * 氏名やメールは**ここでは扱わない**。
 */
export interface DemoAccountRow extends DemoAccountEntry {
  /** どこから来たか。`config` だけが admin から編集できる。 */
  source: 'builtin' | 'env' | 'config';
}

export function listDemoAccounts(): {
  rows: DemoAccountRow[];
  disabledGlobally: boolean;
  /** admin が編集する生テキスト (app_config の値そのまま)。 */
  configRaw: string;
} {
  const configRaw = cfg('demo.account_uids');
  const rows: DemoAccountRow[] = [
    ...BUILTIN_DEMO_UIDS.map((uid) => ({ uid, label: BUILTIN_LABELS[uid] ?? '', source: 'builtin' as const })),
    ...parseEntries(String(import.meta.env.DEMO_ALLOWED_UIDS ?? '')).map((e) => ({ ...e, source: 'env' as const })),
    ...parseEntries(configRaw).map((e) => ({ ...e, source: 'config' as const })),
  ];
  return { rows, disabledGlobally: demoDisabledGlobally(), configRaw };
}

/** 監査・診断用の件数だけ (`/api/debug/viewer` が使う)。 */
export function demoAccountStats(): {
  total: number; builtin: number; fromEnv: number; fromConfig: number; disabledGlobally: boolean;
} {
  const { rows, disabledGlobally } = listDemoAccounts();
  const by = (s: DemoAccountRow['source']) => rows.filter((r) => r.source === s).length;
  return {
    total: demoAccountUids().size,
    builtin: by('builtin'),
    fromEnv: by('env'),
    fromConfig: by('config'),
    disabledGlobally,
  };
}
