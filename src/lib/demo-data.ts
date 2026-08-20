/**
 * デモ / テストフェーズ用のダミーデータ。
 *
 * 目的: 正規の検査履歴がまだ無い顧客に対し、ダッシュボード / お知らせを
 *   「空」ではなく共通のサンプル内容で見せる。実データが入れば自動で実データに切替。
 *
 * 切替条件: 実データ (test_artifacts / diagnosis_results / user_notices …) が空のときだけ
 *   ダミーへフォールバックする (dashboard-queries / notice-queries 側で判定)。
 * 無効化: env `PUBLIC_DEMO_FALLBACK=false` で完全に切る。
 *
 * ※ これは表示用フォールバックであり DB には書き込まない。
 */

import type { ElithSection } from './elith-parser';
import type { DashboardData, MetricTrendSeries } from './dashboard-queries';
import type { NoticesData } from './notice-queries';
import type {
  Announcement,
  DiagnosisResult,
  KitShipment,
  Subscription,
  TestArtifact,
  UserNotice,
} from '../types/supabase';

/** ダミーフォールバックが有効か (既定 ON、PUBLIC_DEMO_FALLBACK=false で無効)。 */
export function demoFallbackEnabled(): boolean {
  return import.meta.env.PUBLIC_DEMO_FALLBACK !== 'false';
}

const now = () => new Date();
const daysAgo = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();
const daysAhead = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();

/** メトリクス抽出 (検査値フィードバック) が効くサンプル Elith レポート。 */
const DEMO_REPORT: ElithSection[] = [
  {
    section_name: 'アブストラクト',
    char_count: 180,
    text: '総合的に大きな問題はありませんが、尿酸値と空腹時血糖がやや高めです。'
      + '生活習慣の見直し（水分摂取・食事・運動）で改善が見込めます。',
  },
  {
    section_name: '検査値フィードバック',
    char_count: 220,
    text:
      '今回の検査結果について。尿酸は7.8 mg/dL（基準値: 7.0 以下）とやや高めでした。'
      + '最高血圧は128 mmHg、最低血圧は82 mmHg と良好な範囲です。'
      + '空腹時血糖が108 mg/dL（基準値: 99 以下）とやや高めです。'
      + 'プリン体を控え、水分を1日2リットル以上摂取しましょう。',
  },
];

/** ダミーの検査履歴。 */
function demoArtifacts(uid: string): TestArtifact[] {
  const base = {
    diagnostic_user_id: uid,
    schema_version: '1.0',
    age_at_test: 55,
    sex: 'male',
    imported_by: 'demo',
    notes: null,
    external_test_id: null,
  };
  return [
    {
      ...base, id: 'demo-art-0001', source: 'wellfort_lab', test_type: 'blood',
      test_date: daysAgo(20), lab_name: 'リージャー', display_mode: 'three_mode',
      page_count: 2, imported_at: daysAgo(18), status: 'imported',
    },
    {
      ...base, id: 'demo-art-0002', source: 'wellfort_lab', test_type: 'cancer_urine',
      test_date: daysAgo(48), lab_name: 'PREVENT', display_mode: 'standard',
      page_count: 1, imported_at: daysAgo(46), status: 'imported',
    },
    {
      ...base, id: 'demo-art-0003', source: 'wellfort_lab', test_type: 'genetics',
      test_date: daysAgo(120), lab_name: 'ジェノプラン', display_mode: 'standard',
      page_count: 3, imported_at: daysAgo(118), status: 'imported',
    },
    {
      ...base, id: 'demo-art-0004', source: 'user_upload', test_type: 'health_checkup',
      test_date: daysAgo(160), lab_name: null, display_mode: 'standard',
      page_count: 4, imported_at: daysAgo(158), status: 'imported',
    },
  ] as TestArtifact[];
}

/** ダミーの最新診断結果。 */
function demoLatestResult(uid: string): DiagnosisResult {
  return {
    id: 'demo-res-0001',
    diagnostic_user_id: uid,
    diagnostic_id: 'demo-diag-0001',
    report: DEMO_REPORT as unknown as DiagnosisResult['report'],
    schema_version: '1.0',
    elith_job_id: null,
    elith_model_version: 'demo',
    received_at: daysAgo(18),
    summary_text: '尿酸値と空腹時血糖がやや高めです。食生活の見直しと適度な運動をおすすめします。',
    highlights_text: null,
    extracted_at: daysAgo(18),
    extracted_by_model: 'demo',
    status: 'published',
  };
}

