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
