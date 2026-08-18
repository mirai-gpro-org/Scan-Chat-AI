/**
 * admin: 健康年齢 (生物学的年齢 / CABA v4d) のテスト実行。
 *
 * デモ運用: 管理者が「顧客 (diagnostic_user_id)」と「S3 上の人間ドックJSON」を選び、
 * サーバ側でマーカー正規化 → CABA 計算 → diagnosis.health_age_scores へ保存する。
 * 保存後、その diagnostic_user_id のダッシュボードに健康年齢が表示される。
 *
 * mode:
 *   - 'list' : S3 の HealthCheckupData_*.json を一覧 (顧客が選ぶ候補)。
 *   - 'run'  : 指定 JSON から計算し、diagnostic_user_id に紐付けて保存。
 *
 * 認可: wellfort-site から Bearer ADMIN_API_KEY (env 未設定 dev のみ省略)。
 * PII: age/sex は wellfort 側で生年月日→年齢に変換して渡す (DOB は受け取らない)。
 */

import type { APIRoute } from 'astro';
import { getS3Config, isS3Configured, listObjects, getObjectText } from '../../../lib/s3';
import {
  computeHealthAge,
  normalizeMarkers,
  requiredCoverage,
  HEALTH_AGE_MODEL_VERSION,
  type HealthAgeMarkers,
  type RawItem,
} from '../../../lib/health-age';
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
function basename(key: string): string {
  return key.split('/').pop() ?? '';
}

interface Body {
  mode?: unknown;
  sourcePrefix?: unknown;
  sourceKey?: unknown;
  diagnosticUserId?: unknown;
  age?: unknown;
  sex?: unknown;
  testDate?: unknown;
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
  const mode = str(body.mode) ?? 'list';

  // ── mode=list: 人間ドック JSON を一覧 ──
  if (mode === 'list') {
    let objs;
    try {
      objs = await listObjects(sourcePrefix);
    } catch (err) {
      return json({ ok: false, error: 'list failed', detail: String(err instanceof Error ? err.message : err) }, 502);
    }
    const files = objs
      .filter((o) => o.key.endsWith('.json') && basename(o.key).startsWith('HealthCheckupData_'))
      .map((o) => {
        const m = /_date_(\d{4}_\d{2}_\d{2})_user_(.+)\.json$/.exec(basename(o.key));
        return {
          key: o.key,
          bytes: o.size,
          test_date: m ? m[1].replace(/_/g, '-') : null,
          client_id: m ? m[2] : null,
        };
      })
      .sort((a, b) => b.key.localeCompare(a.key));
    return json({ ok: true, mode: 'list', source_prefix: sourcePrefix, count: files.length, files });
  }

  // ── mode=check: 各人間ドックJSONの適合状況 (CRP以外の必須が揃っているか) ──
  if (mode === 'check') {
    let objs;
    try {
      objs = await listObjects(sourcePrefix);
    } catch (err) {
      return json({ ok: false, error: 'list failed', detail: String(err instanceof Error ? err.message : err) }, 502);
    }
    const jsons = objs
      .filter((o) => o.key.endsWith('.json') && basename(o.key).startsWith('HealthCheckupData_'))
      .sort((a, b) => b.key.localeCompare(a.key))
      .slice(0, 40); // 時間制約: 先頭40件まで判定
    const files = [];
    for (const o of jsons) {
      const m = /_date_(\d{4}_\d{2}_\d{2})_user_(.+)\.json$/.exec(basename(o.key));
      let cov: { present: string[]; missing: string[]; computable: boolean } = { present: [], missing: [], computable: false };
      let hasCrp = false;
      try {
        const obj = JSON.parse(await getObjectText(o.key)) as Record<string, unknown>;
        const data = (obj.data ?? {}) as Record<string, unknown>;
        const measurements: RawItem[] = Array.isArray(data.measurements) ? (data.measurements as RawItem[]) : [];
        const norm = normalizeMarkers(measurements);
        cov = requiredCoverage(norm);
        hasCrp = norm.crp != null;
      } catch { /* skip parse errors → computable:false */ }
      files.push({
        key: o.key,
        test_date: m ? m[1].replace(/_/g, '-') : null,
        client_id: m ? m[2] : null,
        computable: cov.computable,
        missing: cov.missing,
        present_count: cov.present.length,
        has_crp: hasCrp,
      });
    }
    return json({ ok: true, mode: 'check', source_prefix: sourcePrefix, count: files.length, files, truncated: objs.length > 40 });
  }