/** ダミーの検査キット進捗。 */
function demoShipments(uid: string): (KitShipment & { lab_name: string | null })[] {
  /**
   * 進捗の 6 段階 (SHIPMENT_STAGES) を一通り見せる。
   * DB のダミー (supabase/seed_kit_demo.sql) を入れなくても /kit と
   * ダッシュボードのキットカードで全段階を確認できるようにするため。
   * shipmentLabel() は「どこまで日時が埋まっているか」で段階を決めるので、
   * 各行の日時の埋まり方がそのまま段階になる。
   */
  const base = {
    customer_id: uid, lab_company_id: '', subscription_id: null,
    subscription_year: null, subscription_seq: null, warehouse: null,
    carrier: null, carrier_tracking_url: null, expected_arrival_date: null,
    requested_arrival_date: null, requested_time_window: null,
    requested_at: null, requested_lock_at: null, notes: null,
  };
  const rows: {
    id: string; test_type: string; lab_name: string; tracking_no: string | null;
    shipped: number | null; received: number | null; returned: number | null;
    labRecv: number | null; done: number | null;
  }[] = [
    // step 1 出荷準備 (発送前)
    { id: 'demo-kit-0001', test_type: 'blood',        lab_name: 'リージャー',  tracking_no: null,
      shipped: null, received: null, returned: null, labRecv: null, done: null },
    // step 2 発送済
    { id: 'demo-kit-0002', test_type: 'cancer_urine', lab_name: 'プリベント',  tracking_no: '2345-6789-0123',
      shipped: 2,  received: null, returned: null, labRecv: null, done: null },
    // step 3 受取済
    { id: 'demo-kit-0003', test_type: 'blood',        lab_name: 'リージャー',  tracking_no: '1234-5678-9012',
      shipped: 5,  received: 3,    returned: null, labRecv: null, done: null },
    // step 4 返送済
    { id: 'demo-kit-0004', test_type: 'genetics',     lab_name: 'Genoplan',   tracking_no: '3456-7890-1234',
      shipped: 14, received: 12,   returned: 9,    labRecv: null, done: null },
    // step 5 検査会社受領
    { id: 'demo-kit-0005', test_type: 'blood',        lab_name: 'リージャー',  tracking_no: '4567-8901-2345',
      shipped: 24, received: 22,   returned: 19,   labRecv: 16,   done: null },
    // step 6 検査完了
    { id: 'demo-kit-0006', test_type: 'cancer_urine', lab_name: 'プリベント',  tracking_no: '5678-9012-3456',
      shipped: 60, received: 58,   returned: 55,   labRecv: 52,   done: 46 },
  ];
  const at = (d: number | null) => (d == null ? null : daysAgo(d));
  return rows.map((r) => ({
    ...base,
    id: r.id,
    order_id: `demo-order-${r.id.slice(-4)}`,
    test_type: r.test_type,
    tracking_no: r.tracking_no,
    shipped_at:       at(r.shipped),
    user_received_at: at(r.received),
    user_returned_at: at(r.returned),
    lab_received_at:  at(r.labRecv),
    lab_completed_at: at(r.done),
    created_at: at(r.shipped ?? 1)!,
    lab_name: r.lab_name,
  }) as KitShipment & { lab_name: string | null });
}

/** ダミーのサブスク (プラン名 / 次回検査)。 */
function demoSubscription(uid: string): Subscription & { plan_name: string | null } {
  return {
    id: 'demo-sub-0001', customer_id: uid, plan_id: 'ai', started_at: daysAgo(200),
    next_test_at: daysAhead(35), last_test_at: daysAgo(20),
    current_cycle_year: null, current_cycle_seq: null, status: 'active',
    paused_at: null, cancelled_at: null, created_at: daysAgo(200),
    updated_at: daysAgo(20), plan_name: 'AI予測付パック（年3回）',
  };
}

