/**
 * `npm run verify:sheet-contract`
 *
 * **モックの再現性チェック。** `docs/elith/mock/*.html` から紙面契約を抽出し、
 * 同じ受領 JSON を実装 (`buildReportVM`) に通した結果と突き合わせる。
 * 食い違えば**紙面の言葉で**差分を出して落とす。
 *
 * 正本: docs/elith/ai_prevention_report_generation_spec.md §1.3.10
 *
 * 【使い方 (紙面を変えるとき)】
 *   1. モック HTML を直す (発注者に見せる版は Artifact へ再公開)
 *   2. `npm run verify:sheet-contract -- --write` で契約 JSON を再生成しコミット
 *      → **PR の差分に「紙面がどう変わるか」が出る**
 *   3. 実装を直して `npm run verify:sheet-contract` が通るまで持っていく
 *   **契約 JSON を手で書き換えて通すのは禁止。** 必ずモックから再生成する。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import REPORT_TEXT from '../src/data/elith/report_text_20260826.json';
import HEALTH_CHECKUP from '../src/data/elith/health_checkup_20260826.json';
import { buildReportVM } from '../src/lib/report-adapter';
import { contractFromMockHtml, contractFromVM, diffContract } from './sheet-contract';

const WRITE = process.argv.includes('--write');
// **バンドル後の場所に依存しない**。esbuild の出力は node_modules/.cache に置くので、
// `import.meta.dirname` からの相対で辿るとリポジトリの外を指す (実測)。
// npm scripts は必ずリポジトリのルートで走るので `process.cwd()` が正しい起点。
const root = process.cwd();

const MOCK = resolve(root, 'docs/elith/mock/ai_prevention_report_type2.html');
const SNAPSHOT = resolve(root, 'docs/elith/mock/sheet_contract_type2.json');

const mock = contractFromMockHtml(readFileSync(MOCK, 'utf-8'));

if (WRITE) {
  writeFileSync(SNAPSHOT, `${JSON.stringify(mock, null, 2)}\n`, 'utf-8');
  console.log(`契約 JSON を再生成: ${SNAPSHOT}`);
}

// 契約 JSON は「モックから抽出したもの」であり、レビューで紙面の変化を読むためにコミットする。
// ここでズレたら **モックを直したのに再生成していない**。
const snapshot = readFileSync(SNAPSHOT, 'utf-8');
const fresh = `${JSON.stringify(mock, null, 2)}\n`;
const stale = snapshot !== fresh;

const vm = buildReportVM({
  reportText: REPORT_TEXT,
  checkup: HEALTH_CHECKUP as unknown as Record<string, { date?: string; value?: unknown }[]>,
  name: '相川 佳之 様',
  issuedOn: '2026-08-28',
  isSample: true,
  hasCancerRisk: false,
  cycleSeq: null,
  chronologicalAge: 56,
  readConfig: () => '',
});

const impl = contractFromVM(vm);
const diffs = diffContract(mock, impl);

console.log(`モック ${mock.cards.length} カード / 実装 ${impl.cards.length} カード`);

if (stale) {
  console.log('\n✗ 契約 JSON がモックと食い違っています。`npm run verify:sheet-contract -- --write` で再生成してコミットしてください。');
}

if (diffs.length) {
  console.log(`\n✗ モックと実装の差分 ${diffs.length} 件:\n`);
  for (const d of diffs) {
    console.log(`  ● ${d.where}`);
    console.log(`      モック: ${d.mock}`);
    console.log(`      実装  : ${d.impl}`);
  }
  console.log('\n差分は「モックが正」か「モックが古い」かのどちらかです。');
  console.log('どちらであれ **両方を突き合わせて直す** こと。片方だけ直して通すのは契約の放棄です。');
}

if (diffs.length || stale) process.exit(1);
console.log('\n✓ モックの紙面を実装が再現しています。');