  // ── mode=run: 計算 + 保存 ──
  if (mode === 'run') {
    const sourceKey = str(body.sourceKey);
    const diagnosticUserId = str(body.diagnosticUserId);
    const age = typeof body.age === 'number' && Number.isFinite(body.age) ? body.age : null;
    const sexRaw = str(body.sex);
    const sex = sexRaw === 'male' || sexRaw === 'female' ? sexRaw : null;
    if (!sourceKey) return json({ ok: false, error: 'sourceKey is required' }, 400);
    if (!diagnosticUserId) return json({ ok: false, error: 'diagnosticUserId is required' }, 400);
    if (age === null) return json({ ok: false, error: 'age (number) is required' }, 400);

    // 元 JSON を取得 → measurements 抽出
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(await getObjectText(sourceKey)) as Record<string, unknown>;
    } catch (err) {
      return json({ ok: false, error: 'source read/parse failed', detail: String(err instanceof Error ? err.message : err) }, 502);
    }
    const data = (obj.data ?? {}) as Record<string, unknown>;
    const measurements: RawItem[] = Array.isArray(data.measurements) ? (data.measurements as RawItem[]) : [];
    if (measurements.length === 0) {
      return json({ ok: false, error: 'no_measurements', detail: 'data.measurements が空です' }, 400);
    }

    const normalized = normalizeMarkers(measurements);

    // 適合チェック(ハードゲート): 必須マーカーが揃っていなければ算出しない。
    // mode=check(✅/⚠️) と同一の requiredCoverage を run でも強制し、算出不能(=health_age null)を
    // そもそも作らせない。UI の適合チェックは助言表示だが、run はこのゲートで実行を止める。
    const coverage = requiredCoverage(normalized);
    if (!coverage.computable) {
      return json({
        ok: false,
        error: 'not_computable',
        detail: `必須マーカー不足のため算出不能: ${coverage.missing.join(', ')}。適合チェック(mode=check)で⚠️の検体は算出できません。`,
        mode: 'run',
        computable: false,
        missing_required: coverage.missing,
        present_markers: coverage.present,
      }, 422);
    }

    const markers: HealthAgeMarkers = { ...normalized, age, sex };
    const result = computeHealthAge(markers);

    const testDate = str(body.testDate) ?? (typeof obj.test_date === 'string' ? obj.test_date : null);
    const tDate = testDate && /^\d{4}-\d{2}-\d{2}$/.test(testDate) ? testDate : new Date().toISOString().slice(0, 10);

    const inputs = {
      markers,
      used_markers: result.used_markers,
      imputed_markers: result.imputed_markers,
      missing_required: result.missing_required,
      source_ref: sourceKey,
      adjustments: result.adjustments,
    };

    // 保存 (service_role, RLS バイパス)。型未生成テーブルのため any 経由。
    const sb = getServerSupabase();
    let saved = false;
    let saveError: string | null = null;
    let saveSkipped = false;
    if (!result.ok) {
      // 算出不能(必須マーカー不足=biological_age null)は保存しない。
      // null 行が health_age_scores に残り assemble で null の HealthAgeData を生む事故を防ぐ
      // (捏造ゼロ・"載せない"原則)。既存の妥当スコアがある場合も null で上書きしない。
      saveSkipped = true;
    } else if (sb) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tbl = (sb.schema('diagnosis') as any).from('health_age_scores');
        const { error } = await tbl.upsert(
          {
            diagnostic_user_id: diagnosticUserId,
            source_kind: 'health_checkup',
            test_date: tDate,
            chronological_age: age,
            biological_age: result.biological_age,
            delta: result.delta,
            mortality_risk: result.mortality_risk,
            model_version: HEALTH_AGE_MODEL_VERSION,
            inputs,
            source_ref: sourceKey,
            computed_at: new Date().toISOString(),
          },
          { onConflict: 'diagnostic_user_id,test_date,source_kind' },
        );
        if (error) saveError = error.message;
        else saved = true;
      } catch (err) {
        saveError = String(err instanceof Error ? err.message : err);
      }
    } else {
      saveError = 'supabase_not_configured';
    }

    return json({
      ok: result.ok && saved,
      mode: 'run',
      diagnostic_user_id: diagnosticUserId,
      test_date: tDate,
      chronological_age: age,
      biological_age: result.biological_age,
      delta: result.delta,
      computable: result.ok,
      missing_required: result.missing_required,
      used_markers: result.used_markers,
      imputed_markers: result.imputed_markers,
      normalized_markers: normalized,
      saved,
      save_skipped: saveSkipped, // true=算出不能のため保存せず(null行を作らない)
      save_error: saveError,
    });
  }

  return json({ ok: false, error: `unknown mode: ${mode}` }, 400);
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
