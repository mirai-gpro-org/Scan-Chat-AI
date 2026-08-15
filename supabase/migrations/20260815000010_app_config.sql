-- ランタイム設定 (app_config)。スキャン精度フラグ・使用モデル等の「運用パラメータ」を DB 管理する。
-- 背景(2026-08 発注者判断): 秘匿でない運用パラメータは env 不適(現在値が見えない/都度デプロイ)。
--   → この表を正とし admin モーダルから可視・即時(TTL)変更。秘匿値(GEMINI_API_KEY/AWS/ADMIN_API_KEY/
--   SUPABASE_*)は env 据え置き。優先順位=DB値→コード既定(src/lib/app-config.ts CONFIG_SPECS.default)。
--   env フォールバックは廃止。非PII(diagnosis スキーマ)。
--
-- 【重要】seed の値は現行の確定運用(CLAUDE.md)に一致させる。env 廃止のため、この seed / コード既定が
--   唯一の挙動源となる。cutover 後は Vercel の SCAN_*/GEMINI_*_MODEL env を撤去してよい(無視される)。

create table if not exists diagnosis.app_config (
  key         text primary key,
  value       text not null default '',
  updated_by  text,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

alter table diagnosis.app_config enable row level security;
grant select on diagnosis.app_config to anon, authenticated;
grant all    on diagnosis.app_config to service_role;

-- 読み取り全許可 / 認証済み書き込み(サーバは service_role で RLS バイパス)。既存テーブルと同方針。
create policy "dev_read_all"    on diagnosis.app_config for select using (true);
create policy "dev_authn_write" on diagnosis.app_config for all to authenticated using (true) with check (true);

-- seed: 確定運用の初期値 (存在すれば据え置き)。
insert into diagnosis.app_config (key, value, updated_by) values
  ('scan.model',                'gemini-3.1-flash-lite',          'migration'),
  ('live.model',                'gemini-3.1-flash-live-preview',  'migration'),
  ('scan.output_format',        'markdown',                       'migration'),
  ('scan.boundary_recheck',     'on',                             'migration'),
  ('scan.obs_dedup',            'on',                             'migration'),
  ('scan.scramble_fix',         'on',                             'migration'),
  ('scan.eye_resolve',          'on',                             'migration'),
  ('scan.lipid_fix',            'on',                             'migration'),
  ('scan.canonicalize',         'off',                            'migration'),
  ('scan.perception_repair',    'off',                            'migration'),
  ('scan.vqa_rowcrop',          'off',                            'migration'),
  ('scan.ai_prediction_dedup',  'off',                            'migration'),
  ('fabgate.unperformed',       'off',                            'migration'),
  ('fabgate.refbleed',          'off',                            'migration'),
  ('fabgate.reftable',          'off',                            'migration'),
  ('fabgate.adjacent',          'off',                            'migration')
on conflict (key) do nothing;
