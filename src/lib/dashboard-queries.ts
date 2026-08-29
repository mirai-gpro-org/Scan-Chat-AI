/**
 * ダッシュボードのデータ取得ヘルパ。
 *
 * dev profile (Phase 1.0) では認証が未連携のため、URL パラメータ `?u=<diagnostic_user_id>`
 * で誰のダッシュボードを描画するかを指定する。本番では Google One Tap →
 * app_users.auth_user_id → diagnostic_user_id 解決に置き換える。
 */

import type { AppIconName } from '../components/AppIcon.astro';
import { getServerSupabase, isBridgeConfigured } from './supabase';
import { loadBridgeBundle, type CustomerBundle } from './bridge-queries';
import { buildDemoDashboard, demoFallbackEnabled, demoMetricTrend, demoShipments } from './demo-data';
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
import { AI_PREDICTION_REPORT_LABEL } from './display-names';

export interface MetricTrendPoint {
  date: string;       // ISO date
  value: number;
  /** chip 表示用 — 元の "8.4" や "132/85" */
  raw: string;
  /** 検査機関が付けた基準外マーカー。アプリは算出しない。 */
  flag?: 'H' | 'L' | null;
}

export interface MetricTrendSeries {
  label: string;
  unit: string;
  /** 検査票由来の基準上限 (グラフに基準帯として描画)。アプリが決めた値ではない。 */
  referenceUpper?: number;
  /** 検査票由来の基準下限。 */
  referenceLower?: number;
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
  /**
   * kit_shipments をどこから取ったか (テストフェーズの切り分け用)。
   *   bridge   … 本番構成。HP/EC 側 (#1) の app_bridge から取得
   *   customer … dev 構成。この DB の customer.kit_shipments から取得
   *   demo     … 上記が 0 件だったので demo-data のダミーを表示
   * `?debug=bridge` を付けたときだけ画面に出す。
   */
  shipmentSource: 'bridge' | 'customer' | 'demo';
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
    const usingBridge = isBridgeConfigured();
    const bundle = usingBridge
      ? await loadBridgeBundle(resultUid)
      : await loadMockCustomerBundle(sb, resultUid);
    // バンドル取得失敗時も画面は成立させる (顧客/プランは空扱い)
    const safeBundle: CustomerBundle = 'error' in bundle
      ? { customer: null, shipments: [], subscription: null }
      : bundle;

    /*
     * キット進捗のフォールバック (テストフェーズ)。
     *
     * shipments が 0 件になる経路が複数ある:
     *   - 本番構成 (app_bridge) では customer.kit_shipments を見ないので、
     *     この DB に seed_kit_demo.sql を流しても出ない
     *   - 表示中のユーザーに customer_profiles が無い / 別 customer_id
     * どれであっても「進捗が何も出ない」画面はクライアントの UI 確認にならないため、
     * 0 件のときだけダミーへ落とす。実データが 1 件でもあればそちらが優先。
     */
    let shipmentSource: DashboardData['shipmentSource'] = usingBridge ? 'bridge' : 'customer';
    if (demoFallbackEnabled() && safeBundle.shipments.length === 0) {
      safeBundle.shipments = demoShipments(resultUid);
      shipmentSource = 'demo';
    }

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
      shipmentSource,
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
  /** どの版で算出したか ('full'=正規版 CABA v5.4 / 'simple'=簡易版 v7.0)。旧データは null。 */
  method: 'full' | 'simple' | null;
  /** 簡易版で血糖を HbA1c から推定した場合 'eag'。 */
  glucoseSource: 'measured' | 'eag' | null;
}
export interface HealthAgeSummary {
  latest: HealthAgeLatest | null;
  /** ウェルネス年齢の時系列 (MetricTrendChart にそのまま渡せる) */
  trend: MetricTrendSeries | null;
}

/**
 * diagnosis.health_age_scores からウェルネス年齢 (旧称: 健康年齢) の最新値と時系列を取得。
 * getMetricTrend と同じくスタンドアロン (diagnosis_results が無くても表示できる)。
 */
export async function getHealthAge(diagnosticUserId: string): Promise<HealthAgeSummary> {
  const sb = getServerSupabase();
  if (!sb) return demoHealthAge();
  try {
    // 型未生成テーブルのため any 経由。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (sb.schema('diagnosis') as any)
      .from('health_age_scores')
      .select('test_date, source_kind, chronological_age, biological_age, delta, inputs')
      .eq('diagnostic_user_id', diagnosticUserId)
      .order('test_date', { ascending: true })
      .limit(24);
    if (error || !data || data.length === 0) return demoHealthAge();

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
      // method は簡易版フォールバック導入 (2026-08) 以降の行にだけ入る。旧行は null=正規版扱いにしない
      // (どちらか分からないものを断定しない)。
      method: inputs.method === 'full' || inputs.method === 'simple' ? inputs.method : null,
      glucoseSource:
        inputs.glucose_source === 'eag' || inputs.glucose_source === 'measured'
          ? inputs.glucose_source
          : null,
    };
    const trend: MetricTrendSeries | null =
      points.length > 0 ? { label: 'ウェルネス年齢', unit: '歳', points } : null;
    return { latest, trend };
  } catch {
    return demoHealthAge();
  }
}

