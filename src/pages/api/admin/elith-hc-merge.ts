/**
 * admin: 検診・人間ドック (HealthCheckupData) の複数画像を 1 検査へマージ。
 *
 * 1 回の複数選択 = 1 人分の 1 検査。複数シート(画像)を 1 つの JSON にマージし、
 * 元画像は全て連番で書き出す (docs/elith_batch_centralization_design.md / CLAUDE.md)。
 * CLAUDE.md 原則「1 画像 = 1 リクエスト(60s制約)」を守り、クライアントが順に呼ぶ:
 *   - action=part     : 1 画像をスキャン → 元画像を連番で S3 保存 → 解析結果を返す(JSONは書かない)
 *   - action=finalize : 全 part の測定値をマージ → 1 つの HealthCheckupData JSON を S3 保存
 * キー(GEMINI_API_KEY / AWS_*)はサーバ環境変数のみ (Vercel 一元管理)。
 *
 * 認可: wellfort-site から Bearer ADMIN_API_KEY。env 未設定(dev)のみ省略。
 */

import type { APIRoute } from 'astro';
import {
  scanImageToParsed,
  extFromMime,
  ELITH_HANDOFF_SCHEMA_VERSION,
  sanitizeMeasurementsForDelivery,
  type ParsedScan,
} from '../../../lib/elith-export';
import { MODELS } from '../../../lib/gemini';
import { getS3Config, isS3Configured, putFiles, type S3PutFile } from '../../../lib/s3';
import { checkNecessity } from '../../../lib/elith-necessity-check';

export const prerender = false;

function envKey(name: string): string | undefined {
  const m = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (m != null && m !== '') return m;
  const p = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return p != null && p !== '' ? p : undefined;
}
function authorized(request: Request): boolean {
  const expected = envKey('ADMIN_API_KEY');
  if (!expected) return true;
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return !!m && m[1] === expected;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function parseImage(input: string): { mime: string; data: string } {
  const m = /^data:([^;]+);base64,(.+)$/i.exec(input.trim());
  if (m) return { mime: m[1], data: m[2] };
  return { mime: '', data: input.trim() };
}
function randomUuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}
function utf8Bytes(s: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : Buffer.byteLength(s, 'utf-8');
}
function folderOf(prefix: string, clientId: string, testDate: string): { folder: string; dateFolder: string; stem: string } {
  const dateFolder = testDate.replace(/-/g, '_');
  const cleanPrefix = prefix ? prefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
  const folder = `${cleanPrefix}user/${clientId}/date/${dateFolder}/`;
  return { folder, dateFolder, stem: `HealthCheckupData_date_${dateFolder}_user_${clientId}` };
}

