#!/usr/bin/env node
/**
 * `npm run verify:demo-gate` — **誰にダミーデータが出るか**を固定する回帰チェック。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【2026-08-30 確定】本線 = **デモ用アカウント (uid)** / 追加 = **admin の登録者**
 * ══════════════════════════════════════════════════════════════════════
 *
 * デモの目的は **UI デザインの確認 / 機能確認 / ビジネスパートナーへのお披露目・PR**
 * (発注者指示 2026-08-30)。admin の登録者もデモを見られる (同指示)。
 *
 * 【順序が要件そのもの — 実際に踏んだ失敗】
 *   旧実装は**第 1 条件が `viewerIsAdmin`** で、その値は
 *   **Cookie の署名 → HP Edge の resolve-customer → Wellfort 側 admin_users**
 *   という 3 段の外部依存で決まっていた。どこか 1 つが落ちても結果は同じ `false` で、
 *   画面は**黙って空になる**。原因の切り分けに何往復も費やした。
 *   → **uid を先に評価する。** admin 判定が壊れても、登録したデモ用アカウントは
 *     確実にデモを見られる = お披露目が外部システムの状態に左右されない。
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
function expected(uid, envFalse, extra = [], viewerIsAdmin = false) {
  if (envFalse) return false;                                    // ① 全停止スイッチ
  if (!!uid && [...BUILTIN, ...extra].includes(uid)) return true; // ② デモ用アカウント (本線)
  return viewerIsAdmin === true;                                 // ③ admin の登録者 (追加)
}

const DEMO = BUILTIN[0];
const PARTNER = 'bbbbbbbb-1111-2222-3333-444444444444';   // お披露目用に admin から登録した uid
const CUSTOMER = 'aaaaaaaa-1111-2222-3333-444444444444'; // 実顧客

// [ラベル, uid, env=false か, 追加登録, admin か, 期待]
const cases = [
  ['デモ用アカウント(組み込み)   / env 未設定', DEMO,     false, [],        false, true],
  ['デモ用アカウント(組み込み)   / env=false ', DEMO,     true,  [],        false, false],
  ['パートナー用(admin から登録) / env 未設定', PARTNER,  false, [PARTNER], false, true],
  ['パートナー用(未登録)         / env 未設定', PARTNER,  false, [],        false, false],
  ['admin の登録者               / env 未設定', CUSTOMER, false, [],        true,  true],
  ['admin の登録者               / env=false ', CUSTOMER, true,  [],        true,  false],
  ['一般顧客                     / env 未設定', CUSTOMER, false, [],        false, false],
  ['一般顧客                     / env=false ', CUSTOMER, true,  [],        false, false],
  ['一般顧客(パートナー登録あり) / env 未設定', CUSTOMER, false, [PARTNER], false, false],
  ['未サインイン                 / env 未設定', null,     false, [],        false, false],
  /*
   * **admin 判定が壊れても、デモ用アカウントは見られること。** これが再設計の眼目。
   * 2026-08-30 に本番で edge.is_admin=false を実測しており、admin だけに依存していると
   * お披露目の当日に画面が空になる。
   */
  ['デモ用アカウント / admin 判定が壊れている', DEMO,     false, [],        false, true],
  /*
   * **代理表示 (`?u=`) でも、表示中の uid がデモ用アカウントならデモが出ること。**
   * ページは代理表示中に `viewerIsAdmin` を渡さない (相手の実データを見せるため) ので、
   * ③ は使えない。**② が uid で判定するから成立する。**
   * 実測 2026-08-30: `?u=` 付きの URL で紙面が emptyVM になり、原因の特定に往復した。
   */
  ['代理表示 (?u=) の相手がデモ用アカウント', DEMO,     false, [],        false, true],
];

// ══════════════════════════════════════════════════════════════════════
// 2. 実装の条件と、その評価順序
// ══════════════════════════════════════════════════════════════════════
{
  const fn = src.slice(src.indexOf('export function demoFallbackEnabled'));
  // **本体だけを見る** — 引数リストの `viewerIsAdmin` を条件の出現順と取り違えないため。
  const body = fn.slice(fn.indexOf('{') + 1, fn.indexOf('\n}'));

  if (!/PUBLIC_DEMO_FALLBACK/.test(body)) fails.push('demoFallbackEnabled に全停止スイッチが無い');
  if (!/demoUids\(\)/.test(body)) fails.push('demoFallbackEnabled が uid 一覧を見ていない');
  if (!/viewerIsAdmin/.test(body)) {
    fails.push('demoFallbackEnabled が admin を見ていない'
      + ' — admin の登録者もデモを見られること (発注者指示 2026-08-30)');
  }

  /*
   * **順序が要件そのもの: uid (本線) が admin (追加) より先。**
   *
   * admin を先に置くと、admin 判定の 3 段依存 (Cookie → HP Edge → admin_users) が
   * デモの入口になる。そこが落ちると**デモ用アカウントまで巻き添えで空になる**
   * (2026-08-30 に本番で edge.is_admin=false を実測)。
   * uid を先に評価しておけば、admin が壊れてもお披露目は成立する。
   */
  const iEnv = body.indexOf('PUBLIC_DEMO_FALLBACK');
  const iUid = body.indexOf('demoUids()');
  const iAdmin = body.indexOf('viewerIsAdmin');
  if (iEnv < 0 || iUid < 0 || iAdmin < 0) fails.push('demoFallbackEnabled の 3 条件が読めない');
  else if (!(iEnv < iUid && iUid < iAdmin)) {
    fails.push('順序が ①env → ②uid → ③admin になっていない'
      + ' — admin を先に置くと、admin 判定が壊れたときにデモ用アカウントまで空になる');
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
   * **第 2 引数の渡し忘れを機械で見る。**
   * `viewerIsAdmin` は任意引数なので、渡し忘れても TypeScript は通る。
   * 渡し忘れると admin の登録者が黙ってデモを見られなくなる (静かに壊れる)。
   */
  for (const f of ['src/lib/dashboard-queries.ts', 'src/lib/measurement-queries.ts',
                   'src/lib/notice-queries.ts', 'src/lib/elith-report-queries.ts']) {
    const bare = [...code(f).matchAll(/demoFallbackEnabled\(\s*([A-Za-z0-9_.?]+)\s*\)/g)];
    if (bare.length) {
      fails.push(`${f}: demoFallbackEnabled に viewerIsAdmin を渡していない箇所が ${bare.length} 件`);
    }
  }
  // ページが入口へ渡しているか (代理表示中は渡さないので `!viewer.impersonating` 込み)
  for (const f of ['src/pages/dashboard.astro', 'src/pages/report.astro',
                   'src/pages/trend.astro', 'src/pages/notices.astro', 'src/pages/kit.astro']) {
    if (!/const demoOk = viewer\.isAdmin && !viewer\.impersonating;/.test(read(f))) {
      fails.push(`${f}: viewer.isAdmin を入口関数へ渡していない (demoOk が無い)`);
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
for (const [label, uid, envFalse, extra, isAdmin, want] of cases) {
  const got = expected(uid, envFalse, extra, isAdmin);
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
console.log('\n✓ デモ用アカウントと admin の登録者だけがダミーを見る。一般顧客は自分の実データだけ。');
console.log('  本線は uid の一覧なので、admin 判定が壊れてもデモ用アカウントは見られる。');
