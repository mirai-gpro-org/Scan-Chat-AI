/**
 * admin: 検査データの時系列テスト用「疑似データ」を生成する（血液に加え がん/検診/AI疾病予測 に一般化）。
 *
 * 既存の血液生成方式を踏襲: 現在の1検査を「種」にして過去スナップショットを決定論生成する。
 *   - 同一 client_id・別 date フォルダに書き出す (Elith は §3.3 の時系列として読む)。
 *   - 対象 format:
 *       measurement系 (BloodTestData / CancerRiskAssessmentData / HealthCheckupData)
 *         → data.measurements[].value_num のみ ±amplitude(既定5%) の独立ジッタ。問診/非数値は維持。
 *       Other (AI疾病予測 ai_prediction) → data.payload 内の数値を再帰的に ±amplitude ジッタ。文字列等は維持。
 *   - 年次パターンは intervalMonths=12 / count=2 (種=当年 + 過去2年 = 計3回) を指定して生成する。
 *     (既定は血液の従来値 intervalMonths=4 / count=3 のまま＝後方互換)
 *   - seed 固定 (client_id+パス+月数) のため毎回同じ疑似データ (テスト再現可能)。値はゼロから捏造せず種を摂動。
 *   - `synthetic: true` を付与し識別・後で一括削除できるようにする。
 * キー(AWS_*)はサーバ環境変数のみ。認可: Bearer ADMIN_API_KEY (env 未設定 dev のみ省略)。
 */

import type { APIRoute } from 'astro';
import { getS3Config, isS3Configured, listObjects, getObjectText, putFiles } from '../../../lib/s3';
import { jitterAiPredictionItems } from '../../../lib/elith-synthetic';
import { isAdminAuthorized } from '../../../lib/api-auth';

export const prerender = false;

// 生成対象 format。measurement系は measurements[] をジッタ、Other は payload をジッタ。
const MEAS_FORMATS = new Set(['BloodTestData', 'CancerRiskAssessmentData', 'HealthCheckupData']);
const ALLOWED_FORMATS = new Set([...MEAS_FORMATS, 'Other']);

function authorized(request: Request): boolean {
  // 認可の実装は src/lib/api-auth.ts に集約 (キー未設定の本番は拒否＝fail-closed)。
  return isAdminAuthorized(request);
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
/** 数値 n を ±amplitude で決定論ジッタ。整数は整数・小数は元桁を維持。 */
function jitterNumber(n: number, seedStr: string, amplitude: number): number {
  const rng = mulberry32(hashSeed(seedStr));
  const factor = 1 + (rng() * 2 - 1) * amplitude;
  const decimals = Number.isInteger(n) ? 0 : (String(n).split('.')[1] || '').length;
  const nn = n * factor;
  return decimals > 0 ? Number(nn.toFixed(decimals)) : Math.round(nn);
}
/** 任意構造(payload)を再帰的に走査し、数値のみ ±amplitude ジッタ (文字列/真偽/null は維持)。 */
function jitterDeep(v: unknown, seedBase: string, amplitude: number, ctr: { n: number }): unknown {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return jitterNumber(v, `${seedBase}|${ctr.n++}`, amplitude);
  }
  if (Array.isArray(v)) return v.map((el) => jitterDeep(el, seedBase, amplitude, ctr));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = jitterDeep(val, seedBase, amplitude, ctr);
    return out;
  }
  return v;
}

interface Body {
  mode?: unknown;
  format?: unknown;
  sourceKey?: unknown;
  clientId?: unknown;
  intervalMonths?: unknown;
  count?: unknown;
  amplitude?: unknown;
  dryRun?: unknown;
  sourcePrefix?: unknown;
}

/** {format}_* から client_id 候補を集める (最新検査日・件数付き)。UI のプルダウン用。 */
async function listFormatClients(sourcePrefix: string, format: string): Promise<Array<{ client_id: string; latest_date: string | null; count: number }>> {
  const objs = await listObjects(sourcePrefix);
  const map = new Map<string, { latest_date: string | null; count: number }>();
  const re = new RegExp(`^${format}_date_(\\d{4}_\\d{2}_\\d{2})_user_(.+)\\.json$`);
  for (const o of objs) {
    if (!o.key.endsWith('.json')) continue;
    const m = re.exec(basename(o.key));
    if (!m) continue;
    const date = m[1].replace(/_/g, '-');
    const cid = m[2];
    const cur = map.get(cid) ?? { latest_date: null, count: 0 };
    cur.count += 1;
    if (!cur.latest_date || date > cur.latest_date) cur.latest_date = date;
    map.set(cid, cur);
  }
  return [...map.entries()]
    .map(([client_id, v]) => ({ client_id, latest_date: v.latest_date, count: v.count }))
    .sort((a, b) => (b.latest_date ?? '').localeCompare(a.latest_date ?? '') || a.client_id.localeCompare(b.client_id));
}

