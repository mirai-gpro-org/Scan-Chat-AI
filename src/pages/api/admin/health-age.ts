/**
 * admin: ウェルネス年齢 (生物学的年齢 / 旧称「健康年齢」) のテスト実行。
 *
 * デモ運用: 管理者が「顧客 (diagnostic_user_id)」と「S3 上の人間ドックJSON」を選び、
 * サーバ側でマーカー正規化 → 算出 → diagnosis.health_age_scores へ保存する。
 * 保存後、その diagnostic_user_id のダッシュボードにウェルネス年齢が表示される。
 *
 * 算出は `wellness-age.ts` の段階フォールバック (①正規版 CABA v5.4 → ②簡易版 v7.0 → ③算出不能)。
 * ③ のときだけ値を作らず定型文 (`WELLNESS_AGE_UNAVAILABLE_MESSAGE`) を返す。
 *
 * mode:
 *   - 'list'  : S3 の HealthCheckupData_*.json を一覧 (顧客が選ぶ候補)。
 *   - 'check' : 各 JSON がどの版で算出できるか (full / simple / unavailable) を判定。
 *   - 'run'   : 指定 JSON から計算し、diagnostic_user_id に紐付けて保存。
 *
 * 認可: wellfort-site から Bearer ADMIN_API_KEY (env 未設定 dev のみ省略)。
 * PII: age/sex は wellfort 側で生年月日→年齢に変換して渡す (DOB は受け取らない)。
 */

import type { APIRoute } from 'astro';
import { getS3Config, isS3Configured, listObjects, getObjectText } from '../../../lib/s3';
import {
  normalizeMarkers,
  type HealthAgeMarkers,
  type RawItem,
} from '../../../lib/health-age';
import {
  computeWellnessAge,
  wellnessAgeCoverage,
  METHOD_LABEL,
  WELLNESS_AGE_UNAVAILABLE_MESSAGE,
} from '../../../lib/wellness-age';
import { getServerSupabase } from '../../../lib/supabase';
import { isAdminAuthorized } from '../../../lib/api-auth';

export const prerender = false;

