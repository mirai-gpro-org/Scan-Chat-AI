/**
 * Supabase クライアント (型付き)。
 *
 * - ブラウザ用 (`getBrowserSupabase`): PUBLIC_* で anon (publishable) key を使用。
 * - サーバ用  (`getServerSupabase`):  SERVICE_ROLE_KEY (secret) を使い、RLS bypass で書込可能。
 *
 * 環境変数が未設定の場合は `null` を返し、呼び出し側で no-op を選べる。
 * dev: `.env.local` に Supabase CLI が発行した key を入れる (詳細は supabase/README.md)
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../types/supabase';

let browserClient: SupabaseClient<Database> | null = null;

/** ブラウザ用クライアント。設定が無ければ null。 */
export function getBrowserSupabase(): SupabaseClient<Database> | null {
  if (typeof window === 'undefined') return null;
  if (browserClient) return browserClient;
  const url = import.meta.env.PUBLIC_SUPABASE_URL;
  const anon = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  browserClient = createClient<Database>(url, anon, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  return browserClient;
}

/** サーバ用クライアント (Astro API ルート / SSR 専用)。 */
export function getServerSupabase(): SupabaseClient<Database> | null {
  const url = import.meta.env.PUBLIC_SUPABASE_URL;
  const service = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) return null;
  return createClient<Database>(url, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
