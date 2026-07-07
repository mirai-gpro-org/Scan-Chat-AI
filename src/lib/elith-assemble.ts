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

import { isElithFormatId, type ElithFormatId } from './elith-export';
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
export interface AssembledUserSource {
  formatId: ElithFormatId;
  sourceKey: string;
  date: string;
  newKey: string;
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
}

/** JSON テキストの client_id を new へ書き換える (パース失敗時は素の置換にフォールバック)。 */
function rewriteClientId(jsonText: string, newId: string, sourceKey: string): string {
  try {
    const obj = JSON.parse(jsonText) as Record<string, unknown>;
    obj.client_id = newId;
    // トレーサビリティ: 元 key を控える (PII では無い)
    obj.assembled_from = sourceKey;
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
  const inv = await inventoryElithSource(opts.sourcePrefix);
  const exportedAt = (opts.exportedAt ?? new Date()).toISOString();

  // userId → (formatId → source CatalogItem) の割当を決める
  const plan: { userId: string; picks: Partial<Record<ElithFormatId, CatalogItem>> }[] = [];

  if (opts.manualMapping && Object.keys(opts.manualMapping).length > 0) {
    for (const [userId, m] of Object.entries(opts.manualMapping)) {
      const picks: Partial<Record<ElithFormatId, CatalogItem>> = {};
      for (const f of DELIVERY_FORMAT_IDS) {
        const key = m[f];
        if (!key) continue;
        const item = inv.byFormat[f].find((c) => c.key === key) ?? parseElithKey(key);
        if (item) picks[f] = item;
      }
      plan.push({ userId, picks });
    }
  } else {
    const want = Math.max(0, Math.min(opts.count ?? inv.maxCompleteUsers, inv.maxCompleteUsers));
    for (let i = 0; i < want; i++) {
      const picks: Partial<Record<ElithFormatId, CatalogItem>> = {};
      for (const f of DELIVERY_FORMAT_IDS) picks[f] = inv.byFormat[f][i];
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
      const text = await getObjectText(item.key);
      const rewritten = rewriteClientId(text, p.userId, item.key);
      const newKey = `${deliveryPrefix}user/${p.userId}/date/${item.date}/${f}_date_${item.date}_user_${p.userId}.json`;
      files.push({ key: newKey, contentType: 'application/json; charset=utf-8', body: rewritten, bytes: utf8Bytes(rewritten) });
      sources.push({ formatId: f, sourceKey: item.key, date: item.date, newKey });
    }
    // manifest
    const manifest = {
      user_id: p.userId,
      assembled_at: exportedAt,
      note: '合成テストデータ (実在の同一人物ではない)。Elith 検証・チューニング用。',
      files: sources.map((s) => ({ format_id: s.formatId, key: s.newKey, source_key: s.sourceKey, date: s.date })),
    };
    const manifestBody = JSON.stringify(manifest, null, 2);
    const manifestKey = `${deliveryPrefix}user/${p.userId}/manifest.json`;
    files.push({ key: manifestKey, contentType: 'application/json; charset=utf-8', body: manifestBody, bytes: utf8Bytes(manifestBody) });

    users.push({ userId: p.userId, sources, files });
  }

  return { deliveryPrefix, users, inventory: inv };
}
