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
  syntheticMarkers?: unknown; // 【例外運用】不足必須マーカーの手動合成補完 {lymph:34,...}。計算のみに注入・記録。
}

// 合成補完を許可するマーカーキー (HealthAgeMarkers の数値項目のみ)。
const SYNTH_ALLOW = new Set([
  'albumin', 'creatinine', 'glucose', 'crp', 'lymph', 'mcv', 'rdw', 'alp', 'wbc', 'neut', 'sbp', 'fev1fvc', 'bmi',
]);
function parseSyntheticMarkers(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!SYNTH_ALLOW.has(k)) continue;
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
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
    // check でも合成補完を考慮 (run 前に ✅ を確認できるように)。実測は上書きしない。
    const synthCheck = parseSyntheticMarkers(body.syntheticMarkers);
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
        for (const [k, v] of Object.entries(synthCheck)) {
          if ((norm as Record<string, unknown>)[k] == null) (norm as Record<string, number>)[k] = v;
        }
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

    // 【例外運用・記録付き】不足必須マーカーの手動合成補完。
    //   ・実測が既に在るキーは絶対に上書きしない (合成は"不足"のみ)。
    //   ・注入は健康年齢の計算だけに効く。元 JSON / 納品HC は変更しない (HCは実測のまま=捏造をHCに入れない)。
    //   ・synthetic_markers として応答・inputs に必ず残す (トレーサビリティ)。状況報告書の添付が前提。
    const synthReq = parseSyntheticMarkers(body.syntheticMarkers);
    const synthApplied: Record<string, number> = {};
    for (const [k, v] of Object.entries(synthReq)) {
      if ((normalized as Record<string, unknown>)[k] == null) {
        (normalized as Record<string, number>)[k] = v;
        synthApplied[k] = v;
      }
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
      synthetic_markers: synthApplied, // 例外運用: 手動合成補完した不足マーカー (空={}=なし)
    };

    // 保存 (service_role, RLS バイパス)。型未生成テーブルのため any 経由。
    const sb = getServerSupabase();
    let saved = false;
    let saveError: string | null = null;
    if (sb) {
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
      synthetic_markers: synthApplied,
      normalized_markers: normalized,
      saved,
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
