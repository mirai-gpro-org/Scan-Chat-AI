#!/usr/bin/env node
/**
 * `npm run verify:demo-gate` — **誰にダミーデータが出るか**を固定する回帰チェック。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【2026-08-30 再設計】デモを見せる相手 = **デモ用アカウント**。admin ではない。
 * ══════════════════════════════════════════════════════════════════════
 *
 * デモの目的は **UI デザインの確認 / 機能確認 / ビジネスパートナーへのお披露目・PR**
 * (発注者指示 2026-08-30)。**権限の確認ではない**ので、権限の仕組みに乗せない。
 *
 * 【なぜ切り離したか — 実際に踏んだ失敗】
 *   旧実装は第 1 条件が `viewerIsAdmin` で、その値は
 *   **Cookie の署名 → HP Edge の resolve-customer → Wellfort 側 admin_users**
 *   という 3 段の外部依存で決まっていた。どこか 1 つが落ちても結果は同じ `false` で、
 *   画面は**黙って空になる**。原因の切り分けに何往復も費やした。
 *   さらに admin と束ねていると、**管理者を 1 人増やすたびにダミーの閲覧者が増える**。
 *
 * 【なぜこのチェックが要るか】ここは**静かに壊れる**。
 *   - デモ用アカウントで画面が空になる (お披露目の当日に気づく)
 *   - 実顧客に他人名義のダミーが「自分の結果」として出る (`13a8a95` が塞いだ事故)
 *   どちらも画面を見ただけでは気づけないので、規則を表で固定する。
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
const fails = [];

/** 実装から組み込みの uid を読む (中身は運用で変わるので、そこは固定しない)。 */
const BUILTIN = (() => {
  const block = src.slice(src.indexOf('BUILTIN_DEMO_UIDS: readonly string[]'));
  return [...block.slice(0, block.indexOf('];')).matchAll(/'([0-9a-f-]{36})'/g)].map((m) => m[1]);
})();
if (BUILTIN.length === 0) fails.push('demo-data.ts: 組み込みのデモ用 uid が読めない');

// ══════════════════════════════════════════════════════════════════════
// 1. 判定の規則 (実装とは独立にここへ書き下す)
// ══════════════════════════════════════════════════════════════════════

/**
 * @param uid      表示中の diagnostic_user_id
 * @param envFalse env PUBLIC_DEMO_FALLBACK === 'false'
 * @param extra    env DEMO_ALLOWED_UIDS ∪ app_config demo.account_uids
 */
function expected(uid, envFalse, extra = []) {
  if (envFalse) return false;                                   // ① 全停止スイッチ
  return !!uid && [...BUILTIN, ...extra].includes(uid);         // ② デモ用アカウントか
}

const DEMO = BUILTIN[0];
const PARTNER = 'bbbbbbbb-1111-2222-3333-444444444444';   // お披露目用に admin から登録した uid
const CUSTOMER = 'aaaaaaaa-1111-2222-3333-444444444444'; // 実顧客

// [ラベル, uid, env=false か, 追加登録, 期待]
const cases = [
  ['デモ用アカウント(組み込み)   / env 未設定', DEMO,     false, [],         true],
  ['デモ用アカウント(組み込み)   / env=false ', DEMO,     true,  [],         false],
  ['パートナー用(admin から登録) / env 未設定', PARTNER,  false, [PARTNER],  true],
  ['パートナー用(未登録)         / env 未設定', PARTNER,  false, [],         false],
  ['一般顧客                     / env 未設定', CUSTOMER, false, [],         false],
  ['一般顧客                     / env=false ', CUSTOMER, true,  [],         false],
  ['一般顧客(パートナー登録あり) / env 未設定', CUSTOMER, false, [PARTNER],  false],
  ['未サインイン                 / env 未設定', null,     false, [],         false],
];

