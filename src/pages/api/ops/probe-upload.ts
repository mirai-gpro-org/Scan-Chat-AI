/**
 * ops: 現地実行スクリプトの実行ログ受け口 (テキストのみ)。
 *
 * 用途: 専用PC など**こちらから触れない端末**で実行した診断スクリプトの結果を、
 *       メール添付を待たずに回収する。第一の利用者は
 *       `scripts/デメカル接続チェック.bat` (docs/lab/demecal_powershell_probe_guide.md)。
 *
 * 設計方針 (2026-08-28・admin API が無認可で開いていた件を踏まえて):
 *   ・**既定 off の fail-closed**。env `PROBE_UPLOAD_TOKEN` が設定されているときだけ動く。
 *     未設定なら 503 を返し、何も書かない。
 *   ・**ADMIN_API_KEY は使わない**。配布物 (bat) に埋めるため、漏れても被害が
 *     この口だけに閉じる**専用の使い捨てトークン**にする。用が済んだら env を消す。
 *   ・**書き込み専用**。読み出す API はここに作らない (回収は S3 コンソール / admin から)。
 *   ・**テキストのみ・サイズ上限あり**。実行ファイルや巨大データの投入口にしない。
 *   ・置き場所は S3 の `ops/probe/` 配下。Elith 納品や検査原本の領域には混ぜない。
 *
 * PII: 受け取るのは「証明書の件名/発行者/有効期限・PC名・ログイン前ページのHTML」で、
 *      **氏名・ID・パスワード・検査値は含まれない**前提 (スクリプト側でログインしない)。
 *      送信側が意図せず含めた場合に備え、保存先は短期ライフサイクルの prefix にする。
 */

import type { APIRoute } from 'astro';
import { getS3Config, isS3Configured, putFiles } from '../../../lib/s3';

export const prerender = false;

/** レポート本文の上限 (テキスト)。 */
const MAX_REPORT_CHARS = 256 * 1024;
/** 付随 HTML の上限。 */
const MAX_PAGE_CHARS = 2 * 1024 * 1024;

function env(name: string): string | undefined {
  const m = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (m != null && m !== '') return m;
  const p = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return p != null && p !== '' ? p : undefined;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** ファイル名・キーに使える範囲へ落とす (パス区切りや制御文字を通さない)。 */
function slug(v: unknown, fallback: string, max = 40): string {
  const s = typeof v === 'string' ? v : '';
  const out = s.normalize('NFKC').replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, max);
  return out.replace(/^[-.]+|[-.]+$/g, '') || fallback;
}

function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export const POST: APIRoute = async ({ request }) => {
  const expected = env('PROBE_UPLOAD_TOKEN');
  if (!expected) {
    return json({ ok: false, error: 'disabled', detail: 'PROBE_UPLOAD_TOKEN 未設定 (既定 off)' }, 503);
  }
  const given = (request.headers.get('x-probe-token') || '').trim();
  if (given !== expected) return json({ ok: false, error: 'unauthorized' }, 401);

  if (!isS3Configured()) return json({ ok: false, error: 's3_not_configured' }, 400);

  let body: { report?: unknown; page?: unknown; label?: unknown; host?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const report = typeof body.report === 'string' ? body.report : '';
  if (!report.trim()) return json({ ok: false, error: 'report_required' }, 400);
  if (report.length > MAX_REPORT_CHARS) {
    return json({ ok: false, error: 'report_too_large', detail: `${MAX_REPORT_CHARS} 文字まで` }, 413);
  }
  const page = typeof body.page === 'string' ? body.page : '';
  if (page.length > MAX_PAGE_CHARS) {
    return json({ ok: false, error: 'page_too_large', detail: `${MAX_PAGE_CHARS} 文字まで` }, 413);
  }

  const cfg = getS3Config();
  const prefix = (cfg?.prefix ?? '').replace(/^\/+/, '').replace(/\/*$/, '/');
  const day = new Date().toISOString().slice(0, 10);
  const id = uuid();
  const label = slug(body.label, 'probe', 24);
  const host = slug(body.host, 'unknown', 32);
  const folder = `${prefix}ops/probe/${day}/${label}-${host}-${id}/`;

  const files = [
    {
      key: `${folder}report.txt`,
      contentType: 'text/plain; charset=utf-8',
      body: report,
      bytes: new TextEncoder().encode(report).length,
    },
    ...(page
      ? [{
          key: `${folder}page.html`,
          contentType: 'text/html; charset=utf-8',
          body: page,
          bytes: new TextEncoder().encode(page).length,
        }]
      : []),
  ];

  try {
    const uploaded = await putFiles(files);
    return json({ ok: true, id, folder, uploaded: uploaded.map((u) => u.key) });
  } catch (err) {
    return json({
      ok: false, error: 'upload_failed',
      detail: String(err instanceof Error ? err.message : err),
    }, 502);
  }
};
