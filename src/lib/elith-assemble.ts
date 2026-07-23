/**
 * Elith 納品セット アセンブリ (サーバ専用)。
 *
 * S3 に種別ごと・別 client_id で散在している検査データ (a〜e) を、
 * 「1 人 = 1 ユーザーID フォルダに 5 種を束ねた」納品セットへ組み直す。
 *   - 各種別から 1 件ずつ選び (自動=ラウンドロビン / 手動=source key 指定)、
 *     JSON の client_id・パス・ファイル名を統一 ID へ書き換えてコピーする。
 *   - 合成テストデータ (実在の同一人物ではない) 用途。検証・チューニング向け。
 *   - PII は元 JSON が既に非含有 (subject は性別+年齢のみ)。原本画像/CSV は含めない。
 *
 * キー(AWS_*)は Vercel 環境変数のみ (CLAUDE.md) → 必ずサーバ側で実行。
 */

import { isElithFormatId, ELITH_HANDOFF_SCHEMA_VERSION, type ElithFormatId } from './elith-export';
import { listObjects, getObjectText, type S3PutFile } from './s3';

/** 納品対象の 5 種別 (順序は納品時の見せ方に使用) */
export const DELIVERY_FORMAT_IDS: ElithFormatId[] = [
  'HealthCheckupData',
  'BloodTestData',
  'GeneticTestResultData',
  'CancerRiskAssessmentData',
  'LifestyleQuestionnaireData',
];

export interface CatalogItem {
  key: string;
  formatId: ElithFormatId;
  date: string; // YYYY_MM_DD (フォルダ表記)
  clientId: string;
  size?: number; // S3 上のバイトサイズ (空データ判定の目安)
}

/** JSON キー `…/{format_id}_date_{YYYY_MM_DD}_user_{client_id}.json` を分解 */
export function parseElithKey(key: string): CatalogItem | null {
  const file = key.split('/').pop() ?? '';
  const m = /^([A-Za-z]+)_date_(\d{4}_\d{2}_\d{2})_user_(.+)\.json$/.exec(file);
  if (!m) return null;
  const [, formatId, date, clientId] = m;
  if (!isElithFormatId(formatId)) return null;
  return { key, formatId, date, clientId };
}

/**
 * Elith ハンドオフ JSON の「実データ件数」を数える (空データ判定用)。
 * `data` 配下 (measurements / items / rows 等) の配列要素数を再帰的に合計する。
 * `data` が無ければトップレベルを走査。パース不能は -1。
 */
export function countDataItems(jsonText: string): number {
  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    return -1;
  }
  const root =
    obj && typeof obj === 'object' && 'data' in (obj as Record<string, unknown>)
      ? (obj as Record<string, unknown>).data
      : obj;
  let n = 0;
  const seen = new Set<unknown>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      n += v.length;
      for (const e of v) if (e && typeof e === 'object') walk(e);
    } else if (v && typeof v === 'object') {
      if (seen.has(v)) return;
      seen.add(v);
      for (const val of Object.values(v as Record<string, unknown>)) walk(val);
    }
  };
  walk(root);
  return n;
}

function normPrefix(p: string): string {
  return p ? p.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
}
function utf8Bytes(s: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : Buffer.byteLength(s, 'utf-8');
}

// ── 棚卸し ──────────────────────────────────────────────────────
export interface Inventory {
  sourcePrefix: string;
  byFormat: Record<string, CatalogItem[]>;
  counts: Record<string, number>;
  missing: ElithFormatId[];
  /** 5 種すべてが 1 件以上揃う人数の上限 (= 最少種別の件数) */
  maxCompleteUsers: number;
}

/** ソース prefix を走査し、5 種別ごとに JSON を棚卸しする。 */
export async function inventoryElithSource(sourcePrefix: string): Promise<Inventory> {
  const prefix = normPrefix(sourcePrefix);
  const objs = await listObjects(prefix);
  const byFormat: Record<string, CatalogItem[]> = {};
  for (const f of DELIVERY_FORMAT_IDS) byFormat[f] = [];
  for (const o of objs) {
    if (!o.key.endsWith('.json')) continue;
    const item = parseElithKey(o.key);
    if (!item) continue;
    if (!DELIVERY_FORMAT_IDS.includes(item.formatId)) continue;
    item.size = o.size;
    byFormat[item.formatId].push(item);
  }
  // 安定した順序 (date→key) にソート
  for (const f of DELIVERY_FORMAT_IDS) {
    byFormat[f].sort((a, b) => (a.date === b.date ? a.key.localeCompare(b.key) : a.date.localeCompare(b.date)));
  }
  const counts: Record<string, number> = {};
  const missing: ElithFormatId[] = [];
  let maxComplete = Infinity;
  for (const f of DELIVERY_FORMAT_IDS) {
    const n = byFormat[f].length;
    counts[f] = n;
    if (n === 0) missing.push(f);
    maxComplete = Math.min(maxComplete, n);
  }
  return {
    sourcePrefix: prefix,
    byFormat,
    counts,
    missing,
    maxCompleteUsers: Number.isFinite(maxComplete) ? maxComplete : 0,
  };
}

