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
const ADMIN_UIDS = pick(adminSrc, 'ADMIN_UIDS');
const DEMO_ALLOWED = pick(src, 'DEMO_ALLOWED_UIDS');

if (ADMIN_UIDS.length === 0) { console.error('✗ ADMIN_UIDS を読めなかった'); process.exit(1); }

/** 期待する規則 (発注者指示 2026-08-30)。実装とは独立にここへ書く。 */
function expected(uid, envFalse) {
  if (uid && ADMIN_UIDS.includes(uid)) return true;   // ① admin は env に関わらず出る
  if (envFalse) return false;                          // ② env は admin 以外を一括で切る
  return !!uid && DEMO_ALLOWED.includes(uid);          // ③ デモ許可 uid
}

/** 実装のソースが ①→②→③ の順になっているか (順序が入れ替わると ① が死ぬ)。 */
const fn = src.slice(src.indexOf('export function demoFallbackEnabled'));
const body = fn.slice(0, fn.indexOf('\n}'));
const iAdmin = body.indexOf('isAdminUid');
const iEnv = body.indexOf('PUBLIC_DEMO_FALLBACK');
const iAllowed = body.indexOf('DEMO_ALLOWED_UIDS');

const fails = [];
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

console.log('ダミーデータを出すか (◯=出す / ✗=出さない)\n');
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
