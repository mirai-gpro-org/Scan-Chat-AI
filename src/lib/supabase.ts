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
import type { BridgeDatabase } from '../types/supabase-bridge';

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

/**
 * HP/EC #1 `app_bridge` 読み取り専用クライアント (SSR 専用)。
 *
 * 統合仕様書に基づき、Web は #1 の app_bridge スキーマのみを参照する。
 * 認証は HP 発行の restricted ロール (`app_bridge_readonly`) JWT。
 * env 未設定なら null を返し、呼び出し側はモック (customer スキーマ) へフォールバックする。
 */
// SSR ランタイムで非PUBLIC変数を確実に読むため、import.meta.env を優先しつつ
// 取れない場合は process.env（Node ランタイム = Vercel SSR）にフォールバックする。
function envOf(name: 'HP_BRIDGE_SUPABASE_URL' | 'HP_BRIDGE_READONLY_KEY'): string {
  const v = (import.meta.env as Record<string, string | undefined>)[name];
  if (v) return v;
  if (typeof process !== 'undefined' && process.env) return (process.env as Record<string, string | undefined>)[name] ?? '';
  return '';
}

export function getBridgeSupabase(): SupabaseClient<BridgeDatabase> | null {
  const url = envOf('HP_BRIDGE_SUPABASE_URL');
  const key = envOf('HP_BRIDGE_READONLY_KEY');
  if (!url || !key) return null;
  return createClient<BridgeDatabase>(url, key, {
    db: { schema: 'app_bridge' },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** app_bridge への接続が構成済みか (dev フォールバック判定用)。 */
export function isBridgeConfigured(): boolean {
  return !!envOf('HP_BRIDGE_SUPABASE_URL') && !!envOf('HP_BRIDGE_READONLY_KEY');
}
