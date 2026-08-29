/**
 * ランタイム設定 (app_config)。スキャン精度フラグ・使用モデル等の「運用パラメータ」を DB で一元管理する。
 *
 * 背景 (2026-08 発注者判断): これらは秘匿値でない運用パラメータであり、env は不適
 *   (Vercel ダッシュボードで現在値が見えない / 変更の都度デプロイが要る)。
 *   → Supabase `diagnosis.app_config` を正とし、admin モーダルから可視・即時(TTL反映)に変更する。
 *   秘匿値 (GEMINI_API_KEY / AWS_* / ADMIN_API_KEY / SUPABASE_*) は従来どおり env 据え置き。
 *
 * 優先順位: **DB値 → コード既定 (CONFIG_SPECS.default)**。env フォールバックは持たない (廃止・発注者判断)。
 *   コード既定 = 現行の確定運用 (CLAUDE.md) と一致させ、DB 未接続/障害時も本番挙動を維持する。
 * 反映: サーバ関数インスタンス毎に TTL メモ化 (既定 45s)。admin 保存後は最大 TTL 分のラグで反映。
 */
import { getServerSupabase } from './supabase';

export type ConfigType = 'bool' | 'enum' | 'string';
export interface ConfigSpec {
  key: string;
  type: ConfigType;
  group: string;
  label: string;
  description?: string;
  default: string;
  options?: string[]; // enum の選択肢
}

/**
 * パラメータカタログ (新規パラメータはここに1行追加するだけ = admin に自動表示)。
 * default は **現行の確定運用 (CLAUDE.md)** に一致させること (env 廃止のため DB/既定が唯一の真実)。
 */
export const CONFIG_SPECS: ConfigSpec[] = [
  // ── 画面表示の文言 (Wellfort が admin から編集できるようにする) ──
  // 既定は**空**。空のあいだは UI 側に何も出さない (架空の連絡先や文言を作らない)。
  { key: 'ui.support_contact', type: 'string', group: '画面表示', label: 'サポート窓口', default: '',
    description: 'メニューやエラー画面に出す問い合わせ先 (例: support@example.co.jp / 0120-000-000)。空なら非表示。' },
  { key: 'ui.health_age_followup', type: 'string', group: '画面表示', label: 'ウェルネス年齢のフォローアップ文', default: '',
    description: 'ウェルネス年齢が実年齢より高いときに添える案内文。空なら非表示。'
      + ' **診断・治療の助言にならない範囲で書くこと** (アプリは独自に解釈しない方針)。'
      + ' 例: 「気になる点は次回の検査時に医師へご相談ください。」' },

  // ── モデル ──
  { key: 'scan.model', type: 'enum', group: 'モデル', label: 'スキャン用モデル', default: 'gemini-3.1-flash-lite',
    options: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash'],
    description: '画像解析/REST 呼び出しに使うモデル。既定=3.1-flash-lite (軽量安定)。3.5-flash-lite=GA(2026-07)。' },
  { key: 'live.model', type: 'string', group: 'モデル', label: 'AI問診(Live)用モデル', default: 'gemini-3.1-flash-live-preview',
    description: 'Live API 専用 (REST 非対応)。' },
  // ── スキャン読取 (確定運用スタック) ──
  { key: 'scan.output_format', type: 'enum', group: 'スキャン読取', label: '出力形式', default: 'markdown', options: ['markdown', 'json'],
    description: 'markdown=GFM表経路(既定)。json=responseSchema構造化(補助欄暴走のため未採用)。' },
  { key: 'scan.boundary_recheck', type: 'bool', group: 'スキャン読取', label: '境界定性の2パス再読(VQA)', default: 'on',
    description: '空だった定性(尿蛋白/潜血/糖/便潜血/K-W)を軽量VQAで再読・充填。numeric不変。' },
  { key: 'scan.obs_dedup', type: 'bool', group: 'スキャン読取', label: '観測dedup(別名重複統合)', default: 'on',
    description: '同一概念・同値のみ統合。別値は競合記録(自動採用しない)。' },
  { key: 'scan.scramble_fix', type: 'bool', group: 'スキャン読取', label: '基準レンジ再割当(肝/鉄scramble)', default: 'on' },
  { key: 'scan.eye_resolve', type: 'bool', group: 'スキャン読取', label: '眼科 collapsed-row 付替', default: 'on' },
  { key: 'scan.lipid_fix', type: 'bool', group: 'スキャン読取', label: '脂質 LDL↔TG 物理制約修正', default: 'on' },
  { key: 'scan.canonicalize', type: 'bool', group: 'スキャン読取', label: '②正準化(標準マスタ名寄せ)', default: 'off',
    description: '🎯回帰ゼロ確認後に on 化予定。' },
  { key: 'scan.perception_repair', type: 'bool', group: 'スキャン読取', label: 'P-perc 画像証拠後段補修', default: 'off',
    description: 'VQAインベントリ/領域照合。当面 off 推奨 (baseline が優位)。' },
  { key: 'scan.vqa_rowcrop', type: 'bool', group: 'スキャン読取', label: '行クロップ独立VQA(timeline_leak)', default: 'off' },
  { key: 'scan.ai_prediction_dedup', type: 'bool', group: 'スキャン読取', label: 'AI疾病発症予測 統合(LAiF)', default: 'off' },
  // ── 捏造ゲート (False-Value 抑制・決定論・docs/scan/修正仕様書_捏造ゲート.md) ──
  { key: 'fabgate.unperformed', type: 'bool', group: '捏造ゲート', label: 'G1 未実施ブロック抑制(尿定性/便潜血)', default: 'off',
    description: '比重/pH が両欠落=尿ディップ未実施なら(-)充填を抑止。実施ブロックの救済は不変。' },
  { key: 'fabgate.refbleed', type: 'bool', group: '捏造ゲート', label: 'G2 基準吸い上げドロップ(腹囲等)', default: 'off',
    description: '身体計測4項目で value==片側基準閾値をドロップ。' },
  { key: 'fabgate.reftable', type: 'bool', group: '捏造ゲート', label: 'G3 参考資料/基準値表 行除外', default: 'off',
    description: 'レンジ値(A〜B)/未設定/男性女性基準名 をドロップ(B3基準値表)。' },
  { key: 'fabgate.adjacent', type: 'bool', group: '捏造ゲート', label: 'G4 隣接漏れ監査(体脂肪率==BMI)', default: 'off',
    description: '偶然一致し得るため明示on時のみ(anomalies 監査へ)。' },
];

