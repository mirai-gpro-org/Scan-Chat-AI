/**
 * AI 問診結果を Elith 連携用に S3 へ書き出すエンドポイント (暫定テスト用)。
 *
 * 入力 (POST JSON):
 *   {
 *     diagnosticId?: string,        // 端末発番の UUID。無ければサーバで生成
 *     diagnosticUserId?: string|null,
 *     userName?: string|null,       // 内部取得 (customer.family_name)
 *     dateOfBirth?: string|null,
 *     sex?: string|null,
 *     answers: Record<string, string|string[]|number>,
 *     completedAt?: number          // epoch ms (任意)
 *   }
 *
 * 出力:
 *   - S3 設定あり: { ok:true, configured:true, bucket, folder, uploaded:[...], json }
 *   - S3 未設定 : { ok:false, configured:false, folder, files:[...], json }  ← ドライラン
 *
 * 命名/フォーマットは暫定 (interview-export-v0)。詳細は lib/interview-export.ts。
 */

import type { APIRoute } from 'astro';
import { buildInterviewExportBundle } from '../../../lib/interview-export';
import type { AnswerValue } from '../../../scripts/chat/interview-script';
import { getS3Config, isS3Configured, putFiles } from '../../../lib/s3';

export const prerender = false;

interface ExportBody {
  diagnosticId?: unknown;
  diagnosticUserId?: unknown;
  userName?: unknown;
  dateOfBirth?: unknown;
  sex?: unknown;
  answers?: unknown;
  completedAt?: unknown;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** answers を string | string[] | number のみに正規化 */
function sanitizeAnswers(raw: unknown): Record<string, AnswerValue> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, AnswerValue> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number') {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v.filter((x): x is string => typeof x === 'string');
    }
  }
  return out;
}

export const POST: APIRoute = async ({ request }) => {
  let body: ExportBody;
  try {
    body = (await request.json()) as ExportBody;
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const answers = sanitizeAnswers(body.answers);
  if (Object.keys(answers).length === 0) {
    return json({ ok: false, error: 'answers is required' }, 400);
  }

  const diagnosticId = str(body.diagnosticId) ?? crypto.randomUUID();
  const completedAt = typeof body.completedAt === 'number' ? body.completedAt : undefined;

  const cfg = getS3Config();
  const prefix = cfg?.prefix ?? '';

  const bundle = buildInterviewExportBundle(
    {
      diagnosticId,
      diagnosticUserId: str(body.diagnosticUserId),
      userName: str(body.userName),
      dateOfBirth: str(body.dateOfBirth),
      sex: str(body.sex),
      answers,
      completedAt,
      exportedAt: new Date(),
    },
    prefix,
  );

  if (!isS3Configured() || !cfg) {
    return json({
      ok: false,
      configured: false,
      reason: 's3_not_configured',
      message: 'AWS_REGION 未設定のため S3 へは書き出していません。生成物のプレビューを返します。',
      diagnostic_id: diagnosticId,
      folder: bundle.folder,
      files: bundle.files.map((f) => ({ key: f.key, bytes: f.bytes, contentType: f.contentType })),
      json: bundle.json,
    });
  }

  try {
    const uploaded = await putFiles(bundle.files);
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
