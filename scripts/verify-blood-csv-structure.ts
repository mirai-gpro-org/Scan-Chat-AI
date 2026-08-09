/**
 * ④ 血液 CSV ↔ JSON 構造照合 fixture（決定論・鍵不要・ローカル実行可）
 *
 * 目的（CLAUDE.md 照合定義 / 血液=CSV↔JSON構造照合）:
 *   デメカル様式CSV → `BloodTestData` JSON の決定論パース（`src/lib/elith-blood-csv.ts`）が
 *   「**漏れゼロ（全項目写像）／捏造ゼロ（余剰なし・値改変なし）／単位・判定コード対応／PII非混入**」
 *   を満たすことを、既知期待値の合成CSV（`scripts/blood-csv-fixtures/demecal_sample_v1.csv`・
 *   docs の新様式に忠実）で固定検証する。
 *
 * 実行: `npm run verify:blood-csv`（esbuild でバンドルして node 実行。追加依存なし）。
 * 注: 合成CSVは docs 記載の様式に基づく検証用ダミーで実患者データではない（捏造でなくテスト固定資産）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBloodCsvBundles } from '../src/lib/elith-blood-csv';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${mark}] ${name}${cond ? '' : `  → ${detail ?? ''}`}`);
}

const csvPath = join(process.cwd(), 'scripts/blood-csv-fixtures/demecal_sample_v1.csv');
const text = readFileSync(csvPath, 'utf-8');

const res = buildBloodCsvBundles({
  text,
  sourceFileName: 'demecal_sample_v1.csv',
  makeClientId: (i) => `test-fixture-${i + 1}`,
  exportedAt: new Date('2026-08-06T00:00:00Z'),
});

console.log('=== ④ 血液 CSV↔JSON 構造照合 (demecal_sample_v1) ===');

check('1行(被験者1名)がパースされる', res.rows.length === 1, `rows=${res.rows.length}`);
check('ヘッダ検出: 採血日/性別/生年月日/結果項目数', res.headerFound.drawnDate && res.headerFound.sex && res.headerFound.birth && res.headerFound.itemCount, JSON.stringify(res.headerFound));

const row = res.rows[0];
const json = row?.json;
const ms = json?.data.measurements ?? [];
const byName = (n: string) => ms.find((m) => m.name === n);

// ── 漏れゼロ & 捏造ゼロ: 区分1(4) + 区分2(2) = ちょうど 6 項目。区分3(3)は非納品。 ──
const EXPECTED = ['総タンパク', 'HbA1c(NGSP)', 'LDLコレステロール', 'AST(GOT)', 'たばこを吸いますか', 'お酒を飲みますか'];
check('漏れゼロ: 区分1+2 の全項目が measurements に存在', EXPECTED.every((n) => !!byName(n)), `missing=${EXPECTED.filter((n) => !byName(n)).join(',')}`);
check('捏造ゼロ: measurements 件数がちょうど 6 (余剰なし)', ms.length === 6, `count=${ms.length}: ${ms.map((m) => m.name).join('|')}`);
check('捏造ゼロ: 期待集合以外の項目が無い', ms.every((m) => EXPECTED.includes(m.name ?? '')), `extra=${ms.map((m) => m.name).filter((n) => !EXPECTED.includes(n ?? '')).join(',')}`);

// ── 区分3 (判定/総合コード) は単独項目として出さない ──
check('区分3 非納品: 「判)」「総)」「メタボ」を含む項目が無い', !ms.some((m) => /判[)）]|総[)）]|メタボ/.test(m.name ?? '')), ms.map((m) => m.name).join('|'));

// ── 値の忠実転記 (区分1・数値を書き換えない) ──
check('値忠実: 総タンパク=7.2', byName('総タンパク')?.value === '7.2' && byName('総タンパク')?.value_num === 7.2, `${byName('総タンパク')?.value}/${byName('総タンパク')?.value_num}`);
check('値忠実: LDLコレステロール=130', byName('LDLコレステロール')?.value === '130' && byName('LDLコレステロール')?.value_num === 130, `${byName('LDLコレステロール')?.value}`);
check('値忠実: AST(GOT)=22', byName('AST(GOT)')?.value === '22', `${byName('AST(GOT)')?.value}`);
check('値忠実: HbA1c(NGSP)=5.6', byName('HbA1c(NGSP)')?.value === '5.6', `${byName('HbA1c(NGSP)')?.value}`);

// ── 区分2 (問診) コード→ラベル解決 ──
check('コード解決: 喫煙 "1" → "ハイ"', byName('たばこを吸いますか')?.value === 'ハイ', `${byName('たばこを吸いますか')?.value}`);
check('コード解決: 飲酒 "2" → "イイエ"', byName('お酒を飲みますか')?.value === 'イイエ', `${byName('お酒を飲みますか')?.value}`);

// ── 判定コード (区分3「判)」) が対応する区分1項目へ assessment として付与 ──
check('判定付与: 判)TP → 総タンパク.assessment="A"', (byName('総タンパク') as any)?.assessment === 'A', `${(byName('総タンパク') as any)?.assessment}`);
check('判定付与: 判)HbA1c(NGSP) → HbA1c.assessment="B"', (byName('HbA1c(NGSP)') as any)?.assessment === 'B', `${(byName('HbA1c(NGSP)') as any)?.assessment}`);
check('総) は判定として付与されない (LDL/ASTにassessment無し)', !(byName('LDLコレステロール') as any)?.assessment && !(byName('AST(GOT)') as any)?.assessment, 'assessment leaked');

// ── 標準名/略号の対応 (name=標準名 / name_detail=略号) ──
check('名寄せ: 総タンパク の name_detail="TP"', byName('総タンパク')?.name_detail === 'TP', `${byName('総タンパク')?.name_detail}`);

// ── PII 非混入 (最重要) ──
const jsonStr = JSON.stringify(json);
check('PII非混入: subject は {sex, age} のみ', JSON.stringify(Object.keys(json?.subject ?? {}).sort()) === JSON.stringify(['age', 'sex']), Object.keys(json?.subject ?? {}).join(','));
check('PII非混入: subject.sex="male" (男→正規化)', json?.subject.sex === 'male', `${json?.subject.sex}`);
check('PII非混入: subject.age=46 (生年月日→年齢のみ)', json?.subject.age === 46, `${json?.subject.age}`);
check('PII非混入: 出力に生年月日(1980)を含まない', !jsonStr.includes('1980'), 'birthdate leaked');
check('PII非混入: 生年月日/氏名/住所キーが無い', !/生年月日|氏名|住所|フリガナ/.test(jsonStr), 'PII key leaked');

// ── メタ/命名/経路 ──
check('format_id=BloodTestData / kind=lab_csv', json?.format_id === 'BloodTestData' && json?.kind === 'lab_csv');
check('lab_name=demecal', json?.source.lab_name === 'demecal', `${json?.source.lab_name}`);
check('test_date=2026-08-05 / date_source=drawn_date (採血日優先)', json?.test_date === '2026-08-05' && json?.date_source === 'drawn_date', `${json?.test_date}/${json?.date_source}`);
const key = row?.files[0]?.key ?? '';
check('S3命名: user/<id>/date/2026_08_05/BloodTestData_date_2026_08_05_user_<id>.json', /user\/test-fixture-1\/date\/2026_08_05\/BloodTestData_date_2026_08_05_user_test-fixture-1\.json$/.test(key), key);
check('orderNo(指図番号)は内部保持されJSONには出さない', row?.orderNo === 'ORD-0001' && !jsonStr.includes('ORD-0001'), `orderNo=${row?.orderNo}`);

console.log(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAIL`} (measurements=${ms.length}, 期待6)`);
process.exit(failures === 0 ? 0 : 1);