interface Body {
  action?: unknown;
  image?: unknown;
  mimeType?: unknown;
  clientId?: unknown;
  seq?: unknown;
  examDate?: unknown;
  hint?: unknown;
  testDate?: unknown;
  parts?: unknown;
  sourceFiles?: unknown;
}

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) {
    return json({ ok: false, error: 'unauthorized', detail: 'Invalid API key' }, 401);
  }
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const action = str(body.action) ?? 'part';
  const clientId = str(body.clientId);
  if (!clientId) return json({ ok: false, error: 'clientId is required' }, 400);

  const cfg = getS3Config();
  const prefix = cfg?.prefix ?? '';

  // ── action = part: 1 画像スキャン + 連番画像を書き出し ──
  if (action === 'part') {
    const image = typeof body.image === 'string' ? body.image : '';
    if (!image.trim()) return json({ ok: false, error: 'image is required (data URL or base64)' }, 400);
    const seq = typeof body.seq === 'number' && body.seq > 0 ? Math.floor(body.seq) : 1;
    const parsedImg = parseImage(image);
    const mimeType = parsedImg.mime || str(body.mimeType) || 'image/jpeg';

    let scan: ParsedScan;
    try {
      scan = await scanImageToParsed({ imageBase64: parsedImg.data, mimeType, examDate: str(body.examDate), hint: str(body.hint) });
    } catch (err) {
      return json({ ok: false, error: 'scan failed', detail: String(err instanceof Error ? err.message : err) }, 502);
    }

    const { folder, stem } = folderOf(prefix, clientId, scan.testDate);
    const imageKey = `${folder}${stem}_${String(seq).padStart(2, '0')}${extFromMime(mimeType)}`;

    let uploadedKey: string | null = null;
    if (isS3Configured() && cfg) {
      const imageBytes = Uint8Array.from(Buffer.from(parsedImg.data, 'base64'));
      const files: S3PutFile[] = [{ key: imageKey, contentType: mimeType, body: imageBytes, bytes: imageBytes.length }];
      try {
        await putFiles(files);
        uploadedKey = imageKey;
      } catch (err) {
        return json({ ok: false, configured: true, error: 'S3 upload failed', detail: String(err) }, 502);
      }
    }

    return json({
      ok: true,
      action: 'part',
      configured: isS3Configured(),
      seq,
      test_date: scan.testDate,
      date_source: scan.dateSource,
      image_key: uploadedKey ?? imageKey,
      rows: scan.measurements.length,
      // finalize でマージするため part の解析結果を返す
      measurements: scan.measurements,
      regions: scan.regions,
      notes: scan.notes,
      raw_markdown: scan.markdown,
      finish_reason: scan.finishReason,
      vqa_audit: scan.vqaAudit, // VQA 再読の監査 (可視化用・Elith 納品 data には含めない)
      scan_model: MODELS.scan, // 実際に使用したスキャンモデル (lite/3.5 判別用)
    });
  }

  // ── action = finalize: 全 part をマージして 1 JSON を書き出し ──
  if (action === 'finalize') {
    const testDate = str(body.testDate);
    if (!testDate || !/^\d{4}-\d{2}-\d{2}$/.test(testDate)) {
      return json({ ok: false, error: 'testDate (YYYY-MM-DD) is required for finalize' }, 400);
    }
    const parts = Array.isArray(body.parts) ? (body.parts as Array<Record<string, unknown>>) : [];
    if (parts.length === 0) return json({ ok: false, error: 'parts is required for finalize' }, 400);

    const rawMeasurements: unknown[] = [];
    const notes: string[] = [];
    const markdowns: string[] = [];
    for (const p of parts) {
      if (Array.isArray(p.measurements)) rawMeasurements.push(...p.measurements);
      if (Array.isArray(p.notes)) notes.push(...(p.notes as string[]));
      if (typeof p.raw_markdown === 'string' && p.raw_markdown.trim()) markdowns.push(p.raw_markdown);
    }
    // 書き出し時点で lean 正規化 (↑↓→flag/value_num・空行/総合判定欄 除外・妥当性ガード)。
    // 監査は raw_markdown + 元画像(S3) に保持。全マージ分をまとめて 1 回で正規化する。
    const measurements = sanitizeMeasurementsForDelivery(rawMeasurements).kept;
    const sourceFiles = Array.isArray(body.sourceFiles) ? (body.sourceFiles as unknown[]).filter((x): x is string => typeof x === 'string') : [];

    const { folder, stem } = folderOf(prefix, clientId, testDate);
    const json_key = `${folder}${stem}.json`;
    const jsonObj = {
      format_id: 'HealthCheckupData',
      schema_version: ELITH_HANDOFF_SCHEMA_VERSION,
      kind: 'scan_merged',
      client_id: clientId,
      diagnostic_id: randomUuid(),
      source_images: sourceFiles,
      part_count: parts.length,
      test_date: testDate,
      date_source: 'merged',
      exported_at: new Date().toISOString(),
      subject: { sex: null, age: null },
      source: {
        origin: 'scan-chat-ai',
        app: 'scan-chat-ai',
        model: MODELS.scan,
        note: 'admin バッチ (AIスキャン・複数画像を1検査へマージ)。書式は暫定。',
        lab_name: null,
      },
      // 納品 data は共通 measurements[] + notes のみ (版面座標 regions/bbox は含めない・§7.1)。
      data: { measurements, notes },
      raw_markdown: markdowns.join('\n\n---\n\n'),
    };
    const jsonBody = JSON.stringify(jsonObj, null, 2);
    const necessity = checkNecessity(jsonObj); // 不要項目チェック(必要要素検証)

    if (!isS3Configured() || !cfg) {
      return json({ ok: false, configured: false, reason: 's3_not_configured', json_key, rows: measurements.length, necessity, scan_model: MODELS.scan, preview: jsonObj });
    }
    try {
      const uploaded = await putFiles([{ key: json_key, contentType: 'application/json; charset=utf-8', body: jsonBody, bytes: utf8Bytes(jsonBody) }]);
      return json({
        ok: true, action: 'finalize', configured: true, bucket: cfg.bucket,
        client_id: clientId, format_id: 'HealthCheckupData', test_date: testDate,
        part_count: parts.length, rows: measurements.length, json_key, necessity,
        scan_model: MODELS.scan, // 実際に使用したスキャンモデル (lite/3.5 判別用)
        uri: uploaded[0]?.uri ?? null,
      });
    } catch (err) {
      return json({ ok: false, configured: true, error: 'S3 upload failed', detail: String(err) }, 502);
    }
  }

  return json({ ok: false, error: `unknown action: ${action}` }, 400);
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
