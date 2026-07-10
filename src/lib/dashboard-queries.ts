/**
 * ダッシュボードのデータ取得ヘルパ。
 *
 * dev profile (Phase 1.0) では認証が未連携のため、URL パラメータ `?u=<diagnostic_user_id>`
 * で誰のダッシュボードを描画するかを指定する。本番では Google One Tap →
 * app_users.auth_user_id → diagnostic_user_id 解決に置き換える。
 */

import { getServerSupabase, isBridgeConfigured } from './supabase';
import { loadBridgeBundle, type CustomerBundle } from './bridge-queries';
import { buildDemoDashboard, demoFallbackEnabled, demoMetricTrend } from './demo-data';
import type {
  AppUser,
  CustomerProfile,
  DiagnosisResult,
  KitShipment,
  Subscription,
  TestArtifact,
} from '../types/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../types/supabase';
import { extractMetricCards, type ElithSection, type MetricCard } from './elith-parser';

export interface MetricTrendPoint {
  date: string;       // ISO date
  value: number;
  /** chip 表示用 — 元の "8.4" や "132/85" */
  raw: string;
}

export interface MetricTrendSeries {
  label: string;       // '尿酸' | '血圧 (収縮期)' | '空腹時血糖'
  unit: string;
  /** 参考の基準上限 (折れ線グラフに点線で描画) */
  referenceUpper?: number;
  points: MetricTrendPoint[];
}

export interface DashboardData {
  diagnosticUserId: string;
  /** 検査結果(artifacts/results/trend)の実データ取得元 uid。デモ時は DEFAULT_USER。 */
  resultUid: string;
  /** テストフェーズのデモ(真鍋)フォールバックで結果を表示しているか。 */
  usingDemoData: boolean;
  appUser: AppUser | null;
  customer: CustomerProfile | null;
  artifacts: TestArtifact[];
  latestResult: DiagnosisResult | null;
  /** Elith JSON (latest published) */
  elithSections: ElithSection[];
  /** 進行中 + 直近完了の kit_shipment + lab name の join */
  shipments: (KitShipment & { lab_name: string | null })[];
  /** active subscription (なければ null) */
  subscription: (Subscription & { plan_name: string | null }) | null;
}

/** 認証未連携の dev profile で ?u= が無い時に使うデフォルトユーザー (真鍋 慶次郎)。 */
export const DEFAULT_USER = 'd0000001-0000-0000-0000-000000000000';

/**
 * URL パラメータの ?u= で来る値を正規化する:
 *   - 完全な uuid (36 char) → そのまま
 *   - 短縮形 `d0000001` や `d0000001-0000-0000-0000-00000000000` (最終ブロック不足)
 *     → 先頭 8 桁を取り、末尾を `-0000-0000-0000-000000000000` で埋めて返す
 *   - 何もマッチしなければ null
 */
function normalizeDiagnosticUserId(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return trimmed;
  }
  const m = /^([0-9a-f]{8})/i.exec(trimmed);
  if (m) return `${m[1].toLowerCase()}-0000-0000-0000-000000000000`;
  return null;
}

