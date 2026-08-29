/**
 * AI疾病予防報告書 — 表示モデルの回帰チェック。
 *
 * 正本: docs/elith/ai_prevention_report_generation_spec.md §1.3.7
 *
 * 【担保したいこと】**文言を書き換えていないこと。**
 *   可読化は「選択」で行い「圧縮」で行わない (spec §1.0.0) ので、紙面に出る文はすべて
 *   受領 JSON の**部分文字列**でなければならない。要約・言い換え・語順の入れ替えが
 *   混ざれば、この検査が落ちる。章の並べ替えや設定変更で本文が変質しないことも見る。
 *
 * 実行: npm run verify:report-model
 */

import REPORT_TEXT from '../src/data/elith/report_text_20260826.json';
import HEALTH_CHECKUP from '../src/data/elith/health_checkup_20260826.json';
import { buildReportVM, PILOT_CANCER_FINDING_TEXT, leadSentences } from '../src/lib/report-adapter';
import { anchorFor, resolveChapters } from '../src/lib/report-sections';
import type { ReportVM } from '../src/lib/report-model';

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; return; }
  fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const checkup = HEALTH_CHECKUP as unknown as Record<string, { date?: string; value?: unknown }[]>;

function build(readConfig: (k: string) => string = () => ''): ReportVM {
  return buildReportVM({
    reportText: REPORT_TEXT,
    checkup,
    name: '相川 佳之 様',
    issuedOn: '2026-08-26',
    isSample: true,
    hasCancerRisk: false,
    cycleSeq: null,
    chronologicalAge: 56,
    readConfig,
  });
}

const vm = build();

// ── 受領本文を 1 本の文字列にして、部分文字列判定の母体にする ──────────────
let corpus = '';
const walk = (v: unknown): void => {
  if (typeof v === 'string') corpus += `\n${v}`;
  else if (Array.isArray(v)) v.forEach(walk);
  else if (v && typeof v === 'object') Object.values(v).forEach(walk);
};
walk(REPORT_TEXT);
const norm = (s: string) => s.replace(/\s+/g, '');
const CORPUS = norm(corpus);

/** 紙面に出る文が受領本文の逐語かを見る。 */
function verbatim(label: string, text: string): void {
  if (!text) return;
  check(`逐語: ${label}`, CORPUS.includes(norm(text)), `"${text.slice(0, 40)}…"`);
}

// ── 1) ダイジェストの全文が逐語であること ────────────────────────────
for (const card of vm.digest) {
  for (const b of card.blocks) {
    if (b.kind === 'paragraphs') {
      for (const t of b.items) {
        // 主軸 A のパイロット暫定文だけは受領データに無い (発注者指示の唯一の例外)。
        if (PILOT_CANCER_FINDING_TEXT.includes(t)) continue;
        verbatim(`${card.key}/paragraph`, t);
      }
    }
    if (b.kind === 'steps' || b.kind === 'weeks') {
      for (const i of b.items) verbatim(`${card.key}/${i.heading}`, i.text);
    }
    if (b.kind === 'pairs') {
      for (const p of b.items) {
        verbatim(`${card.key}/${p.heading}/現状`, p.current);
        verbatim(`${card.key}/${p.heading}/提案`, p.action);
      }
    }
    if (b.kind === 'table') {
      // 判定は Elith の原文の部分文字列でなければならない (当社が判定を作らない)。
      for (const r of b.rows) verbatim(`${card.key}/${r.name}/判定`, r.judgement);
    }
  }
}

// ── 2) 可読化: 最初に読む面が受領本文より十分に短いこと ─────────────────
let digestChars = 0;
for (const c of vm.digest) for (const b of c.blocks) {
  if (b.kind === 'paragraphs') b.items.forEach((t) => { digestChars += norm(t).length; });
  if (b.kind === 'steps' || b.kind === 'weeks') b.items.forEach((i) => { digestChars += norm(i.text).length; });
  if (b.kind === 'pairs') b.items.forEach((p) => { digestChars += norm(p.current).length + norm(p.action).length; });
  if (b.kind === 'table') b.rows.forEach((r) => { digestChars += norm(r.name + r.value + r.reference + r.judgement).length; });
}
const reduction = 100 - (digestChars / CORPUS.length) * 100;
// 前回の実装は削減率 1% でリバートされた (spec §9.2)。**80% を下回ったら可読化していない。**
check('可読化: ダイジェストの削減率 ≥ 80%', reduction >= 80, `${reduction.toFixed(1)}%`);
check('全編を捨てていない', vm.chapters.length >= 9, `${vm.chapters.length} 章`);
// 全編を開いたまま置くとダイジェストと同じ内容が二重に流れ、旧実装と同じ画面になる。
check('全編は既定で畳む', vm.chapters.every((c) => c.collapsed),
  vm.chapters.filter((c) => !c.collapsed).map((c) => c.key).join(','));

