/**
 * admin: S3 の Elith 関連ファイルを削除する (2 段階: list → delete)。
 *
 * target (検査種別ごとに個別削除。basename の format_id 接頭辞で対象を絞る):
 *   - 'health-checkup' : HealthCheckupData_*      (JSON + 連番画像)
 *   - 'genetic'        : GeneticTestResultData_*   (JSON)
 *   - 'cancer'         : CancerRiskAssessmentData_* (JSON + 画像)
 *   - 'blood'          : BloodTestData_*           (JSON)
 *   - 'other'          : Other_*                   (LAiF AI疾病発症予測・JSON)
 *   - 'delivery'       : 納品先 (バケット直下 user/ および旧 elith-delivery/) 配下を全削除。
 * mode:
 *   - 'list'   : 削除対象の key 一覧を返す (削除しない)。
 *   - 'delete' : 実際に削除する。
 * キー(AWS_*)はサーバ環境変数のみ。認可: Bearer ADMIN_API_KEY (env 未設定 dev のみ省略)。
 */

import type { APIRoute } from 'astro';
import { getS3Config, isS3Configured, listObjects, deleteObjects } from '../../../lib/s3';

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
function basename(key: string): string {
  return key.split('/').pop() ?? '';
}

interface Body {
  mode?: unknown;
  target?: unknown;
  sourcePrefix?: unknown;
}

// 検査種別 target → basename の format_id 接頭辞 (JSON も画像も同じ接頭辞で始まる)。
const TARGET_PREFIX: Record<string, string> = {
  'health-checkup': 'HealthCheckupData_',
  'genetic': 'GeneticTestResultData_',
  'cancer': 'CancerRiskAssessmentData_',
  'blood': 'BloodTestData_',
  'other': 'Other_', // LAiF AI疾病発症予測(Other/ai_prediction)
};

/** target に該当する削除対象 key を集める */
async function collectKeys(target: string, sourcePrefix: string): Promise<string[]> {
  const fp = TARGET_PREFIX[target];
  if (fp) {
    const objs = await listObjects(sourcePrefix);
    // basename が format_id 接頭辞で始まるもの (JSON も連番画像も対象)
    return objs.filter((o) => basename(o.key).startsWith(fp)).map((o) => o.key);
  }
  if (target === 'delivery') {
    // 納品先 = バケット直下 user/ と 旧 elith-delivery/
    const [a, b] = await Promise.all([listObjects('user/'), listObjects('elith-delivery/')]);
    return [...a, ...b].map((o) => o.key);
  }
  throw new Error(`unknown target: ${target}`);
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

  const mode = str(body.mode) ?? 'list';
  const target = str(body.target) ?? '';
  const cfg = getS3Config();
  const sourcePrefix = str(body.sourcePrefix) ?? cfg?.prefix ?? 'scan-accuracy-test/';

  let keys: string[];
  try {
    keys = await collectKeys(target, sourcePrefix);
  } catch (err) {
    return json({ ok: false, error: 'list failed', detail: String(err instanceof Error ? err.message : err) }, 400);
  }

  if (mode === 'list') {
    return json({
      ok: true, mode: 'list', target, count: keys.length,
      keys: keys.slice(0, 50), truncated: keys.length > 50,
    });
  }
  if (mode === 'delete') {
    if (keys.length === 0) return json({ ok: true, mode: 'delete', target, deleted: 0, note: '対象なし' });
    try {
      const deleted = await deleteObjects(keys);
      return json({ ok: true, mode: 'delete', target, deleted, requested: keys.length });
    } catch (err) {
      return json({ ok: false, error: 'delete failed', detail: String(err instanceof Error ? err.message : err) }, 502);
    }
  }
  return json({ ok: false, error: `unknown mode: ${mode}` }, 400);
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
