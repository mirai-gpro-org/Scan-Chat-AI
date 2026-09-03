/**
 * 回帰チェック: 血液 CSV の **production parser** (`parseBloodCsvRowsStrict`)。
 *
 * 実行: `npm run verify:blood-parser`
 * 正本: `docs/lab/demecal_phase_c_spec_20260903.md` v0.2 §4.1〜§4.3 / §6 / C1-A 指示 §8。
 *
 * 【何を守るチェックか】
 *   ここが静かに壊れると、**他人の検査結果を他人の ID で Elith へ出す**か、
 *   **実行日を医療データの日付として捏造する**。どちらも画面上は正常に見えるので、
 *   目視では絶対に気づけない。だから機械で固定する。
 *
 * 【2 種類の検査を混ぜている】
 *   ① 振る舞い  … fixture を通して出力を見る
 *   ② ソース検査 … production parser の **region のソース文字列**を直接読む
 *      (「今日の日付を作らない」「UUID を作らない」等は、
 *       出力を見るだけでは「たまたま出なかった」と区別できないため)
 *      region は `elith-blood-csv.ts` の
 *      `C1-A: production parser (ここから)` 〜 `(ここまで)` のマーカーで切る。
 *      **旧経路 (buildBloodCsvBundles) にはこれらが在るので、範囲を切らないと意味がない。**
 */

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseBloodCsvRowsStrict,
  REQUIRED_BLOOD_CSV_HEADERS,
  type BloodProductionParseResult,
} from '../src/lib/elith-blood-csv';

const ROOT = process.cwd();
if (!existsSync(resolve(ROOT, 'package.json'))) {
  console.error(`✗ リポジトリ直下で実行してください (cwd=${ROOT})`);
  process.exit(1);
}

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  OK   ${name}`); }
  else { fails.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  NG   ${name} — ${detail ?? ''}`); }
}

const fx = (n: string): string => readFileSync(resolve(ROOT, 'scripts/blood-csv-fixtures', n), 'utf-8');
const fxBytes = (n: string): Uint8Array =>
  new Uint8Array(readFileSync(resolve(ROOT, 'scripts/blood-csv-fixtures', n)));

/** 失敗コードの集合 (順不同で比べる)。 */
const codes = (r: BloodProductionParseResult): string[] => [...new Set(r.failures.map((f) => f.code))].sort();

console.log('');
console.log('── 正常系 ──────────────────────────────────────────');

const ok = parseBloodCsvRowsStrict({ text: fx('prod_ok_2rows.csv') });
check('P01 正常な複数行が parse できる', ok.ok && ok.rows.length === 2,
  `ok=${ok.ok} rows=${ok.rows.length} failures=${JSON.stringify(ok.failures)}`);
check('P02 totalRows / headerOk が入る', ok.totalRows === 2 && ok.headerOk, `total=${ok.totalRows} header=${ok.headerOk}`);

// ── §3 指図番号は string のまま ────────────────────────────────
// fixture の値は **Number 化すると必ず壊れる**もの:
//   17 桁 → 2^53 を超えて精度が落ちる / 先頭 0 → 消える
const o1 = ok.rows[0]?.orderNo;
const o2 = ok.rows[1]?.orderNo;
check('P03 指図番号が string 型', typeof o1 === 'string' && typeof o2 === 'string', `${typeof o1} / ${typeof o2}`);
check('P04 17 桁の指図番号が 1 文字も変わらない', o1 === '20212345678901234', String(o1));
check('P05 先頭 0 の指図番号が保持される', o2 === '0202123456789012', String(o2));
check('P06 (前提) この値は Number 化すると壊れる = テストが意味を持つ',
  String(Number('20212345678901234')) !== '20212345678901234'
  && String(Number('0202123456789012')) !== '0202123456789012',
  `${String(Number('20212345678901234'))} / ${String(Number('0202123456789012'))}`);

// ── §4 日付 ────────────────────────────────────────────────────
check('P07 採血日があれば testDate=採血日 / dateSource=drawn_date',
  ok.rows[0]?.testDate === '2026-08-05' && ok.rows[0]?.dateSource === 'drawn_date',
  `${ok.rows[0]?.testDate} / ${ok.rows[0]?.dateSource}`);
