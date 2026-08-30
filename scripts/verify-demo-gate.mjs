#!/usr/bin/env node
/**
 * `npm run verify:demo-gate` — **誰にダミーデータが出るか**を固定する回帰チェック。
 *
 * 正本: docs/elith/AI疾病予防報告書_仕様書.md §4.6 (発注者指示 2026-08-30)
 *
 * 【なぜ要るか】ここは**静かに壊れる**。判定が 1 つ変わるだけで
 *   - admin が全画面ほぼ空になる (実測 2026-08-30。`/report` が `emptyVM` になった)
 *   - 逆に、実顧客に他人名義のダミーが「自分の結果」として出る (`13a8a95` が塞いだ事故)
 *   のどちらかが起きる。**どちらも画面を見ただけでは気づけない**ので表で固定する。
 *
 * 判定の実体は `src/lib/demo-data.ts` の `demoFallbackEnabled`。
 * ここでは同じ規則を**独立に**書き下して突き合わせる (実装をそのまま読むと
 * 「実装が実装どおり」を確認するだけになる)。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const src = readFileSync(resolve(ROOT, 'src/lib/demo-data.ts'), 'utf8');
const adminSrc = readFileSync(resolve(ROOT, 'src/lib/admin-auth.ts'), 'utf8');

/** 実装から uid 集合を読む (リストの中身は運用で変わるので、そこは固定しない)。 */
const pick = (text, name) => {
  const block = text.slice(text.indexOf(name));
  const body = block.slice(block.indexOf('['), block.indexOf(']'));
  return [...body.matchAll(/'([0-9a-f-]{36})'/g)].map((m) => m[1]);
};

/** 管理者メンバー登録 (`ADMIN_MEMBERS`) を読む。**admin を足す唯一の場所。** */
const membersBlock = adminSrc.slice(
  adminSrc.indexOf('export const ADMIN_MEMBERS'),
  adminSrc.indexOf('/** 管理者のメール'),
);
const ADMIN_MEMBERS = [...membersBlock.matchAll(
  /\{\s*label:\s*'([^']*)',\s*email:\s*(?:'([^']*)'|null),\s*uid:\s*(?:'([^']*)'|null)\s*\}/g,
)].map((m) => ({ label: m[1], email: m[2] ?? null, uid: m[3] ?? null }));

const ADMIN_UIDS = ADMIN_MEMBERS.map((m) => m.uid).filter(Boolean);
const ADMIN_EMAILS = ADMIN_MEMBERS.map((m) => m.email).filter(Boolean);
const DEMO_ALLOWED = pick(src, 'DEMO_ALLOWED_UIDS');

if (ADMIN_MEMBERS.length === 0) { console.error('✗ ADMIN_MEMBERS を読めなかった'); process.exit(1); }
if (ADMIN_UIDS.length === 0) { console.error('✗ uid を持つ管理者が 1 人もいない'); process.exit(1); }

/** 期待する規則 (発注者指示 2026-08-30)。実装とは独立にここへ書く。 */
function expected(uid, envFalse) {
  if (uid && ADMIN_UIDS.includes(uid)) return true;   // ① admin は env に関わらず出る
  if (envFalse) return false;                          // ② env は admin 以外を一括で切る
  return !!uid && DEMO_ALLOWED.includes(uid);          // ③ デモ許可 uid
}

const fails = [];

/** 実装のソースが ①→②→③ の順になっているか (順序が入れ替わると ① が死ぬ)。 */
const fn = src.slice(src.indexOf('export function demoFallbackEnabled'));
const body = fn.slice(0, fn.indexOf('\n}'));
const iAdmin = body.indexOf('isAdminUid');
const iEnv = body.indexOf('PUBLIC_DEMO_FALLBACK');
const iAllowed = body.indexOf('DEMO_ALLOWED_UIDS');

if (iAdmin < 0 || iEnv < 0 || iAllowed < 0) fails.push('demoFallbackEnabled の 3 条件が読めない');
else if (!(iAdmin < iEnv && iEnv < iAllowed)) {
  fails.push('順序が ①admin → ②env → ③許可uid になっていない'
    + ' — env が先だと PUBLIC_DEMO_FALLBACK=false で **admin まで塞がれる**');
}

const ADMIN = ADMIN_UIDS[0];
const CUSTOMER = 'aaaaaaaa-1111-2222-3333-444444444444'; // Google 認証済みの一般顧客
const OEM = DEMO_ALLOWED[0] ?? null;

const cases = [
  ['admin                / env 未設定', ADMIN, false, true],
  ['admin                / env=false ', ADMIN, true, true],   // ← ここが要件
  ['一般顧客(非admin)     / env 未設定', CUSTOMER, false, false],
  ['一般顧客(非admin)     / env=false ', CUSTOMER, true, false],
  ['未サインイン(uid無し) / env 未設定', null, false, false],
  ['未サインイン(uid無し) / env=false ', null, true, false],
];
if (OEM) cases.push(
  ['OEMデモ顧客           / env 未設定', OEM, false, true],
  ['OEMデモ顧客           / env=false ', OEM, true, false],
);

