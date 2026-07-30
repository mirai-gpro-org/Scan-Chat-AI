/**
 * admin: プラン駆動で「2プラン×3年」の時系列疑似データを一括生成する。
 *
 * 仕様: docs/elith_synthetic_timeseries_plan_spec.md
 *   - plan(executive/middle) + baseDate(D0) + years(既定3) から受診回スケジュールを展開し、
 *     各 format の occurrence を「実データ種(seed)を決定論ジッタ」して生成 (値は捏造しない)。
 *   - 各受診回の date フォルダへ format JSON を置き、最後に manifest.json(complete:true) を置く。
 *   - 1プラン=1人の個別フォルダ (client_id=合成ID)。synthetic:true 付与・PII非同梱。
 * 種(seed)は各 format の実データ/サンプル1件 (seeds[formatId]=sourceKey 明示、または seedClientId で解決)。
 * キー(AWS_*)はサーバ環境変数のみ。認可: Bearer ADMIN_API_KEY (env 未設定 dev のみ省略)。
 */

import type { APIRoute } from 'astro';
import { getS3Config, isS3Configured, listObjects, getObjectText, putFiles } from '../../../lib/s3';
import { ELITH_HANDOFF_SCHEMA_VERSION } from '../../../lib/elith-export';
import { PLANS, expandPlanSchedule } from '../../../lib/elith-plan';
import { buildSnapshot } from '../../../lib/elith-synthetic';

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
function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}
function basename(key: string): string {
  return key.split('/').pop() ?? '';
}
function utf8Bytes(s: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : Buffer.byteLength(s, 'utf-8');
}
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

interface Body {
  plan?: unknown;
  clientId?: unknown;
  baseDate?: unknown;
  years?: unknown;
  amplitude?: unknown;
  seeds?: unknown;        // { [formatId]: sourceKey }
  seedClientId?: unknown; // seeds 未指定 format をこの client の最新で解決
  sourcePrefix?: unknown;
  dryRun?: unknown;
}