check('P08 採血日が無ければ testDate=結果承認日 / dateSource=approved_date',
  ok.rows[1]?.drawnDate === null && ok.rows[1]?.testDate === '2026-08-08'
  && ok.rows[1]?.dateSource === 'approved_date',
  `drawn=${ok.rows[1]?.drawnDate} test=${ok.rows[1]?.testDate} src=${ok.rows[1]?.dateSource}`);
check('P09 approvedDate が必ず入る',
  ok.rows[0]?.approvedDate === '2026-08-07' && ok.rows[1]?.approvedDate === '2026-08-08',
  `${ok.rows[0]?.approvedDate} / ${ok.rows[1]?.approvedDate}`);
check('P10 dateSource に today が 1 件も出ない',
  ok.rows.every((r) => r.dateSource === 'drawn_date' || r.dateSource === 'approved_date'),
  JSON.stringify(ok.rows.map((r) => r.dateSource)));

// ── measurements の決定論パースが維持されている ────────────────
// 区分3 (判)TP) は納品しない・区分2 は凡例でラベル解決・ヘッダ標準名を name に採る。
const m0 = ok.rows[0]?.measurements ?? [];
check('P11 measurements 件数 (区分3 を除いた 3 件)', m0.length === 3, `len=${m0.length}`);
check('P12 ヘッダ標準名が name / 行の略号が name_detail',
  m0[0]?.name === '総タンパク' && m0[0]?.name_detail === 'TP' && m0[0]?.value === '7.2',
  JSON.stringify(m0[0]));
check('P13 区分2 の凡例でコードがラベルへ (1 → ハイ)',
  m0[2]?.name === 'たばこを吸いますか' && m0[2]?.value === 'ハイ', JSON.stringify(m0[2]));
check('P14 区分3 (判定コード) は項目として出さず assessment に付く',
  m0.every((m) => !String(m.name ?? '').startsWith('判)')) && m0[0]?.assessment === 'A',
  JSON.stringify(m0.map((m) => m.name)));
check('P15 value_num が数値化される', m0[0]?.value_num === 7.2, String(m0[0]?.value_num));
check('P16 itemCount = measurements 件数', ok.rows[0]?.itemCount === m0.length,
  `${ok.rows[0]?.itemCount} / ${m0.length}`);

// ── subject ────────────────────────────────────────────────────
check('P17 subject.sex が正規化される', ok.rows[0]?.subject.sex === 'male' && ok.rows[1]?.subject.sex === 'female',
  `${ok.rows[0]?.subject.sex} / ${ok.rows[1]?.subject.sex}`);
check('P18 subject.age が testDate 基準で算出される (1980-01-15 → 2026-08-05 = 46)',
  ok.rows[0]?.subject.age === 46, String(ok.rows[0]?.subject.age));

// ── Shift_JIS bytes 入力 ───────────────────────────────────────
const sjis = parseBloodCsvRowsStrict({ bytes: fxBytes('prod_ok_2rows.sjis.csv') });
check('P19 Shift_JIS の bytes 入力でも同じ結果になる',
  sjis.ok && JSON.stringify(sjis.rows) === JSON.stringify(ok.rows),
  `ok=${sjis.ok} rows=${sjis.rows.length}`);

console.log('');
console.log('── 失敗系 (1 件でも NG なら batch 全体 FAIL) ────────');

const noOrder = parseBloodCsvRowsStrict({ text: fx('prod_order_no_missing.csv') });
check('P20 指図番号が空 → BLOOD_ROW_ORDER_NO_MISSING',
  !noOrder.ok && codes(noOrder).join(',') === 'BLOOD_ROW_ORDER_NO_MISSING', codes(noOrder).join(','));

const noApproved = parseBloodCsvRowsStrict({ text: fx('prod_approved_missing.csv') });
check('P21 結果承認日が空 → BLOOD_ROW_APPROVED_DATE_INVALID',
  !noApproved.ok && codes(noApproved).join(',') === 'BLOOD_ROW_APPROVED_DATE_INVALID', codes(noApproved).join(','));

