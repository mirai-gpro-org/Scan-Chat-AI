/**
 * AI スキャン読込結果 → Elith 連携用エクスポート (暫定 scan-export-v0)
 *
 * 目的:
 *   読込精度確認テストのため、確定済 scan markdown を構造化 JSON へ変換し、
 *   md / manifest と合わせて S3 バケットへ書き出す (Elith 側のテストデータ補充)。
 *
 * 命名/フォーマットは「暫定」。Elith 側の正式仕様確定後に schema_version を bump する。
 * フォルダ/ファイル規約は docs/architecture/diagnostic_session_data_spec.md §3.5/§3.6 に準拠:
 *
 *   {diagnostic_id}/
 *     scan-{ISO8601圧縮}.json   ← 構造化 (メイン)
 *     scan-{ISO8601圧縮}.md     ← 確定 Markdown (精度突合用)
 *     manifest.json             ← 索引
 *
 * 本モジュールは DOM/AWS に依存しない純粋関数のみ (サーバ/クライアント両用)。
 */

export const SCAN_EXPORT_SCHEMA_VERSION = 'scan-export-v0';

export interface ScanTableRowJson {
  /** ヘッダ名 → セル値 (重複ヘッダは _2, _3… を付与) */
  by_column: Record<string, string>;
  /** 元の生セル配列 (列数がヘッダと食い違う行も保持) */
  cells: string[];
}

export interface ScanRegionJson {
  index: number;
  label: string;
  /** [ymin, xmin, ymax, xmax] (0.0-1.0) / 無ければ null */
  bbox: [number, number, number, number] | null;
  type: 'table' | 'notes';
  /** type=table */
  columns?: string[];
  rows?: ScanTableRowJson[];
  /** type=notes (手書きメモ等) */
  notes?: string[];
}

export interface ScanExportMeta {
  diagnosticId: string;
  diagnosticUserId?: string | null;
  /** Gemini モデル名など (任意) */
  model?: string | null;
  /** スキャン時の補足プロンプト (任意) */
  hint?: string | null;
  /** 読込元ファイル名 (アップロード時)。書き出しファイル名に一部を組み込む */
  sourceFileName?: string | null;
  /** 撮影/解析時刻。未指定なら exported_at と同じ */
  capturedAt?: Date;
  exportedAt?: Date;
}

export interface ScanExportJson {
  schema_version: typeof SCAN_EXPORT_SCHEMA_VERSION;
  kind: 'scan_result';
  diagnostic_id: string;
  diagnostic_user_id: string | null;
  captured_at: string;
  exported_at: string;
  source: {
    app: 'scan-chat-ai';
    model: string | null;
    hint: string | null;
    /** 読込元ファイル名 (原本) */
    file: string | null;
    note: string;
  };
  region_count: number;
  row_count: number;
  regions: ScanRegionJson[];
  /** 確定 Markdown (人/Elith が原本突合に使う) */
  raw_markdown: string;
}

// ── Markdown パース (サーバ安全な自己完結版) ───────────────────

const HEADING_RE = /^#{1,6}\s+(.+?)\s*$/;
const BBOX_RE = /<!--\s*bbox:\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*-->/i;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

function isTablePipe(line: string): boolean {
  return /^\s*\|/.test(line);
}
function isSeparator(line: string): boolean {
  return /^\|[\s\-:|]+\|?$/.test(line.trim());
}

/** ヘッダ重複を _2, _3… で一意化 */
function uniqueHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h) => {
    const key = h || '_';
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n === 1 ? key : `${key}_${n}`;
  });
}

function regionFromBody(label: string, bbox: ScanRegionJson['bbox'], body: string, index: number): ScanRegionJson {
  const lines = body.split('\n');
  const pipeLines = lines.filter(isTablePipe).map((l) => l.trim());

  if (pipeLines.length >= 3) {
    const headers = splitRow(pipeLines[0]);
    const sepIdx = pipeLines.findIndex(isSeparator);
    if (sepIdx >= 0) {
      const cols = uniqueHeaders(headers);
      const rows: ScanTableRowJson[] = pipeLines.slice(sepIdx + 1).map((line) => {
        const cells = splitRow(line);
        const by_column: Record<string, string> = {};
        cols.forEach((c, i) => {
          by_column[c] = cells[i] ?? '';
        });
        return { by_column, cells };
      });
      return { index, label, bbox, type: 'table', columns: cols, rows };
    }
  }

  // テーブルでなければ notes (箇条書き/自由テキスト)
  const notes = lines
    .map((l) => l.replace(/^\s*[-*・]\s?/, '').trim())
    .filter((l) => l.length > 0 && !BBOX_RE.test(l));
  return { index, label, bbox, type: 'notes', notes };
}

/** 確定 Markdown を領域配列へパース */
export function parseScanRegions(markdown: string): ScanRegionJson[] {
  const lines = markdown.split('\n');
  const regions: ScanRegionJson[] = [];
  let cur: { label: string; bbox: ScanRegionJson['bbox']; body: string[] } | null = null;

  const flush = (): void => {
    if (cur) regions.push(regionFromBody(cur.label, cur.bbox, cur.body.join('\n').trim(), regions.length));
    cur = null;
  };

  for (const line of lines) {
    const h = HEADING_RE.exec(line);
    if (h) {
      flush();
      cur = { label: h[1].trim(), bbox: null, body: [] };
      continue;
    }
    if (!cur) {
      // 見出し前の前文があれば暗黙領域として拾う
      if (line.trim()) cur = { label: '(無題領域)', bbox: null, body: [line] };
      continue;
    }
    const b = BBOX_RE.exec(line);
    if (b && !cur.bbox) {
      cur.bbox = [clamp01(+b[1]), clamp01(+b[2]), clamp01(+b[3]), clamp01(+b[4])];
      continue; // bbox コメント行は body に含めない
    }
    cur.body.push(line);
  }
  flush();
  return regions;
}

