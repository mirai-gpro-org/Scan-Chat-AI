#!/usr/bin/env node
/**
 * `npm run verify:demo-gate` — **誰にダミーデータが出るか**を固定する回帰チェック。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【2026-08-30 確定】**デモ用アカウントと管理者アカウントは別物。混ぜない。**
 * ══════════════════════════════════════════════════════════════════════
 *
 * デモの目的は **UI デザイン確認 / 機能確認 / ビジネスパートナーへのお披露目・PR**。
 * **PR 用のアカウントは社外に渡る**ので、管理者と同じ枠に置くことはできない。
 *
 *   デモの資格 = uid が一覧にあるか (`demo-accounts.ts` `isDemoAccount`)。**それだけ。**
 *   管理者権限 = Wellfort 側 `admin_users` (`admin-auth.ts`)。**まったく別系統。**
 *
 * 【admin を混ぜてはいけない理由 — 実際に踏んだ失敗】
 *   旧実装は `viewerIsAdmin` を条件に持っていた。その値は
 *   **Cookie の署名 → HP Edge の resolve-customer → Wellfort 側 admin_users**
 *   という 3 段の外部依存で決まり、どこか 1 つが落ちても結果は同じ `false` で、
 *   **画面は黙って空になる** (本番で `edge.is_admin:false` を実測)。
 *   さらに**管理者を 1 人増やすたびにダミーの閲覧者が増える**。
 *
 * 判定の実体は `src/lib/demo-data.ts` の `demoFallbackEnabled`。
 * ここでは同じ規則を**独立に**書き下して突き合わせる (実装をそのまま読むと
 * 「実装が実装どおり」を確認するだけになる)。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
/** コメント行を落とす (経緯の説明に旧コードが書いてあるため、そこを拾わない)。 */
const code = (p) => read(p).split('\n').filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln)).join('\n');

const src = read('src/lib/demo-data.ts');
/** 資格の実体はこちら。「誰に見せるか」は demo-accounts.ts が単独で持つ。 */
const acct = read('src/lib/demo-accounts.ts');
const fails = [];

/** 実装から組み込みの uid を読む (中身は運用で変わるので、そこは固定しない)。 */
const BUILTIN = (() => {
  const block = acct.slice(acct.indexOf('BUILTIN_DEMO_UIDS: readonly string[]'));
  return [...block.slice(0, block.indexOf('];')).matchAll(/'([0-9a-f-]{36})'/g)].map((m) => m[1]);
})();
if (BUILTIN.length === 0) fails.push('demo-accounts.ts: 組み込みのデモ用 uid が読めない');

// ══════════════════════════════════════════════════════════════════════
// 1. 判定の規則 (実装とは独立にここへ書き下す)
// ══════════════════════════════════════════════════════════════════════

/**
 * @param uid      表示中の diagnostic_user_id
 * @param envFalse env PUBLIC_DEMO_FALLBACK === 'false'
 * @param extra    env DEMO_ALLOWED_UIDS ∪ app_config demo.account_uids
 */
function expected(uid, envFalse, extra = []) {
  if (envFalse) return false;                            // ① 全停止スイッチ
  return !!uid && [...BUILTIN, ...extra].includes(uid);  // ② デモ用アカウントか。それだけ
}

const DEMO = BUILTIN[0];
const PARTNER = 'bbbbbbbb-1111-2222-3333-444444444444';   // お披露目用に admin から登録した uid
const CUSTOMER = 'aaaaaaaa-1111-2222-3333-444444444444'; // 実顧客

// [ラベル, uid, env=false か, 追加登録, 期待]
const cases = [
  ['デモ用アカウント(組み込み)     / env 未設定', DEMO,     false, [],        true],
  ['デモ用アカウント(組み込み)     / env=false ', DEMO,     true,  [],        false],
  ['PR/お披露目用(admin から登録)  / env 未設定', PARTNER,  false, [PARTNER], true],
  ['PR/お披露目用(未登録)          / env 未設定', PARTNER,  false, [],        false],
  ['一般顧客                       / env 未設定', CUSTOMER, false, [],        false],
  ['一般顧客                       / env=false ', CUSTOMER, true,  [],        false],
  ['一般顧客(他所で PR 登録あり)   / env 未設定', CUSTOMER, false, [PARTNER], false],
  ['未サインイン                   / env 未設定', null,     false, [],        false],
  /*
   * **admin であることはデモの資格にならない。**
   * 管理者を増やしてもダミーの閲覧者は増えない = 2 つの資格が分かれている証拠。
   * admin がダミーを見たいなら、その uid を登録する (それが唯一の道)。
   */
  ['admin だが uid 未登録          / env 未設定', CUSTOMER, false, [],        false],
  /*
   * **admin 判定が壊れていてもデモ用アカウントは見られる。**
   * お披露目が外部システム (Cookie / HP Edge / admin_users) の状態に左右されない。
   */
  ['デモ用アカウント / admin 判定が壊れている',  DEMO,     false, [],        true],
  /*
   * **代理表示 (`?u=`) は「表示中の uid」で判定される。**
   * 実測 2026-08-30: `?u=` 付きで紙面が emptyVM になり、原因の特定に往復した。
   */
  ['代理表示 (?u=) の相手がデモ用アカウント',    DEMO,     false, [],        true],
  ['代理表示 (?u=) の相手が一般顧客',            CUSTOMER, false, [],        false],
];