/** ダッシュボード全体のダミーデータ。実データが空のとき使用。 */
export function buildDemoDashboard(uid: string, displayName: string | null): DashboardData {
  return {
    diagnosticUserId: uid,
    resultUid: uid,
    usingDemoData: true,
    appUser: displayName
      ? ({
          diagnostic_user_id: uid, auth_user_id: null, google_sub: null,
          hp_customer_user_id: null, display_name_cache: displayName,
          eligibility_checked_at: null, created_at: now().toISOString(),
          updated_at: now().toISOString(),
        } as DashboardData['appUser'])
      : null,
    customer: null,
    artifacts: demoArtifacts(uid),
    latestResult: demoLatestResult(uid),
    elithSections: DEMO_REPORT,
    shipments: demoShipments(uid),
    subscription: demoSubscription(uid),
  };
}

/** メトリクス推移グラフのダミー系列。 */
export function demoMetricTrend(): MetricTrendSeries[] {
  const dates = [daysAgo(160), daysAgo(110), daysAgo(60), daysAgo(18)].map((d) => d.slice(0, 10));
  const series = (
    label: string, unit: string, ref: number, vals: number[],
  ): MetricTrendSeries => ({
    label, unit, referenceUpper: ref,
    // 検査機関が付ける flag を模す。これが無いとカード表示と推移表示で
    // 基準外の印の有無が食い違う (実測 2026-08)。
    points: vals.map((value, i) => ({
      date: dates[i], value, raw: String(value),
      flag: value > ref ? ('H' as const) : null,
    })),
  });
  return [
    series('尿酸', 'mg/dL', 7.0, [7.0, 7.3, 7.6, 7.8]),
    series('最高血圧', 'mmHg', 129, [134, 131, 129, 128]),
    series('空腹時血糖', 'mg/dL', 99, [101, 104, 106, 108]),
  ];
}

/** お知らせページのダミーデータ。 */
export function buildDemoNotices(uid: string, userName: string): NoticesData {
  const important: UserNotice[] = [
    {
      id: 'demo-un-0001', diagnostic_user_id: uid,
      title: '尿酸値が基準を超えました',
      body: '直近の血液検査で尿酸値が 7.8 mg/dL となり基準値 (7.0) を超えました。生活習慣の見直しと、必要に応じて医療機関の受診をご検討ください。',
      link_url: null, published_at: daysAgo(2), read_at: null, created_at: daysAgo(2),
    } as UserNotice,
    {
      id: 'demo-un-0002', diagnostic_user_id: uid,
      title: '次回検査キットの発送予定について',
      body: '次回の検査キットの発送準備を開始しました。お届け先住所に変更がある場合はご確認ください。',
      link_url: null, published_at: daysAgo(6), read_at: null, created_at: daysAgo(6),
    } as UserNotice,
  ];
  const general: Announcement[] = [
    mkAnn('demo-an-g1', 'general', 'マイページをリニューアルしました',
      'より見やすく使いやすいマイページへリニューアルしました。検査結果のトレンドや AI 健康コーチをご活用ください。', daysAgo(8)),
    mkAnn('demo-an-g2', 'general', '夏季休業期間の検査キット発送について',
      '夏季休業期間は検査キットの発送および検査結果の反映を一時停止いたします。ご了承ください。', daysAgo(15)),
  ];
  const news: Announcement[] = [
    mkAnn('demo-an-n1', 'news', '新プラン「AI予測付パック」を提供開始',
      '血液検査・がんリスク検査に加え、AI による疾病発症予測を組み合わせた新プランの提供を開始しました。', daysAgo(10)),
    mkAnn('demo-an-n2', 'news', 'がんリスク尿検査の対象がん種を拡大',
      '検査機関との連携により、がんリスク尿検査で評価できるがん種を拡大しました。', daysAgo(25)),
  ];
  return {
    diagnosticUserId: uid,
    userName,
    important,
    importantUnreadCount: important.filter((n) => !n.read_at).length,
    general,
    news,
  };
}

function mkAnn(id: string, category: 'general' | 'news', title: string, body: string, published_at: string): Announcement {
  return {
    id, category, title, body, link_url: null, published_at,
    created_at: published_at, source_news_id: null, image_url: null, link_text: null,
    visible_on_hp: category === 'news', visible_on_web: true,
    published_until: null, updated_at: published_at,
  } as Announcement;
}

/** デモのお知らせ未読件数 (バッジ用)。 */
export function demoUnreadImportant(): number {
  return 2;
}
