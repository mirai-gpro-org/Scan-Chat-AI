/**
 * AI スキャン読込結果を Elith 連携用に S3 へ書き出すエンドポイント (暫定テスト用)。
 *
 * 入力 (POST JSON):
 *   {
 *     markdownClean: string,        // 確定 Markdown (必須)
 *     diagnosticId?: string,        // 端末発番の UUID。無ければサーバで生成
 *     diagnosticUserId?: string|null,
 *     model?: string|null,
 *     hint?: string|null,
 *     capturedAt?: string           // ISO8601 (任意)
 *   }
 *
 * 出力:
 *   - S3 設定あり: { ok:true, configured:true, bucket, folder, uploaded:[{key,bytes,uri}], json }
 *   - S3 未設定 : { ok:false, configured:false, folder, files:[{name,bytes}], json }  ← ドライラン
 *
 * 命名/フォーマットは暫定 (scan-export-v0)。詳細は docs/scan_s3_export.md / lib/scan-export.ts。
 */

import type { APIRoute } from 'astro';
import { buildScanExportBundle } from '../../../lib/scan-export';
import { getS3Config, isS3Configured, putScanFiles } from '../../../lib/s3';

export const prerender = false;

interface ExportBody {
  markdownClean?: unknown;
  diagnosticId?: unknown;
  diagnosticUserId?: unknown;
  model?: unknown;
  hint?: unknown;
  capturedAt?: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export const POST: APIRoute = async ({ request }) => {
  let body: ExportBody;
  try {
    body = (await request.json()) as ExportBody;
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const markdownClean = typeof body.markdownClean === 'string' ? body.markdownClean : '';
  if (!markdownClean.trim()) {
    return json({ ok: false, error: 'markdownClean is required' }, 400);
  }

  const diagnosticId = str(body.diagnosticId) ?? crypto.randomUUID();
  const diagnosticUserId = str(body.diagnosticUserId);
  const capturedRaw = str(body.capturedAt);
  const capturedAt = capturedRaw && !Number.isNaN(Date.parse(capturedRaw)) ? new Date(capturedRaw) : undefined;
  const exportedAt = new Date();

  const cfg = getS3Config();
  const prefix = cfg?.prefix ?? '';

  const bundle = buildScanExportBundle(
    markdownClean,
    {
      diagnosticId,
      diagnosticUserId,
      model: str(body.model),
      hint: str(body.hint),
      capturedAt,
      exportedAt,
    },
    prefix,
  );

  if (!isS3Configured() || !cfg) {
    // ドライラン: 生成物のプレビューを返す (S3 未設定でも変換結果を確認できる)
    return json({
      ok: false,
      configured: false,
      reason: 's3_not_configured',
      message: 'AWS_S3_BUCKET / AWS_REGION 未設定のため S3 へは書き出していません。生成物のプレビューを返します。',
      diagnostic_id: diagnosticId,
      folder: bundle.folder,
      files: bundle.files.map((f) => ({ name: f.name, bytes: f.bytes, contentType: f.contentType })),
      json: bundle.json,
    });
  }

  try {
    const uploaded = await putScanFiles(bundle.files);
    return json({
      ok: true,
      configured: true,
      bucket: cfg.bucket,
      region: cfg.region,
      diagnostic_id: diagnosticId,
      folder: bundle.folder,
      uploaded,
      json: bundle.json,
    });
  } catch (err) {
    return json(
      { ok: false, configured: true, error: 'S3 upload failed', detail: String(err), folder: bundle.folder },
      502,
    );
  }
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
