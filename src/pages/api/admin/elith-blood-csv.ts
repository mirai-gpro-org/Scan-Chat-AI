/**
 * admin バッチ: 血液検査 CSV (デメカル様式) → Elith `BloodTestData` JSON 群を S3 へ。
 *
 * 血液検査結果は CSV (構造化) で受領するため、LLM は使わず **決定論パーサ**で全行を転記する
 * (docs: docs/elith/elith_s3_data_handoff_spec.md §7.1 / docs/lab/demecal_auto_download_overview_spec.md)。
 * 1 CSV = 複数人 (行) → 1 人 = 1 `BloodTestData` JSON。CSV パースは軽量なので 1 リクエストで一括処理。
 * キー(AWS_*)は **サーバ環境変数**のみ (CLAUDE.md: Vercel 一元管理)。
 * PII (氏名/住所/生年月日等) は Elith JSON に載せない。原本 CSV は PII を含むため S3 へ置かない。
 *
 * 入力 (POST JSON):
 *   {
 *     csvBase64: string,      // CSV (Shift_JIS) の base64 (必須)。data URL も可
 *     filename?: string,      // 元ファイル名 (source_file に記録)
 *     idPrefix?: string,      // 自動採番の接頭辞 (既定 "test")
 *   }
 * 出力:
 *   - S3 設定あり: { ok:true, configured:true, count, uploaded:[{client_id,test_date,item_count,json_key,uri}] }
 *   - S3 未設定 : { ok:false, configured:false, count, rows:[...], preview:[...] }  ← ドライラン
 *
 * 認可: wellfort-site から `Authorization: Bearer <ADMIN_API_KEY>` (wellfort_admin_lab_upload_spec §6-1)。
 *   env `ADMIN_API_KEY` 未設定 (dev) のみ認証省略。
 */

import type { APIRoute } from 'astro';
import { buildBloodCsvBundles } from '../../../lib/elith-blood-csv';
import { getS3Config, isS3Configured, putFiles, type S3PutFile } from '../../../lib/s3';
import { isLabIntakeEndpointAuthorized } from '../../../lib/api-auth';

export const prerender = false;

function authorized(request: Request): boolean {
  // 認可の実装は src/lib/api-auth.ts に集約 (キー未設定の本番は拒否＝fail-closed)。
  // **取り込み 3 口のひとつ**。admin キー (wellfort-site の画面用) に加えて、
  // 専用PC が持つ**取り込み専用キー** `x-intake-key` も通す。
  // ADMIN_API_KEY を PC に置かないための分離 (`demecal_unattended_spec §3.1`)。用途=CSV 取り込み
  return isLabIntakeEndpointAuthorized(request);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function base64ToBytes(input: string): Uint8Array {
  const m = /^data:[^;]*;base64,(.+)$/i.exec(input.trim());
  const b64 = (m ? m[1] : input).trim();
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}
/** yyyymmddhhmm (JST) — 自動採番の安定した接尾辞に使う */
function jstStamp(d: Date = new Date()): string {
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${jst.getUTCFullYear()}${p(jst.getUTCMonth() + 1)}${p(jst.getUTCDate())}${p(jst.getUTCHours())}${p(jst.getUTCMinutes())}`;
}

interface Body {
  csvBase64?: unknown;
  filename?: unknown;
  idPrefix?: unknown;
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

  const csvB64 = str(body.csvBase64);
  if (!csvB64) return json({ ok: false, error: 'csvBase64 is required' }, 400);

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(csvB64);
  } catch {
    return json({ ok: false, error: 'csvBase64 is not valid base64' }, 400);
  }

  const idPrefix = str(body.idPrefix) ?? 'test';
  const stamp = jstStamp();
  const cfg = getS3Config();
  const prefix = cfg?.prefix ?? '';

  let parsed;
  try {
    parsed = buildBloodCsvBundles({
      bytes,
      sourceFileName: str(body.filename),
      prefix,
      makeClientId: (i) => `${idPrefix}-${stamp}-${String(i + 1).padStart(3, '0')}`,
    });
  } catch (err) {
    return json({ ok: false, error: 'csv parse failed', detail: String(err instanceof Error ? err.message : err) }, 502);
  }

  if (parsed.rows.length === 0) {
    return json({ ok: false, error: 'no data rows parsed from CSV', headerFound: parsed.headerFound }, 400);
  }

  const rowSummary = parsed.rows.map((r) => ({
    client_id: r.clientId,
    test_date: r.testDate,
    item_count: r.itemCount,
    json_key: r.files[0]?.key ?? null,
  }));
  // 取り込んだ最新の検査日 (デメカル状態 last_to の前進に使う)。
  const maxTestDate = rowSummary.reduce<string | null>(
    (mx, r) => (r.test_date && /^\d{4}-\d{2}-\d{2}$/.test(r.test_date) && (!mx || r.test_date > mx) ? r.test_date : mx),
    null,
  );

  if (!isS3Configured() || !cfg) {
    return json({
      ok: false,
      configured: false,
      reason: 's3_not_configured',
      count: parsed.rows.length,
      header_found: parsed.headerFound,
      max_test_date: maxTestDate,
      rows: rowSummary,
      preview: parsed.rows.slice(0, 2).map((r) => r.json),
    });
  }

  // 全行のファイルをまとめて S3 へ (1 行 = 1 JSON)。
  const files: S3PutFile[] = parsed.rows.flatMap((r) => r.files);
  try {
    const uploaded = await putFiles(files);
    const uriByKey = new Map(uploaded.map((u) => [u.key, u.uri]));
    return json({
      ok: true,
      configured: true,
      bucket: cfg.bucket,
      count: parsed.rows.length,
      header_found: parsed.headerFound,
      max_test_date: maxTestDate,
      uploaded: rowSummary.map((r) => ({ ...r, uri: r.json_key ? uriByKey.get(r.json_key) ?? null : null })),
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
