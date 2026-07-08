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
} from '../../../lib/elith-assemble';

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
  // 納品先はバケット直下 (プレフィックス無し) が仕様 (docs/elith_s3_data_handoff_spec.md §3.1:
  //   s3://wellfort-ai-input/user/... 「例: 無し or prod/」)。body で 'prod/' 等に上書き可。
  const deliveryPrefix = typeof body.deliveryPrefix === 'string' ? (str(body.deliveryPrefix) ?? '') : '';
  const mode = str(body.mode) ?? 'inventory';

  try {
    if (mode === 'inventory') {
      const inv = await inventoryElithSource(sourcePrefix);
      return json({
        ok: true,
        mode,
        source_prefix: inv.sourcePrefix,
        counts: inv.counts,
        missing: inv.missing,
        max_complete_users: inv.maxCompleteUsers,
        samples: Object.fromEntries(
          DELIVERY_FORMAT_IDS.map((f) => [f, inv.byFormat[f].slice(0, 3).map((c) => c.key)]),
        ),
      });
    }

    // assemble
    const count = typeof body.count === 'number' && body.count > 0 ? Math.floor(body.count) : undefined;
    const manualMapping =
      body.manualMapping && typeof body.manualMapping === 'object'
        ? (body.manualMapping as Record<string, Partial<Record<string, string>>>)
        : undefined;

    const result = await assembleElithDeliverySet({
      sourcePrefix,
      deliveryPrefix,
      count,
      idPrefix: str(body.idPrefix) ?? 'elith-test',
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
      users: result.users.map((u) => ({
        user_id: u.userId,
        folder: `${result.deliveryPrefix}user/${u.userId}/`,
        files: u.sources.map((s) => ({ format_id: s.formatId, key: s.newKey, source_key: s.sourceKey, date: s.date })),
      })),
    });
  } catch (err) {
    return json({ ok: false, error: 'assemble failed', detail: String(err instanceof Error ? err.message : err) }, 502);
  }
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
