/**
 * AI疾病予防報告書: 章レジストリとアダプタの回帰チェック。
 *
 * 正本: `docs/elith/ai_prevention_report_generation_spec.md` §1.3.7。
 * 実行: `npm run verify:report-model`
 *
 * 【何を守るか】
 *   ① **文言を書き換えていないこと** — 本文はアダプタを通しても Elith の原文と一致する
 *      (要約・言い換え・並べ替えをしない = ミッション④)。
 *   ② **黙って空にならないこと** — 抽出はフォーマット依存で fail-safe (拾えなければ出さない)
 *      なので、実測値を数で固定しておかないと形式変更に気づけない (spec §1.3.6)。
 *      Stage2 → Stage3 で `判定区分` と `[pN]` が消えた実績がある。
 *   ③ **設定の打ち間違いで報告書が真っ白にならないこと** (spec §9.2)。
 *
 * 【fixture】`src/data/elith/` の 2 点は 2026-08-26 受領分。**合成検体**で PII を含まない
 *   (氏名・生年月日・連絡先の記載なしを確認済み・spec §7.0)。
 *   実データ受領までのサンプル表示にも同じファイルを使う (`elith-report-sample.ts`) —
 *   **1 か所に置いて二重管理しない**。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildReportVM, extractFindings, extractTopPriority, parseCheckup, parseReportText,
} from '../src/lib/report-adapter';
import { CHAPTER_REGISTRY, anchorFor, resolveChapters } from '../src/lib/report-sections';
import { ELITH_REPORT_SAMPLE } from '../src/lib/elith-report-sample';

// バンドルして `node --input-type=module` で走らせるため import.meta.url は使えない
// (eval のパスになる)。npm run はパッケージルートを cwd にするのでそれを基点にする。
const ROOT = process.cwd();
const load = (f: string): unknown => JSON.parse(readFileSync(join(ROOT, 'src/data/elith', f), 'utf8'));

let failed = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) { console.log(`  ok  ${name}`); return; }
  console.log(`  NG  ${name}\n        got  ${a}\n        want ${b}`);
  failed++;
}

// ── 章レジストリ ────────────────────────────────────────────────
console.log('\n[章レジストリ]');
const cfgOf = (o: Record<string, string>) => (k: string): string => o[k] ?? '';

eq('既定 = コード既定の全章', resolveChapters(cfgOf({})).chapters.length, CHAPTER_REGISTRY.length);
eq('先頭は A 軸 (がん早期発見)',
  [CHAPTER_REGISTRY[0].key, CHAPTER_REGISTRY[0].axis], ['cancer_finding', 'A']);
eq('B の先頭は medical_visit', CHAPTER_REGISTRY[1].key, 'medical_visit');
eq('キー重複なし', new Set(CHAPTER_REGISTRY.map((c) => c.key)).size, CHAPTER_REGISTRY.length);
eq('order は書いた章を書いた順で',
  resolveChapters(cfgOf({ 'report.sections.order': 'summary, medical_visit' })).chapters.map((c) => c.key),
  ['summary', 'medical_visit']);
eq('hidden は order の後に効く',
  resolveChapters(cfgOf({ 'report.sections.order': 'summary,medical_visit', 'report.sections.hidden': 'summary' }))
    .chapters.map((c) => c.key),
  ['medical_visit']);
eq('labels で見出しを差し替えられる',
  resolveChapters(cfgOf({ 'report.sections.labels': 'summary=まとめ' }))
    .chapters.find((c) => c.key === 'summary')?.title,
  'まとめ');
eq('collapsed を指定できる',
  resolveChapters(cfgOf({ 'report.sections.collapsed': 'diet,sleep' }))
    .chapters.filter((c) => c.collapsed).map((c) => c.key),
  ['diet', 'sleep']);
// 打ち間違いで真っ白にしない (spec §9.2)
eq('区切りだけの指定は既定へ戻る',
  resolveChapters(cfgOf({ 'report.sections.order': ' , , ' })).chapters.length, CHAPTER_REGISTRY.length);
eq('未知キーだけの指定も既定へ戻る',
  resolveChapters(cfgOf({ 'report.sections.order': 'typo_a,typo_b' })).chapters.length, CHAPTER_REGISTRY.length);
eq('未知キーは監査へ出る',
  resolveChapters(cfgOf({ 'report.sections.order': 'summary,typo_a' })).unknown, ['typo_a']);
eq('全章 hidden は 0 件を許す',
  resolveChapters(cfgOf({ 'report.sections.hidden': CHAPTER_REGISTRY.map((c) => c.key).join(',') })).chapters.length, 0);
eq('アンカーは決定論', anchorFor('diet', '1. 食事改善の目的'), anchorFor('diet', '1. 食事改善の目的'));
eq('アンカーは見出しごとに別', anchorFor('diet', 'A') !== anchorFor('diet', 'B'), true);

// ── 新形式 (2026-08-26 受領分) ──────────────────────────────────
console.log('\n[新形式アダプタ — 2026-08-26 受領分]');
const reportText = load('report_text_20260826.json');
const checkup = load('health_checkup_20260826.json');
const { byKey, healthAge } = parseReportText(reportText);

eq('セクション 10 件', byKey.size, 10);
eq('ウェルネス年齢 (Elith 出力の値)', healthAge, 46.6);
eq('検査値 40 項目', parseCheckup(checkup).length, 40);

const findings = extractFindings(byKey);
eq('所見 5 ブロック', findings.length, 5);
eq('所見は Elith が書いた順のまま',
  findings.map((f) => f.category),
  ['赤血球・ヘモグロビン・ヘマトクリット', '尿素窒素', 'ALT(GPT)', '総コレステロール', 'eGFR・クレアチニン']);
// 判定は Elith の原文そのまま。誤字「上上回っており」も直さない (spec §7.3)。
eq('判定文は原文のまま (誤字も含む)', findings[2].judgement, '基準範囲を上上回っており');
eq('値と基準値が 8 件読める', findings.reduce((n, f) => n + f.items.length, 0), 8);
eq('単一項目ブロックの名前は見出しから', findings[1].items[0].name, '尿素窒素');

const top = extractTopPriority(byKey);
eq('最優先の所見を拾える', top?.heading, '1. 最優先の所見とその理由');

const vm = buildReportVM({
  reportText, checkup, type: 'single', issuedOn: '2026-08-26',
  name: 'テスト 太郎', actualAge: 55, ownWellnessAge: 46.6,
  chapters: CHAPTER_REGISTRY.slice(),
});

eq('材料の無い A の章は出さない', vm.audit.skippedChapters, ['cancer_finding']);
eq('出る章', vm.chapters.map((c) => c.key), [
  'medical_visit', 'measurements', 'summary', 'diet', 'exercise',
  'sleep', 'lifestyle', 'diet_plan', 'nutrients', 'references',
]);
eq('タイプ 2 は検査サイクルを出さない', vm.cover.cycle, null);
eq('トピック 37 件', vm.audit.topicCount, 37);
eq('生活習慣は 6 ペア', vm.chapters.find((c) => c.key === 'lifestyle')?.pairs.length, 6);
eq('基準値が付いたのは 7 件', vm.audit.referenceCount, 7);
// 受領データの既知の状態 (spec §7.1 / §7.2)。**自動採用も補完もしない**。
eq('同名別値 9 組を監査に出す',
  vm.audit.anomalies.filter((a) => a.startsWith('同名別値')).length, 9);
eq('本文が参照するヘマトクリットが検査値に無いことを検知',
  vm.audit.anomalies.some((a) => a.includes('ヘマトクリット')), true);

// ① 文言を書き換えていない
const summaryRaw = byKey.get('summary')!.text;
eq('本文は原文と 1 文字も違わない', vm.chapters.find((c) => c.key === 'summary')?.body, summaryRaw);
const dietRaw = byKey.get('diet')!.text;
const diet = vm.chapters.find((c) => c.key === 'diet')!;
const plan = vm.chapters.find((c) => c.key === 'diet_plan')!;
eq('食事プランを別章に出したので本文からは消える', /か\s*月.*プラン/.test(diet.body), false);
eq('食事プランの本文は原文に含まれる', dietRaw.includes(plan.body), true);

// ── DB 往復 (jsonb) ─────────────────────────────────────────────
// `report` は jsonb で保存する (§8.2)。**jsonb はキー順を保持しない**ので、
// 並びに依存した読み方をしていないことを確認する。
console.log('\n[jsonb のキー順に依存しない]');
const shuffled = Object.fromEntries(
  Object.entries(reportText as Record<string, unknown>).reverse(),
);
const vmShuffled = buildReportVM({
  reportText: shuffled, checkup, type: 'single', issuedOn: '2026-08-26',
  chapters: CHAPTER_REGISTRY.slice(),
});
const shape = (v: typeof vm) => v.chapters.map((c) => [c.key, c.title, c.body.length, c.topics.length]);
eq('キー順を入れ替えても章の並びと中身が同じ', shape(vmShuffled), shape(vm));
eq('キー順を入れ替えても監査値が同じ',
  [vmShuffled.audit.topicCount, vmShuffled.audit.measurementCount, vmShuffled.audit.referenceCount],
  [vm.audit.topicCount, vm.audit.measurementCount, vm.audit.referenceCount]);

// ── 旧形式 (Stage2 サンプル) ─────────────────────────────────────
// 実データ受領までサンプルが表示される。検出ルールを変えたときに
// **こちらが無言で空になっていない**ことを見る (実際に一度 0 件にした)。
console.log('\n[旧形式 — Stage2 サンプル]');
const legacy = parseReportText(ELITH_REPORT_SAMPLE);
eq('セクション 10 件', legacy.byKey.size, 10);
const legacyFindings = extractFindings(legacy.byKey);
eq('所見が空にならない', legacyFindings.length, 3);
eq('旧形式の判定区分も読める', legacyFindings[0].judgement, '注意・経過観察');
eq('最優先も読める', extractTopPriority(legacy.byKey) != null, true);

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