function authorized(request: Request): boolean {
  // 認可の実装は src/lib/api-auth.ts に集約 (キー未設定の本番は拒否＝fail-closed)。
  return isAdminAuthorized(request);
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
  // 簡易版 (v7.0) の入力・補助オーバーレイ
  'hba1c', 'ua', 'egfr', 'ldl', 'tg', 'ggt', 'bun', 'waist', 'dbp',
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

  // ── mode=check: 各人間ドックJSONの適合状況 (①正規版で算出可か / ②簡易版なら算出可か / ③不能か) ──
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
      let cov = { method: 'unavailable' as const, missing_full: [] as string[], missing_simple: [] as string[] };
      let present = 0;
      let hasCrp = false;
      try {
        const obj = JSON.parse(await getObjectText(o.key)) as Record<string, unknown>;
        const data = (obj.data ?? {}) as Record<string, unknown>;
        const measurements: RawItem[] = Array.isArray(data.measurements) ? (data.measurements as RawItem[]) : [];
        const norm = normalizeMarkers(measurements);
        for (const [k, v] of Object.entries(synthCheck)) {
          if ((norm as Record<string, unknown>)[k] == null) (norm as Record<string, number>)[k] = v;
        }
        cov = wellnessAgeCoverage(norm) as typeof cov;
        present = Object.values(norm).filter((v) => v != null).length;
        hasCrp = norm.crp != null;
      } catch { /* skip parse errors → method:'unavailable' */ }
      files.push({
        key: o.key,
        test_date: m ? m[1].replace(/_/g, '-') : null,
        client_id: m ? m[2] : null,
        // computable = ①②いずれかで算出できる (③のときだけ false)。
        computable: cov.method !== 'unavailable',
        method: cov.method,
        method_label: METHOD_LABEL[cov.method],
        // 正規版で足りていない必須 (簡易版で救済される場合も参考として返す)。
        missing: cov.missing_full,
        missing_simple: cov.missing_simple,
        present_count: present,
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
    //   ・注入はウェルネス年齢の計算だけに効く。元 JSON / 納品HC は変更しない (HCは実測のまま=捏造をHCに入れない)。
    //   ・synthetic_markers として応答・inputs に必ず残す (トレーサビリティ)。状況報告書の添付が前提。
    //   ・ハードゲート(下記)より前に適用する → 合成で不足を埋めた検体は算出可(computable)になりゲートを通す。
    const synthReq = parseSyntheticMarkers(body.syntheticMarkers);
    const synthApplied: Record<string, number> = {};
    for (const [k, v] of Object.entries(synthReq)) {
      if ((normalized as Record<string, unknown>)[k] == null) {
        (normalized as Record<string, number>)[k] = v;
        synthApplied[k] = v;
      }
    }

    // ①正規版 → ②簡易版 → ③算出不能 の順で算出する (wellness-age.ts)。
    // ※合成補完(上)の後に評価するので、正規の例外運用(synthetic)で埋めた検体は①を通る。
    const markers: HealthAgeMarkers = { ...normalized, age, sex };
    const result = computeWellnessAge(markers);

    // ③ ハードゲート: ①でも②でも算出できない検体は値を作らない (捏造ゼロ・"載せない"原則)。
    // health_age_scores に null 行を残さないため、保存もしない。
    if (result.method === 'unavailable') {
      return json({
        ok: false,
        error: 'not_computable',
        detail: WELLNESS_AGE_UNAVAILABLE_MESSAGE,
        message: WELLNESS_AGE_UNAVAILABLE_MESSAGE,
        mode: 'run',
        computable: false,
        method: 'unavailable',
        method_label: METHOD_LABEL.unavailable,
        missing_required: result.missing_full,
        missing_simple: result.missing_simple,
        normalized_markers: normalized,
      }, 422);
    }

    const testDate = str(body.testDate) ?? (typeof obj.test_date === 'string' ? obj.test_date : null);
    const tDate = testDate && /^\d{4}-\d{2}-\d{2}$/.test(testDate) ? testDate : new Date().toISOString().slice(0, 10);

    const inputs = {
      markers,
      // どの版で算出したか。簡易版は補助オーバーレイの係数が暫定・血糖が eAG 推定になり得るため必ず残す。
      method: result.method,
      model_version: result.model_version,
      glucose_source: result.glucose_source, // 'eag' = HbA1c からの推定平均血糖で代用
      used_markers: result.used_markers,
      imputed_markers: result.imputed_markers,
      missing_required: result.missing_full,
      source_ref: sourceKey,
      adjustments: result.full.adjustments,
      overlay: result.simple
        ? { total: result.simple.overlay_total, contributions: result.simple.overlay_contributions }
        : null,
      synthetic_markers: synthApplied, // 例外運用: 手動合成補完した不足マーカー (空={}=なし)
    };

    // 保存 (service_role, RLS バイパス)。型未生成テーブルのため any 経由。
    const sb = getServerSupabase();
    let saved = false;
    let saveError: string | null = null;
    let saveSkipped = false;
    if (!result.ok || result.biological_age == null) {
      // 算出不能は保存しない (通常はこの手前の 422 で返るが、二重の安全弁として残す)。
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
            model_version: result.model_version, // CABA-v5.4 (正規版) / CABA-SIMPLE-v7.0 (簡易版)
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
      method: result.method,             // 'full' = 正規版 / 'simple' = 簡易版
      method_label: METHOD_LABEL[result.method],
      model_version: result.model_version,
      glucose_source: result.glucose_source, // 'eag' = HbA1c から推定平均血糖で代用
      message: result.message,           // 算出不能時のみ (通常は null)
      missing_required: result.missing_full,
      missing_simple: result.missing_simple,
      used_markers: result.used_markers,
      imputed_markers: result.imputed_markers,
      synthetic_markers: synthApplied,
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