const DEFAULTS: Record<string, string> = Object.fromEntries(CONFIG_SPECS.map((s) => [s.key, s.default]));
const KNOWN_KEYS = new Set(CONFIG_SPECS.map((s) => s.key));

const TTL_MS = 45_000;
let cache: Map<string, string> | null = null;
let cacheTs = 0;

/** DB から設定を読み込みキャッシュへ。TTL 内かつ force でなければ no-op。障害時は既存キャッシュ(なければ空)を維持。 */
export async function refreshConfig(force = false): Promise<void> {
  const now = Date.now();
  if (!force && cache && now - cacheTs < TTL_MS) return;
  const sb = getServerSupabase();
  if (!sb) { if (!cache) cache = new Map(); cacheTs = now; return; } // dev/未設定: 既定運用
  try {
    const { data, error } = await (sb.schema('diagnosis') as unknown as {
      from: (t: string) => { select: (c: string) => Promise<{ data: Array<{ key: string; value: string | null }> | null; error: unknown }> };
    }).from('app_config').select('key,value');
    if (error) throw error;
    const m = new Map<string, string>();
    for (const r of data ?? []) if (r && typeof r.key === 'string') m.set(r.key, r.value == null ? '' : String(r.value));
    cache = m;
    cacheTs = now;
  } catch {
    if (!cache) { cache = new Map(); cacheTs = now; } // 障害時は既定へフォールバック(本番挙動維持)
  }
}

/** 現在値 (DB → 既定)。同期。事前に refreshConfig() 済みが前提 (未実行でも既定=本番挙動)。 */
export function cfg(key: string): string {
  const v = cache?.get(key);
  return v != null && v !== '' ? v : DEFAULTS[key] ?? '';
}
export function cfgBool(key: string): boolean {
  return ['on', 'true', '1', 'yes'].includes(cfg(key).trim().toLowerCase());
}
export function getScanModel(): string { return cfg('scan.model'); }
export function getLiveModel(): string { return cfg('live.model'); }

/** admin 用: 全パラメータ (spec + 現在値) を返す。必ず最新を取りに行く。 */
export async function listConfig(): Promise<Array<ConfigSpec & { value: string }>> {
  await refreshConfig(true);
  return CONFIG_SPECS.map((s) => ({ ...s, value: cfg(s.key) }));
}

/** admin 用: パラメータを upsert。未知キーは無視。保存後キャッシュを即更新。 */
export async function setConfig(updates: Record<string, string>, updatedBy?: string): Promise<{ ok: boolean; updated: string[]; reason?: string }> {
  const sb = getServerSupabase();
  if (!sb) return { ok: false, updated: [], reason: 'supabase_not_configured' };
  const rows = Object.entries(updates)
    .filter(([k]) => KNOWN_KEYS.has(k))
    .map(([key, value]) => ({ key, value: String(value ?? ''), updated_by: updatedBy ?? null, updated_at: new Date().toISOString() }));
  if (rows.length === 0) return { ok: false, updated: [], reason: 'no_known_keys' };
  const { error } = await (sb.schema('diagnosis') as unknown as {
    from: (t: string) => { upsert: (r: unknown, o: unknown) => Promise<{ error: unknown }> };
  }).from('app_config').upsert(rows, { onConflict: 'key' });
  if (error) return { ok: false, updated: [], reason: String((error as { message?: string })?.message ?? error) };
  await refreshConfig(true);
  return { ok: true, updated: rows.map((r) => r.key) };
}
