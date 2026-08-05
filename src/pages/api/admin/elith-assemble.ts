/**
 * admin: Elith 納品セット アセンブリ。
 *
 * S3 に種別ごと・別 client_id で散在している検査データ (a〜e) を、
 * 「1 人 = 1 ユーザーID フォルダに 5 種を束ねた」納品セット (elith-delivery/) へ組み直す。
 * キー(AWS_*)は Vercel 環境変数のみ (CLAUDE.md) → サーバ側で実行。
 *
 * 入力 (POST JSON):
 *   {
 *     mode: 'inventory' | 'assemble',   // 既定 'inventory'
 *     sourcePrefix?: string,            // 既定 = S3 設定の prefix (scan-accuracy-test/)
 *     deliveryPrefix?: string,          // 既定 'elith-delivery/'
 *     count?: number,                   // assemble(自動)の人数。既定 = 揃う範囲の上限
 *     idPrefix?: string,                // 既定 'elith-test'
 *     manualMapping?: { [userId]: { [formatId]: sourceKey } },  // 手動指定 (任意)
 *   }
 * 出力:
 *   - inventory: { ok, counts, missing, maxCompleteUsers, samples }
 *   - assemble : { ok, delivery_prefix, users:[{user_id, files:[{format_id,key,source_key,date}]}], put_count }
 *
 * 認可: wellfort-site から Bearer ADMIN_API_KEY。env 未設定(dev)のみ省略。
 */

import type { APIRoute } from 'astro';
import { getS3Config, isS3Configured, putFiles, type S3PutFile } from '../../../lib/s3';
import {
  inventoryElithSource,
  assembleElithDeliverySet,
  DELIVERY_FORMAT_IDS,
  type HealthAgeRecord,
} from '../../../lib/elith-assemble';
import { getServerSupabase } from '../../../lib/supabase';

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

