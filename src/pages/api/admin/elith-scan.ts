/**
 * admin バッチ: 1 画像 → AIスキャン → Elith 形式 JSON + 元画像を S3 へ。
 *
 * 「がんリスク検査・遺伝子検査」等、Wellfort が手動取得した検査結果を Elith 用に一括生成する
 * 管理機能のサーバ側 (docs/elith_batch_centralization_design.md)。
 * Vercel 実行モデルに合わせ **1 画像 = 1 リクエスト**。クライアント(/admin/elith-batch)が順に呼ぶ。
 * キー(GEMINI_API_KEY / AWS_*)は **サーバ環境変数**のみ (CLAUDE.md: Vercel 一元管理)。
 *
 * 入力 (POST JSON):
 *   {
 *     image: string,              // data: URL もしくは生 base64 (必須)
 *     mimeType?: string,          // image が生 base64 のときの MIME (既定 image/jpeg)
 *     formatId: string,           // Elith format_id (必須)
 *     clientId?: string,          // 未指定ならサーバで UUID 採番 (サンプル用)
 *     examDate?: string,          // YYYY-MM-DD (任意。未指定は画像抽出→本日)
 *     sourceFileName?: string,    // 元ファイル名 (任意)
 *   }
 * 出力:
 *   - S3 設定あり: { ok:true, configured:true, uploaded:[{key,uri}], test_date, date_source, rows, json_key, image_key }
 *   - S3 未設定 : { ok:false, configured:false, ... , preview: json }  ← ドライラン
 *
 * 認可: wellfort-site (www.wellfort.co.jp/admin) からサーバ間で呼ばれる。
 *   `Authorization: Bearer <ADMIN_API_KEY>` を検証 (wellfort_admin_lab_upload_spec §6-1)。
 *   wellfort-site 側は同値を `SCAN_CHAT_AI_API_KEY` として持つ。
 *   env `ADMIN_API_KEY` が未設定の場合のみ (dev) 認証を省略する。
 */

import type { APIRoute } from 'astro';
import { buildElithScanBundle, isElithFormatId, ELITH_FORMAT_IDS } from '../../../lib/elith-export';
import { getS3Config, isS3Configured, putFiles } from '../../../lib/s3';

export const prerender = false;

function envKey(name: string): string | undefined {
  const m = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (m != null && m !== '') return m;
  const p = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return p != null && p !== '' ? p : undefined;
}
/** Bearer 検証。expected 未設定(dev)なら true。 */
function authorized(request: Request): boolean {
  const expected = envKey('ADMIN_API_KEY');
  if (!expected) return true; // dev: キー未設定なら素通し
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return !!m && m[1] === expected;
}

interface Body {
  image?: unknown;
  mimeType?: unknown;
  formatId?: unknown;
  clientId?: unknown;
  examDate?: unknown;
  sourceFileName?: unknown;
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

  const image = typeof body.image === 'string' ? body.image : '';
  if (!image.trim()) return json({ ok: false, error: 'image is required (data URL or base64)' }, 400);

  const formatId = str(body.formatId);
  if (!isElithFormatId(formatId)) {
    return json({ ok: false, error: `formatId must be one of ${ELITH_FORMAT_IDS.join(', ')}` }, 400);
  }

  const parsed = parseImage(image);
  const mimeType = parsed.mime || str(body.mimeType) || 'image/jpeg';
  const clientId = str(body.clientId) ?? randomUuid();
  const cfg = getS3Config();
  const prefix = cfg?.prefix ?? '';

  let bundle;
  try {
    bundle = await buildElithScanBundle({
      formatId,
      clientId,
      imageBase64: parsed.data,
      mimeType,
      sourceFileName: str(body.sourceFileName),
      examDate: str(body.examDate),
      prefix,
    });
  } catch (err) {
    return json({ ok: false, error: 'scan/build failed', detail: String(err instanceof Error ? err.message : err) }, 502);
  }

  const rows = Array.isArray((bundle.json as { data?: { measurements?: unknown[] } })?.data?.measurements)
    ? (bundle.json as { data: { measurements: unknown[] } }).data.measurements.length
    : 0;

  if (!isS3Configured() || !cfg) {
    return json({
      ok: false,
      configured: false,
      reason: 's3_not_configured',
      client_id: clientId,
      format_id: formatId,
      test_date: bundle.testDate,
      date_source: bundle.dateSource,
      rows,
      json_key: bundle.jsonKey,
      image_key: bundle.imageKey,
      preview: bundle.json,
    });
  }

  try {
    const uploaded = await putFiles(bundle.files);
    return json({
      ok: true,
      configured: true,
      bucket: cfg.bucket,
      client_id: clientId,
      format_id: formatId,
      test_date: bundle.testDate,
      date_source: bundle.dateSource,
      rows,
      json_key: bundle.jsonKey,
      image_key: bundle.imageKey,
      uploaded: uploaded.map((u) => ({ key: u.key, uri: u.uri })),
    });
  } catch (err) {
    return json({ ok: false, configured: true, error: 'S3 upload failed', detail: String(err) }, 502);
  }
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
