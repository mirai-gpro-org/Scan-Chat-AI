/**
 * admin: 血液検査 (BloodTestData) の時系列テスト用「疑似データ」を生成する。
 *
 * Elith が血液を時系列 (最多プランで4カ月毎) でも受け取りたいとの要望に対し、
 * 現在の 1 検査を種にして過去スナップショット (既定 -4/-8/-12カ月) を生成する。
 *   - 同一 client_id・別 date フォルダに書き出す (Elith は §3.3 の時系列として読む)。
 *   - 数値項目 (value_num) のみ ±amplitude(既定5%) の独立ジッタ。問診/非数値は維持。
 *   - seed 固定 (client_id+項目名+月数) のため毎回同じ疑似データ (テスト再現可能)。
 *   - `synthetic: true` を付与し識別・後で一括削除できるようにする (既存の血液削除で消える)。
 * キー(AWS_*)はサーバ環境変数のみ。認可: Bearer ADMIN_API_KEY (env 未設定 dev のみ省略)。
 */

import type { APIRoute } from 'astro';
import { getS3Config, isS3Configured, listObjects, getObjectText, putFiles } from '../../../lib/s3';

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

// ── 疑似データ生成のための純粋関数 ──────────────────────────────
/** 文字列 → 32bit ハッシュ (seed 用・FNV-1a)。 */
function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
/** seed から [0,1) の決定論乱数列 (mulberry32)。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** test_date(YYYY-MM-DD) を monthsBack カ月だけ過去へ。末日は対象月の最終日にクランプ。 */
function shiftMonths(iso: string, monthsBack: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  let y = +m[1];
  let mo = +m[2] - 1 - monthsBack;
  let d = +m[3];
  y += Math.floor(mo / 12);
  mo = ((mo % 12) + 12) % 12;
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  if (d > last) d = last;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${y}-${p(mo + 1)}-${p(d)}`;
}
/** 数値 value を ±amplitude で決定論ジッタ。元の小数桁を維持。 */
function jitter(valueStr: string, valueNum: number, seedStr: string, amplitude: number): { value: string; value_num: number } {
  const rng = mulberry32(hashSeed(seedStr));
  const factor = 1 + (rng() * 2 - 1) * amplitude;
  const decimals = (valueStr.split('.')[1] || '').length;
  const nn = valueNum * factor;
  const value = decimals > 0 ? nn.toFixed(decimals) : String(Math.round(nn));
  return { value, value_num: Number(value) };
}

interface Body {
  sourceKey?: unknown;
  clientId?: unknown;
  intervalMonths?: unknown;
  count?: unknown;
  amplitude?: unknown;
  dryRun?: unknown;
  sourcePrefix?: unknown;
}

/** 種となる BloodTestData JSON の key を決める (sourceKey 優先 / clientId で最新)。 */
async function resolveSourceKey(sourceKey: string | null, clientId: string | null, sourcePrefix: string): Promise<string | null> {
  if (sourceKey) return sourceKey;
  if (!clientId) return null;
  const objs = await listObjects(sourcePrefix);
  const mine = objs
    .filter((o) => o.key.endsWith('.json') && basename(o.key).startsWith('BloodTestData_') && o.key.includes(`user_${clientId}`))
    .sort((a, b) => b.key.localeCompare(a.key)); // date は key に含まれるため降順=最新
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

  const intervalMonths = Math.max(1, Math.round(num(body.intervalMonths, 4)));
  const count = Math.max(1, Math.min(12, Math.round(num(body.count, 3))));
  const amplitude = Math.min(0.5, Math.max(0, num(body.amplitude, 0.05)));
  const dryRun = body.dryRun === true;

  const cfg = getS3Config();
  const sourcePrefix = str(body.sourcePrefix) ?? cfg?.prefix ?? 'scan-accuracy-test/';

  if (!isS3Configured() || !cfg) {
    return json({ ok: false, error: 's3_not_configured', detail: 'AWS_REGION 未設定' }, 400);
  }

  let srcKey: string | null;
  try {
    srcKey = await resolveSourceKey(str(body.sourceKey), str(body.clientId), sourcePrefix);
  } catch (err) {
    return json({ ok: false, error: 'list failed', detail: String(err instanceof Error ? err.message : err) }, 502);
  }
  if (!srcKey) return json({ ok: false, error: 'source_not_found', detail: 'sourceKey か clientId(該当BloodTestData) が必要です' }, 400);

  let src: Record<string, unknown>;
  try {
    src = JSON.parse(await getObjectText(srcKey)) as Record<string, unknown>;
  } catch (err) {
    return json({ ok: false, error: 'source read/parse failed', detail: String(err instanceof Error ? err.message : err) }, 502);
  }
  if (src.format_id !== 'BloodTestData') {
    return json({ ok: false, error: 'source_not_blood', detail: `format_id=${String(src.format_id)}` }, 400);
  }
  const clientId = str(src.client_id);
  const baseDate = str(src.test_date);
  if (!clientId || !baseDate || !/^\d{4}-\d{2}-\d{2}$/.test(baseDate)) {
    return json({ ok: false, error: 'source_invalid', detail: 'client_id / test_date が不正' }, 400);
  }
  const measurements = Array.isArray((src.data as { measurements?: unknown[] } | undefined)?.measurements)
    ? ((src.data as { measurements: Array<Record<string, unknown>> }).measurements)
    : [];

  const cleanPrefix = sourcePrefix ? sourcePrefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
  const generated: Array<{ test_date: string; key: string; item_count: number; jittered: number; uri: string | null }> = [];
  const putList: { key: string; contentType: string; body: string; bytes: number }[] = [];

  for (let i = 1; i <= count; i++) {
    const monthsBack = intervalMonths * i;
    const testDate = shiftMonths(baseDate, monthsBack);
    const dateFolder = testDate.replace(/-/g, '_');

    let jittered = 0;
    const newMeas = measurements.map((m) => {
      const valueNum = m.value_num;
      const valueStr = typeof m.value === 'string' ? m.value : m.value == null ? null : String(m.value);
      if (typeof valueNum === 'number' && Number.isFinite(valueNum) && valueStr != null) {
        const seed = `${clientId}|${String(m.name ?? '')}|${monthsBack}`;
        const j = jitter(valueStr, valueNum, seed, amplitude);
        jittered++;
        return { ...m, value: j.value, value_num: j.value_num };
      }
      return { ...m }; // 問診(ハイ/イイエ)・非数値は維持
    });

    const obj = {
      ...src,
      diagnostic_id: randomUuid(),
      test_date: testDate,
      date_source: 'synthetic',
      synthetic: true,
      exported_at: new Date().toISOString(),
      source: {
        ...(src.source && typeof src.source === 'object' ? (src.source as Record<string, unknown>) : {}),
        note: `疑似時系列テストデータ (${monthsBack}カ月前・±${Math.round(amplitude * 100)}%ジッタ)。種=${basename(srcKey)}`,
      },
      synthetic_from: srcKey,
      data: { ...(src.data as Record<string, unknown>), measurements: newMeas },
    };
    const stem = `BloodTestData_date_${dateFolder}_user_${clientId}`;
    const key = `${cleanPrefix}user/${clientId}/date/${dateFolder}/${stem}.json`;
    const bodyStr = JSON.stringify(obj, null, 2);
    putList.push({ key, contentType: 'application/json; charset=utf-8', body: bodyStr, bytes: utf8Bytes(bodyStr) });
    generated.push({ test_date: testDate, key, item_count: newMeas.length, jittered, uri: null });
  }

  if (dryRun) {
    return json({ ok: true, dry_run: true, source_key: srcKey, client_id: clientId, base_date: baseDate, count, interval_months: intervalMonths, amplitude, generated });
  }
  try {
    const uploaded = await putFiles(putList);
    const byKey = new Map(uploaded.map((u) => [u.key, u.uri]));
    for (const g of generated) g.uri = byKey.get(g.key) ?? null;
    return json({ ok: true, dry_run: false, bucket: cfg.bucket, source_key: srcKey, client_id: clientId, base_date: baseDate, count, interval_months: intervalMonths, amplitude, generated });
  } catch (err) {
    return json({ ok: false, error: 'S3 upload failed', detail: String(err instanceof Error ? err.message : err) }, 502);
  }
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