interface Body {
  mode?: unknown;
  sourcePrefix?: unknown;
  deliveryPrefix?: unknown;
  count?: unknown;
  idPrefix?: unknown;
  manualMapping?: unknown;
  bundleDate?: unknown;
}

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) {
    return json({ ok: false, error: 'unauthorized', detail: 'Invalid API key' }, 401);
  }
  if (!isS3Configured()) {
    return json({ ok: false, error: 's3_not_configured', detail: 'AWS_REGION 未設定' }, 400);
  }
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const cfg = getS3Config();
  const sourcePrefix = str(body.sourcePrefix) ?? cfg?.prefix ?? 'scan-accuracy-test/';
  // 納品先はバケット直下 (プレフィックス無し) が仕様 (docs/elith/elith_s3_data_handoff_spec.md §3.1:
  //   s3://wellfort-ai-input/user/... 「例: 無し or prod/」)。body で 'prod/' 等に上書き可。
  const deliveryPrefix = typeof body.deliveryPrefix === 'string' ? (str(body.deliveryPrefix) ?? '') : '';
  const mode = str(body.mode) ?? 'inventory';

  try {
    if (mode === 'inventory') {
      const inv = await inventoryElithSource(sourcePrefix);
      // 健康年齢: 算出済みスコア(source_ref)が既存の元ファイルに一致する数 = 納品で HealthAgeData が付く見込み数。
      const haByRef = await fetchHealthAgeByRef();
      const sourceKeys = new Set<string>();
      for (const f of DELIVERY_FORMAT_IDS) for (const c of inv.byFormat[f]) sourceKeys.add(c.key);
      const haMatchedRefs = Object.keys(haByRef).filter((ref) => sourceKeys.has(ref));
      // 血液の時系列: client_id 単位で日付数を数え、複数日付(≥2)=時系列を持つ client を集計。
      const bloodDatesByClient = new Map<string, number>();
      for (const c of inv.byFormat.BloodTestData) {
        const cid = c.clientId ?? '';
        bloodDatesByClient.set(cid, (bloodDatesByClient.get(cid) ?? 0) + 1);
      }
      const bloodTimeseriesClients = [...bloodDatesByClient.values()].filter((n) => n >= 2).length;
      return json({
        ok: true,
        mode,
        source_prefix: inv.sourcePrefix,
        // HealthAgeData はアセンブリ時に生成 (元ファイルは無い)。在庫にも見込み数を出す。
        counts: { ...inv.counts, HealthAgeData: haMatchedRefs.length },
        missing: inv.missing,
        max_complete_users: inv.maxCompleteUsers,
        health_age: { scores_total: Object.keys(haByRef).length, matched_sources: haMatchedRefs.length },
        blood_timeseries: { clients: bloodTimeseriesClients, total_clients: bloodDatesByClient.size },
        samples: {
          ...Object.fromEntries(
            DELIVERY_FORMAT_IDS.map((f) => [
              f,
              inv.byFormat[f].slice(0, 5).map((c) => ({ key: c.key, date: c.date, bytes: c.size ?? null })),
            ]),
          ),
          HealthAgeData: haMatchedRefs.slice(0, 5).map((ref) => ({ key: ref, date: null, bytes: null })),
        },
      });
    }

    // assemble
    const count = typeof body.count === 'number' && body.count > 0 ? Math.floor(body.count) : undefined;
    const manualMapping =
      body.manualMapping && typeof body.manualMapping === 'object'
        ? (body.manualMapping as Record<string, Partial<Record<string, string>>>)
        : undefined;

    // 統一日付 (YYYY_MM_DD)。未指定なら lib 側で本日を採用。
    const bundleDate = (() => {
      const s = str(body.bundleDate);
      return s && /^\d{4}_\d{2}_\d{2}$/.test(s) ? s : undefined;
    })();

    // 健康年齢: 算出済みスコア (health_age_scores) を source_ref(元S3キー)で引けるよう Map 化。
    // 採用元に対応するスコアがあれば assemble が HealthAgeData を納品に追加する。
    const healthAgeByRef = await fetchHealthAgeByRef();

    const result = await assembleElithDeliverySet({
      sourcePrefix,
      deliveryPrefix,
      count,
      idPrefix: str(body.idPrefix) ?? 'elith-test',
      bundleDate,
      healthAgeByRef,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      manualMapping: manualMapping as any,
    });

    if (result.users.length === 0) {
      return json({
        ok: false,
        error: 'nothing_to_assemble',
        detail: '揃う人数が 0 です。不足種別を確認してください。',
        counts: result.inventory.counts,
        missing: result.inventory.missing,
        max_complete_users: result.inventory.maxCompleteUsers,
      }, 400);
    }

    const files: S3PutFile[] = result.users.flatMap((u) => u.files);
    const uploaded = await putFiles(files);

    return json({
      ok: true,
      mode: 'assemble',
      bucket: cfg?.bucket,
      delivery_prefix: result.deliveryPrefix,
      counts: result.inventory.counts,
      put_count: uploaded.length,
      // 空データを掴んだ納品ファイルを警告として返す (data_items=0)
      empty_files: result.users.flatMap((u) =>
        u.sources.filter((s) => s.dataItems <= 0).map((s) => ({ user_id: u.userId, format_id: s.formatId, source_key: s.sourceKey, data_items: s.dataItems })),
      ),
      users: result.users.map((u) => ({
        user_id: u.userId,
        folder: `${result.deliveryPrefix}user/${u.userId}/date/${u.sources[0]?.deliveredDate ?? ''}/`,
        files: u.sources.map((s) => ({ format_id: s.formatId, key: s.newKey, source_key: s.sourceKey, date: s.deliveredDate, source_date: s.sourceDate, data_items: s.dataItems })),
      })),
    });
  } catch (err) {
    return json({ ok: false, error: 'assemble failed', detail: String(err instanceof Error ? err.message : err) }, 502);
  }
};

/** health_age_scores を source_ref → 最新スコア の Map にする (assemble の突合用)。 */
async function fetchHealthAgeByRef(): Promise<Record<string, HealthAgeRecord>> {
  const out: Record<string, HealthAgeRecord> = {};
  const sb = getServerSupabase();
  if (!sb) return out;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tbl = (sb.schema('diagnosis') as any).from('health_age_scores');
    const { data, error } = await tbl
      .select('source_ref, biological_age, chronological_age, test_date, computed_at, delta, model_version')
      .not('source_ref', 'is', null)
      .order('computed_at', { ascending: false });
    if (error || !Array.isArray(data)) return out;
    // computed_at 降順なので、source_ref 毎に最初(最新)だけ採用
    for (const r of data as Array<Record<string, unknown>>) {
      const ref = typeof r.source_ref === 'string' ? r.source_ref : null;
      if (!ref || out[ref]) continue;
      const numOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : v == null ? null : Number(v));
      out[ref] = {
        biological_age: numOrNull(r.biological_age),
        chronological_age: numOrNull(r.chronological_age),
        test_date: typeof r.test_date === 'string' ? r.test_date : null,
        computed_at: typeof r.computed_at === 'string' ? r.computed_at : null,
        delta: numOrNull(r.delta),
        model_version: typeof r.model_version === 'string' ? r.model_version : null,
      };
    }
  } catch {
    /* テーブル未生成/未設定時は健康年齢を載せないだけ (assemble は継続) */
  }
  return out;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