// ══════════════════════════════════════════════════════════════════════
// 2. デモの資格に admin が混ざっていないこと (**この再設計の要**)
// ══════════════════════════════════════════════════════════════════════
{
  const fn = src.slice(src.indexOf('export function demoFallbackEnabled'));
  const body = fn.slice(fn.indexOf('{') + 1, fn.indexOf('\n}'));

  if (!/isDemoAccount/.test(body)) fails.push('demoFallbackEnabled が isDemoAccount を使っていない');
  if (!/demoDisabledGlobally/.test(body)) fails.push('demoFallbackEnabled に全停止スイッチが無い');

  // **引数は uid 1 つだけ。** 任意の第 2 引数は渡し忘れても型で落ちず、静かに挙動が変わる。
  if (!/export function demoFallbackEnabled\(uid\?: string \| null\): boolean/.test(src)) {
    fails.push('demoFallbackEnabled の引数が uid 1 つではない'
      + ' — admin を受け取る形に戻すと、デモの資格が権限の仕組みに再び結合する');
  }

  /*
   * **デモの経路のどこにも admin が現れないこと。**
   * ここが緩むと「管理者を増やすとダミーの閲覧者が増える」形に戻り、
   * PR 用アカウントを社外に渡す前提と両立しなくなる。
   */
  for (const f of ['src/lib/demo-accounts.ts', 'src/lib/demo-data.ts',
                   'src/lib/dashboard-queries.ts', 'src/lib/measurement-queries.ts',
                   'src/lib/notice-queries.ts', 'src/lib/elith-report-queries.ts',
                   'src/lib/result-queries.ts']) {
    if (/viewerIsAdmin|isAdmin/.test(code(f))) {
      fails.push(`${f}: デモの経路に admin 判定が混ざっている`
        + ' — デモ用アカウントと管理者アカウントは別物。混ぜない');
    }
  }
  // ページ側も同様 (demoOk のような橋渡しを作らない)
  for (const f of ['src/pages/dashboard.astro', 'src/pages/report.astro',
                   'src/pages/trend.astro', 'src/pages/notices.astro', 'src/pages/kit.astro']) {
    if (/demoOk/.test(read(f))) {
      fails.push(`${f}: demoOk が復活している — デモの資格を画面から引き回さない (uid で決まる)`);
    }
  }

  /*
   * **資格は `demo-accounts.ts` が単独で持つこと。**
   * `demo-data.ts` は「何を見せるか」で、「誰に見せるか」を書く場所ではない。
   */
  if (!/BUILTIN_DEMO_UIDS/.test(code('src/lib/demo-accounts.ts'))) {
    fails.push('demo-accounts.ts に uid 一覧が無い');
  }
  if (/BUILTIN_DEMO_UIDS|DEMO_ALLOWED_UIDS/.test(code('src/lib/demo-data.ts'))) {
    fails.push('demo-data.ts が uid 一覧を持っている — 資格は demo-accounts.ts に一本化する');
  }

  /*
   * **PR 用アカウントは代理表示できないこと。**
   * `?u=` は admin だけの機能。デモ用アカウントは admin ではないので他人を覗けない。
   * 社外に渡すアカウントなので、ここが緩むと実顧客のデータに到達しうる。
   */
  if (!/isAdmin && requested && requested !== selfUid/.test(code('src/lib/viewer.ts'))) {
    fails.push('viewer.ts: `?u=` の代理表示が admin 限定でなくなっている'
      + ' — 社外に渡すデモ用アカウントが他人のデータを覗けてしまう');
  }
}