// ══════════════════════════════════════════════════════════════════════
// 2. 実装が「uid だけ」で決めていること
// ══════════════════════════════════════════════════════════════════════
{
  const fn = src.slice(src.indexOf('export function demoFallbackEnabled'));
  const body = fn.slice(0, fn.indexOf('\n}'));

  // **admin を見ていないこと。** ここが今回の再設計の要。
  if (/viewerIsAdmin|isAdmin/.test(body)) {
    fails.push('demoFallbackEnabled が admin を見ている'
      + ' — デモの相手はデモ用アカウントであって管理者ではない。'
      + ' admin に束ねると Cookie/HP Edge/admin_users の 3 段依存が復活し、黙って空になる');
  }
  if (!/PUBLIC_DEMO_FALLBACK/.test(body)) fails.push('demoFallbackEnabled に全停止スイッチが無い');
  if (!/demoUids\(\)/.test(body)) fails.push('demoFallbackEnabled が uid 一覧を見ていない');

  // 引数が 1 つだけ (第 2 引数の「渡し忘れ」という穴を構造的に消した)
  if (!/export function demoFallbackEnabled\(uid\?: string \| null\): boolean/.test(src)) {
    fails.push('demoFallbackEnabled の引数が uid 1 つではない'
      + ' — 任意の第 2 引数は渡し忘れても型で落ちず、静かに挙動が変わる');
  }
}

// ══════════════════════════════════════════════════════════════════════
// 3. 供給元が 3 つとも生きていること (和であって上書きでない)
// ══════════════════════════════════════════════════════════════════════
{
  const fn = src.slice(src.indexOf('function demoUids('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  for (const [needle, why] of [
    ['BUILTIN_DEMO_UIDS', '組み込み (消えない下限)'],
    ['DEMO_ALLOWED_UIDS', 'env (DB 障害に影響されない)'],
    ["cfg('demo.account_uids')", 'app_config (admin から即時に増減)'],
  ]) {
    if (!body.includes(needle)) fails.push(`demoUids() が ${why} を見ていない: ${needle}`);
  }
  // 和であること = キャッシュして固定しないこと (admin の変更が 45 秒で届くように)
  if (/cachedDemoUids|let cached/.test(body)) {
    fails.push('demoUids() が結果をキャッシュしている'
      + ' — app_config は TTL 45 秒で入れ替わるので、固定すると admin の変更が反映されない');
  }

  // app_config にキーが登録されていること (無いと admin 画面に出ない)
  if (!read('src/lib/app-config.ts').includes("key: 'demo.account_uids'")) {
    fails.push('app-config.ts に demo.account_uids が無い — admin の設定画面に出ない');
  }

  // **データ取得より前に refreshConfig() を呼んでいること。**
  // 後ろだと初回リクエストで admin の登録が効かず、コード既定に落ちる。
  for (const f of ['src/pages/dashboard.astro', 'src/pages/report.astro',
                   'src/pages/trend.astro', 'src/pages/notices.astro', 'src/pages/kit.astro']) {
    const t = read(f);
    const iCfg = t.indexOf('await refreshConfig()');
    const iLoad = Math.min(...['await loadDashboard(', 'await loadNotices(']
      .map((n) => t.indexOf(n)).filter((i) => i >= 0).concat([Number.MAX_SAFE_INTEGER]));
    if (iCfg < 0) fails.push(`${f}: refreshConfig() を呼んでいない — app_config のデモ登録が効かない`);
    else if (iLoad !== Number.MAX_SAFE_INTEGER && iCfg > iLoad) {
      fails.push(`${f}: refreshConfig() がデータ取得より後ろ — 初回リクエストで admin の登録が効かない`);
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
  /*
   * **admin が壊れてもデモは動くこと。**
   * これが再設計の眼目なので、デモの経路に admin 判定が混ざっていないかを機械で見る。
   */
  for (const f of ['src/lib/dashboard-queries.ts', 'src/lib/measurement-queries.ts',
                   'src/lib/notice-queries.ts', 'src/lib/elith-report-queries.ts',
                   'src/lib/result-queries.ts']) {
    if (/viewerIsAdmin/.test(code(f))) {
      fails.push(`${f}: デモの経路に viewerIsAdmin が残っている — admin から切り離した意味が無くなる`);
    }
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
console.log('\n✓ デモ用アカウントだけがダミーを見る。一般顧客は自分の実データだけ。');
console.log('  判定は uid 1 本。admin 権限とは無関係なので、admin が壊れてもデモは動く。');
