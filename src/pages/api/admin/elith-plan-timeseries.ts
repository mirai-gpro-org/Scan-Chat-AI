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
  mode?: unknown;         // 'generate'(既定) | 'list'(種client_id候補を返す)
  plan?: unknown;
  clientId?: unknown;
  baseDate?: unknown;
  years?: unknown;
  amplitude?: unknown;
  seeds?: unknown;        // { [formatId]: sourceKey }
  seedClientId?: unknown; // seeds 未指定 format をこの client の最新で解決
  seedPrefix?: unknown;   // 種の探索先 prefix (既定=sourcePrefix。UI は納品層 'user/' を渡す)
  sourcePrefix?: unknown; // 生成物の出力先 prefix (既定 scan-accuracy-test/)
  deliveryPrefix?: unknown; // mode=list: 納品(assembled)層の走査 prefix (既定 'user/')
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

  // S3 と sourcePrefix を先に解決 (mode=list でも使う)。
  const cfg = getS3Config();
  if (!isS3Configured() || !cfg) return json({ ok: false, error: 's3_not_configured', detail: 'AWS_REGION 未設定' }, 400);
  const sourcePrefix = str(body.sourcePrefix) ?? cfg.prefix ?? 'scan-accuracy-test/';
  const cleanPrefix = sourcePrefix.replace(/^\/+/, '').replace(/\/*$/, '/');

  const mode = str(body.mode) ?? 'generate';

  // ── mode=list: 種 client_id 候補を「層(納品/ソース)・保有 format 付き」で返す (UI プルダウン用) ──
  // 種は単一 client_id を全 format に使うため、**全 format が1IDに揃う「納品(assembled)層」を優先**する。
  //   - 納品(assembled)層: バケット直下 user/{id}/... = アセンブリ済み完全バンドル(推奨・seed_prefix='user/')。
  //   - ソース層: {sourcePrefix}user/{id}/... = 生スキャン(単一 format が多い・seed_prefix=sourcePrefix)。
  // 各候補に seed_prefix を付け、generate 時に seedPrefix として渡すと探索先が一致する。
  if (mode === 'list') {
    const deliveryPrefix = (str(body.deliveryPrefix) ?? 'user/').replace(/^\/+/, '').replace(/\/*$/, '/');
    const re = /^(HealthCheckupData|BloodTestData|CancerRiskAssessmentData|GeneticTestResultData|Other)_date_(\d{4}_\d{2}_\d{2})_user_(.+)\.json$/;
    const layers: { prefix: string; layer: 'assembled' | 'source' }[] = [{ prefix: deliveryPrefix, layer: 'assembled' }];
    if (cleanPrefix !== deliveryPrefix) layers.push({ prefix: cleanPrefix, layer: 'source' });
    const byKey = new Map<string, { client_id: string; layer: string; seed_prefix: string; formats: Set<string>; latest: string | null; count: number }>();
    for (const L of layers) {
      const objs = await listObjects(L.prefix);
      for (const o of objs) {
        const m = re.exec(basename(o.key));
        if (!m) continue;
        const k = `${L.layer}::${m[3]}`;
        const e = byKey.get(k) ?? { client_id: m[3], layer: L.layer, seed_prefix: L.prefix, formats: new Set<string>(), latest: null, count: 0 };
        e.formats.add(m[1]); e.count++;
        if (!e.latest || m[2] > e.latest) e.latest = m[2];
        byKey.set(k, e);
      }
    }
    const clients = [...byKey.values()]
      .map((e) => ({ client_id: e.client_id, layer: e.layer, seed_prefix: e.seed_prefix, formats: [...e.formats].sort(), latest_date: e.latest ? e.latest.replace(/_/g, '-') : null, count: e.count }))
      .sort((a, b) => (a.layer === b.layer ? a.client_id.localeCompare(b.client_id) : a.layer === 'assembled' ? -1 : 1));
    return json({ ok: true, mode: 'list', delivery_prefix: deliveryPrefix, source_prefix: cleanPrefix, clients });
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
  // 種の探索先 (seedClientId 解決に使う)。既定はソース層だが、UI は納品(assembled)層の完全バンドルを渡す。
  const seedPrefix = str(body.seedPrefix)
    ? str(body.seedPrefix)!.replace(/^\/+/, '').replace(/\/*$/, '/')
    : cleanPrefix;

  // 1) 各 format の種(seed) key を解決 (seeds[fmt] 明示 → seedClientId で最新)。
  const planFormats = [...new Set(plan.formats.map((f) => f.formatId))];
  const seedKey: Record<string, string> = {};
  const missing: string[] = [];
  for (const fmt of planFormats) {
    const explicit = str(seedsIn[fmt]);
    if (explicit) { seedKey[fmt] = explicit; continue; }
    if (seedClientId) {
      try {
        const k = await resolveSeedKey(fmt, seedClientId, seedPrefix);
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