// ── アセンブリ ──────────────────────────────────────────────────
/** 健康年齢 (CABA) の算出済みスコア。health_age_scores を source_ref で突合して納品に載せる。 */
export interface HealthAgeRecord {
  biological_age: number | null;   // 健康年齢
  chronological_age: number | null; // 実年齢
  test_date: string | null;        // 元データ取得日
  computed_at: string | null;      // 算出日時
  delta: number | null;            // biological - chronological
  model_version: string | null;
}

export interface AssembledUserSource {
  formatId: string; // ElithFormatId または 'HealthAgeData' (生成)
  sourceKey: string;
  /** コピー元の取得日 (YYYY_MM_DD) */
  sourceDate: string;
  /** 納品フォルダ/ファイル名に使う統一日付 (YYYY_MM_DD) */
  deliveredDate: string;
  newKey: string;
  /** コピー元 JSON の実データ件数 (0 = 空データ。-1 = パース不能)。 */
  dataItems: number;
}
export interface AssembledUser {
  userId: string;
  sources: AssembledUserSource[];
  files: S3PutFile[]; // 書き換え済み JSON 群 + manifest.json
}
export interface AssembleResult {
  deliveryPrefix: string;
  users: AssembledUser[];
  inventory: Inventory;
}

export interface AssembleOptions {
  sourcePrefix: string;
  deliveryPrefix: string;
  /** 自動生成する人数 (在庫が許す範囲に丸める)。手動指定時は無視。 */
  count?: number;
  idPrefix?: string; // 既定 'elith-test'
  /** 手動指定: userId → { formatId: sourceKey }。指定時はこちらを優先。 */
  manualMapping?: Record<string, Partial<Record<ElithFormatId, string>>>;
  exportedAt?: Date;
  /**
   * 納品フォルダ/ファイル名に使う統一日付 (YYYY_MM_DD)。
   * 仕様 §3.3「1回分の入力一式を 1 つの date フォルダに」に合わせ、
   * 1 人分の 5 種を単一の date/ にまとめる。未指定なら組み立て日 (本日)。
   */
  bundleDate?: string;
  /**
   * 健康年齢スコア: source_ref(元S3キー) → 算出済みスコア。
   * 採用元(人間ドック優先→血液)に対応するスコアがあれば HealthAgeData を納品に追加する。
   * age は PII 除去済み元データから再計算できないため、算出済み(health_age_scores)を突合して載せる。
   */
  healthAgeByRef?: Record<string, HealthAgeRecord>;
}

/** 本日 (UTC) を YYYY_MM_DD で返す。 */
function todayYmd(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '_');
}
function randomUuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

/** 健康年齢の納品ファイル (エンベロープは他の検査ファイルに準拠)。 */
function buildHealthAgeJson(userId: string, bundleDate: string, rec: HealthAgeRecord, sourceRef: string): string {
  const testDate = rec.test_date && /^\d{4}-\d{2}-\d{2}$/.test(rec.test_date) ? rec.test_date : bundleDate.replace(/_/g, '-');
  const computedDate = rec.computed_at ? rec.computed_at.slice(0, 10) : null;
  const obj = {
    format_id: 'HealthAgeData',
    schema_version: ELITH_HANDOFF_SCHEMA_VERSION,
    kind: 'health_age',
    client_id: userId,
    diagnostic_id: randomUuid(),
    test_date: testDate,
    exported_at: new Date().toISOString(),
    subject: { sex: null, age: rec.chronological_age }, // 実年齢は subject.age にも保持 (他ファイル準拠)
    source: {
      origin: 'scan-chat-ai',
      app: 'scan-chat-ai',
      model: rec.model_version ?? 'CABA-v4d',
      note: '健康年齢 (CABA)。実年齢との差 delta を含む。',
      lab_name: null,
    },
    data: {
      health_age: rec.biological_age, // 健康年齢
      actual_age: rec.chronological_age, // 実年齢
      computed_date: computedDate, // 算出計算日付
      delta: rec.delta,
      model_version: rec.model_version ?? 'CABA-v4d',
    },
    assembled_from: sourceRef,
  };
  return JSON.stringify(obj, null, 2);
}

