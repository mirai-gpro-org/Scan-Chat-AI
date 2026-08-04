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
import { computeHealthAge, normalizeMarkers, type RawItem } from '../../../lib/health-age';

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
function randomUuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}
/** 合成 HealthAgeData 納品JSON (buildHealthAgeJson[assemble] と同形。synthetic 明記)。 */
function buildSyntheticHealthAge(
  clientId: string, testDate: string, ha: { biological_age: number | null; chronological_age: number; delta: number | null; model_version: string },
  sex: 'male' | 'female' | null, exportedAt: string, seedRef: string | null,
): Record<string, unknown> {
  return {
    format_id: 'HealthAgeData',
    schema_version: ELITH_HANDOFF_SCHEMA_VERSION,
    kind: 'health_age',
    synthetic: true,
    client_id: clientId,
    diagnostic_id: randomUuid(),
    test_date: testDate,
    date_source: 'synthetic',
    exported_at: exportedAt,
    subject: { sex: sex ?? null, age: ha.chronological_age },
    source: {
      origin: 'scan-chat-ai', app: 'scan-chat-ai', model: ha.model_version,
      note: '健康年齢(CABA)。合成: 血液(なければ健診)の合成値から算出。', lab_name: null, seed_ref: seedRef ?? null,
    },
    data: {
      health_age: ha.biological_age,
      actual_age: ha.chronological_age,
      computed_date: exportedAt.slice(0, 10),
      delta: ha.delta,
      model_version: ha.model_version,
    },
  };
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
  age?: unknown;          // 合成ペルソナの D0 時点実年齢 (健康年齢算出に必須)
  sex?: unknown;          // 'male' | 'female' (クレアチニン性別正規化に使用・任意)
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
/** prefix 配下の {format}_ 最新 key を「任意 client から」解決 (種フォールバック用)。 */
async function resolveLatestFormatKey(format: string, prefix: string): Promise<string | null> {
  const objs = await listObjects(prefix);
  const all = objs
    .filter((o) => o.key.endsWith('.json') && basename(o.key).startsWith(`${format}_`))
    .sort((a, b) => b.key.localeCompare(a.key));
  return all[0]?.key ?? null;
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

  // 1) 各 format の種(seed) key を解決。優先順位:
  //    ① seeds[fmt] 明示 → ② 選択 client(seedClientId)の当該 format → ③ seedPrefix 内の任意 client(最新)
  //    → ④ ソース層の任意 client(最新)。②で無くても③④で「借用」してプラン全 format を揃える
  //    (アセンブリIDが Other 等を欠いても、他所に実在すれば流用=合成なので可・借用元は応答で明示)。
  const planFormats = [...new Set(plan.formats.map((f) => f.formatId))];
  const seedKey: Record<string, string> = {};
  const borrowed: Record<string, string> = {}; // ②で解決できず③④で借用した format → 借用元 key
  const skippedFormats: string[] = [];         // 種がどこにも無い format = 生成せずスキップ(捏造しない)
  for (const fmt of planFormats) {
    const explicit = str(seedsIn[fmt]);
    if (explicit) { seedKey[fmt] = explicit; continue; }
    try {
      let k = seedClientId ? await resolveSeedKey(fmt, seedClientId, seedPrefix) : null;
      if (!k) { k = await resolveLatestFormatKey(fmt, seedPrefix); if (k) borrowed[fmt] = k; }
      if (!k && cleanPrefix !== seedPrefix) { k = await resolveLatestFormatKey(fmt, cleanPrefix); if (k) borrowed[fmt] = k; }
      if (k) { seedKey[fmt] = k; continue; }
    } catch (err) {
      return json({ ok: false, error: 'seed_resolve_failed', detail: String(err instanceof Error ? err.message : err) }, 502);
    }
    skippedFormats.push(fmt); // 種がどこにも無い → その format のみ生成しない。他 format は通常生成。
  }
  // ハード失敗はプランの全 format で種が皆無のときだけ (それ以外は在る分を生成し、欠けた分は報告)。
  if (Object.keys(seedKey).length === 0) {
    return json({
      ok: false, error: 'no_seeds',
      detail: `プランの全 format で種が見つかりません: ${skippedFormats.join(', ')}。まず各検査を1件スキャン/投入して種を用意してください。`,
      skipped_formats: skippedFormats,
    }, 400);
  }

  // 2) 種を取得・検証 (解決できた format のみ)。
  const seedObj: Record<string, Record<string, unknown>> = {};
  for (const fmt of Object.keys(seedKey)) {
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

  // 健康年齢(HealthAgeData)の生成設定。
  //   - 「血液検査毎に最新を算出」→ 生成の数/タイミングは **血液(あれば)/無ければ健診** の各回に一致。
  //     幹部=血液9回→9本 / ミドル=血液なし→健診3回→3本。
  //   - 算出には実年齢が必須。age 未指定なら健康年齢は生成しない(捏造しない)。
  const haSourceFormat = plan.formats.some((f) => f.formatId === 'BloodTestData')
    ? 'BloodTestData'
    : plan.formats.some((f) => f.formatId === 'HealthCheckupData')
      ? 'HealthCheckupData'
      : null;
  const personaAge = num(body.age, NaN);
  const sexRaw = str(body.sex);
  const personaSex: 'male' | 'female' | null = sexRaw === 'male' ? 'male' : sexRaw === 'female' ? 'female' : null;
  let haGenerated = 0;
  let haSkipped = 0; // 必要マーカー不足等で算出不可(捏造せず空きにする)

  // 3) スケジュール展開 → occurrence ごとにスナップショット生成 (種が在る format のみ)。
  const occurrences = expandPlanSchedule(plan, baseDate, years).filter((o) => seedKey[o.formatId]);
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

    // 健康年齢: 血液(なければ健診)の各回に、その回の合成値から算出して同日フォルダへ同梱。
    if (haSourceFormat && occ.formatId === haSourceFormat && Number.isFinite(personaAge)) {
      const meas = (snap.obj as { data?: { measurements?: unknown } }).data?.measurements;
      const ageAt = Math.round(personaAge) + Math.floor(occ.monthsFromBase / 12); // 経年で実年齢も進む
      const markers = { ...normalizeMarkers(Array.isArray(meas) ? (meas as RawItem[]) : []), age: ageAt, sex: personaSex };
      const ha = computeHealthAge(markers);
      if (ha.ok && ha.biological_age != null) {
        const haFile = `HealthAgeData_date_${dateFolder}_user_${clientId}.json`;
        const haKey = `${cleanPrefix}user/${clientId}/date/${dateFolder}/${haFile}`;
        const haObj = buildSyntheticHealthAge(
          clientId, occ.testDate,
          { biological_age: ha.biological_age, chronological_age: ageAt, delta: ha.delta, model_version: ha.model_version },
          personaSex, exportedAt, seedKey[occ.formatId] ?? null,
        );
        const haBody = JSON.stringify(haObj, null, 2);
        dataFiles.push({ key: haKey, contentType: 'application/json; charset=utf-8', body: haBody, bytes: utf8Bytes(haBody) });
        perFormatCount.HealthAgeData = (perFormatCount.HealthAgeData ?? 0) + 1;
        folder.files.push({ format_id: 'HealthAgeData', file: haFile });
        haGenerated++;
      } else {
        haSkipped++; // 必要マーカー不足 → 捏造せずスキップ (種の血液に CABA 必須項目が無い等)
      }
    }
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
    seed_borrowed: borrowed,       // ②選択clientに無く③④他所から借用した format → 借用元key
    skipped_formats: skippedFormats, // 種がどこにも無く生成しなかった format (捏造しない)
    health_age: { source_format: haSourceFormat, generated: haGenerated, skipped: haSkipped, age: Number.isFinite(personaAge) ? Math.round(personaAge) : null, sex: personaSex },
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