/** 種となる {format} JSON の key を決める (sourceKey 優先 / clientId で最新)。 */
async function resolveSourceKey(sourceKey: string | null, clientId: string | null, sourcePrefix: string, format: string): Promise<string | null> {
  if (sourceKey) return sourceKey;
  if (!clientId) return null;
  const objs = await listObjects(sourcePrefix);
  const mine = objs
    .filter((o) => o.key.endsWith('.json') && basename(o.key).startsWith(`${format}_`) && o.key.includes(`user_${clientId}`))
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

  const mode = str(body.mode) ?? 'generate';
  const format = str(body.format) ?? 'BloodTestData'; // 後方互換: 未指定は血液
  if (!ALLOWED_FORMATS.has(format)) {
    return json({ ok: false, error: 'unsupported_format', detail: `format は ${[...ALLOWED_FORMATS].join(' / ')} のいずれか` }, 400);
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

  // ── mode=list: client_id 候補を返す (UI プルダウン用) ──
  if (mode === 'list') {
    try {
      const clients = await listFormatClients(sourcePrefix, format);
      return json({ ok: true, mode: 'list', format, source_prefix: sourcePrefix, count: clients.length, clients });
    } catch (err) {
      return json({ ok: false, error: 'list failed', detail: String(err instanceof Error ? err.message : err) }, 502);
    }
  }

  let srcKey: string | null;
  try {
    srcKey = await resolveSourceKey(str(body.sourceKey), str(body.clientId), sourcePrefix, format);
  } catch (err) {
    return json({ ok: false, error: 'list failed', detail: String(err instanceof Error ? err.message : err) }, 502);
  }
  if (!srcKey) return json({ ok: false, error: 'source_not_found', detail: `sourceKey か clientId(該当${format}) が必要です` }, 400);

  let src: Record<string, unknown>;
  try {
    src = JSON.parse(await getObjectText(srcKey)) as Record<string, unknown>;
  } catch (err) {
    return json({ ok: false, error: 'source read/parse failed', detail: String(err instanceof Error ? err.message : err) }, 502);
  }
  if (src.format_id !== format) {
    return json({ ok: false, error: 'source_format_mismatch', detail: `種の format_id=${String(src.format_id)} (要求=${format})` }, 400);
  }
  const clientId = str(src.client_id);
  const baseDate = str(src.test_date);
  if (!clientId || !baseDate || !/^\d{4}-\d{2}-\d{2}$/.test(baseDate)) {
    return json({ ok: false, error: 'source_invalid', detail: 'client_id / test_date が不正' }, 400);
  }
  const srcData = src.data && typeof src.data === 'object' ? (src.data as Record<string, unknown>) : {};
  const measurements = Array.isArray((srcData as { measurements?: unknown[] }).measurements)
    ? ((srcData as { measurements: Array<Record<string, unknown>> }).measurements)
    : [];

  const cleanPrefix = sourcePrefix ? sourcePrefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
  const generated: Array<{ test_date: string; key: string; item_count: number; jittered: number; uri: string | null }> = [];
  const putList: { key: string; contentType: string; body: string; bytes: number }[] = [];

  for (let i = 1; i <= count; i++) {
    const monthsBack = intervalMonths * i;
    const testDate = shiftMonths(baseDate, monthsBack);
    const dateFolder = testDate.replace(/-/g, '_');

    let jittered = 0;
    let dataOut: Record<string, unknown>;
    let itemCount: number;
    if (MEAS_FORMATS.has(format)) {
      // measurement系: measurements[].value_num のみジッタ。問診/非数値は維持。
      const newMeas = measurements.map((m) => {
        const valueNum = m.value_num;
        const valueStr = typeof m.value === 'string' ? m.value : m.value == null ? null : String(m.value);
        if (typeof valueNum === 'number' && Number.isFinite(valueNum) && valueStr != null) {
          const seed = `${clientId}|${String(m.name ?? '')}|${monthsBack}`;
          const j = jitter(valueStr, valueNum, seed, amplitude);
          jittered++;
          return { ...m, value: j.value, value_num: j.value_num };
        }
        return { ...m };
      });
      dataOut = { ...srcData, measurements: newMeas };
      itemCount = newMeas.length;
    } else {
      // Other (LAiF ai_prediction): 実納品は data.items[] (§5)。発症率%/相対リスク比のみジッタし
      // 疾患名/アドバイス/item_count/pages は維持。旧 data.payload 形式の種は後方互換で再帰ジッタ。
      // ※「昨年の相対リスク比」の前年引き継ぎはプラン駆動 (elith-plan-timeseries) 側で行う。
      const itemsSrc = (srcData as { items?: unknown }).items;
      if (Array.isArray(itemsSrc)) {
        const j = jitterAiPredictionItems(itemsSrc, `${clientId}|items|${monthsBack}`, amplitude);
        jittered = j.jittered;
        dataOut = { ...srcData, items: j.items, item_count: j.items.length };
        itemCount = j.items.length;
      } else {
        const ctr = { n: 0 };
        const payloadOut = jitterDeep((srcData as { payload?: unknown }).payload, `${clientId}|payload|${monthsBack}`, amplitude, ctr);
        jittered = ctr.n;
        dataOut = { ...srcData, payload: payloadOut };
        itemCount = jittered;
      }
    }

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
      data: dataOut,
    };
    const stem = `${format}_date_${dateFolder}_user_${clientId}`;
    const key = `${cleanPrefix}user/${clientId}/date/${dateFolder}/${stem}.json`;
    const bodyStr = JSON.stringify(obj, null, 2);
    putList.push({ key, contentType: 'application/json; charset=utf-8', body: bodyStr, bytes: utf8Bytes(bodyStr) });
    generated.push({ test_date: testDate, key, item_count: itemCount, jittered, uri: null });
  }

  if (dryRun) {
    return json({ ok: true, dry_run: true, format, source_key: srcKey, client_id: clientId, base_date: baseDate, count, interval_months: intervalMonths, amplitude, generated });
  }
  try {
    const uploaded = await putFiles(putList);
    const byKey = new Map(uploaded.map((u) => [u.key, u.uri]));
    for (const g of generated) g.uri = byKey.get(g.key) ?? null;
    return json({ ok: true, dry_run: false, format, bucket: cfg.bucket, source_key: srcKey, client_id: clientId, base_date: baseDate, count, interval_months: intervalMonths, amplitude, generated });
  } catch (err) {
    return json({ ok: false, error: 'S3 upload failed', detail: String(err instanceof Error ? err.message : err) }, 502);
  }
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
