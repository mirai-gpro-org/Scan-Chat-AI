/**
 * 血液検査 CSV (デメカル様式) → Elith `BloodTestData` への決定論パーサ (サーバ専用)。
 *
 * 設計 (docs: docs/elith/elith_s3_data_handoff_spec.md §7.1 / docs/lab/demecal_auto_download_overview_spec.md):
 *   - CSV は「自己記述型」: 固定メタ列 + `結果項目数` + (項目名N / 項目区分N / 検査値N) の繰り返し。
 *     → 検査項目が増減・改称してもコード修正不要 (項目名をハードコードしない汎用転記)。
 *   - LLM は使わない。構造化データは決定論パースで値を完全転記する (検査値は誤り厳禁)。
 *   - PII 厳守 (CLAUDE.md): 氏名・かな・住所・電話・メール・生年月日は **Elith JSON に載せない**。
 *     subject は性別 + 年齢のみ。新様式は CSV から PII 列 (性別/生年月日/氏名/住所) が削除されたため
 *     subject は原則 null (sex/age は顧客DB側で紐付け)。原本 CSV は S3 へ置かない。
 *   - client_id は呼び出し側が採番 (テストは自動採番)。日付は `採血日`。
 *   - Shift_JIS で受領するため TextDecoder('shift-jis') でデコード。
 *
 * 新様式 (2026-07〜) の仕様:
 *   - ヘッダの `項目名N` セルに標準名を埋め込み (例 "項目名1\n総タンパク")。データ行は略号 (TP 等)。
 *     → name=標準名 / name_detail=略号 (標準名が無い項目・問診はデータ行の値を name)。
 *   - `項目区分N` の値がブロック番号: 1=検査値 / 2=問診結果 / 3=判定・総合コード。
 *     区分3 は納品しない。項目区分そのものは JSON に出さない (category を設定しない)。
 *   - 区分2 は `検査値N` ヘッダに凡例 (例 "1：ハイ" "2：イイエ") があり、コード値をラベルへ解決する。
 *   - 引用フィールド内に改行を含む (項目名/凡例) ため CSV パーサは文字レベルで処理する。
 */

import { ELITH_HANDOFF_SCHEMA_VERSION, toValueNum, type ElithMeasurement } from './elith-export';
import { applyBloodReference } from './blood-reference-master';
import type { S3PutFile } from './s3';

