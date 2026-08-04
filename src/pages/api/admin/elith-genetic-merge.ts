/**
 * admin: 遺伝子検査 (GeneticTestResultData) の複数ページを 1 検査へ集約。
 *
 * 構造化は **Gemini(LLM) に全面委任** (elith-genetic.ts)。プログラムはパースしない。
 * CLAUDE.md「1 画像 = 1 リクエスト(60s)」を守り、クライアントがページ順に呼ぶ:
 *   - action=part     : 1 ページ画像を LLM 構造化 → items を返す (S3 書き込みなし)
 *   - action=finalize : 全 part の items を集約 → 1 つの GeneticTestResultData JSON を S3 保存
 * キー(GEMINI_API_KEY / AWS_*)はサーバ環境変数のみ (Vercel 一元管理)。
 *
 * 認可: wellfort-site から Bearer ADMIN_API_KEY。env 未設定(dev)のみ省略。
 */

import type { APIRoute } from 'astro';
import { scanGeneticPage, scanAiPredictionPage } from '../../../lib/elith-genetic';
import { ELITH_HANDOFF_SCHEMA_VERSION, jstTodayIso } from '../../../lib/elith-export';
import { MODELS } from '../../../lib/gemini';
import { getS3Config, isS3Configured, putFiles } from '../../../lib/s3';

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
function folderOf(prefix: string, clientId: string, testDate: string, formatId: string): { folder: string; stem: string } {
  const dateFolder = testDate.replace(/-/g, '_');
  const cleanPrefix = prefix ? prefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
  return {
    folder: `${cleanPrefix}user/${clientId}/date/${dateFolder}/`,
    stem: `${formatId}_date_${dateFolder}_user_${clientId}`,
  };
}
/** このエンドポイントが扱う多ページ自由構造レポート。既定=遺伝子。Other=LAiF AI疾病発症予測。 */
function resolveFormat(v: unknown): { formatId: 'GeneticTestResultData' | 'Other'; kind: string } {
  return v === 'Other'
    ? { formatId: 'Other', kind: 'ai_prediction' }
    : { formatId: 'GeneticTestResultData', kind: 'genetic_scan_merged' };
}

interface Body {
  action?: unknown;
  formatId?: unknown;   // 'GeneticTestResultData'(既定) | 'Other'(LAiF AI疾病発症予測)
  image?: unknown;
  mimeType?: unknown;
  clientId?: unknown;
  page?: unknown;
  hint?: unknown;
  testDate?: unknown;
  parts?: unknown;
  sourceFile?: unknown;
  sourcePages?: unknown;
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
  const { formatId, kind } = resolveFormat(str(body.formatId));
  const clientId = str(body.clientId);
  if (!clientId) return json({ ok: false, error: 'clientId is required' }, 400);

  const cfg = getS3Config();
  const prefix = cfg?.prefix ?? '';

  // ── action = part: 1 ページを LLM 構造化 ──
  if (action === 'part') {
    const image = typeof body.image === 'string' ? body.image : '';
    if (!image.trim()) return json({ ok: false, error: 'image is required (data URL or base64)' }, 400);
    const page = typeof body.page === 'number' && body.page > 0 ? Math.floor(body.page) : 1;
    const parsedImg = parseImage(image);
    const mimeType = parsedImg.mime || str(body.mimeType) || 'image/jpeg';

    try {
      const scanPage = formatId === 'Other' ? scanAiPredictionPage : scanGeneticPage;
      const r = await scanPage({ imageBase64: parsedImg.data, mimeType, hint: str(body.hint) });
      return json({
        ok: true,
        action: 'part',
        page,
        section: r.section,
        items: r.items,
        item_count: r.items.length,
        parsed: r.parsed,
        finish_reason: r.finishReason,
        // 構造化に失敗(JSON化不可)した場合のみ生出力を返す (監査/再試行判断用)
        raw: r.parsed ? undefined : r.raw.slice(0, 2000),
      });
    } catch (err) {
      return json({ ok: false, error: 'scan failed', detail: String(err instanceof Error ? err.message : err) }, 502);
    }
  }

  // ── action = finalize: 全 part の items を集約 → 1 JSON ──
  if (action === 'finalize') {
    const parts = Array.isArray(body.parts) ? (body.parts as Array<Record<string, unknown>>) : [];
    if (parts.length === 0) return json({ ok: false, error: 'parts is required for finalize' }, 400);

    const providedDate = str(body.testDate);
    const testDate = providedDate && /^\d{4}-\d{2}-\d{2}$/.test(providedDate) ? providedDate : jstTodayIso();

    const items: unknown[] = [];
    const pages: { page: number; section: string | null; count: number }[] = [];
    for (const p of parts) {
      const pageItems = Array.isArray(p.items) ? (p.items as unknown[]) : [];
      items.push(...pageItems);
      pages.push({
        page: typeof p.page === 'number' ? p.page : pages.length + 1,
        section: typeof p.section === 'string' ? p.section : null,
        count: pageItems.length,
      });
    }

    const { folder, stem } = folderOf(prefix, clientId, testDate, formatId);
    const json_key = `${folder}${stem}.json`;
    const jsonObj = {
      format_id: formatId,
      schema_version: ELITH_HANDOFF_SCHEMA_VERSION,
      kind,
      client_id: clientId,
      diagnostic_id: randomUuid(),
      source_file: str(body.sourceFile),
      source_pages: str(body.sourcePages),
      page_count: parts.length,
      test_date: testDate,
      date_source: providedDate ? 'provided' : 'today',
      exported_at: new Date().toISOString(),
      subject: { sex: null, age: null },
      source: {
        origin: 'scan-chat-ai',
        app: 'scan-chat-ai',
        model: MODELS.scan,
        note: formatId === 'Other'
          ? 'admin バッチ (LAiF AI疾病発症予測・AIスキャン・構造化はLLM全面委任)。項目構造はLLM判定。'
          : 'admin バッチ (遺伝子・AIスキャン・構造化はLLM全面委任)。項目構造はLLM判定。',
        lab_name: formatId === 'Other' ? 'LAiF' : null,
      },
      data: { item_count: items.length, items, pages },
    };
    const jsonBody = JSON.stringify(jsonObj, null, 2);

    if (!isS3Configured() || !cfg) {
      return json({ ok: false, configured: false, reason: 's3_not_configured', json_key, item_count: items.length, format_id: formatId, preview: jsonObj });
    }
    try {
      const uploaded = await putFiles([
        { key: json_key, contentType: 'application/json; charset=utf-8', body: jsonBody, bytes: utf8Bytes(jsonBody) },
      ]);
      return json({
        ok: true, action: 'finalize', configured: true, bucket: cfg.bucket,
        client_id: clientId, format_id: formatId, test_date: testDate,
        page_count: parts.length, item_count: items.length, json_key,
        uri: uploaded[0]?.uri ?? null,
        preview: jsonObj, // 🎯 照合用: 納品JSON(data.items)を返す(S3未設定分岐と同様)。
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