// ── 3) 実測値の固定 (spec の記載と一致すること) ─────────────────────────
check('セクション 10 件', vm.audit.sections.length === 10, String(vm.audit.sections.length));
check('トピック 39 件 (spec §5.4)', vm.audit.topicCount === 39, String(vm.audit.topicCount));
check('基準値は 8 件のみ (spec §6 ④)', vm.audit.referenceCount === 8, String(vm.audit.referenceCount));
check('ウェルネス年齢 46.6', vm.cover.wellnessAge === 46.6, String(vm.cover.wellnessAge));
check('タイプ 2 と判定', vm.reportType === 2, String(vm.reportType));

// ── 4) 2 本柱は常設 ────────────────────────────────────────────────
check('主軸は常に 2 本', vm.axes.length === 2);
check('主軸 A が先頭', vm.axes[0]?.key === 'a');
// 帯にリードを持たせない (ポリシーの説明文を紙面に載せない・spec §4.-1)。
check('軸は見出しだけを持つ',
  vm.axes.every((a) => Object.keys(a).length === 2 && !!a.title));

// ── 5) 捏造ゼロの境界 ──────────────────────────────────────────────
const allRows = vm.chapters.find((c) => c.key === 'measurements')?.table ?? [];
check('基準値が無い項目は空のまま (外部マスタで補完しない)',
  allRows.filter((r) => !r.reference).length > 0);
check('Elith が判定を書いていない行は判定が空',
  allRows.every((r) => r.judgement === '' || CORPUS.includes(norm(r.judgement))));
// 同名別値は自動採用しない (spec §7.1)。
check('同名別値を競合として残す', allRows.some((r) => r.variants > 1));
// 誤字は直さない (spec §7.3)。
check('誤字「上上回っており」を直さず出す',
  allRows.some((r) => r.judgement.includes('上上回っており')));
// 2 ファイルは包含関係でない (spec §7.2)。
check('本文にしかない値も表に載る',
  allRows.some((r) => r.source === 'report_text'));

// ── 6) 章立ての設定 ────────────────────────────────────────────────
const cfgOf = (m: Record<string, string>) => (k: string) => m[k] ?? '';

const ordered = build(cfgOf({ 'report.sections.order': 'measurements,medical_visit' }));
check('order: 書いた章だけを書いた順で出す',
  ordered.chapters.map((c) => c.key).join(',') === 'measurements,medical_visit',
  ordered.chapters.map((c) => c.key).join(','));

const hidden = build(cfgOf({ 'report.sections.hidden': 'references,nutrients' }));
check('hidden: 指定した章が消える',
  !hidden.chapters.some((c) => ['references', 'nutrients'].includes(c.key)));

const labeled = build(cfgOf({ 'report.sections.labels': 'medical_visit=今回いちばん大事なこと' }));
check('labels: 見出しを差し替えられる',
  labeled.chapters.find((c) => c.key === 'medical_visit')?.title === '今回いちばん大事なこと');

// **打ち間違いで報告書を真っ白にしない** (spec §1.3.2)。
const garbage = build(cfgOf({ 'report.sections.order': ' , , ' }));
check('order が空白だけならコード既定へ落ちる', garbage.chapters.length >= 9,
  String(garbage.chapters.length));
const unknownOnly = build(cfgOf({ 'report.sections.order': 'nope,typo' }));
check('order が未知キーだけでもコード既定へ落ちる', unknownOnly.chapters.length >= 9,
  String(unknownOnly.chapters.length));
check('未知キーは監査に出る', unknownOnly.audit.unknownChapterKeys.join(',') === 'nope,typo',
  unknownOnly.audit.unknownChapterKeys.join(','));

