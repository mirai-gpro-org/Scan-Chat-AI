/**
 * Elith 連携用エクスポート (共有サーバモジュール)。
 *
 * 画像 (検査結果) → AIスキャン(Gemini) → Elith エンベロープ(elith-handoff-v0.1) →
 * S3 に置く「JSON + 元画像(同名・拡張子替え)」のファイル群を生成する。
 *
 * - キー(GEMINI_API_KEY)は **サーバ環境変数からのみ**取得 (CLAUDE.md: Vercel 一元管理)。
 * - スキャンのプロンプト/設定は scan-prompt.ts を共用 (scan.ts と同一ロジック)。
 * - パス/命名は docs/elith_s3_data_handoff_spec.md に準拠。
 * - Vercel 実行モデルに合わせ **1 画像 = 1 呼び出し** (呼び出し側がループ)。
 *
 * サーバ専用 (GEMINI_API_KEY を読むため、クライアントから呼ばない)。
 */

import { callGemini, MODELS, extractText } from './gemini';
import {
  ANALYZE_SYSTEM,
  SCAN_GENERATION_CONFIG,
  buildScanUserText,
  EXAM_DATE_INSTRUCTION,
} from './scan-prompt';
import { parseScanRegions, type ScanRegionJson } from './scan-export';
import type { S3PutFile } from './s3';

export const ELITH_HANDOFF_SCHEMA_VERSION = 'elith-handoff-v0.1';

export const ELITH_FORMAT_IDS = [
  'CancerRiskAssessmentData',
  'HealthCheckupData',
  'GeneticTestResultData',
  'BloodTestData',
  'LifestyleQuestionnaireData',
  'Other',
] as const;
export type ElithFormatId = (typeof ELITH_FORMAT_IDS)[number];

export function isElithFormatId(v: unknown): v is ElithFormatId {
  return typeof v === 'string' && (ELITH_FORMAT_IDS as readonly string[]).includes(v);
}

// ── env (サーバ専用) ────────────────────────────────────────────
function env(name: string): string | undefined {
  const fromMeta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (fromMeta != null && fromMeta !== '') return fromMeta;
  const fromProc = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return fromProc != null && fromProc !== '' ? fromProc : undefined;
}
export function getGeminiApiKey(): string | undefined {
  return env('GEMINI_API_KEY');
}
export function isGeminiConfigured(): boolean {
  return !!getGeminiApiKey();
}

// ── MIME / 拡張子 ───────────────────────────────────────────────
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/tiff': '.tif',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
};
export function isSupportedMime(mime: string): boolean {
  return mime in MIME_TO_EXT;
}
export function extFromMime(mime: string): string {
  return MIME_TO_EXT[mime] ?? '.bin';
}