/**
 * ウェルネス年齢のダミー (テストフェーズの表示確認用)。
 *
 * health_age_scores が空 / Supabase 未接続でも、ダッシュボードの並び
 * (ウェルネス年齢 → AI疾病予防報告書 → AI スキャン/AI 問診) を確認できるようにする。
 * demo-data.ts の他のダミーと同じ扱いで、`PUBLIC_DEMO_FALLBACK=false` で切れる。
 * **値は CABA で算出したものではなく固定のダミー**。DB に実データが入れば自動で消える。
 */
function demoHealthAge(): HealthAgeSummary {
  if (!demoFallbackEnabled()) return { latest: null, trend: null };
  const points: MetricTrendPoint[] = [
    { date: '2026-03-13', value: 60.8, raw: '60.8歳' },
    { date: '2026-05-02', value: 60.1, raw: '60.1歳' },
    { date: '2026-06-21', value: 59.6, raw: '59.6歳' },
    { date: '2026-08-02', value: 59.4, raw: '59.4歳' },
  ];
  return {
    latest: {
      testDate: '2026-08-02',
      sourceKind: 'blood',
      chronologicalAge: 56,
      biologicalAge: 59.4,
      delta: 3.4,
      carried: ['fev1'],
      imputed: ['crp'],
      missing: [],
      method: 'full',
      glucoseSource: null,
    },
    trend: { label: 'ウェルネス年齢', unit: '歳', points },
  };
}

/**
 * ユーザー氏名を「真鍋様」形式で返す。なければ「お客様」。
 *
 * `display_name_cache` は連携元によって「真鍋様」(敬称込み) だったり
 * 「浜田一英」(氏名のみ) だったりするため、**敬称が無いときだけ「様」を足す**。
 * 二重敬称 (「〇〇様様」) を作らないよう、既に様/さん/殿で終わるものは触らない。
 */
const HONORIFIC = /(?:様|さま|さん|殿|どの)$/;

export function withHonorific(name: string): string {
  const n = name.trim();
  if (!n) return 'お客様';
  return HONORIFIC.test(n) ? n : `${n}様`;
}

export function formatGreeting(data: DashboardData): string {
  if (data.appUser?.display_name_cache) return withHonorific(data.appUser.display_name_cache);
  if (data.customer?.family_name) return withHonorific(data.customer.family_name);
  return 'お客様';
}

/** 検査キットの進捗段階。表示は アイコン + テキスト + 色 の 3 点セットで行う。 */
export interface ShipmentStage {
  label: string;
  icon: AppIconName;
  /** 状態トーン (ブランド色ではなく status.* を使う)。 */
  tone: 'ok' | 'active' | 'unknown';
  color: string;
  step: number;
}

/** 検査キット進捗の全 6 段階 (表示順は step 昇順)。 */
export const SHIPMENT_STAGES: ReadonlyArray<{ step: number; label: string; icon: AppIconName }> = [
  { step: 1, label: '出荷準備',     icon: 'clock' },
  { step: 2, label: '発送済',       icon: 'kit-shipped' },
  { step: 3, label: '受取済',       icon: 'kit' },
  { step: 4, label: '返送済',       icon: 'send' },
  { step: 5, label: '検査会社受領', icon: 'lab' },
  { step: 6, label: '検査完了',     icon: 'kit-done' },
];

/**
 * kit_shipment を画面表示用の段階へ変換する。
 *
 * 【注意】段階 5「検査会社受領」/ 6「検査完了」は本番では値が入らない。
 *   src/lib/bridge-queries.ts の adaptShipment() が lab_received_at / lab_completed_at を
 *   null 固定で返すため。完了したように見せず「未取得」として表示すること
 *   (到達不能な段階を完了扱いにしない)。
 */
export function shipmentLabel(s: KitShipment): ShipmentStage {
  if (s.lab_completed_at) return { label: '検査完了',     icon: 'kit-done',    tone: 'ok',      color: 'text-status-ok',      step: 6 };
  if (s.lab_received_at)  return { label: '検査会社受領', icon: 'lab',         tone: 'active',  color: 'text-status-active',  step: 5 };
  if (s.user_returned_at) return { label: '返送済',       icon: 'send',        tone: 'active',  color: 'text-status-active',  step: 4 };
  if (s.user_received_at) return { label: '受取済',       icon: 'kit',         tone: 'active',  color: 'text-status-active',  step: 3 };
  if (s.shipped_at)       return { label: '発送済',       icon: 'kit-shipped', tone: 'active',  color: 'text-status-active',  step: 2 };
  return { label: '出荷準備', icon: 'clock', tone: 'unknown', color: 'text-status-unknown', step: 1 };
}

/** test_type ラベル */
export function testTypeLabel(type: string): { name: string; icon: AppIconName } {
  const map: Record<string, { name: string; icon: AppIconName }> = {
    health_checkup: { name: '人間ドック',  icon: 'health-checkup' },
    blood:          { name: '血液検査',    icon: 'blood' },
    genetics:       { name: '遺伝子検査',  icon: 'genetics' },
    cancer_urine:   { name: 'がんリスク',  icon: 'cancer-risk' },
    ai_prediction:  { name: AI_PREDICTION_REPORT_LABEL, icon: 'ai-prediction' },
  };
  return map[type] ?? { name: type, icon: 'result' };
}

/** ISO 日付を「2026年6月15日 (木)」 形式に。 */
export function formatJpDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const weekday = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 (${weekday})`;
}