const badApproved = parseBloodCsvRowsStrict({ text: fx('prod_approved_invalid.csv') });
check('P22 結果承認日が不正 (2026-13-45) → BLOOD_ROW_APPROVED_DATE_INVALID',
  !badApproved.ok && codes(badApproved).join(',') === 'BLOOD_ROW_APPROVED_DATE_INVALID', codes(badApproved).join(','));

const dup = parseBloodCsvRowsStrict({ text: fx('prod_duplicate_order_no.csv') });
check('P23 同一指図番号が 2 行 → DUPLICATE_EXTERNAL_TEST_ID_IN_CSV で batch FAIL',
  !dup.ok && codes(dup).join(',') === 'DUPLICATE_EXTERNAL_TEST_ID_IN_CSV', codes(dup).join(','));
check('P24 重複時は先頭も末尾も採用しない (rows は空)', dup.rows.length === 0, `rows=${dup.rows.length}`);
check('P25 重複の detail は行番号で指す (指図番号の実値を書かない)',
  dup.failures.some((f) => /行 1, 2/.test(f.detail)) && !dup.failures.some((f) => f.detail.includes('20212345678901234')),
  JSON.stringify(dup.failures));

const badHeader = parseBloodCsvRowsStrict({ text: fx('prod_header_missing.csv') });
check('P26 必須ヘッダ欠落 → CSV_HEADER_INVALID (server が独立に検査する)',
  !badHeader.ok && codes(badHeader).join(',') === 'CSV_HEADER_INVALID' && !badHeader.headerOk,
  codes(badHeader).join(','));
check('P27 必須ヘッダは 指図番号 / 結果承認日 / 結果項目数 の 3 つ',
  REQUIRED_BLOOD_CSV_HEADERS.join(',') === '指図番号,結果承認日,結果項目数',
  REQUIRED_BLOOD_CSV_HEADERS.join(','));

check('P28 失敗時は rows が必ず空 (部分成功を返さない)',
  [noOrder, noApproved, badApproved, dup, badHeader].every((r) => r.rows.length === 0), '');

console.log('');
console.log('── 日付の暦検証 (C1-A レビュー指摘 2026-09-03) ──────');

/**
 * 日付だけを変えた最小 CSV を組み立てる。
 *
 * **fixture ファイルにしない理由**: 検証したいのは日付 1 列だけで、
 * ほぼ同じ CSV が 6 本並ぶと「どれが何を見ているか」が読めなくなる。
 * PII 境界の検査 (P29〜P32) は**実ファイル**の fixture を使う (そちらは中身が要点なので)。
 */
function mkCsv(drawn: string, approved: string): string {
  const header = ['指図番号', '性別', '生年月日', '採血日', '結果承認日',
    'エラーコード', 'エラー内容', '結果項目数', '"項目名1\n総タンパク"', '項目区分1', '検査値1'].join(',');
  const row = ['20212345678901234', '男', '19800115', drawn, approved, '', '', '1', 'TP', '1', '7.2'].join(',');
  return `${header}\r\n${row}\r\n`;
}
const at = (drawn: string, approved: string): BloodProductionParseResult =>
  parseBloodCsvRowsStrict({ text: mkCsv(drawn, approved) });

// ── 実在する日は通る ───────────────────────────────────────────
const d0228 = at('20260228', '20260807');
check('P41 2026-02-28 は valid (testDate=採血日)',
  d0228.ok && d0228.rows[0]?.testDate === '2026-02-28', `${d0228.ok} / ${d0228.rows[0]?.testDate}`);
const dLeap = at('20240229', '20260807');
check('P42 閏年 2024-02-29 は valid',
  dLeap.ok && dLeap.rows[0]?.testDate === '2024-02-29', `${dLeap.ok} / ${dLeap.rows[0]?.testDate}`);

// ── 実在しない日は落ちる ───────────────────────────────────────
const dNoLeap = at('20250229', '20260807');
check('P43 非閏年 2025-02-29 は invalid → BLOOD_ROW_DRAWN_DATE_INVALID',
  !dNoLeap.ok && codes(dNoLeap).join(',') === 'BLOOD_ROW_DRAWN_DATE_INVALID', codes(dNoLeap).join(','));