/** 確定 Markdown → 構造化 JSON */
export function markdownToScanJson(markdownClean: string, meta: ScanExportMeta): ScanExportJson {
  const exportedAt = meta.exportedAt ?? new Date();
  const capturedAt = meta.capturedAt ?? exportedAt;
  const regions = parseScanRegions(markdownClean);
  const rowCount = regions.reduce((sum, r) => sum + (r.rows?.length ?? 0), 0);

  return {
    schema_version: SCAN_EXPORT_SCHEMA_VERSION,
    kind: 'scan_result',
    diagnostic_id: meta.diagnosticId,
    diagnostic_user_id: meta.diagnosticUserId ?? null,
    captured_at: capturedAt.toISOString(),
    exported_at: exportedAt.toISOString(),
    source: {
      app: 'scan-chat-ai',
      model: meta.model ?? null,
      hint: meta.hint ?? null,
      file: meta.sourceFileName?.trim() || null,
      note: 'AIスキャン読込精度確認テスト用。命名・フォーマットは暫定。',
    },
    region_count: regions.length,
    row_count: rowCount,
    regions,
    raw_markdown: markdownClean,
  };
}

// ── バンドル生成 (S3 へ置くファイル群) ─────────────────────────

export interface ScanExportFile {
  /** フォルダ内ファイル名 */
  name: string;
  /** バケット内 key (prefix + folder + name) */
  key: string;
  contentType: string;
  body: string;
  bytes: number;
}

export interface ScanExportBundle {
  diagnosticId: string;
  /** バケット内フォルダ (末尾 / 付き、prefix 込み) */
  folder: string;
  timestamp: string;
  files: ScanExportFile[];
  json: ScanExportJson;
}

/** ISO8601 を JST のコンパクト表記 (YYYYMMDDTHHMMSS) にする (ファイル名一意化用) */
export function compactJstStamp(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${jst.getUTCFullYear()}${p(jst.getUTCMonth() + 1)}${p(jst.getUTCDate())}` +
    `T${p(jst.getUTCHours())}${p(jst.getUTCMinutes())}${p(jst.getUTCSeconds())}`
  );
}

/**
 * 読込元ファイル名 → ファイル名に埋め込めるスラッグ。
 * 例: "がんリスク検査 (2026).pdf" → "がんリスク検査-2026"
 *  - ディレクトリ/拡張子を除去
 *  - 空白・S3/FS で問題になる記号を `-` 化、連続 `-` を圧縮
 *  - 40 文字に制限。空になったら '' (= スラッグ無し)
 */
export function sourceFileSlug(name: string | null | undefined): string {
  if (!name) return '';
  let base = name.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  base = base
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|#%\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length > 40) base = base.slice(0, 40).replace(/-+$/, '');
  return base;
}

function utf8Bytes(s: string): number {
  // サーバ/ブラウザ両対応の UTF-8 バイト長
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  return Buffer.byteLength(s, 'utf-8');
}

/**
 * scan.json / scan.md / manifest.json の3点セットを生成する (画像は同梱しない)。
 * @param prefix バケット内共通プレフィックス (例 "scan-accuracy-test/")。空可。
 */
export function buildScanExportBundle(
  markdownClean: string,
  meta: ScanExportMeta,
  prefix = '',
): ScanExportBundle {
  const json = markdownToScanJson(markdownClean, meta);
  const stamp = compactJstStamp(meta.exportedAt ?? new Date());
  const cleanPrefix = prefix ? prefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
  const folder = `${cleanPrefix}${meta.diagnosticId}/`;

  // 読込元ファイル名の一部を書き出しファイル名に組み込む (例 scan-血液検査-20260619T....json)
  const slug = sourceFileSlug(meta.sourceFileName);
  const stem = slug ? `scan-${slug}-${stamp}` : `scan-${stamp}`;
  const jsonName = `${stem}.json`;
  const mdName = `${stem}.md`;

  const jsonBody = JSON.stringify(json, null, 2);
  const mdBody = markdownClean.endsWith('\n') ? markdownClean : `${markdownClean}\n`;

  const manifest = {
    diagnostic_id: meta.diagnosticId,
    schema_version: SCAN_EXPORT_SCHEMA_VERSION,
    kind: 'scan_test_export',
    created_at: (meta.exportedAt ?? new Date()).toISOString(),
    source_file: meta.sourceFileName?.trim() || null,
    note: 'AIスキャン読込精度確認テスト用。命名/フォーマットは暫定。',
    artifacts: [
      { type: 'scan_json', file: jsonName, bytes: utf8Bytes(jsonBody), mime: 'application/json' },
      { type: 'scan_md', file: mdName, bytes: utf8Bytes(mdBody), mime: 'text/markdown' },
    ],
  };
  const manifestBody = JSON.stringify(manifest, null, 2);

  const mk = (name: string, contentType: string, body: string): ScanExportFile => ({
    name,
    key: `${folder}${name}`,
    contentType,
    body,
    bytes: utf8Bytes(body),
  });

  return {
    diagnosticId: meta.diagnosticId,
    folder,
    timestamp: stamp,
    json,
    files: [
      mk(jsonName, 'application/json; charset=utf-8', jsonBody),
      mk(mdName, 'text/markdown; charset=utf-8', mdBody),
      mk('manifest.json', 'application/json; charset=utf-8', manifestBody),
    ],
  };
}