// category(区分/region見出し) を納品しない format。検診/がん(版面見出し)・血液(項目区分)とも Elith 要望で除去。
// 遺伝子は items のキー構成を LLM 全面委任のため対象外 (意味のある category を消さない)。
const CATEGORY_STRIP_FORMATS = new Set(['HealthCheckupData', 'CancerRiskAssessmentData', 'BloodTestData']);

/**
 * 納品物のサニタイズ (Elith 要望)。元データが旧形式でも納品物からは版面情報を除く。
 *  - `data.regions`(bboxの器) を削除。
 *  - measurements/items の各要素から `region`/`bbox` を削除 (スキャン由来は `category` も)。
 *  - `raw_markdown` から `<!-- bbox: … -->` コメントを除去。
 * ※ 値(value/value_num)は書き換えない。旧元データの値の乱れは元ファイルの再生成で対応する。
 */
function sanitizeDelivery(obj: Record<string, unknown>): void {
  const fmt = typeof obj.format_id === 'string' ? obj.format_id : '';
  const data = obj.data;
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    delete d.regions;
    for (const arrKey of ['measurements', 'items']) {
      const arr = d[arrKey];
      if (Array.isArray(arr)) {
        for (const el of arr) {
          if (el && typeof el === 'object') {
            const e = el as Record<string, unknown>;
            delete e.region;
            delete e.bbox;
            if (CATEGORY_STRIP_FORMATS.has(fmt)) delete e.category;
          }
        }
      }
    }
  }
  if (typeof obj.raw_markdown === 'string') {
    obj.raw_markdown = obj.raw_markdown
      .split('\n')
      .filter((l) => !/^\s*<!--\s*bbox:[^>]*-->\s*$/i.test(l))
      .join('\n');
  }
}

/** JSON テキストの client_id を new へ書き換え + 納品用サニタイズ (パース失敗時は素の置換にフォールバック)。 */
function rewriteClientId(jsonText: string, newId: string, sourceKey: string): string {
  try {
    const obj = JSON.parse(jsonText) as Record<string, unknown>;
    obj.client_id = newId;
    // トレーサビリティ: 元 key を控える (PII では無い)
    obj.assembled_from = sourceKey;
    sanitizeDelivery(obj); // 旧形式の元データでも納品物から bbox/region を除去
    return JSON.stringify(obj, null, 2);
  } catch {
    return jsonText;
  }
}

/**
 * 納品セットを組み立てる (S3 から JSON を GET し、書き換え済みファイル群を返す)。
 * S3 への PUT は呼び出し側 (s3.putFiles)。
 */