// ══════════════════════════════════════════════════════════════════════
// 3. 供給元が 3 つとも生きていること (和であって上書きでない)
// ══════════════════════════════════════════════════════════════════════
{
  const fn = acct.slice(acct.indexOf('function demoAccountUids('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  for (const [needle, why] of [
    ['BUILTIN_DEMO_UIDS', '組み込み (消えない下限)'],
    ['DEMO_ALLOWED_UIDS', 'env (DB 障害に影響されない)'],
    ["cfg('demo.account_uids')", 'app_config (admin から即時に増減)'],
  ]) {
    if (!body.includes(needle)) fails.push(`demoAccountUids() が ${why} を見ていない: ${needle}`);
  }
  // 和であること = キャッシュして固定しないこと (admin の登録が 45 秒で届くように)
  if (/cached|memo/i.test(body)) {
    fails.push('demoAccountUids() が結果をキャッシュしている'
      + ' — app_config は TTL 45 秒で入れ替わるので、固定すると admin の登録が反映されない');
  }

  // app_config にキーが登録されていること (無いと admin 画面に出ない)
  if (!read('src/lib/app-config.ts').includes("key: 'demo.account_uids'")) {
    fails.push('app-config.ts に demo.account_uids が無い — admin の設定画面に出ない');
  }

  // **データ取得より前に refreshConfig() を呼んでいること。**
  // 後ろだと初回リクエストで admin 画面からの登録が効かず、コード既定に落ちる。
  for (const f of ['src/pages/dashboard.astro', 'src/pages/report.astro',
                   'src/pages/trend.astro', 'src/pages/notices.astro', 'src/pages/kit.astro']) {
    const t = read(f);
    const iCfg = t.indexOf('await refreshConfig()');
    const iLoad = Math.min(...['await loadDashboard(', 'await loadNotices(']
      .map((n) => t.indexOf(n)).filter((i) => i >= 0).concat([Number.MAX_SAFE_INTEGER]));
    if (iCfg < 0) fails.push(`${f}: refreshConfig() を呼んでいない — app_config のデモ登録が効かない`);
    else if (iLoad !== Number.MAX_SAFE_INTEGER && iCfg > iLoad) {
      fails.push(`${f}: refreshConfig() がデータ取得より後ろ — 初回リクエストで登録が効かない`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// 4. admin 判定に名簿を持ち込まないこと (デモとは別件だが、同じ轍なので見張る)
// ══════════════════════════════════════════════════════════════════════
{
  const adminSrc = code('src/lib/admin-auth.ts');
  for (const name of ['ADMIN_MEMBERS', 'ADMIN_EMAILS', 'ADMIN_UIDS', 'isAdminUid']) {
    if (adminSrc.includes(`const ${name}`) || adminSrc.includes(`function ${name}`)) {
      fails.push(`admin-auth.ts: ベタ書きの管理者判定 ${name} が復活している`
        + ' — admin の正は wellfort-site の管理者リスト (admin_users) だけ');
    }
  }
  if (/isAdminUid\s*\(/.test(code('src/lib/viewer.ts'))) {
    fails.push('viewer.ts: uid の一覧で admin を判定している — URL に uid を書くだけで admin になれる');
  }
  if (/PUBLIC_SUPABASE_URL[\s\S]{0,400}admin_users/.test(adminSrc)) {
    fails.push('admin-auth.ts: 自前の Supabase から admin_users を直引きしている'
      + ' — 別プロジェクトなので必ず 404 になり、管理者が誰も admin にならない');
  }
  if (!/resolveCustomerWithAdmin/.test(adminSrc)) {
    fails.push('admin-auth.ts: HP Edge の resolveCustomerWithAdmin を使っていない'
      + ' — 顧客DB と管理者リストは Wellfort 側にしか無く、この経路が正');
  }
  if (!/payload\.is_admin/.test(code('src/lib/hp-edge.ts'))) {
    fails.push('hp-edge.ts: 応答の top-level is_admin を見ていない'
      + ' — 顧客レコードの無い管理者 (data: null) が admin になれない');
  }
}

// ══════════════════════════════════════════════════════════════════════
// 5. 旧形式 seed 行の回避が、必ずデモの内側にあること
// ══════════════════════════════════════════════════════════════════════
if (!/Array\.isArray\(row\.report\)\s*&&\s*demoFallbackEnabled\(/.test(read('src/lib/elith-report-queries.ts'))) {
  fails.push('elith-report-queries.ts: 旧形式 seed 行の回避が無い、または'
    + ' demoFallbackEnabled の外に出ている — 実顧客の実データを隠す危険');
}

// ══════════════════════════════════════════════════════════════════════
console.log('\nダミーデータを出すか (◯=出す / ✗=出さない)\n');
for (const [label, uid, envFalse, extra, want] of cases) {
  const got = expected(uid, envFalse, extra);
  const ok = got === want;
  if (!ok) fails.push(`${label}: 期待 ${want} / 規則 ${got}`);
  console.log(`  ${ok ? '✓' : '✗'} ${label}  → ${got ? '◯' : '✗'}`);
}

console.log(`\n組み込みのデモ用アカウント: ${BUILTIN.length} 件`);
console.log('  追加は wellfort-site admin → 設定「デモ」→「デモ用アカウントの uid」(再デプロイ不要)');
console.log('  env DEMO_ALLOWED_UIDS でも足せる。全停止は env PUBLIC_DEMO_FALLBACK=false');

if (fails.length) {
  console.log(`\n✗ ${fails.length} 件`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\n✓ デモ用アカウントだけがダミーを見る。admin であることは資格にならない。');
console.log('  デモ用アカウントと管理者アカウントは別物 — PR 用は社外に渡るので混ぜない。');