const d0231 = at('20260231', '20260807');
check('P44 2026-02-31 は invalid → BLOOD_ROW_DRAWN_DATE_INVALID',
  !d0231.ok && codes(d0231).join(',') === 'BLOOD_ROW_DRAWN_DATE_INVALID', codes(d0231).join(','));
const d0431 = at('20260431', '20260807');
check('P45 2026-04-31 (小の月の 31 日) は invalid → BLOOD_ROW_DRAWN_DATE_INVALID',
  !d0431.ok && codes(d0431).join(',') === 'BLOOD_ROW_DRAWN_DATE_INVALID', codes(d0431).join(','));

// ── 100 年 / 400 年規則 ────────────────────────────────────────
// **これが無いと「4 の倍数なら閏年」の実装でもテストが全部通ってしまう**
// (実測 2026-09-03: 閏年判定を `year % 4 === 0` に壊しても 59 件 PASS のままだった)。
const dCentury = at('21000229', '20260807');
check('P52 2100-02-29 は invalid (100 年規則: 2100 は閏年でない)',
  !dCentury.ok && codes(dCentury).join(',') === 'BLOOD_ROW_DRAWN_DATE_INVALID', codes(dCentury).join(','));
const dQuad = at('20000229', '20260807');
check('P53 2000-02-29 は valid (400 年規則: 2000 は閏年)',
  dQuad.ok && dQuad.rows[0]?.testDate === '2000-02-29', `${dQuad.ok} / ${dQuad.rows[0]?.testDate}`);

// ── **不正な採血日は結果承認日へ fallback しない** (今回の blocker) ──
check('P46 不正な採血日は approvedDate へ fallback しない (rows が 0)',
  d0231.rows.length === 0 && dNoLeap.rows.length === 0 && d0431.rows.length === 0,
  `${d0231.rows.length} / ${dNoLeap.rows.length} / ${d0431.rows.length}`);
check('P47 fallback していたら testDate=2026-08-07 になるはず = この検査が意味を持つ',
  !d0231.rows.some((r) => r.testDate === '2026-08-07'), JSON.stringify(d0231.rows.map((r) => r.testDate)));

// ── 空の採血日「だけ」は fallback してよい ─────────────────────
const dBlank = at('', '20260807');
check('P48 空の採血日は approvedDate へ fallback する (drawnDate=null)',
  dBlank.ok && dBlank.rows[0]?.drawnDate === null
  && dBlank.rows[0]?.testDate === '2026-08-07' && dBlank.rows[0]?.dateSource === 'approved_date',
  `${dBlank.ok} / ${dBlank.rows[0]?.drawnDate} / ${dBlank.rows[0]?.testDate}`);

// ── 結果承認日も同じ暦検証を通す ───────────────────────────────
const aNoLeap = at('20260805', '20250229');
check('P49 結果承認日 2025-02-29 は invalid → BLOOD_ROW_APPROVED_DATE_INVALID',
  !aNoLeap.ok && codes(aNoLeap).join(',') === 'BLOOD_ROW_APPROVED_DATE_INVALID', codes(aNoLeap).join(','));
const a0431 = at('20260805', '20260431');
check('P50 結果承認日 2026-04-31 は invalid → BLOOD_ROW_APPROVED_DATE_INVALID',
  !a0431.ok && codes(a0431).join(',') === 'BLOOD_ROW_APPROVED_DATE_INVALID', codes(a0431).join(','));
check('P51 (前提) 旧 normDate はこれらを受理してしまう = strict 版が要る理由',
  /if \(M < 1 \|\| M > 12 \|\| D < 1 \|\| D > 31\) return null;/.test(
    readFileSync(resolve(ROOT, 'src/lib/elith-blood-csv.ts'), 'utf-8')), '');

console.log('');
console.log('── 日付書式の exact match (レビュー指摘 2026-09-03) ──');