const { chapters: allHidden } = resolveChapters(cfgOf({
  'report.sections.hidden': 'cancer_finding,medical_visit,measurements,summary,abstract,lifestyle,diet_plan,diet,exercise,sleep,nutrients,references',
}));
check('全章を明示 hidden にしたときだけ 0 件を許す', allHidden.length === 0, String(allHidden.length));

// ── 7) アンカーは並べ替えで壊れない (spec §5.4) ────────────────────────
const a1 = anchorFor('diet', '食材の選び方');
const a2 = anchorFor('diet', '食材の選び方');
const a3 = anchorFor('sleep', '食材の選び方');
check('アンカーは決定論', a1 === a2);
check('アンカーは章キーを含むので章間で衝突しない', a1 !== a3);
const anchors = vm.chapters.flatMap((c) => c.topics.map((t) => t.anchor));
check('アンカーが重複しない', new Set(anchors).size === anchors.length,
  `${anchors.length} 件中 ${new Set(anchors).size} 件がユニーク`);

// ── 8) 文の切り出しは文字を足さない ───────────────────────────────────
check('leadSentences は 1 文を「。」付きで返す',
  leadSentences('あいう。えお。かき。', 1) === 'あいう。');
check('leadSentences は n 文を連結する',
  leadSentences('あいう。えお。かき。', 2) === 'あいう。えお。');
check('leadSentences は「。」が無ければ原文のまま',
  leadSentences('あいう', 1) === 'あいう');
check('leadSentences は空文字で空を返す', leadSentences('', 1) === '');

// ── 9) タイプ 1 で Elith の記述が無ければカードごと非表示 (spec §4.0.1) ──
const type1 = buildReportVM({
  reportText: REPORT_TEXT, checkup, name: '', issuedOn: '2026-08-26', isSample: true,
  hasCancerRisk: true, cycleSeq: 1, chronologicalAge: 56, readConfig: () => '',
});
check('タイプ 1 と判定', type1.reportType === 1);
check('タイプ 1 で記述が無ければ A のカードを出さない',
  !type1.digest.some((c) => c.key === 'cancer_finding'));
check('タイプ 1 でも主軸の帯は立つ', type1.axes.length === 2);
check('カードを出さなかったことは監査に出る',
  type1.audit.emptyCards.includes('cancer_finding'));

// ── 10) Elith が書けば、そちらが優先される ────────────────────────────
const withElith = buildReportVM({
  reportText: { ...(REPORT_TEXT as object), cancer_screening: { status: 'no_notable_finding', text: 'Elith が書いた所見です。' } },
  checkup, name: '', issuedOn: '2026-08-26', isSample: true,
  hasCancerRisk: true, cycleSeq: 1, chronologicalAge: 56, readConfig: () => '',
});
const cancerCard = withElith.digest.find((c) => c.key === 'cancer_finding');
check('Elith の記述があればそれを出す',
  cancerCard?.blocks[0]?.kind === 'paragraphs'
  && (cancerCard.blocks[0] as { items: string[] }).items[0] === 'Elith が書いた所見です。');

// ── 11) 新旧どちらの形式も読む (spec §5.1) ────────────────────────────
const legacy = buildReportVM({
  reportText: [{ section_name: '医療受診の目安', char_count: 10, text: '### 1. 見出し\nこれは本文です。' }],
  checkup: null, name: '', issuedOn: '2026-08-26', isSample: true,
  hasCancerRisk: false, cycleSeq: null, chronologicalAge: null, readConfig: () => '',
});
check('旧形式 (配列) も読める', legacy.chapters.some((c) => c.key === 'medical_visit'));

// ── 結果 ──────────────────────────────────────────────────────────
console.log(`\n受領本文 ${CORPUS.length} 字 / ダイジェスト ${digestChars} 字 (削減率 ${reduction.toFixed(1)}%)`);
console.log(`検査値 ${vm.audit.measurementCount} 行・基準値 ${vm.audit.referenceCount} 件・トピック ${vm.audit.topicCount} 件`);
if (vm.audit.anomalies.length) {
  console.log(`\n受領データの異常 ${vm.audit.anomalies.length} 件 (紙面には出さない):`);
  for (const a of vm.audit.anomalies) console.log(`  - ${a}`);
}
console.log(`\n${fails.length ? '✗' : '✓'} ${pass} / ${pass + fails.length} 件`);
for (const f of fails) console.log(`  ✗ ${f}`);
if (fails.length) process.exit(1);
