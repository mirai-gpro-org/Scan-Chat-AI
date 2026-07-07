/**
 * 血液検査 CSV (デメカル様式) → Elith `BloodTestData` への決定論パーサ (サーバ専用)。
 *
 * 設計 (docs: elith_s3_data_handoff_spec.md §7.1 / demecal_auto_download_overview_spec.md):
 *   - CSV は「自己記述型」: 固定メタ列 + `結果項目数` + (項目名N / 項目区分N / 検査値N) の繰り返し。
 *     → 検査項目が増減・改称してもコード修正不要 (項目名をハードコードしない汎用転記)。
 *   - LLM は使わない。構造化データは決定論パースで値を完全転記する (検査値は誤り厳禁)。
 *   - PII 厳守 (CLAUDE.md): 氏名・かな・住所・電話・メール・生年月日は **Elith JSON に載せない**。
 *     subject は性別 + 年齢 (生年月日から算出) のみ。原本 CSV は PII を含むため S3 へ置かない。
 *   - client_id は呼び出し側が採番 (テストは自動採番)。日付は `採血日`。
 *   - Shift_JIS で受領するため TextDecoder('shift-jis') でデコード。
 */

import { ELITH_HANDOFF_SCHEMA_VERSION } from './elith-export';
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

// ── CSV パース (ダブルクォート対応・埋め込み改行は非対応=本データに無い) ──
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; }
      } else cur += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(text: string): string[][] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => l.length > 0)
    .map(splitCsvLine);
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
export interface BloodItem {
  name: string;
  category: string | null;
  value: string | null;
}
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
  data: { item_count: number; items: BloodItem[] };
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

    // 検査項目: 結果項目数の直後から (項目名, 項目区分, 検査値) を itemCount 組 読む。
    // 結果項目数が欠損/不正でも、以降を 3 列ずつ末尾まで読み切る (汎用・堅牢)。
    const declared = Number(get(idx.itemCount) ?? '');
    const startCol = idx.itemCount >= 0 ? idx.itemCount + 1 : -1;
    const items: BloodItem[] = [];
    if (startCol >= 0) {
      const maxTriples = Math.floor((row.length - startCol) / 3);
      const n = Number.isFinite(declared) && declared > 0 ? Math.min(declared, maxTriples) : maxTriples;
      for (let k = 0; k < n; k++) {
        const base = startCol + k * 3;
        const name = row[base]?.trim() || '';
        if (!name) continue;
        items.push({
          name,
          category: row[base + 1]?.trim() || null,
          value: row[base + 2]?.trim() ?? null,
        });
      }
    }

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
      subject: { sex: normSex(get(idx.sex)), age: ageAt(birthIso, testDate) },
      source: {
        origin: 'scan-chat-ai',
        app: 'scan-chat-ai',
        model: null,
        note: 'admin バッチ (血液CSV・決定論パース)。書式は暫定。',
        lab_name: 'demecal',
        error_code: get(idx.errCode),
        error_detail: get(idx.errDetail),
      },
      data: { item_count: items.length, items },
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
