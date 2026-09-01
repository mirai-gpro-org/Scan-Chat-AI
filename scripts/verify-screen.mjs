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
/*
 * 契約は**タイプ 2 の検体**の紙面なので、**タイプ 2 の紙面 (`/report?preview=2`) と突き合わせる。**
 * 既定の `/report` は 2026-09-01 から**タイプ 1** になった (発注者指示) ため、
 * 既定の画面に型 2 の契約を当てると全項目が不一致になる。契約は検体ごとのものなので、
 * **契約と同じ検体を出す URL に当てる**のが筋。
 *
 * 【2026-08-30 修正・重要】ここには以前、
 *   「ローカル/デモ層はがんリスク検査を持つのでタイプ 1 になり、主軸 A は出ないのが正」
 * と書いてあり、**A 軸のカードが出ないことを合格条件にしていた**。
 * ところがそれは仕様ではなく**不具合**だった —
 * デモが貸した真鍋の `cancer_urine` artifact を拾って `hasCancerRisk: true` になり、
 * タイプ 1 (未実装) に反転して A 軸が消えていた (実測: 本番 admin で `vm_digest` 6 枚が全て B)。
 * **検証が不具合を「正」として取り込んでいたため、全部緑なのに紙面が違う**状態が続いた。
 * → デモ表示は `report.astro` でタイプ 2 に固定した。ここでは**それを機械で見張る**。
 */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/report?preview=2`, { waitUntil: 'domcontentloaded' });
  // 全編は `<details>` で畳まれているが DOM には在るので innerText でなく textContent。
  const raw = await page.evaluate(() => document.body.textContent ?? '');
  const body = raw.replace(/\s+/g, '');
  const isType1 = body.includes('がんリスク検査の結果を見る');
  if (isType1) {
    console.log('✗ ?preview=2 がタイプ 1 になっている — 切替が効いていない');
    fails.push('?preview=2 でタイプ 2 の紙面が出ていない');
  } else {
    console.log('✓ ?preview=2 の紙面のタイプ: 2 (がんリスク検査なし)');
  }

  /*
   * **既定の `/report` はタイプ 1** (発注者指示 2026-09-01)。
   * 既定が入れ替わったことを名指しで見張る — 以前ここは「タイプ 2 が正」だった。
   */
  await page.goto(`${BASE}/report?preview=1`, { waitUntil: 'domcontentloaded' });
  /*
   * **A 軸の中だけを見る。** `document.body` 全体を見ると全編 (abstract/総評) にも
   * 同じ文が在るので、**A 軸が空でも緑になる** — 実際に一度この誤りを書いた
   * (壊して確かめたら通ってしまい発覚)。検証は必ず壊して落ちることを確認する。
   */
  const t1A = await page.evaluate(() => {
    const band = [...document.querySelectorAll('.rp-axis')]
      .find((b) => (b.textContent ?? '').includes('初期がんの早期発見'));
    const section = band?.parentElement;
    const cards = section ? [...section.querySelectorAll('.rp-card')] : [];
    return { cards: cards.length, text: cards.map((c) => c.textContent ?? '').join('') };
  });
  const t1Ok = t1A.cards > 0 && t1A.text.includes('尿中のポルフィリン量');
  console.log(`${t1Ok ? '✓' : '✗'} ?preview=1 の主軸 A に受領本文の逐語が出ている (カード ${t1A.cards} 枚)`);
  if (!t1Ok) fails.push('?preview=1 の主軸 A が空 (がんリスク検査の項目名で選べていない)');
  await page.goto(`${BASE}/report?preview=2`, { waitUntil: 'domcontentloaded' });

  // **A 軸のカードが在ること。** ここが実際に落ちていた箇所なので名指しで見る。
  const axisA = await page.evaluate(() => {
    const bands = [...document.querySelectorAll('.rp-axis')];
    const a = bands.find((b) => (b.textContent ?? '').includes('初期がんの早期発見'));
    if (!a) return { band: false, cards: 0 };
    // 軸の <section> = 帯の親。その中の .rp-card がその軸のダイジェスト。
    const section = a.parentElement;
    return { band: true, cards: section ? section.querySelectorAll('.rp-card').length : 0 };
  });
  if (!axisA.band) {
    console.log('✗ 主軸 A の帯が無い');
    fails.push('主軸 A (初期がんの早期発見) の帯が画面に無い');
  } else if (axisA.cards === 0) {
    console.log('✗ 主軸 A の帯は在るがカードが 0 枚 — 発注者に「画面が空」と見える状態');
    fails.push('主軸 A のカードが 0 枚 (タイプ反転か材料欠落)');
  } else {
    console.log(`✓ 主軸 A のカード ${axisA.cards} 枚`);
  }

  for (const card of contractCards()) {
    const missing = card.texts.filter((t) => !body.includes(t.replace(/\s+/g, '')));
    if (missing.length) {
      console.log(`✗ ${card.key} — 画面に出ていない文 ${missing.length}/${card.texts.length} 件`);
      for (const m of missing.slice(0, 5)) fails.push(`${card.key}: 画面に無い「${m.slice(0, 36)}」`);
    } else {
      console.log(`✓ ${card.key}`);
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