/** dashboard.astro から呼ぶ。 */
export async function loadDashboard(diagnosticUserId?: string | null): Promise<DashboardData | { error: string }> {
  const normalized = diagnosticUserId ? normalizeDiagnosticUserId(diagnosticUserId) : null;
  const uid = normalized ?? DEFAULT_USER;

  try {
    const sb = getServerSupabase();
    if (!sb) {
      // Supabase 未設定でもテストフェーズはダミーを見せる (500 にしない)
      if (demoFallbackEnabled()) return buildDemoDashboard(uid, null);
      return { error: 'Supabase が未設定です。.env.local を確認してください。' };
    }

    // diagnosis schema (Web 所有) — appUser / artifacts / results は常に #2 から取得
    const dsb = sb.schema('diagnosis');
    const [
      { data: appUser, error: appUserErr },
      { data: artifactsRaw, error: artErr },
      { data: resultsRaw, error: resErr },
    ] = await Promise.all([
      dsb.from('app_users').select('*').eq('diagnostic_user_id', uid).maybeSingle(),
      dsb.from('test_artifacts').select('*').eq('diagnostic_user_id', uid).order('test_date', { ascending: false }),
      dsb.from('diagnosis_results').select('*').eq('diagnostic_user_id', uid).order('received_at', { ascending: false }),
    ]);

    // クエリエラー時もテストフェーズはダミーへ (テーブル未適用等で 500 にしない)
    if (appUserErr || artErr || resErr) {
      if (demoFallbackEnabled()) return buildDemoDashboard(uid, appUser?.display_name_cache ?? null);
      if (appUserErr) return { error: `app_users: ${appUserErr.message}` };
      if (artErr)     return { error: `test_artifacts: ${artErr.message}` };
      return { error: `diagnosis_results: ${resErr!.message}` };
    }

    let artifacts = artifactsRaw ?? [];
    let results = resultsRaw ?? [];
    let resultUid = uid;
    let usingDemoData = false;

    // フォールバック1: 当該ユーザーに結果が無ければ 真鍋(DEFAULT_USER) の実データを表示。
    if (demoFallbackEnabled() && results.length === 0 && uid !== DEFAULT_USER) {
      const [
        { data: demoArtifacts },
        { data: demoResults },
      ] = await Promise.all([
        dsb.from('test_artifacts').select('*').eq('diagnostic_user_id', DEFAULT_USER).order('test_date', { ascending: false }),
        dsb.from('diagnosis_results').select('*').eq('diagnostic_user_id', DEFAULT_USER).order('received_at', { ascending: false }),
      ]);
      if (demoResults && demoResults.length > 0) {
        artifacts = demoArtifacts ?? [];
        results = demoResults;
        resultUid = DEFAULT_USER;
        usingDemoData = true;
      }
    }

    // フォールバック2: 真鍋にも実データが無ければ 組込みダミー(demo-data) で画面を成立させる。
    if (demoFallbackEnabled() && results.length === 0) {
      return buildDemoDashboard(uid, appUser?.display_name_cache ?? null);
    }

    const latestResult = results[0] ?? null;
    // report は jsonb 配列想定。配列以外 (null/オブジェクト/文字列) は空扱いにして throw を防ぐ。
    const elithSections: ElithSection[] = Array.isArray(latestResult?.report)
      ? (latestResult!.report as unknown as ElithSection[])
      : [];

    // 顧客/プラン/キットは app_bridge (本番) もしくは customer モック (dev) から取得。
    // デモ表示中は結果元 (resultUid) に揃える。
    const bundle = isBridgeConfigured()
      ? await loadBridgeBundle(resultUid)
      : await loadMockCustomerBundle(sb, resultUid);
    // バンドル取得失敗時も画面は成立させる (顧客/プランは空扱い)
    const safeBundle: CustomerBundle = 'error' in bundle
      ? { customer: null, shipments: [], subscription: null }
      : bundle;

    return {
      diagnosticUserId: uid,
      resultUid,
      usingDemoData,
      appUser: appUser ?? null,
      customer: safeBundle.customer,
      artifacts,
      latestResult,
      elithSections,
      shipments: safeBundle.shipments,
      subscription: safeBundle.subscription,
    };
  } catch (e) {
    // 想定外の例外でも 500 にせず、テストフェーズはダミー／それ以外はエラー表示
    if (demoFallbackEnabled()) return buildDemoDashboard(uid, null);
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * dev フォールバック: モック `customer` スキーマから顧客バンドルを取得。
 * 本番 (app_bridge 構成済) では loadBridgeBundle が使われる。
 */
async function loadMockCustomerBundle(
  sb: SupabaseClient<Database>,
  uid: string,
): Promise<CustomerBundle | { error: string }> {
  const csb = sb.schema('customer');

  const { data: customer, error: custErr } = await csb
    .from('customer_profiles')
    .select('*')
    .eq('diagnostic_user_id', uid)
    .maybeSingle();
  if (custErr) return { error: `customer_profiles: ${custErr.message}` };
  if (!customer) return { customer: null, shipments: [], subscription: null };

  const [
    { data: shipmentsRaw, error: shipErr },
    { data: labCompanies, error: labErr },
    { data: subRaw, error: subErr },
    { data: plans, error: planErr },
  ] = await Promise.all([
    csb.from('kit_shipments').select('*').eq('customer_id', customer.user_id).order('shipped_at', { ascending: false }).limit(10),
    csb.from('lab_companies').select('id, name'),
    csb.from('subscriptions').select('*').eq('customer_id', customer.user_id).eq('status', 'active').limit(1).maybeSingle(),
    csb.from('subscription_plans').select('id, name'),
  ]);

  if (shipErr) return { error: `kit_shipments: ${shipErr.message}` };
  if (labErr)  return { error: `lab_companies: ${labErr.message}` };
  if (subErr)  return { error: `subscriptions: ${subErr.message}` };
  if (planErr) return { error: `subscription_plans: ${planErr.message}` };

  const labById = new Map((labCompanies ?? []).map((l) => [l.id, l.name]));
  const planById = new Map((plans ?? []).map((p) => [p.id, p.name]));

  const shipments = (shipmentsRaw ?? []).map((s) => ({
    ...s,
    lab_name: labById.get(s.lab_company_id) ?? null,
  }));

  const subscription = subRaw
    ? { ...subRaw, plan_name: planById.get(subRaw.plan_id) ?? null }
    : null;

  return { customer, shipments, subscription };
}

/**
 * 過去 N 件の diagnosis_results から主要 3 指標 (尿酸/血圧収縮期/空腹時血糖)
 * を時系列で抽出。グラフ描画用。
 */
export async function getMetricTrend(
  diagnosticUserId: string,
  limit = 6,
): Promise<MetricTrendSeries[]> {
  const sb = getServerSupabase();
  if (!sb) return demoFallbackEnabled() ? demoMetricTrend() : [];

  try {
  const { data, error } = await sb
    .schema('diagnosis')
    .from('diagnosis_results')
    .select('received_at, report')
    .eq('diagnostic_user_id', diagnosticUserId)
    .in('status', ['published', 'extracted'])
    .order('received_at', { ascending: true })
    .limit(limit);

  if (error || !data || data.length === 0) {
    return demoFallbackEnabled() ? demoMetricTrend() : [];
  }

  const uric: MetricTrendPoint[] = [];
  const bpSystolic: MetricTrendPoint[] = [];
  const fpg: MetricTrendPoint[] = [];

  for (const row of data) {
    // report は配列想定。配列以外は skip して throw を防ぐ。
    const sections: ElithSection[] = Array.isArray(row.report)
      ? (row.report as unknown as ElithSection[])
      : [];
    if (sections.length === 0) continue;
    const cards = extractMetricCards(sections);
    const date = row.received_at as string;
    for (const c of cards) {
      const v = parseFloat(c.value.split('/')[0]); // 血圧は "132/85" の前半
      if (Number.isNaN(v)) continue;
      if (c.label === '尿酸')        uric.push({ date, value: v, raw: c.value });
      else if (c.label === '血圧')   bpSystolic.push({ date, value: v, raw: c.value });
      else if (c.label === '空腹時血糖') fpg.push({ date, value: v, raw: c.value });
    }
  }

  const out: MetricTrendSeries[] = [];
  if (uric.length > 0)       out.push({ label: '尿酸',       unit: 'mg/dL', referenceUpper: 7.0,  points: uric });
  if (bpSystolic.length > 0) out.push({ label: '最高血圧',   unit: 'mmHg',  referenceUpper: 129,  points: bpSystolic });
  if (fpg.length > 0)        out.push({ label: '空腹時血糖', unit: 'mg/dL', referenceUpper: 99,   points: fpg });
  if (out.length === 0 && demoFallbackEnabled()) return demoMetricTrend();
  return out;
  } catch {
    return demoFallbackEnabled() ? demoMetricTrend() : [];
  }
}

export interface HealthAgeLatest {
  testDate: string;
  sourceKind: string;         // 'health_checkup' | 'blood'
  chronologicalAge: number;
  biologicalAge: number | null;
  delta: number | null;
  carried: string[];          // 据え置きしたマーカー (血液回など)
  imputed: string[];          // 標準値で補完したマーカー (crp 等 → 参考値)
  missing: string[];          // 欠落した必須マーカー
}
export interface HealthAgeSummary {
  latest: HealthAgeLatest | null;
  /** 健康年齢の時系列 (MetricTrendChart にそのまま渡せる) */
  trend: MetricTrendSeries | null;
}

/**
 * diagnosis.health_age_scores から健康年齢の最新値と時系列を取得。
 * getMetricTrend と同じくスタンドアロン (diagnosis_results が無くても表示できる)。
 */
export async function getHealthAge(diagnosticUserId: string): Promise<HealthAgeSummary> {
  const sb = getServerSupabase();
  if (!sb) return { latest: null, trend: null };
  try {
    // 型未生成テーブルのため any 経由。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (sb.schema('diagnosis') as any)
      .from('health_age_scores')
      .select('test_date, source_kind, chronological_age, biological_age, delta, inputs')
      .eq('diagnostic_user_id', diagnosticUserId)
      .order('test_date', { ascending: true })
      .limit(24);
    if (error || !data || data.length === 0) return { latest: null, trend: null };

    const points: MetricTrendPoint[] = [];
    for (const r of data) {
      if (r.biological_age == null) continue;
      const v = Number(r.biological_age);
      points.push({ date: r.test_date as string, value: v, raw: `${v.toFixed(1)}歳` });
    }
    const last = data[data.length - 1];
    const inputs = (last.inputs ?? {}) as Record<string, unknown>;
    const arr = (k: string): string[] => (Array.isArray(inputs[k]) ? (inputs[k] as string[]) : []);
    const latest: HealthAgeLatest = {
      testDate: last.test_date as string,
      sourceKind: (last.source_kind as string) ?? 'health_checkup',
      chronologicalAge: Number(last.chronological_age),
      biologicalAge: last.biological_age == null ? null : Number(last.biological_age),
      delta: last.delta == null ? null : Number(last.delta),
      carried: arr('carried_markers').length ? arr('carried_markers') : arr('carried'),
      imputed: arr('imputed_markers'),
      missing: arr('missing_required'),
    };
    const trend: MetricTrendSeries | null =
      points.length > 0 ? { label: '健康年齢', unit: '歳', points } : null;
    return { latest, trend };
  } catch {
    return { latest: null, trend: null };
  }
}

/** ユーザー氏名を「真鍋様」形式で返す。なければ「お客様」。 */
export function formatGreeting(data: DashboardData): string {
  if (data.appUser?.display_name_cache) return data.appUser.display_name_cache;
  if (data.customer?.family_name) return `${data.customer.family_name}様`;
  return 'お客様';
}

/** kit_shipment のステータス文字列を画面表示用にラベル化。 */
export function shipmentLabel(s: KitShipment): { label: string; color: string; step: number } {
  if (s.lab_completed_at) return { label: '✅ 検査完了', color: 'text-emerald-600', step: 6 };
  if (s.lab_received_at)  return { label: '🔬 検査会社受領', color: 'text-sky-600', step: 5 };
  if (s.user_returned_at) return { label: '📮 返送済', color: 'text-blue-600', step: 4 };
  if (s.user_received_at) return { label: '📦 受取済', color: 'text-amber-600', step: 3 };
  if (s.shipped_at)       return { label: '🚚 発送済', color: 'text-orange-600', step: 2 };
  return { label: '⏳ 出荷準備', color: 'text-slate-500', step: 1 };
}

/** test_type ラベル */
export function testTypeLabel(type: string): { name: string; emoji: string } {
  const map: Record<string, { name: string; emoji: string }> = {
    health_checkup: { name: '人間ドック',  emoji: '🩺' },
    blood:          { name: '血液検査',    emoji: '🩸' },
    genetics:       { name: '遺伝子検査',  emoji: '🧬' },
    cancer_urine:   { name: 'がんリスク',  emoji: '🎗️' },
    ai_prediction:  { name: 'AI 疾病予測', emoji: '🤖' },
  };
  return map[type] ?? { name: type, emoji: '📋' };
}

/** ISO 日付を「2026年6月15日 (木)」 形式に。 */
export function formatJpDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const weekday = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 (${weekday})`;
}