/** seedClientId の {format}_ 最新 key を解決。 */
async function resolveSeedKey(format: string, seedClientId: string, sourcePrefix: string): Promise<string | null> {
  const objs = await listObjects(sourcePrefix);
  const mine = objs
    .filter((o) => o.key.endsWith('.json') && basename(o.key).startsWith(`${format}_`) && o.key.includes(`user_${seedClientId}`))
    .sort((a, b) => b.key.localeCompare(a.key));
  return mine[0]?.key ?? null;
}

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized', detail: 'Invalid API key' }, 401);

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const planKey = str(body.plan) ?? '';
  const plan = PLANS[planKey];
  if (!plan) return json({ ok: false, error: 'unknown_plan', detail: `plan は ${Object.keys(PLANS).join(' / ')} のいずれか` }, 400);

  const clientId = str(body.clientId);
  if (!clientId) return json({ ok: false, error: 'clientId_required', detail: '合成 client_id (例 elith-test-exec-001) が必要' }, 400);

  const baseDate = str(body.baseDate);
  if (!baseDate || !/^\d{4}-\d{2}-\d{2}$/.test(baseDate)) {
    return json({ ok: false, error: 'baseDate_invalid', detail: 'baseDate=YYYY-MM-DD (D0=1年目 第1回) が必要' }, 400);
  }
  const years = Math.max(1, Math.min(10, Math.round(num(body.years, 3))));
  const amplitude = Math.min(0.5, Math.max(0, num(body.amplitude, 0.05)));
  const dryRun = body.dryRun === true;
  const seedsIn = body.seeds && typeof body.seeds === 'object' ? (body.seeds as Record<string, unknown>) : {};
  const seedClientId = str(body.seedClientId);

  const cfg = getS3Config();
  if (!isS3Configured() || !cfg) return json({ ok: false, error: 's3_not_configured', detail: 'AWS_REGION 未設定' }, 400);
  const sourcePrefix = str(body.sourcePrefix) ?? cfg.prefix ?? 'scan-accuracy-test/';
  const cleanPrefix = sourcePrefix.replace(/^\/+/, '').replace(/\/*$/, '/');

  // 1) 各 format の種(seed) key を解決 (seeds[fmt] 明示 → seedClientId で最新)。
  const planFormats = [...new Set(plan.formats.map((f) => f.formatId))];
  const seedKey: Record<string, string> = {};
  const missing: string[] = [];
  for (const fmt of planFormats) {
    const explicit = str(seedsIn[fmt]);
    if (explicit) { seedKey[fmt] = explicit; continue; }
    if (seedClientId) {
      try {
        const k = await resolveSeedKey(fmt, seedClientId, sourcePrefix);
        if (k) { seedKey[fmt] = k; continue; }
      } catch (err) {
        return json({ ok: false, error: 'seed_resolve_failed', detail: String(err instanceof Error ? err.message : err) }, 502);
      }
    }
    missing.push(fmt);
  }
  if (missing.length) {
    return json({ ok: false, error: 'seed_missing', detail: `種(seed)未指定の format: ${missing.join(', ')}。seeds[formatId]=sourceKey か seedClientId を指定してください。` }, 400);
  }

  // 2) 種を取得・検証。
  const seedObj: Record<string, Record<string, unknown>> = {};
  for (const fmt of planFormats) {
    try {
      const o = JSON.parse(await getObjectText(seedKey[fmt])) as Record<string, unknown>;
      if (o.format_id !== fmt) {
        return json({ ok: false, error: 'seed_format_mismatch', detail: `種 ${basename(seedKey[fmt])} の format_id=${String(o.format_id)} (要求=${fmt})` }, 400);
      }
      seedObj[fmt] = o;
    } catch (err) {
      return json({ ok: false, error: 'seed_read_failed', detail: `${fmt}: ${String(err instanceof Error ? err.message : err)}` }, 502);
    }
  }

  // 3) スケジュール展開 → occurrence ごとにスナップショット生成。
  const occurrences = expandPlanSchedule(plan, baseDate, years);
  const exportedAt = new Date().toISOString();
  const dataFiles: { key: string; contentType: string; body: string; bytes: number }[] = [];
  const byFolder = new Map<string, { date: string; files: { format_id: string; file: string }[] }>();
  const perFormatCount: Record<string, number> = {};

  for (const occ of occurrences) {
    const dateFolder = occ.testDate.replace(/-/g, '_');
    const snap = buildSnapshot({
      src: seedObj[occ.formatId],
      formatId: occ.formatId,
      clientId,
      testDate: occ.testDate,
      seedBase: `${clientId}|${occ.formatId}|${occ.occIndex}`,
      amplitude,
      srcKey: seedKey[occ.formatId],
      exportedAt,
    });
    const stem = `${occ.formatId}_date_${dateFolder}_user_${clientId}`;
    const fileName = `${stem}.json`;
    const key = `${cleanPrefix}user/${clientId}/date/${dateFolder}/${fileName}`;
    const bodyStr = JSON.stringify(snap.obj, null, 2);
    dataFiles.push({ key, contentType: 'application/json; charset=utf-8', body: bodyStr, bytes: utf8Bytes(bodyStr) });
    perFormatCount[occ.formatId] = (perFormatCount[occ.formatId] ?? 0) + 1;

    const folder = byFolder.get(dateFolder) ?? { date: dateFolder, files: [] };
    folder.files.push({ format_id: occ.formatId, file: fileName });
    byFolder.set(dateFolder, folder);
  }

  // 4) 各 date フォルダの manifest.json (complete:true)。※ format JSON を全て Put した後に Put する。
  const manifestFiles: { key: string; contentType: string; body: string; bytes: number }[] = [];
  for (const [dateFolder, folder] of byFolder) {
    const manifest = {
      client_id: clientId,
      date: dateFolder,
      schema_version: ELITH_HANDOFF_SCHEMA_VERSION,
      created_at: exportedAt,
      files: folder.files,
      complete: true,
    };
    const key = `${cleanPrefix}user/${clientId}/date/${dateFolder}/manifest.json`;
    const bodyStr = JSON.stringify(manifest, null, 2);
    manifestFiles.push({ key, contentType: 'application/json; charset=utf-8', body: bodyStr, bytes: utf8Bytes(bodyStr) });
  }

  const summary = {
    plan: plan.key,
    plan_name: plan.name,
    client_id: clientId,
    base_date: baseDate,
    years,
    amplitude,
    folders: byFolder.size,
    json_files: dataFiles.length,
    manifests: manifestFiles.length,
    per_format: perFormatCount,
    seed_keys: seedKey,
    files: [...dataFiles, ...manifestFiles].map((f) => f.key),
  };

  if (dryRun) return json({ ok: true, dry_run: true, ...summary });

  try {
    await putFiles(dataFiles);       // 先に各 format JSON
    await putFiles(manifestFiles);   // 最後に manifest (半端読み防止・spec §8.2)
    return json({ ok: true, dry_run: false, bucket: cfg.bucket, ...summary });
  } catch (err) {
    return json({ ok: false, error: 'S3 upload failed', detail: String(err instanceof Error ? err.message : err) }, 502);
  }
};