// ── 日付 ────────────────────────────────────────────────────────
export function jstTodayIso(now: Date = new Date()): string {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())}`;
}
function isoDate(y: string, mo: string, d: string): string | null {
  const Y = +y, M = +mo, D = +d;
  if (M < 1 || M > 12 || D < 1 || D > 31) return null;
  return `${String(Y).padStart(4, '0')}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}`;
}
/** 検査日: 先頭コメント <!-- exam_date --> → 本文の日付 → today */
export function extractExamDate(markdown: string, todayIso: string): { date: string; source: string } {
  const m = /<!--\s*exam_date:\s*(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/i.exec(markdown);
  if (m) {
    const d = isoDate(m[1], m[2], m[3]);
    if (d) return { date: d, source: 'exam_date' };
  }
  const re = /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/g;
  let g: RegExpExecArray | null;
  while ((g = re.exec(markdown))) {
    const d = isoDate(g[1], g[2], g[3]);
    if (d) return { date: d, source: 'markdown' };
  }
  return { date: todayIso, source: 'today' };
}
function stripExamComment(md: string): string {
  return md.replace(/^\s*<!--\s*exam_date:[^>]*-->\s*\n?/i, '');
}

// ── 計測値 (表領域 → measurements[]) ────────────────────────────
export interface ElithMeasurement {
  region: string;
  no: string | null;
  name: string | null;
  name_detail: string | null;
  value: string | null;
  inferred: string | null;
  unit: string | null;
  ref_low: string | null;
  ref_high: string | null;
  flag: string | null;
  note: string | null;
}
function pickCol(cols: string[], names: string[]): number {
  for (const n of names) {
    const i = cols.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}
function toMeasurements(regions: ScanRegionJson[]): ElithMeasurement[] {
  const out: ElithMeasurement[] = [];
  for (const r of regions) {
    if (r.type !== 'table' || !r.columns || !r.rows) continue;
    const c = r.columns;
    const idx = {
      no: pickCol(c, ['No', 'no']),
      name: pickCol(c, ['検査項目']),
      detail: pickCol(c, ['検査項目詳細']),
      value: pickCol(c, ['読み取った値', '結果', '値']),
      inferred: pickCol(c, ['推論値']),
      unit: pickCol(c, ['単位', '単位名称']),
      low: pickCol(c, ['下限値']),
      high: pickCol(c, ['上限値']),
      flag: pickCol(c, ['判定']),
      note: pickCol(c, ['備考']),
    };
    for (const row of r.rows) {
      const g = (i: number): string => (i >= 0 && i < row.cells.length ? row.cells[i] : '') || '';
      const name = g(idx.name);
      if (!name && !g(idx.value)) continue;
      out.push({
        region: r.label,
        no: g(idx.no) || null,
        name: name || null,
        name_detail: g(idx.detail) || null,
        value: g(idx.value) || null,
        inferred: g(idx.inferred) || null,
        unit: g(idx.unit) || null,
        ref_low: g(idx.low) || null,
        ref_high: g(idx.high) || null,
        flag: g(idx.flag) || null,
        note: g(idx.note) || null,
      });
    }
  }
  return out;
}
function collectNotes(regions: ScanRegionJson[]): string[] {
  const out: string[] = [];
  for (const r of regions) if (r.type === 'notes' && r.notes?.length) out.push(...r.notes);
  return out;
}

// ── Gemini スキャン (1 画像) ────────────────────────────────────
async function scanImage(
  apiKey: string,
  imageBase64: string,
  mimeType: string,
  hint?: string | null,
): Promise<{ markdown: string; finishReason: string | null }> {
  const res = await callGemini(
    apiKey,
    {
      systemInstruction: { parts: [{ text: ANALYZE_SYSTEM }] },
      contents: [
        {
          role: 'user',
          parts: [
            { inline_data: { mime_type: mimeType, data: imageBase64 } },
            { text: buildScanUserText(hint) + EXAM_DATE_INSTRUCTION },
          ],
        },
      ],
      generationConfig: { ...SCAN_GENERATION_CONFIG },
    },
    MODELS.scan,
  );
  return { markdown: extractText(res), finishReason: res.candidates?.[0]?.finishReason ?? null };
}

// ── バンドル生成 ────────────────────────────────────────────────
export interface ElithScanInput {
  formatId: ElithFormatId;
  clientId: string;
  imageBase64: string;
  mimeType: string;
  sourceFileName?: string | null;
  /** 呼び出し側が検査日を明示する場合 (YYYY-MM-DD)。未指定なら画像から抽出→today */
  examDate?: string | null;
  /** 検査日不明時の today (YYYY-MM-DD, JST)。未指定なら実行時 JST */
  today?: string;
  /** バケット内共通プレフィックス */
  prefix?: string;
  diagnosticId?: string;
  hint?: string | null;
}

export interface ElithScanBundle {
  formatId: ElithFormatId;
  clientId: string;
  testDate: string;
  dateSource: string;
  dateFolder: string;
  folder: string;
  jsonKey: string;
  imageKey: string;
  json: unknown;
  markdown: string;
  finishReason: string | null;
  files: S3PutFile[];
}

function utf8Bytes(s: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : Buffer.byteLength(s, 'utf-8');
}
function randomUuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

/**
 * 1 画像を Elith 形式で S3 に置くためのバンドル (JSON + 元画像) を生成する。
 * Gemini 呼び出しを含む (サーバ側)。S3 への put は呼び出し側で行う (s3.putFiles)。
 */
export async function buildElithScanBundle(input: ElithScanInput): Promise<ElithScanBundle> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured (server env)');
  if (!isSupportedMime(input.mimeType)) throw new Error(`unsupported mime: ${input.mimeType}`);

  const { markdown, finishReason } = await scanImage(apiKey, input.imageBase64, input.mimeType, input.hint);
  if (!markdown.trim()) throw new Error(`empty scan result (finishReason=${finishReason})`);

  const todayIso = input.today || jstTodayIso();
  let testDate: string;
  let dateSource: string;
  const provided = input.examDate && /^\d{4}-\d{2}-\d{2}$/.test(input.examDate) ? input.examDate : null;
  if (provided) {
    testDate = provided;
    dateSource = 'provided';
  } else {
    const ex = extractExamDate(markdown, todayIso);
    testDate = ex.date;
    dateSource = ex.source;
  }
  const dateFolder = testDate.replace(/-/g, '_');

  const regions = parseScanRegions(markdown);
  const diagnosticId = input.diagnosticId || randomUuid();
  const json = {
    format_id: input.formatId,
    schema_version: ELITH_HANDOFF_SCHEMA_VERSION,
    kind: 'scan',
    client_id: input.clientId,
    diagnostic_id: diagnosticId,
    source_image: input.sourceFileName ?? null,
    test_date: testDate,
    date_source: dateSource,
    exported_at: new Date().toISOString(),
    subject: { sex: null, age: null },
    source: {
      origin: 'scan-chat-ai',
      app: 'scan-chat-ai',
      model: MODELS.scan,
      note: 'admin バッチ (AIスキャン)。命名/フォーマットは暫定。',
      lab_name: null,
      finish_reason: finishReason,
    },
    data: {
      measurements: toMeasurements(regions),
      notes: collectNotes(regions),
      regions,
    },
    raw_markdown: stripExamComment(markdown),
  };

  const prefix = input.prefix ? input.prefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
  const folder = `${prefix}user/${input.clientId}/date/${dateFolder}/`;
  const stem = `${input.formatId}_date_${dateFolder}_user_${input.clientId}`;
  const jsonKey = `${folder}${stem}.json`;
  const imageKey = `${folder}${stem}${extFromMime(input.mimeType)}`;

  const jsonBody = JSON.stringify(json, null, 2);
  const imageBytes = Uint8Array.from(Buffer.from(input.imageBase64, 'base64'));

  const files: S3PutFile[] = [
    { key: jsonKey, contentType: 'application/json; charset=utf-8', body: jsonBody, bytes: utf8Bytes(jsonBody) },
    { key: imageKey, contentType: input.mimeType, body: imageBytes, bytes: imageBytes.length },
  ];

  return {
    formatId: input.formatId,
    clientId: input.clientId,
    testDate,
    dateSource,
    dateFolder,
    folder,
    jsonKey,
    imageKey,
    json,
    markdown,
    finishReason,
    files,
  };
}
