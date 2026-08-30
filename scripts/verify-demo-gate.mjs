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

const DEMO_ALLOWED = pick(src, 'DEMO_ALLOWED_UIDS');

const fails = [];

/*
 * ── ベタ書きの管理者一覧が復活していないこと (2026-08-30) ──────────
 *
 * 以前は `admin-auth.ts` に `ADMIN_MEMBERS` という手書きの一覧があり、
 * **それが唯一動いている admin 判定**だった。`admin_users` を引く側は
 * **別プロジェクトの Supabase を叩いていて常に 404** だったため
 * (Scan-Chat-AI = nfubaio… / wellfort-site = nlydlve…)、
 * **管理者リストに登録しても診断アプリには一生届かない**うえ、
 * **リストから外しても admin のまま**という状態だった。
 * → 一覧は撤去。**戻ってきたらここで落とす。**
 */
for (const name of ['ADMIN_MEMBERS', 'ADMIN_EMAILS', 'ADMIN_UIDS', 'isAdminUid']) {
  if (adminSrc.includes(`const ${name}`) || adminSrc.includes(`function ${name}`)) {
    fails.push(`admin-auth.ts: ベタ書きの管理者判定 ${name} が復活している`
      + ' — admin の正は wellfort-site の管理者リスト (admin_users) だけ');
  }
}
// uid だけで admin になれる経路が残っていないこと
const viewerSrc = readFileSync(resolve(ROOT, 'src/lib/viewer.ts'), 'utf8');
if (/isAdminUid\s*\(/.test(viewerSrc)) {
  fails.push('viewer.ts: uid の一覧で admin を判定している — URL に uid を書くだけで admin になれる');
}

/** 期待する規則 (発注者指示 2026-08-30)。実装とは独立にここへ書く。 */
function expected(isAdmin, uid, envFalse) {
  if (isAdmin) return true;                    // ① admin は env に関わらず出る
  if (envFalse) return false;                  // ② env は admin 以外を一括で切る
  return !!uid && DEMO_ALLOWED.includes(uid);  // ③ デモ許可 uid
}

/** 実装のソースが ①→②→③ の順になっているか (順序が入れ替わると ① が死ぬ)。 */
const fn = src.slice(src.indexOf('export function demoFallbackEnabled'));
const body = fn.slice(0, fn.indexOf('\n}'));
const iAdmin = body.indexOf('viewerIsAdmin');
const iEnv = body.indexOf('PUBLIC_DEMO_FALLBACK');
const iAllowed = body.indexOf('DEMO_ALLOWED_UIDS');

if (iAdmin < 0 || iEnv < 0 || iAllowed < 0) fails.push('demoFallbackEnabled の 3 条件が読めない');
else if (!(iAdmin < iEnv && iEnv < iAllowed)) {
  fails.push('順序が ①admin → ②env → ③許可uid になっていない'
    + ' — env が先だと PUBLIC_DEMO_FALLBACK=false で **admin まで塞がれる**');
}

const SOMEONE = 'aaaaaaaa-1111-2222-3333-444444444444';
const OEM = DEMO_ALLOWED[0] ?? null;

// [ラベル, 閲覧者が admin か, 表示中の uid, env=false か, 期待]
const cases = [
  ['admin                / env 未設定', true,  SOMEONE, false, true],
  ['admin                / env=false ', true,  SOMEONE, true,  true],  // ← ここが要件
  ['一般顧客(非admin)     / env 未設定', false, SOMEONE, false, false],
  ['一般顧客(非admin)     / env=false ', false, SOMEONE, true,  false],
  ['未サインイン          / env 未設定', false, null,    false, false],
  ['未サインイン          / env=false ', false, null,    true,  false],
];
if (OEM) cases.push(
  ['OEMデモ顧客           / env 未設定', false, OEM, false, true],
  ['OEMデモ顧客           / env=false ', false, OEM, true,  false],
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
  /*
   * admin の正は **wellfort-site の管理者リスト**。
   * **自前の Supabase を直接引かないこと** — `admin_users` は別プロジェクトに在り、
   * 直引きすると 404 になって「常に非 admin」になる (2026-08-30 に実測)。
   */
  // **コメント行は見ない** — 経緯の説明に旧コードが書いてあるため。
  const aa = readFileSync(resolve(ROOT, 'src/lib/admin-auth.ts'), 'utf8')
    .split('\n').filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln)).join('\n');
  if (/PUBLIC_SUPABASE_URL[\s\S]{0,400}admin_users/.test(aa)) {
    fails.push('admin-auth.ts: 自前の Supabase から admin_users を直引きしている'
      + ' — 別プロジェクトなので必ず 404 になり、管理者が誰も admin にならない');
  }
  /*
   * **顧客の解決と admin 判定を同時に受け取る口**を使っていること。
   *
   * `resolveCustomerByEmail` (顧客だけ) では admin を判定できない。加えて、
   * 顧客が引けたかに admin を従属させると **顧客レコードの無い管理者が
   * 永久に admin にならない** (2026-08-30 に本番で実測)。管理者 ≠ EC の顧客。
   */
  if (!/resolveCustomerWithAdmin/.test(aa)) {
    fails.push('admin-auth.ts: HP Edge の resolveCustomerWithAdmin を使っていない'
      + ' — 顧客DB と管理者リストは Wellfort 側にしか無く、この経路が正。'
      + ' 顧客だけを引く resolveCustomerByEmail では admin を判定できない');
  }
  /*
   * Edge 応答の **top-level `is_admin`** を見ていること。
   * `data` の中だけを見ると、顧客が居ない管理者 (`data: null`) を取りこぼす。
   */
  const he = readFileSync(resolve(ROOT, 'src/lib/hp-edge.ts'), 'utf8')
    .split('\n').filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln)).join('\n');
  if (!/payload\.is_admin/.test(he)) {
    fails.push('hp-edge.ts: 応答の top-level is_admin を見ていない'
      + ' — 顧客レコードの無い管理者 (data: null) が admin になれない');
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

console.log('\nダミーデータを出すか (◯=出す / ✗=出さない)\n');
for (const [label, isAdmin, uid, envFalse, want] of cases) {
  const got = expected(isAdmin, uid, envFalse);
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
console.log('  admin の正 = wellfort-site の管理者リスト (admin_users)。このリポジトリに名簿は持たない。');