/** 採血日にその文字列を入れて parse し、通ったかどうかだけを見る。 */
const drawnOk = (v: string): boolean => {
  const r = at(v, '20260807');
  return r.ok && r.rows[0]?.testDate === '2026-02-28';
};
const drawnRejected = (v: string): boolean => {
  const r = at(v, '20260807');
  // **fallback していないこと**まで見る (invalid が blank 扱いになると
  // testDate=2026-08-07 で ok:true になってしまい、この検査が空振りする)。
  return !r.ok && codes(r).join(',') === 'BLOOD_ROW_DRAWN_DATE_INVALID' && r.rows.length === 0;
};

check('P54 YYYYMMDD は valid', drawnOk('20260228'), '');
check('P55 YYYY-MM-DD は valid', drawnOk('2026-02-28'), '');
check('P56 YYYY/MM/DD は valid', drawnOk('2026/02/28'), '');

check('P57 前にゴミが付く abc2026-02-28 は invalid', drawnRejected('abc2026-02-28'), '');
check('P58 後ろにゴミが付く 2026-02-28xyz は invalid', drawnRejected('2026-02-28xyz'), '');
check('P59 9 桁の 202602280 は invalid', drawnRejected('202602280'), '');
check('P60 2026-02-280 は invalid', drawnRejected('2026-02-280'), '');
check('P61 任意の区切り 2026a02b28 は invalid (区切りは - と / だけ)', drawnRejected('2026a02b28'), '');
check('P62 区切りが前後で違う 2026-02/28 は invalid', drawnRejected('2026-02/28'), '');
check('P63 1 桁の月日 2026-2-28 は invalid (書式を 3 つに固定している)', drawnRejected('2026-2-28'), '');
check('P64 前後の空白は trim される ( 2026-02-28 は valid)', drawnOk(' 2026-02-28 '), '');

check('P65 (前提) 部分一致なら通ってしまう値である = この検査が意味を持つ',
  ['abc2026-02-28', '2026-02-28xyz', '202602280', '2026-02-280', '2026a02b28']
    .every((v) => /(\d{4})\D?(\d{1,2})\D?(\d{1,2})/.test(v)), '');

console.log('');
console.log('── PII 境界 ────────────────────────────────────────');

// fixture に入れてある**架空の** PII。1 つでも parse 結果に出たら落とす。
const RAW_PII = [
  '架空田', '一郎太', 'カクウダ', 'イチロウタ', '19800115', '09099998888',
  '999-9998', '架空県', '架空市架空町9-9-9', 'kakuu-ichiro@example.invalid',
  '仮名原', '二子代', 'カメイハラ', 'フタコヨ', '19751203', '08077776666',
  '888-8887', '仮名県', '仮名市仮名町8-8-8', 'kameihara-futako@example.invalid',
];
/**
 * **正規化されてから漏れる形**。fixture には raw (`19800115`) しか無いので
 * RAW_PII とは分けて持つ。
 * 実測 2026-09-03: DOB を結果へ残す退行を注入したとき、raw の `19800115` では
 * 1 件も引っかからず、**正規化後の `1980-01-15` でしか検出できなかった**。
 * 「fixture に在る文字列」だけを見ていると PII 検査は静かに素通りする。
 */
const DERIVED_PII = ['1980-01-15', '1975-12-03'];

const serialized = JSON.stringify(ok);
const leaked = [...RAW_PII, ...DERIVED_PII].filter((v) => serialized.includes(v));
check('P29 parse 結果に raw / 正規化後の PII が 1 つも出ない', leaked.length === 0, `漏れ=${leaked.join(' / ')}`);
check('P30 (前提) fixture は実際にその PII を持っている = テストが意味を持つ',
  RAW_PII.every((v) => fx('prod_ok_2rows.csv').includes(v)), '');
check('P31 生年月日は age へ畳まれ、日付そのものは残らない',
  !serialized.includes('1980-01-15') && !serialized.includes('19800115') && ok.rows[0]?.subject.age === 46, '');
check('P32 許可されるのは age / sex / orderNo だけ (行のキーが仕様どおり)',
  JSON.stringify(Object.keys(ok.rows[0] ?? {}).sort()) === JSON.stringify(
    ['approvedDate', 'dateSource', 'drawnDate', 'errorCode', 'errorDetail', 'itemCount',
      'measurements', 'orderNo', 'rowIndex', 'subject', 'testDate'],
  ),
  JSON.stringify(Object.keys(ok.rows[0] ?? {}).sort()));

