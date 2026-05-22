/**
 * Supabase クライアント雛形。実接続は次フェーズで本実装。
 * - ブラウザからは anon key、サーバからは service_role を使う想定。
 * - 環境変数が未設定の場合は `null` を返し、呼び出し側で no-op を選べるようにする。
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let browserClient: SupabaseClient | null = null;

/** ブラウザ用クライアント（PUBLIC_*）。設定が無ければ null。 */
export function getBrowserSupabase(): SupabaseClient | null {
  if (typeof window === 'undefined') return null;
  if (browserClient) return browserClient;
  const url = import.meta.env.PUBLIC_SUPABASE_URL;
  const anon = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  browserClient = createClient(url, anon, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  return browserClient;
}

/** サーバ用クライアント（service_role）。Astro API ルート専用。 */
export function getServerSupabase(): SupabaseClient | null {
  const url = import.meta.env.PUBLIC_SUPABASE_URL;
  const service = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) return null;
  return createClient(url, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
