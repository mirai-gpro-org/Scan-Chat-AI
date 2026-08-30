/**
 * HP/EC #1 の Edge Function をサーバー間で呼び出すヘルパ (SSR / API ルート専用)。
 *
 * 統合仕様書 §6:
 *   - resolve-customer : email → { diagnostic_user_id, display_name, is_admin }
 *   - kit-self-report  : 受取/返送の自己申告 → orders (正本) を更新
 *
 * 認証は共有シークレット `x-resolve-secret`。クライアントには絶対に出さない。
 * env (HP_EDGE_BASE_URL / RESOLVE_SHARED_SECRET) 未設定なら null を返し、
 * 呼び出し側は dev フォールバックを選べる。
 */

const EDGE_BASE = () => import.meta.env.HP_EDGE_BASE_URL as string | undefined;
const SECRET = () => import.meta.env.RESOLVE_SHARED_SECRET as string | undefined;

/** HP Edge Function 連携が構成済みか。 */
export function isHpEdgeConfigured(): boolean {
  return !!EDGE_BASE();
}

export interface ResolvedCustomer {
  diagnostic_user_id: string;
  display_name: string | null;
  /**
   * **admin の管理者リスト (`admin_users`) に載っている現役の管理者か。**
   *
   * 顧客DB も管理者リストも **Wellfort 側の Supabase にしか無い**
   * (個人情報は Wellfort 側でしか持たない取り決め)。したがって admin 判定も
   * **この経路で受け取る**のが正で、Scan-Chat-AI 側に名簿を持たない。
   * 古い Edge Function がまだ返さない場合に備えて省略可 (その場合は false 扱い)。
   */
  is_admin?: boolean;
}

/**
 * email から本人 (diagnostic_user_id) を解決する。
 * 未連携 / 退会 / 未構成 の場合は null。
 */
export interface ResolveOutcome {
  /** 顧客が引けたか。**管理者が顧客とは限らない**ので null もあり得る。 */
  customer: ResolvedCustomer | null;
  /**
   * 管理者リスト (`admin_users`) に載っている現役の管理者か。
   * **顧客が居なくても答えが返る** (応答の top-level・2026-08-30)。
   * 古い Edge Function は返さないので、その場合は false。
   */
  isAdmin: boolean;
  /**
   * **admin 判定が false だったときに、原因を切り分けるための内訳。**
   *
   * fail-closed なので「リストに載っていない」も「照会が失敗した」も同じ false になる。
   * それでは原因が分からず推測が始まるので、Edge 側が内訳を返す (2026-08-30)。
   * 古い Edge Function は返さないので省略可。**PII は含まない** (人数と真偽だけ)。
   */
  adminLookup?: {
    /** `admin_users` を読めたか。false なら権限/スキーマ側の問題。 */
    readable: boolean;
    /** 現役の管理者の総数。0 ならリスト自体が空。一致したときは null。 */
    active_count: number | null;
    /** この email が一致したか。 */
    matched: boolean;
    error?: string;
  };
}

/**
 * email から **顧客の解決と admin 判定を同時に**受け取る。
 *
 * 【なぜ分けないか】どちらも Wellfort 側 DB にしか無く、経路は同じ 1 本
 * (`resolve-customer`)。2 回呼ぶ理由が無い。
 *
 * 【なぜ customer と isAdmin を分けるか】**管理者が EC の顧客とは限らない。**
 * 顧客が引けなかった (`data: null`) からといって admin でないとは限らないので、
 * `is_admin` は応答の top-level で受け取る (2026-08-30 に実測でこれを踏んだ)。
 */
export async function resolveCustomerWithAdmin(email: string): Promise<ResolveOutcome> {
  const base = EDGE_BASE();
  if (!base) return { customer: null, isAdmin: false };
  const normalized = email.trim().toLowerCase();
  if (!normalized) return { customer: null, isAdmin: false };

  const res = await fetch(`${base}/functions/v1/resolve-customer`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(SECRET() ? { 'x-resolve-secret': SECRET()! } : {}),
    },
    body: JSON.stringify({ email: normalized }),
  });
  if (!res.ok) throw new Error(`resolve-customer HTTP ${res.status}`);
  const payload = (await res.json().catch(() => null)) as
    | {
        success: boolean;
        data: ResolvedCustomer | null;
        is_admin?: boolean;
        admin_lookup?: ResolveOutcome['adminLookup'];
        error?: string;
      }
    | null;
  if (!payload?.success) throw new Error(payload?.error ?? 'resolve-customer failed');
  return {
    customer: payload.data ?? null,
    // top-level を正とし、無ければ data 内 (旧形式) を見る。
    isAdmin: payload.is_admin === true || payload.data?.is_admin === true,
    adminLookup: payload.admin_lookup,
  };
}

/** 顧客だけが要るとき用の薄いラッパ。 */
export async function resolveCustomerByEmail(email: string): Promise<ResolvedCustomer | null> {
  const base = EDGE_BASE();
  if (!base) return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;

  const res = await fetch(`${base}/functions/v1/resolve-customer`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(SECRET() ? { 'x-resolve-secret': SECRET()! } : {}),
    },
    body: JSON.stringify({ email: normalized }),
  });
  if (!res.ok) {
    throw new Error(`resolve-customer HTTP ${res.status}`);
  }
  const payload = (await res.json().catch(() => null)) as
    | { success: boolean; data: ResolvedCustomer | null; error?: string }
    | null;
  if (!payload?.success) {
    throw new Error(payload?.error ?? 'resolve-customer failed');
  }
  return payload.data ?? null;
}

export type KitSelfReportEvent = 'received' | 'returned';

export interface KitSelfReportResult {
  order_id: string;
  event: KitSelfReportEvent;
  occurred_at: string;
}

/**
 * 検査キットの受取/返送を HP の正本 (orders) に申告する。
 * 所有者照合 (diagnostic_user_id) は Edge Function 側で実施される。
 */
export async function submitKitSelfReport(input: {
  orderId: string;
  diagnosticUserId: string;
  event: KitSelfReportEvent;
  occurredAt?: string;
}): Promise<KitSelfReportResult> {
  const base = EDGE_BASE();
  if (!base) throw new Error('HP_EDGE_BASE_URL is not configured');

  const res = await fetch(`${base}/functions/v1/kit-self-report`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(SECRET() ? { 'x-resolve-secret': SECRET()! } : {}),
    },
    body: JSON.stringify({
      order_id: input.orderId,
      diagnostic_user_id: input.diagnosticUserId,
      event: input.event,
      ...(input.occurredAt ? { occurred_at: input.occurredAt } : {}),
    }),
  });
  const payload = (await res.json().catch(() => null)) as
    | { success: boolean; data: KitSelfReportResult; error?: string }
    | null;
  if (!res.ok || !payload?.success) {
    throw new Error(payload?.error ?? `kit-self-report HTTP ${res.status}`);
  }
  return payload.data;
}