export async function assembleElithDeliverySet(opts: AssembleOptions): Promise<AssembleResult> {
  const deliveryPrefix = normPrefix(opts.deliveryPrefix);
  const idPrefix = opts.idPrefix || 'elith-test';
  // 1 人分の 5 種を単一 date フォルダにまとめる (仕様 §3.3)。既定は本日。
  const bundleDate =
    opts.bundleDate && /^\d{4}_\d{2}_\d{2}$/.test(opts.bundleDate) ? opts.bundleDate : todayYmd();
  const inv = await inventoryElithSource(opts.sourcePrefix);

  // ソース JSON を GET してキャッシュ (空データ判定と本コピーで再利用し二重取得を避ける)
  const textCache = new Map<string, string>();
  const fetchText = async (key: string): Promise<string> => {
    const c = textCache.get(key);
    if (c !== undefined) return c;
    const t = await getObjectText(key);
    textCache.set(key, t);
    return t;
  };

  // userId → (formatId → source CatalogItem) の割当を決める
  const plan: { userId: string; picks: Partial<Record<ElithFormatId, CatalogItem>> }[] = [];

  if (opts.manualMapping && Object.keys(opts.manualMapping).length > 0) {
    for (const [userId, m] of Object.entries(opts.manualMapping)) {
      const picks: Partial<Record<ElithFormatId, CatalogItem>> = {};
      for (const f of DELIVERY_FORMAT_IDS) {
        const key = m[f];
        if (!key) continue;
        const item = inv.byFormat[f].find((c) => c.key === key) ?? parseElithKey(key);
        if (item) picks[f] = item; // 手動指定は明示尊重 (空でもそのまま)
      }
      plan.push({ userId, picks });
    }
  } else {
    // 自動: 種別ごとに新しい日付順で「実データが入っている」ものを優先して選ぶ。
    // (旧仕様は最古を無条件採用 → 初期の空テストを掴んで空データ納品になっていた)
    const want = Math.max(0, Math.min(opts.count ?? inv.maxCompleteUsers, inv.maxCompleteUsers));
    const cursor: Record<string, number> = {};
    const orderedDesc: Record<string, CatalogItem[]> = {};
    for (const f of DELIVERY_FORMAT_IDS) {
      cursor[f] = 0;
      orderedDesc[f] = [...inv.byFormat[f]].sort((a, b) =>
        a.date === b.date ? b.key.localeCompare(a.key) : b.date.localeCompare(a.date),
      );
    }
    for (let i = 0; i < want; i++) {
      const picks: Partial<Record<ElithFormatId, CatalogItem>> = {};
      for (const f of DELIVERY_FORMAT_IDS) {
        const list = orderedDesc[f];
        let chosen: CatalogItem | undefined;
        // カーソル位置から、実データ件数>0 の最初の候補を採用 (空はスキップ)
        while (cursor[f] < list.length) {
          const cand = list[cursor[f]++];
          if (countDataItems(await fetchText(cand.key)) > 0) { chosen = cand; break; }
        }
        // 全て空 (または尽きた) なら、この人には先頭候補を割当 (空でも可視化のため出す)
        picks[f] = chosen ?? list[i] ?? list[0];
      }
      plan.push({ userId: `${idPrefix}-${String(i + 1).padStart(3, '0')}`, picks });
    }
  }

  const users: AssembledUser[] = [];
  for (const p of plan) {
    const sources: AssembledUserSource[] = [];
    const files: S3PutFile[] = [];
    for (const f of DELIVERY_FORMAT_IDS) {
      const item = p.picks[f];
      if (!item) continue;
      const text = await fetchText(item.key);
      const dataItems = countDataItems(text);
      const rewritten = rewriteClientId(text, p.userId, item.key);
      // パス/ファイル名の日付は統一日付 (bundleDate)。JSON 内の test_date は原本のまま。
      const newKey = `${deliveryPrefix}user/${p.userId}/date/${bundleDate}/${f}_date_${bundleDate}_user_${p.userId}.json`;
      files.push({ key: newKey, contentType: 'application/json; charset=utf-8', body: rewritten, bytes: utf8Bytes(rewritten) });
      sources.push({ formatId: f, sourceKey: item.key, sourceDate: item.date, deliveredDate: bundleDate, newKey, dataItems });
    }

    // 健康年齢: 採用元(人間ドック優先→血液)の source_ref に対応する算出済みスコアがあれば納品に追加。
    if (opts.healthAgeByRef) {
      const refCandidates = [p.picks.HealthCheckupData?.key, p.picks.BloodTestData?.key].filter((k): k is string => !!k);
      let rec: HealthAgeRecord | undefined;
      let matchedRef: string | undefined;
      for (const k of refCandidates) {
        if (opts.healthAgeByRef[k]) { rec = opts.healthAgeByRef[k]; matchedRef = k; break; }
      }
      if (rec && matchedRef) {
        const stem = `HealthAgeData_date_${bundleDate}_user_${p.userId}`;
        const key = `${deliveryPrefix}user/${p.userId}/date/${bundleDate}/${stem}.json`;
        const bodyStr = buildHealthAgeJson(p.userId, bundleDate, rec, matchedRef);
        files.push({ key, contentType: 'application/json; charset=utf-8', body: bodyStr, bytes: utf8Bytes(bodyStr) });
        sources.push({
          formatId: 'HealthAgeData', sourceKey: matchedRef, sourceDate: rec.test_date ?? bundleDate,
          deliveredDate: bundleDate, newKey: key, dataItems: rec.biological_age != null ? 1 : 0,
        });
      }
    }
    // 納品フォルダには Elith 規約のファイル ({format_id}_..._user_....json) のみを置く。
    // 出典元トレーサビリティ (source_key) は API 応答の users[].sources で返すため、
    // 規約外の manifest.json は S3 へ書き出さない (Elith「構成が違う」対策)。
    users.push({ userId: p.userId, sources, files });
  }

  return { deliveryPrefix, users, inventory: inv };
}
