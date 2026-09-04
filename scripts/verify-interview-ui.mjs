/**
 * AI問診 UI の回帰チェック (実ブラウザ + ソース検査)。
 *
 * 守りたい約束 (発注者指示 2026-09-04 / docs/interview/AI問診_仕様と設計原則.md §4):
 *   ① 音声 / テキスト切替トグルが存在しない (音声は常時オン)
 *   ② 「どちらでも OK」等の説明文が無い
 *   ③ 質問直下・選択肢の直前に常設ガイダンス「そのまま話して回答できます」がある
 *   ④ ガイダンスに**既存アイコンを使っていない** (自作 SVG のみ)
 *   ⑤ **復唱を依頼していない** — AI への依頼文にも system prompt にも復唱指示が無い
 *   ⑥ **UI を音声に結合していない** — 音声 chunk で次の質問を描画しない
 *      (schedulePendingQuestion / audioFirstChunkResolvers が存在しない)
 *   ⑦ プログラム側の音声ターン制御を足していない (SPEAKING 等の状態機械が無い)
 *
 * 前提: `npm run dev` が起動していること。
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.VERIFY_URL ?? 'http://localhost:4321';
const EXEC = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// ── ソース検査 (画面に出ない約束はここで見る) ──
const raw = readFileSync('src/scripts/chat/live-controller.ts', 'utf8');
/*
 * `_OBSOLETE_SYSTEM_INSTRUCTION` は**使われていない旧プロンプト**で、中に復唱指示が
 * 残っている。生きている挙動ではないので検査対象から外す (削除は今回のスコープ外)。
 * 生きているか死んでいるかは、参照されているかで判定する。
 */
const obsoleteAt = raw.indexOf('const _OBSOLETE_SYSTEM_INSTRUCTION');
const obsoleteEnd = obsoleteAt < 0 ? -1 : raw.indexOf('`;', obsoleteAt) + 2;
const ctrl = obsoleteAt < 0 ? raw : raw.slice(0, obsoleteAt) + raw.slice(obsoleteEnd);
/** コメントを外す。「〜しない」と書いた散文で誤検知しないため (過去 3 回踏んだ罠)。 */
const code = ctrl
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

/*
 * 「復唱」の語そのものを禁じると、**禁止文 (「復唱しない」) に誤反応**する。
 * 同じ罠を過去 3 回踏んでいるので、**否定形以外の出現**だけを落とす。
 */
const echoAsks = code
  .split('\n')
  .filter((l) => /復唱/.test(l) && !/復唱しない|復唱も|復唱は行わない/.test(l));
ok('⑤ 復唱を依頼している箇所が無い', echoAsks.length === 0, echoAsks[0]?.trim().slice(0, 70) ?? '');
ok('⑥ schedulePendingQuestion が無い', !/schedulePendingQuestion/.test(code), '');
ok('⑥ audioFirstChunkResolvers が無い', !/audioFirstChunkResolvers/.test(code), '');
ok('① modeToggle の参照が無い', !/modeToggle/.test(code), '');
ok(
  '⑦ 音声ターン制御の状態機械を足していない',
  !/(QUESTION_ACTIVE|SPEAKING|ANSWER_RECEIVED|CONFIRMING|NEXT_QUESTION)/.test(code),
  '',
);
ok(
  '⑤ system prompt が復唱しないと明記している',
  /ユーザーの回答を復唱しない/.test(ctrl),
  '',
);
/*
 * 旧プロンプトは宣言 + `void ...` (未使用警告の抑制) の 2 箇所に出る。
 * 大事なのは**モデルへ渡っていない**こと。渡す経路の行に出ていないかで見る。
 */
const obsoleteUsed = raw
  .split('\n')
  .filter((l) => /_OBSOLETE_SYSTEM_INSTRUCTION/.test(l))
  .filter((l) => !/^const _OBSOLETE_SYSTEM_INSTRUCTION/.test(l.trim()) && !/^void _OBSOLETE_SYSTEM_INSTRUCTION;/.test(l.trim()));
ok('⑤ 旧プロンプトはモデルへ渡っていない', obsoleteUsed.length === 0, obsoleteUsed[0]?.trim() ?? '');
// 依頼文が音声 / タップで分岐していないこと (silent 分岐の再犯防止)
const submitBody = code.slice(code.indexOf('const sectionChanged'), code.indexOf('function toAnswerValue'));
ok('⑤ 依頼文が silent で分岐していない', !/opts\.silent/.test(submitBody), '');

// ── 画面検査 ──
let browser;
try {
  browser = await chromium.launch({ executablePath: EXEC });
} catch {
  browser = await chromium.launch();
}
const page = await browser.newPage();
await page.goto(`${BASE}/chat`, { waitUntil: 'networkidle' });

const count = (sel) => page.locator(sel).count();
const html = await page.content();

ok('① 切替トグルが DOM に無い', (await count('#mode-toggle')) === 0, '');
ok('② 「どちらでも OK」が無い', !html.includes('どちらでも'), '');
ok('② 「タップでもOK」が無い', !html.includes('タップでもOK'), '');
ok('③ 常設ガイダンスがある', (await count('#voice-guide')) === 1, '');
ok('③ 文言が「そのまま話して回答できます」', html.includes('そのまま話して回答できます'), '');
ok('③ フッター文言が残っている', html.includes('AIは質問だけを読み上げます') || html.includes('AI は質問だけ'), '');

// ④ ガイダンス内に既存アイコン (Lucide の svg) を使っていないこと。
//    AppIcon が吐く svg は stroke ベース。自作波形は rect/circle のみ。
const guideHtml = await page.evaluate(() => document.getElementById('voice-guide')?.innerHTML ?? '');
ok('④ ガイダンスに lucide アイコンが無い', !/lucide/i.test(guideHtml), '');
ok('④ 波形は自作 (rect を使っている)', /<rect/.test(guideHtml), '');
ok('④ パルスリング / 発光ドットがある', /vg-ring/.test(guideHtml) && /vg-dot/.test(guideHtml), '');

// 並び順: 質問文 → ガイダンス → 選択肢
const order = await page.evaluate(() => {
  const pos = (id) => {
    const el = document.getElementById(id);
    if (!el) return -1;
    let n = 0, cur = el;
    while ((cur = cur.previousElementSibling || cur.parentElement)) n += 1;
    return document.body.innerHTML.indexOf(el.outerHTML.slice(0, 40));
  };
  return { q: pos('question-text'), g: pos('voice-guide'), l: pos('ui-list') };
});
ok('③ 質問文 → ガイダンス → 選択肢 の順', order.q < order.g && order.g < order.l, JSON.stringify(order));

await browser.close();
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