// ── 引数の伝播チェック ────────────────────────────────────────
// `demoFallbackEnabled(uid, viewerIsAdmin)` の 2 つ目は**任意引数**なので、
// 渡し忘れても TypeScript は通る。**email だけで登録した admin が黙って
// デモを見られなくなる**ので、ここで機械的に見る。
{
  const entryFiles = [
    'src/lib/dashboard-queries.ts', 'src/lib/measurement-queries.ts',
    'src/lib/notice-queries.ts', 'src/lib/elith-report-queries.ts',
  ];
  for (const f of entryFiles) {
    // **コメント行は見ない** (説明文の `demoFallbackEnabled(uid)` を拾ってしまうため)
    const t = readFileSync(resolve(ROOT, f), 'utf8')
      .split('\n').filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln)).join('\n');
    const bare = [...t.matchAll(/demoFallbackEnabled\(\s*([A-Za-z0-9_.?]+)\s*\)/g)];
    if (bare.length) {
      fails.push(`${f}: demoFallbackEnabled に viewerIsAdmin を渡していない箇所が ${bare.length} 件`);
    }
  }
  // ページが入口へ渡しているか
  const pages = ['src/pages/dashboard.astro', 'src/pages/report.astro',
                 'src/pages/trend.astro', 'src/pages/notices.astro', 'src/pages/kit.astro'];
  for (const f of pages) {
    let t;
    try { t = readFileSync(resolve(ROOT, f), 'utf8'); } catch { continue; }
    if (!t.includes('resolveViewer')) continue;
    if (!t.includes('demoOk')) fails.push(`${f}: viewer.isAdmin を入口関数へ渡していない (demoOk が無い)`);
  }
  // サインイン時に email から admin を決めているか
  const rv = readFileSync(resolve(ROOT, 'src/pages/api/auth/resolve.ts'), 'utf8');
  if (!/signViewer\([^)]*isAdminEmailAsync\(/.test(rv)) {
    fails.push('api/auth/resolve.ts: Cookie の admin フラグを email から決めていない'
      + ' — 手写しの uid/email に依存すると管理者が admin にならない');
  }
  // admin の正は admin_users テーブル (wellfort-site の admin 画面が出し入れする実体)
  const aa = readFileSync(resolve(ROOT, 'src/lib/admin-auth.ts'), 'utf8');
  if (!/admin_users\?email=eq\./.test(aa)) {
    fails.push('admin-auth.ts: admin_users を引いていない'
      + ' — 管理者が追加登録されても追随できない');
  }
  // 旧形式 (elith-v1.0 配列) の seed 行より現行サンプルを優先する分岐が、
  // **必ず demoFallbackEnabled の内側**にあること (= 実顧客には影響しない)。
  const eq = readFileSync(resolve(ROOT, 'src/lib/elith-report-queries.ts'), 'utf8');
  const legacyBranch = /Array\.isArray\(row\.report\)\s*&&\s*demoFallbackEnabled\(/.test(eq);
  if (!legacyBranch) {
    fails.push('elith-report-queries.ts: 旧形式 seed 行の回避が無い、または'
      + ' demoFallbackEnabled の外に出ている — 実顧客の実データを隠す危険');
  }

  // Cookie の自己修復 (旧形式のままだと判定の変更が最大 30 日届かない)
  const vw = readFileSync(resolve(ROOT, 'src/lib/viewer.ts'), 'utf8');
  const ot = readFileSync(resolve(ROOT, 'src/components/GoogleOneTap.astro'), 'utf8');
  if (!/cookieStale/.test(vw) || !/viewer-cookie-stale/.test(ot)) {
    fails.push('Cookie の自己修復が無い — 既存 Cookie は 30 日発行し直されないので'
      + '、判定を変えても既にサインイン済みの人には届かない');
  }
}

// ── 管理者メンバー登録の棚卸し ────────────────────────────────
// **uid が admin 判定の実体**なので、uid の無いメンバーは admin にならない。
// 黙って非 admin のまま放置されないよう、毎回名指しで出す (落としはしない —
// uid がまだ分からない期間は正当にあり得るため)。
console.log(`管理者メンバー ${ADMIN_MEMBERS.length} 名 (admin を足すのは ADMIN_MEMBERS だけ)\n`);
const noUid = ADMIN_MEMBERS.filter((m) => !m.uid);
for (const m of ADMIN_MEMBERS) {
  const mark = m.uid ? '✓' : (m.email ? '~' : '!');
  const note = m.uid ? ''
    : m.email ? '  ← uid 未登録 (サインインし直せば email 経由で admin になります)'
    : '  ← email も uid も無く **admin になれません**';
  console.log(`  ${mark} ${m.label.padEnd(18)} ${(m.email ?? '(email 不明)').padEnd(26)}${note}`);
}
if (noUid.length) {
  console.log(`\n  ⚠ uid 未登録 ${noUid.length} 名: ${noUid.map((m) => m.label).join(' / ')}`);
  console.log('    → email が登録されていれば **サインインし直せば admin として扱われます**');
  console.log('      (Cookie の admin フラグは resolve 時に email から決まるため)。');
  console.log('    uid を埋めておくと `?u=` 入場など Cookie 以外の経路でも admin になります。');
}
console.log(`\n  email 登録 ${ADMIN_EMAILS.length} 名 / uid 登録 ${ADMIN_UIDS.length} 名`);

console.log('\nダミーデータを出すか (◯=出す / ✗=出さない)\n');
for (const [label, uid, envFalse, want] of cases) {
  const got = expected(uid, envFalse);
  const ok = got === want;
  if (!ok) fails.push(`${label}: 期待 ${want} / 規則 ${got}`);
  console.log(`  ${ok ? '✓' : '✗'} ${label}  → ${got ? '◯' : '✗'}`);
}

if (fails.length) {
  console.log(`\n✗ ${fails.length} 件`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\n✓ admin だけがダミーを見る。一般顧客は env に関わらず自分の実データだけ。');