console.log('');
console.log('── ソース検査 (production parser の region だけを見る) ──');

const src = readFileSync(resolve(ROOT, 'src/lib/elith-blood-csv.ts'), 'utf-8');
const B = 'C1-A: production parser (ここから)';
const E = 'C1-A: production parser (ここまで)';
const bi = src.indexOf(B);
const ei = src.indexOf(E);
check('P33 region のマーカーが在る', bi >= 0 && ei > bi, `begin=${bi} end=${ei}`);
// **コメントは検査対象から外す。** この region の冒頭コメント自体が
// 「client_id / diagnostic_id / exported_at / S3PutFile を作らない」と**列挙している**ので、
// 素朴に検査すると自分の説明文に引っかかる (実測 2026-09-03)。
// マーカーは冒頭・末尾のブロックコメントの**中**にあるため、slice は
// **閉じていないコメント片**で始まり、**開いたままのコメント片**で終わる。
// → ①先頭の `*/` までを捨てる ②末尾の最後の `/*` 以降を捨てる ③残りの完全なコメントを消す。
function stripComments(t: string): string {
  let x = t;
  const head = x.indexOf('*/');
  if (head >= 0) x = x.slice(head + 2);          // ① 開いたまま始まっているコメント片
  const tail = x.lastIndexOf('/*');
  if (tail >= 0) x = x.slice(0, tail);           // ② 閉じないまま終わるコメント片
  return x
    .replace(/\/\*[\s\S]*?\*\//g, '')            // ③ 完全なブロックコメント
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}
const region = stripComments(src.slice(bi, ei));

/** region に出てはいけないもの (spec §1: parser が作らない 7 つ)。 */
const BANNED: Array<[string, RegExp]> = [
  ['現在時刻 (new Date)', /\bnew\s+Date\s*\(/],
  ['現在時刻 (Date.now)', /\bDate\.now\s*\(/],
  ['UUID 生成', /randomUUID|randomUuid/],
  ["date_source='today'", /['"`]today['"`]/],
  ['client_id 採番', /\bmakeClientId\b|\bclientId\b|\bclient_id\b/],
  ['diagnostic_id 生成', /\bdiagnosticId\b|\bdiagnostic_id\b/],
  ['exported_at', /\bexportedAt\b|\bexported_at\b/],
  ['S3 key 組み立て', /\bS3PutFile\b|\bputFiles\b|\bprefix\b|user\/\$\{/],
  ['network / DB', /\bfetch\s*\(|getServerSupabase|supabase|listObjects|getObjectText/],
];
for (const [label, re] of BANNED) {
  check(`P34 region に「${label}」が無い`, !re.test(region), (re.exec(region) ?? [''])[0]);
}

// **在るべきもの** (消したら落ちる = 検査が空振りしない)
check('P35 region に指図番号の必須チェックが在る', /BLOOD_ROW_ORDER_NO_MISSING/.test(region), '');
check('P36 region に結果承認日の必須チェックが在る', /BLOOD_ROW_APPROVED_DATE_INVALID/.test(region), '');
check('P37 region に重複チェックが在る', /DUPLICATE_EXTERNAL_TEST_ID_IN_CSV/.test(region), '');
check('P38 region がヘッダを独立検査している', /REQUIRED_BLOOD_CSV_HEADERS/.test(region), '');
check('P39 measurements は共通実装を呼んでいる (決定論パースを複製しない)',
  /buildRowMeasurements\s*\(/.test(region), '');

// 旧経路は今回変更していない = region の外には today fallback が「まだ在る」
const outside = src.slice(0, bi);
check('P40 (前提) 旧 buildBloodCsvBundles には today fallback がまだ在る = 範囲を切る意味がある',
  /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/.test(outside) && /'today'/.test(outside), '');

console.log('');
console.log('='.repeat(56));
if (fails.length > 0) {
  console.error(`✗ ${fails.length} 件 失敗 / ${pass} 件 成功`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ 全 ${pass} 件 PASS`);
