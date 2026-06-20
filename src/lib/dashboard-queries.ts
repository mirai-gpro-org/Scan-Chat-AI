/**
 * ダッシュボードのデータ取得ヘルパ。
 *
 * dev profile (Phase 1.0) では認証が未連携のため、URL パラメータ `?u=<diagnostic_user_id>`
 * で誰のダッシュボードを描画するかを指定する。本番では Google One Tap →
 * app_users.auth_user_id → diagnostic_user_id 解決に置き換える。
 */

import { getServerSupabase } from './supabase';
import type {
  AppUser,
  CustomerProfile,
  DiagnosisResult,
  KitShipment,
  Subscription,
  TestArtifact,
} from '../types/supabase';
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
  const sb = getServerSupabase();
  if (!sb) return { error: 'Supabase が未設定です。.env.local を確認してください。' };

  const normalized = diagnosticUserId ? normalizeDiagnosticUserId(diagnosticUserId) : null;
  const uid = normalized ?? DEFAULT_USER;

  // diagnosis schema
  const dsb = sb.schema('diagnosis');
  const csb = sb.schema('customer');

  // 並行クエリ
  const [
    { data: appUser, error: appUserErr },
    { data: artifactsRaw, error: artErr },
    { data: resultsRaw, error: resErr },
    { data: customer, error: custErr },
  ] = await Promise.all([
    dsb.from('app_users').select('*').eq('diagnostic_user_id', uid).maybeSingle(),
    dsb.from('test_artifacts').select('*').eq('diagnostic_user_id', uid).order('test_date', { ascending: false }),
    dsb.from('diagnosis_results').select('*').eq('diagnostic_user_id', uid).order('received_at', { ascending: false }),
    csb.from('customer_profiles').select('*').eq('diagnostic_user_id', uid).maybeSingle(),
  ]);

  if (appUserErr) return { error: `app_users: ${appUserErr.message}` };
  if (artErr)     return { error: `test_artifacts: ${artErr.message}` };
  if (resErr)     return { error: `diagnosis_results: ${resErr.message}` };
  if (custErr)    return { error: `customer_profiles: ${custErr.message}` };

  const artifacts = artifactsRaw ?? [];
  const results = resultsRaw ?? [];
  const latestResult = results[0] ?? null;
  const elithSections = (latestResult?.report as ElithSection[] | null) ?? [];

  // 顧客が居なければ早期 return (kit_shipments も取れない)
  if (!customer) {
    return {
      diagnosticUserId: uid,
      appUser: appUser ?? null,
      customer: null,
      artifacts,
      latestResult,
      elithSections,
      shipments: [],
      subscription: null,
    };
  }

  // customer schema から kit + subscription
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

  return {
    diagnosticUserId: uid,
    appUser: appUser ?? null,
    customer,
    artifacts,
    latestResult,
    elithSections,
    shipments,
    subscription,
  };
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
  if (!sb) return [];

  const { data, error } = await sb
    .schema('diagnosis')
    .from('diagnosis_results')
    .select('received_at, report')
    .eq('diagnostic_user_id', diagnosticUserId)
    .in('status', ['published', 'extracted'])
    .order('received_at', { ascending: true })
    .limit(limit);

  if (error || !data) return [];

  const uric: MetricTrendPoint[] = [];
  const bpSystolic: MetricTrendPoint[] = [];
  const fpg: MetricTrendPoint[] = [];

  for (const row of data) {
    const sections = (row.report as ElithSection[] | null) ?? [];
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
  return out;
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