// ── デコード ────────────────────────────────────────────────────
/** Shift_JIS を優先しつつ UTF-8 にフォールバック */
export function decodeBloodCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder('shift-jis', { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

// ── CSV パース (ダブルクォート対応・引用フィールド内の改行/カンマも扱う文字レベル版) ──
// 新様式は項目名/凡例セルに改行を含むため、行分割ベースでは壊れる → 文字単位で走査する。
function parseCsv(text: string): string[][] {
  const t = text.replace(/\r\n?/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inQ) {
      if (ch === '"') {
        if (t[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      row.push(cur.trim()); cur = '';
    } else if (ch === '\n') {
      row.push(cur.trim()); rows.push(row); row = []; cur = '';
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur.trim()); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

/** 全角英数字・記号を半角へ (検査値コードの照合用)。 */
function toHalfWidth(s: string): string {
  return s.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ');
}
/** ヘッダの項目名セル ("項目名1\n総タンパク" 等) から標準名を取り出す。無ければ ''。 */
function headerStdName(cell: string | undefined): string {
  if (!cell) return '';
  const skip = (l: string): boolean =>
    l === '' || /^項目名\d+$/.test(l) || l === 'ここから問診結果' || l === '質問' || l === '回答' ||
    /^[0-9０-９]+\s*[：:]/.test(l);
  for (const line of cell.split('\n').map((s) => s.trim())) {
    if (!skip(line)) return line;
  }
  return '';
}
/** ヘッダの検査値セル ("検査値23\n1：ハイ\n2：イイエ" 等) からコード→ラベル凡例を作る。 */
function headerLegend(cell: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!cell) return map;
  for (const line of cell.split('\n')) {
    const m = /^\s*([0-9０-９]+)\s*[：:]\s*(.+?)\s*$/.exec(line);
    if (m) map[toHalfWidth(m[1]).trim()] = m[2].trim();
  }
  return map;
}

/** 照合用の正規化 (半角化・小文字・空白/記号除去)。 */
function norm(s: string): string {
  return toHalfWidth(s).toLowerCase().replace(/[\s　・（）()]/g, '');
}
/** 区分3「判)…」の名称から、対応する区分1値へ紐づける照合キー候補を作る。 */
function assessmentKeys(judgeName: string): string[] {
  // "判)" / "総)" 接頭辞を除去 (半角/全角の閉じ括弧に対応)
  let s = judgeName.replace(/^\s*[判総][)）]\s*/, '').trim();
  const keys: string[] = [];
  const full = s.replace(/^\d+/, '').trim(); // 数字コード(017等)を除いた全体 (例 "HbA1c(NGSP)")
  if (full) keys.push(norm(full));
  const paren = /[（(]([^）)]+)[）)]\s*$/.exec(s); // 末尾の略号 (TP)/(HDL-C) 等
  if (paren) {
    keys.push(norm(paren[1]));
    s = s.slice(0, paren.index).trim();
  }
  s = s.replace(/^\d+/, '').trim(); // 先頭のコード数字 (017 等) を除去
  if (s) keys.push(norm(s));
  return [...new Set(keys.filter(Boolean))];
}

// ── 日付/年齢 ───────────────────────────────────────────────────
/** YYYYMMDD (または YYYY-MM-DD 等) → YYYY-MM-DD。不正なら null。 */
function normDate(v: string | undefined | null): string | null {
  if (!v) return null;
  const m = /(\d{4})\D?(\d{1,2})\D?(\d{1,2})/.exec(v.trim());
  if (!m) return null;
  const Y = +m[1], M = +m[2], D = +m[3];
  if (M < 1 || M > 12 || D < 1 || D > 31) return null;
  return `${String(Y).padStart(4, '0')}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}`;
}
/** 生年月日と基準日 (共に YYYY-MM-DD) から満年齢。算出不可は null。 */
function ageAt(birthIso: string | null, refIso: string | null): number | null {
  if (!birthIso) return null;
  const b = birthIso.split('-').map(Number);
  const ref = (refIso ?? new Date().toISOString().slice(0, 10)).split('-').map(Number);
  if (b.length !== 3 || ref.length !== 3) return null;
  let age = ref[0] - b[0];
  if (ref[1] < b[1] || (ref[1] === b[1] && ref[2] < b[2])) age--;
  return age >= 0 && age < 150 ? age : null;
}
/** 性別コード → 正規化 (F/女→female, M/男→male, それ以外はそのまま) */
function normSex(v: string | undefined | null): string | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (s === 'f' || s === '女' || s === 'female') return 'female';
  if (s === 'm' || s === '男' || s === 'male') return 'male';
  return v.trim() || null;
}

// ── 型 ──────────────────────────────────────────────────────────
// 検査値型は共通 measurements[] (ElithMeasurement) にキーを揃える (§7.1 / ファイル間キー統一)。
// 血液CSVは決定論パース: 値は原本を忠実に転記し value を書き換えない (value_num のみ数値化)。
export interface BloodTestDataJson {
  format_id: 'BloodTestData';
  schema_version: typeof ELITH_HANDOFF_SCHEMA_VERSION;
  kind: 'lab_csv';
  client_id: string;
  diagnostic_id: string;
  source_file: string | null;
  test_date: string; // 採血日 (YYYY-MM-DD)
  date_source: 'drawn_date' | 'approved_date' | 'today';
  exported_at: string;
  subject: { sex: string | null; age: number | null }; // PII: 氏名/生年月日/住所は載せない
  source: {
    origin: 'scan-chat-ai';
    app: 'scan-chat-ai';
    model: null;
    note: string;
    lab_name: string | null;
    error_code: string | null;
    error_detail: string | null;
  };
  data: { measurements: ElithMeasurement[] };
}

export interface BloodCsvRowResult {
  clientId: string;
  testDate: string;
  itemCount: number;
  json: BloodTestDataJson;
  files: S3PutFile[];
  /** 内部照合用 (S3 には出さない): 指図番号。将来 lab_tests への割当に使用。 */
  orderNo: string | null;
}

export interface BloodCsvParseResult {
  rows: BloodCsvRowResult[];
  /** ヘッダ検出できた列 (デバッグ用) */
  headerFound: { drawnDate: boolean; sex: boolean; birth: boolean; itemCount: boolean };
  totalRows: number;
}

// ── ヘッダ列の検出 ──────────────────────────────────────────────
function colIndex(header: string[], names: string[]): number {
  for (const n of names) {
    const i = header.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

function utf8Bytes(s: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : Buffer.byteLength(s, 'utf-8');
}
function randomUuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

/**
 * 1 行ぶんの検査項目 (項目名N / 項目区分N / 検査値N の 3 列組) を measurements[] にする。
 *
 * **`buildBloodCsvBundles`（旧・PoC 経路）と `parseBloodCsvRowsStrict`（C1-A・本番用）の
 * 両方がこれを呼ぶ。** 決定論パースを 2 か所に複製すると必ず片方だけ直って割れるので、
 * 実装本体は 1 つに保つ (`sanitizeMeasurementsForDelivery` と同じ規律)。
 * **この関数は C1-A で新規に書いたものではなく、旧経路の該当ループをそのまま切り出したもの。**
 * 挙動が変わっていないことは `npm run verify:blood-csv` が固定する。
 */
function buildRowMeasurements(
  header: string[],
  row: string[],
  itemCountCol: number,
  declaredRaw: string | null,
  rowSex: string | null,
): ElithMeasurement[] {
  const items: ElithMeasurement[] = [];
  const startCol = itemCountCol >= 0 ? itemCountCol + 1 : -1;
  if (startCol < 0) return items;

  const declared = Number(declaredRaw ?? '');
  const maxTriples = Math.floor((row.length - startCol) / 3);
  const n = Number.isFinite(declared) && declared > 0 ? Math.min(declared, maxTriples) : maxTriples;

  // pass 1: 区分3 の「判)」判定コードを {照合キー → コード} に集める (説明情報の付与用)。
  // 「総)」(メタボ等の全体判定) は対象外 (別途)。
  const assessMap: Record<string, string> = {};
  for (let k = 0; k < n; k++) {
    const base = startCol + k * 3;
    if ((row[base + 1] ?? '').trim() !== '3') continue;
    const nm = (row[base] ?? '').trim();
    const code = (row[base + 2] ?? '').trim();
    if (!code || !/^\s*判[)）]/.test(nm)) continue;
    for (const key of assessmentKeys(nm)) if (!(key in assessMap)) assessMap[key] = code;
  }
  const lookupAssessment = (name: string | null, detail: string | null): string | null => {
    for (const cand of [detail, name]) {
      if (cand) {
        const hit = assessMap[norm(cand)];
        if (hit) return hit;
      }
    }
    return null;
  };

  // pass 2: measurements 構築。区分3 は出さない。区分1 には対応する判定コードを assessment として付与。
  for (let k = 0; k < n; k++) {
    const base = startCol + k * 3;
    const block = (row[base + 1] ?? '').trim(); // 項目区分の値 = ブロック番号 (1/2/3)
    if (block === '3') continue; // 区分3 (判定・総合コード) は単独項目としては納品しない
    const rowName = (row[base] ?? '').trim();
    const rawVal = (row[base + 2] ?? '').trim();
    if (!rowName && !rawVal) continue;
    // 検査値ヘッダの凡例でコード値をラベルへ (区分2 問診: 1→ハイ 2→イイエ / 0→イイエ 1→ハイ 等)。
    // 凡例が無い列 (区分1 等) はコードにヒットしないので原本の値がそのまま残る。
    const legend = headerLegend(header[base + 2]);
    const value = (rawVal && legend[toHalfWidth(rawVal).trim()]) || rawVal || null;
    // 項目名: ヘッダ標準名を name、データ行の略号/質問文を name_detail。標準名が無ければ行の値を name。
    const std = headerStdName(header[base]);
    const name = std || rowName || null;
    const name_detail = std && rowName && rowName !== std ? rowName : null;
    // 区分1 (検査値) には判定コード (F2/A3 等) を assessment として紐づける (該当あれば)。
    const assessment = block === '1' ? lookupAssessment(name, name_detail) : null;
    // 項目区分(category)は JSON に出さない (要件4)。CSV は単位/基準値カラムを持たないため初期値は null。
    const meas: ElithMeasurement = {
      name,
      name_detail,
      value,
      value_num: toValueNum(value),
      unit: null,
      ref_low: null,
      ref_high: null,
      flag: null,
      note: null,
    };
    if (assessment) meas.assessment = assessment;
    // Elith 要望(2026-07): 基準値/単位マスタ(BLOOD_REFERENCE)があれば unit/ref を付与し flag(H/L)を算出。
    // マスタ未登録の項目は null のまま（挙動不変）。医療値はデメカル一次資料で登録する。
    applyBloodReference(meas, rowSex);
    items.push(meas);
  }
  return items;
}

export interface BuildBloodCsvInput {
  /** デコード済み CSV テキスト、または生バイト列 (Shift_JIS 想定) */
  text?: string;
  bytes?: Uint8Array;
  sourceFileName?: string | null;
  /** client_id 採番関数 (0-based の行 index を受け取る)。テストは `test-<stamp>-<seq>`。 */
  makeClientId: (rowIndex: number) => string;
  /** バケット内共通プレフィックス (例 "scan-accuracy-test/") */
  prefix?: string;
  exportedAt?: Date;
}

/**
 * 血液 CSV を全行パースし、行ごとに Elith `BloodTestData` バンドルを生成する。
 * S3 への put は呼び出し側 (s3.putFiles)。原本 CSV は PII を含むため **併置しない**。
 */
export function buildBloodCsvBundles(input: BuildBloodCsvInput): BloodCsvParseResult {
  const text = input.text ?? (input.bytes ? decodeBloodCsv(input.bytes) : '');
  const table = parseCsv(text);
  if (table.length < 2) {
    return { rows: [], headerFound: { drawnDate: false, sex: false, birth: false, itemCount: false }, totalRows: 0 };
  }
  const header = table[0];
  const idx = {
    orderNo: colIndex(header, ['指図番号']),
    sex: colIndex(header, ['性別']),
    birth: colIndex(header, ['生年月日']),
    drawn: colIndex(header, ['採血日']),
    approved: colIndex(header, ['結果承認日']),
    errCode: colIndex(header, ['エラーコード']),
    errDetail: colIndex(header, ['エラー内容']),
    itemCount: colIndex(header, ['結果項目数']),
  };
  const prefix = input.prefix ? input.prefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
  const exportedAt = (input.exportedAt ?? new Date()).toISOString();

  const rows: BloodCsvRowResult[] = [];
  for (let r = 1; r < table.length; r++) {
    const row = table[r];
    const get = (i: number): string | null => (i >= 0 && i < row.length ? (row[i]?.trim() || null) : null);

    const drawn = normDate(get(idx.drawn));
    const approved = normDate(get(idx.approved));
    const testDate = drawn ?? approved ?? new Date().toISOString().slice(0, 10);
    const dateSource: BloodTestDataJson['date_source'] = drawn ? 'drawn_date' : approved ? 'approved_date' : 'today';
    const birthIso = normDate(get(idx.birth));
    // この行(被験者)の性別。基準値の男女別選択 と subject.sex に使う。
    const rowSex = normSex(get(idx.sex));

    // 検査項目: 結果項目数の直後から (項目名, 項目区分, 検査値) を itemCount 組 読む。
    // 結果項目数が欠損/不正でも、以降を 3 列ずつ末尾まで読み切る (汎用・堅牢)。
    // **本体は buildRowMeasurements に切り出し済み** (本番 parser と同じものを使う)。
    const items = buildRowMeasurements(header, row, idx.itemCount, get(idx.itemCount), rowSex);

    const clientId = input.makeClientId(r - 1);
    const dateFolder = testDate.replace(/-/g, '_');
    const json: BloodTestDataJson = {
      format_id: 'BloodTestData',
      schema_version: ELITH_HANDOFF_SCHEMA_VERSION,
      kind: 'lab_csv',
      client_id: clientId,
      diagnostic_id: randomUuid(),
      source_file: input.sourceFileName ?? null,
      test_date: testDate,
      date_source: dateSource,
      exported_at: exportedAt,
      subject: { sex: rowSex, age: ageAt(birthIso, testDate) },
      source: {
        origin: 'scan-chat-ai',
        app: 'scan-chat-ai',
        model: null,
        note: 'admin バッチ (血液CSV・決定論パース)。書式は暫定。',
        lab_name: 'demecal',
        error_code: get(idx.errCode),
        error_detail: get(idx.errDetail),
      },
      data: { measurements: items },
    };

    const folder = `${prefix}user/${clientId}/date/${dateFolder}/`;
    const stem = `BloodTestData_date_${dateFolder}_user_${clientId}`;
    const jsonKey = `${folder}${stem}.json`;
    const jsonBody = JSON.stringify(json, null, 2);

    rows.push({
      clientId,
      testDate,
      itemCount: items.length,
      json,
      orderNo: get(idx.orderNo),
      files: [
        { key: jsonKey, contentType: 'application/json; charset=utf-8', body: jsonBody, bytes: utf8Bytes(jsonBody) },
      ],
    });
  }

  return {
    rows,
    headerFound: {
      drawnDate: idx.drawn >= 0,
      sex: idx.sex >= 0,
      birth: idx.birth >= 0,
      itemCount: idx.itemCount >= 0,
    },
    totalRows: table.length - 1,
  };
}

/* ════════════════════════════════════════════════════════════════════
 * C1-A: production parser (ここから)
 *
 * 正本: docs/lab/demecal_phase_c_spec_20260903.md v0.2 §4.1〜§4.3 / §6。
 *
 * 【なぜ旧 buildBloodCsvBundles と分けるか】
 *   旧経路は「CSV parse + client_id 採番 + JSON 生成 + S3 key 生成」を 1 度に行う。
 *   本番では **本人解決 (指図番号 → diagnostic_user_id) が parse と write の間に入る**ので、
 *   parse だけを取り出せないと「本人が決まる前に client_id を採番する」ことになる。
 *   → **純粋 parse をここに分ける。**
 *
 * 【この region が作らないもの (spec §1)】
 *   client_id / diagnostic_id / exported_at / S3 key / S3PutFile / UUID / 現在時刻。
 *   **この 7 つが 1 つでも出てきたら設計が壊れている。**
 *   `scripts/verify-blood-parser.ts` が**この region のソースを直接読んで**機械確認する
 *   (この region の外＝旧経路にはこれらが在るので、範囲を切って見る必要がある)。
 *
 * 【旧経路との関係】
 *   `buildBloodCsvBundles` は**今回変更しない**。attended 運用 (admin 画面からの取り込み) が
 *   現に使っているため。両者は `buildRowMeasurements` を共有するので、
 *   **measurements の決定論パースは 1 つのまま**。
 * ════════════════════════════════════════════════════════════════════ */

/** production parse の失敗コード (spec §4.2 / §4.3 / §6)。 */
export type BloodParseErrorCode =
  | 'CSV_HEADER_INVALID'
  | 'CSV_NO_DATA_ROWS'
  | 'BLOOD_ROW_ORDER_NO_MISSING'
  | 'BLOOD_ROW_DRAWN_DATE_INVALID'
  | 'BLOOD_ROW_APPROVED_DATE_INVALID'
  | 'BLOOD_ROW_TEST_DATE_INVALID'
  | 'DUPLICATE_EXTERNAL_TEST_ID_IN_CSV';

/**
 * server 側で独立に検査する最低ヘッダ (spec §6)。
 * **専用PC 側の検査 (`demecal-verify.ps1` の `$RequiredCsvHeaders`) を信用して省略しない** —
 * server は別の trust boundary なので、届いたバイト列を自分で検査する。
 */
export const REQUIRED_BLOOD_CSV_HEADERS = ['指図番号', '結果承認日', '結果項目数'] as const;

/**
 * production parse の 1 行。
 *
 * **raw PII を持たない。** 生年月日・氏名・かな・電話・郵便番号・住所・メールは返さない。
 * 生年月日は **age の算出中だけメモリで使い、結果には残さない** (spec §2)。
 */
export interface BloodProductionRow {
  /** CSV のデータ行番号 (1-based)。PII ではない。失敗の指し示しに使う。 */
  rowIndex: number;
  /** 指図番号。**必ず string。数値化しない** (spec §3)。 */
  orderNo: string;
  /** 採血日 (YYYY-MM-DD)。無ければ null。 */
  drawnDate: string | null;
  /** 結果承認日 (YYYY-MM-DD)。**必須**。 */
  approvedDate: string;
  /** 採用した検査日 = drawnDate ?? approvedDate。 */
  testDate: string;
  /** **`'today'` は存在しない** (spec §4)。 */
  dateSource: 'drawn_date' | 'approved_date';
  itemCount: number;
  subject: { sex: string | null; age: number | null };
  measurements: ElithMeasurement[];
  /** CSV の「エラーコード」列 (デメカル側の検査エラー)。parse の失敗コードとは別物。 */
  errorCode: string | null;
  /** CSV の「エラー内容」列。同上。 */
  errorDetail: string | null;
}

export interface BloodParseFailure {
  /** 行に紐づく失敗は 1-based のデータ行番号。batch 全体の失敗は null。 */
  rowIndex: number | null;
  code: BloodParseErrorCode;
  /** 人が読む説明。**PII を入れない** (値そのものを書かない)。 */
  detail: string;
}

export interface BloodProductionParseResult {
  /** **1 件でも失敗があれば false**。呼び出し側は write を 1 件も開始しない (spec §5.8)。 */
  ok: boolean;
  /**
   * 成功時のみ埋まる。**`ok:false` のときは必ず空配列** —
   * 部分的な行を返すと、呼び出し側が「使えるものだけ書く」を選べてしまうため
   * (spec §5.8 preflight all → write later を型で守る)。
   */
  rows: BloodProductionRow[];
  /** 失敗は**全部**返す (1 件ずつ直させない)。 */
  failures: BloodParseFailure[];
  /** ヘッダを除いたデータ行数。ok/失敗にかかわらず入る。 */
  totalRows: number;
  /** §6 の最低ヘッダが揃っていたか。 */
  headerOk: boolean;
}

export interface ParseBloodCsvStrictInput {
  /** デコード済み CSV テキスト、または生バイト列 (Shift_JIS 想定)。 */
  text?: string;
  bytes?: Uint8Array;
}

/**
 * 血液 CSV (デメカル様式) を **本番向けに厳格 parse** する純粋関数。
 *
 * spec v0.2 §4.1〜§4.3 / §6。**S3 も DB も network も触らない。**
 */
export function parseBloodCsvRowsStrict(input: ParseBloodCsvStrictInput): BloodProductionParseResult {
  const text = input.text ?? (input.bytes ? decodeBloodCsv(input.bytes) : '');
  const table = parseCsv(text);
  const failures: BloodParseFailure[] = [];

  if (table.length === 0) {
    return { ok: false, rows: [], totalRows: 0, headerOk: false,
      failures: [{ rowIndex: null, code: 'CSV_HEADER_INVALID', detail: 'CSV に行がありません' }] };
  }

  // ── §6 ヘッダの独立検査 ───────────────────────────────────────
  const header = table[0];
  const missing = REQUIRED_BLOOD_CSV_HEADERS.filter((h) => header.indexOf(h) < 0);
  if (missing.length > 0) {
    return { ok: false, rows: [], totalRows: Math.max(0, table.length - 1), headerOk: false,
      failures: [{ rowIndex: null, code: 'CSV_HEADER_INVALID',
        detail: `必須ヘッダが足りません: ${missing.join(' ')}` }] };
  }

  const totalRows = table.length - 1;
  if (totalRows === 0) {
    // **0 件は parse としては失敗**。「0 件を正常に扱う」(spec §7) のは
    // **CSV レスポンス検査の層**であって、ここではない (呼び出し側が rows=0 を先に判定する)。
    return { ok: false, rows: [], totalRows: 0, headerOk: true,
      failures: [{ rowIndex: null, code: 'CSV_NO_DATA_ROWS', detail: 'データ行がありません' }] };
  }

  const idx = {
    orderNo: colIndex(header, ['指図番号']),
    sex: colIndex(header, ['性別']),
    birth: colIndex(header, ['生年月日']),
    drawn: colIndex(header, ['採血日']),
    approved: colIndex(header, ['結果承認日']),
    errCode: colIndex(header, ['エラーコード']),
    errDetail: colIndex(header, ['エラー内容']),
    itemCount: colIndex(header, ['結果項目数']),
  };

  const rows: BloodProductionRow[] = [];
  for (let r = 1; r < table.length; r++) {
    const rowIndex = r; // 1-based のデータ行番号
    const row = table[r];
    const get = (i: number): string | null => (i >= 0 && i < row.length ? (row[i]?.trim() || null) : null);

    // ── §3 指図番号: 必須・**string のまま**保持する ──────────────
    // 実値は 15 桁前後の数値だが、Number 化すると 16 桁以上で精度が落ち、
    // 先頭 0 も消える。**最初から最後まで文字列**で扱う。
    const orderNoRaw = get(idx.orderNo);
    if (!orderNoRaw) {
      failures.push({ rowIndex, code: 'BLOOD_ROW_ORDER_NO_MISSING', detail: '指図番号が空です' });
      continue;
    }
    const orderNo: string = orderNoRaw;

    // ── §4 日付: today fallback は無い。実在する暦日だけを通す ────
    const approved = normDateStrict(get(idx.approved));
    if (approved.kind !== 'ok') {
      failures.push({ rowIndex, code: 'BLOOD_ROW_APPROVED_DATE_INVALID',
        detail: approved.kind === 'blank'
          ? '結果承認日がありません'
          : '結果承認日が実在する日付ではありません' });
      continue;
    }
    const approvedDate = approved.iso;

    // **「空」と「在るのに不正」を区別する。**
    // 混同すると `2026-02-31` のような行が黙って結果承認日へ落ち、
    // **採血日が別の日に化けたまま納品される**。空のときだけ fallback してよい。
    const drawn = normDateStrict(get(idx.drawn));
    if (drawn.kind === 'invalid') {
      failures.push({ rowIndex, code: 'BLOOD_ROW_DRAWN_DATE_INVALID',
        detail: '採血日が入っていますが実在する日付ではありません' });
      continue;
    }
    const drawnDate = drawn.kind === 'ok' ? drawn.iso : null;
    const testDate = drawnDate ?? approvedDate;
    const dateSource: BloodProductionRow['dateSource'] = drawnDate ? 'drawn_date' : 'approved_date';
    if (!testDate) {
      // 到達しない (approvedDate が非 null なので) が、型と意図を明示するために残す。
      failures.push({ rowIndex, code: 'BLOOD_ROW_TEST_DATE_INVALID', detail: '検査日を決められません' });
      continue;
    }

    const rowSex = normSex(get(idx.sex));
    // **生年月日はここでしか触らない。** age を出したら捨てる (結果に残さない)。
    // 生年月日も strict で見る (`2025-02-29` のような日から年齢を作らない)。
    // ただし生年月日は必須ではないので、不正でも FAIL にはせず age を null にする。
    const birth = normDateStrict(get(idx.birth));
    const age = ageOnStrict(birth.kind === 'ok' ? birth.iso : null, testDate);

    const measurements = buildRowMeasurements(header, row, idx.itemCount, get(idx.itemCount), rowSex);

    rows.push({
      rowIndex, orderNo, drawnDate, approvedDate, testDate, dateSource,
      itemCount: measurements.length,
      subject: { sex: rowSex, age },
      measurements,
      errorCode: get(idx.errCode),
      errorDetail: get(idx.errDetail),
    });
  }

  // ── §4.3 CSV 内の指図番号の重複 → batch 全体 FAIL ───────────────
  // **先頭も末尾も勝手に採用しない。** どちらが正しいかは CSV からは決まらない。
  const seen = new Map<string, number[]>();
  for (const row of rows) {
    const at = seen.get(row.orderNo);
    if (at) at.push(row.rowIndex); else seen.set(row.orderNo, [row.rowIndex]);
  }
  for (const [, at] of seen) {
    if (at.length > 1) {
      failures.push({ rowIndex: null, code: 'DUPLICATE_EXTERNAL_TEST_ID_IN_CSV',
        // **指図番号そのものは detail に書かない** (外部 ID とはいえ最小開示に寄せる)。行番号で指す。
        detail: `同一の指図番号が ${at.length} 行あります (行 ${at.join(', ')})` });
    }
  }

  if (failures.length > 0) {
    return { ok: false, rows: [], failures, totalRows, headerOk: true };
  }
  return { ok: true, rows, failures: [], totalRows, headerOk: true };
}

/**
 * strict 日付の 3 値。**「空」と「在るのに不正」を型で分ける。**
 * 2 値 (string | null) にすると呼び出し側が必ず取り違える — 実際 v1 では
 * `2026-02-31` の採血日が null になり、**結果承認日へ黙って fallback していた**。
 */
type StrictDate =
  | { kind: 'blank' }
  | { kind: 'invalid' }
  | { kind: 'ok'; iso: string };

/** その年月の日数。**閏年を正しく数える** (400 年規則まで)。 */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/**
 * production 用の日付正規化。**実在する暦日だけを通す。**
 *
 * 旧 `normDate` は「月 1〜12 / 日 1〜31」しか見ないので `2026-02-31` や
 * `2026-04-31` を受理する (`2025-02-29` も通る)。医療データの日付なので、
 * **存在しない日をそのまま納品してはいけない。**
 * 旧 `normDate` は attended 経路が使っているため**変更しない**。ここは strict 専用。
 *
 * **`Date` を一切使わない** — production parser は現在時刻を作ってはいけないので、
 * `new Date(...)` を region に持ち込まずに算術だけで判定する。
 */
function normDateStrict(v: string | undefined | null): StrictDate {
  const raw = (v ?? '').trim();
  if (!raw) return { kind: 'blank' };
  const m = /(\d{4})\D?(\d{1,2})\D?(\d{1,2})/.exec(raw);
  if (!m) return { kind: 'invalid' };
  const Y = +m[1], M = +m[2], D = +m[3];
  // 年の範囲: 生年月日 (古い) と検査日 (未来寄り) の両方を通すが、
  // 0000 年のような明らかな異常は落とす。
  if (Y < 1900 || Y > 2999) return { kind: 'invalid' };
  if (M < 1 || M > 12) return { kind: 'invalid' };
  if (D < 1 || D > daysInMonth(Y, M)) return { kind: 'invalid' };
  return { kind: 'ok', iso: `${String(Y).padStart(4, '0')}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}` };
}

/**
 * 満年齢。**基準日は必須** — `ageAt` は refIso が null のとき「今日」へ落ちるが、
 * production parser は現在時刻を使ってはいけないので、落ちない版をここに持つ。
 */
function ageOnStrict(birthIso: string | null, refIso: string): number | null {
  if (!birthIso) return null;
  const b = birthIso.split('-').map(Number);
  const ref = refIso.split('-').map(Number);
  if (b.length !== 3 || ref.length !== 3) return null;
  let age = ref[0] - b[0];
  if (ref[1] < b[1] || (ref[1] === b[1] && ref[2] < b[2])) age--;
  return age >= 0 && age < 150 ? age : null;
}

/* ════════════════════════════════════════════════════════════════════
 * C1-A: production parser (ここまで)
 * ════════════════════════════════════════════════════════════════════ */
