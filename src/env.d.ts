/// <reference path="../.astro/types.d.ts" />

interface ImportMetaEnv {
  readonly GEMINI_API_KEY: string;
  readonly PUBLIC_SUPABASE_URL: string;
  readonly PUBLIC_SUPABASE_ANON_KEY: string;
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
  readonly PUBLIC_VOICE_BACKEND_URL: string;
  // HP/EC #1 連携 (app_bridge / Edge Functions)。未設定なら dev フォールバック。
  readonly HP_BRIDGE_SUPABASE_URL?: string;
  readonly HP_BRIDGE_READONLY_KEY?: string;
  readonly HP_EDGE_BASE_URL?: string;
  readonly RESOLVE_SHARED_SECRET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
