/**
 * `npm run verify:screen` — **画面の実測**。
 *
 * `verify:sheet-contract` は「モック ↔ 表示モデル」までしか見ない。
 * **表示モデルが正しくても、`.astro` が描き落とせば画面は空になる。**
 * ここで「表示モデル ↔ 実際の画面」を閉じ、併せて幅を測る。
 *
 * 見るのは 4 つだけ:
 *   ① 契約の文が**実際に画面に出ている**こと (レンダラの描き落としの検知)
 *   ② `/report` の器の幅が `/dashboard` と**全ブレークポイントで一致**すること
 *      — 幅は実際に 1 度壊れた (`/report` だけ `width="flow"` で 672px 止まり・spec §9.3.2)
 *   ③ ダイジェスト本文の行長が 38em (=608px) を超えないこと
 *   ④ **紙面 (白いシート) が地の上に在る**こと (仕様書 §4.3.5)
 *      — ここが**実際に抜けていた**。色や見出しや表の型は入っていたのに、
 *        それを載せる紙が無く「アプリの画面に要素が並んでいるだけ」で、
 *        ①②③ は全部通っていた (2026-08-30・発注者指摘「モックと全く違う」)。
 *        **だから "紙が在るか" だけは見る。** 色の細部・余白・影は見ない
 *        (デザインの微調整で落ちる検査は誰も直さなくなる)。
 *
 * 前提: `npm run dev` が起動していること。URL は `VERIFY_URL` で差し替えられる。
 */

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.VERIFY_URL ?? 'http://localhost:4321';
const EXEC = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
/** 本文の行長上限。`global.css` の `.report-prose { max-width: 38em }` × 16px。 */
const MAX_PROSE = 608;

const SIZES = [
  [1440, 900, 'PC 1440'],
  [1280, 800, 'PC 1280'],
  [834, 1112, 'iPad 縦 834'],
  [768, 1024, 'タブレット 768'],
  [393, 852, 'スマホ 393'],
];

const fails = [];

/** 契約のカードごとに、画面に出ているべき文をばらす (タブ区切りのセルも 1 つずつ)。 */
function contractCards() {
  const c = JSON.parse(readFileSync('docs/elith/mock/sheet_contract_type2.json', 'utf-8'));
  return c.cards.map((card) => {
    const texts = card.title ? [card.title] : [];
    for (const b of card.blocks) {
      for (const line of [...(b.items ?? []), ...(b.rows ?? [])]) {
        for (const cell of line.split('\t')) if (cell.trim()) texts.push(cell);
      }
    }
    return { key: card.key, texts };
  });
}

let browser;
try {
  browser = await chromium.launch({ executablePath: EXEC });
} catch {
  browser = await chromium.launch();
}

const shellWidth = async (page, path) => {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  return page.evaluate(() =>
    Math.round(document.querySelector('body > div').getBoundingClientRect().width));
};

// ── ① 契約の文が画面に出ているか (レンダラの描き落としの検知) ──────────
//
// 契約は**タイプ 2 (がんリスク検査なし)** の紙面。ローカル/デモ層はがんリスク検査を
// 持つのでタイプ 1 になり、そのとき主軸 A の「今回の所見」は **出ないのが正** —
// Elith が `cancer_screening` を書いていないタイプ 1 ではカードごと非表示にする
// (spec §4.0.1「記載が無いこと ≠ 所見が無いこと」)。
// → **紙面のタイプを画面から判定し、それに応じて出る/出ないの両方を検査する。**
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/report`, { waitUntil: 'domcontentloaded' });
  // 全編は `<details>` で畳まれているが DOM には在るので innerText でなく textContent。
  const raw = await page.evaluate(() => document.body.textContent ?? '');
  const body = raw.replace(/\s+/g, '');
  const isType1 = body.includes('がんリスク検査の結果を見る');
  console.log(`  紙面のタイプ: ${isType1 ? '1 (がんリスク検査あり)' : '2 (がんリスク検査なし)'}`);

  for (const card of contractCards()) {
    // タイプ 1 かつ Elith 未記載 → このカードは出ないのが正。**出ていたら異常。**
    const expected = !(isType1 && card.key === 'cancer_finding');
    const missing = card.texts.filter((t) => !body.includes(t.replace(/\s+/g, '')));
    const shown = missing.length < card.texts.length;
    if (expected && missing.length) {
      console.log(`✗ ${card.key} — 画面に出ていない文 ${missing.length}/${card.texts.length} 件`);
      for (const m of missing.slice(0, 5)) fails.push(`${card.key}: 画面に無い「${m.slice(0, 36)}」`);
    } else if (!expected && shown) {
      console.log(`✗ ${card.key} — タイプ 1 では出ないはずのカードが出ている`);
      fails.push(`${card.key}: タイプ 1 で表示されている (spec §4.0.1)`);
    } else {
      console.log(`✓ ${card.key}${expected ? '' : ' (タイプ 1 のため非表示・仕様どおり)'}`);
    }
  }
  await ctx.close();
}

// ── ④ 紙面が在るか ────────────────────────────────────────────
// 「白い紙が地の上に在る」ことだけを見る。**紙の幅は見ない** —
// 幅はダッシュボードに合わせる裁定 (2026-08-30) なので器の幅と一致するのが正。
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/report`, { waitUntil: 'networkidle' });
  const sheet = await page.evaluate(() => {
    const el = document.querySelector('main.rp-sheet');
    if (!el) return null;
    return {
      paper: getComputedStyle(el).backgroundColor,
      ground: getComputedStyle(document.body).backgroundColor,
      cover: !!document.querySelector('.rp-cover'),
      inner: !!document.querySelector('.rp-inner'),
    };
  });
  if (!sheet) {
    fails.push('紙面 (main.rp-sheet) が無い — 紙が無く要素が並んでいるだけになっている');
    console.log('✗ 紙面           main.rp-sheet が無い');
  } else {
    const ok = sheet.paper !== sheet.ground && sheet.cover && sheet.inner;
    console.log(`${ok ? '✓' : '✗'} 紙面           紙=${sheet.paper} 地=${sheet.ground} 表紙=${sheet.cover} 本文枠=${sheet.inner}`);
    if (sheet.paper === sheet.ground) fails.push('紙面と地が同色 — 紙が地に浮いて見えない');
    if (!sheet.cover) fails.push('表紙 (.rp-cover) が無い');
    if (!sheet.inner) fails.push('本文の左右マージン (.rp-inner) が無い');
  }
  await ctx.close();
}

// ── ②③ 幅と行長 ──────────────────────────────────────────────
for (const [width, height, label] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  const dash = await shellWidth(page, '/dashboard');
  const report = await shellWidth(page, '/report');
  const prose = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.report-prose')];
    return els.length ? Math.max(...els.map((e) => Math.round(e.getBoundingClientRect().width))) : null;
  });

  const ok = dash === report && (prose === null || prose <= MAX_PROSE);
  console.log(`${ok ? '✓' : '✗'} ${label.padEnd(14)} dashboard=${dash}px report=${report}px 本文=${prose ?? '-'}px`);
  if (dash !== report) {
    fails.push(`${label}: 器の幅が違う (dashboard ${dash}px / report ${report}px)`);
  }
  if (prose !== null && prose > MAX_PROSE) {
    fails.push(`${label}: 本文の行長が ${prose}px で上限 ${MAX_PROSE}px を超えた`);
  }
  await ctx.close();
}
await browser.close();

if (fails.length) {
  console.log(`\n✗ ${fails.length} 件`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\n✓ 紙面が在り、幅はダッシュボードと一致し、行長も上限内です。');
