// src/lib/elith-synthetic.ts
// 疑似時系列データ生成の純粋関数（決定論ジッタ + スナップショット組立）。
// 値をゼロから捏造せず「実データ種(seed)を摂動」する方式（elith-blood-timeseries と同思想）。
// 参照: docs/elith/elith_synthetic_timeseries_plan_spec.md §6

/** measurement系 format（measurements[].value_num をジッタ）。 */
export const MEAS_FORMATS = new Set(['BloodTestData', 'CancerRiskAssessmentData', 'HealthCheckupData']);

/** 文字列 → 32bit ハッシュ (seed 用・FNV-1a)。 */
export function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
/** seed から [0,1) の決定論乱数列 (mulberry32)。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** iso(YYYY-MM-DD) に months を加算(負可)。末日は対象月の最終日にクランプ。 */
export function addMonths(iso: string, months: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  let y = +m[1];
  let mo = +m[2] - 1 + months;
  let d = +m[3];
  y += Math.floor(mo / 12);
  mo = ((mo % 12) + 12) % 12;
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  if (d > last) d = last;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${y}-${p(mo + 1)}-${p(d)}`;
}
/** 文字列表現の数値 value を ±amplitude で決定論ジッタ。元の小数桁を維持。 */
export function jitterValue(valueStr: string, valueNum: number, seedStr: string, amplitude: number): { value: string; value_num: number } {
  const rng = mulberry32(hashSeed(seedStr));
  const factor = 1 + (rng() * 2 - 1) * amplitude;
  const decimals = (valueStr.split('.')[1] || '').length;
  const nn = valueNum * factor;
  const value = decimals > 0 ? nn.toFixed(decimals) : String(Math.round(nn));
  return { value, value_num: Number(value) };
}
/** 数値 n を ±amplitude で決定論ジッタ。整数は整数・小数は元桁を維持。 */
export function jitterNumber(n: number, seedStr: string, amplitude: number): number {
  const rng = mulberry32(hashSeed(seedStr));
  const factor = 1 + (rng() * 2 - 1) * amplitude;
  const decimals = Number.isInteger(n) ? 0 : (String(n).split('.')[1] || '').length;
  const nn = n * factor;
  return decimals > 0 ? Number(nn.toFixed(decimals)) : Math.round(nn);
}
/** 任意構造を再帰走査し、数値のみ ±amplitude ジッタ (文字列/真偽/null は維持)。 */
export function jitterDeep(v: unknown, seedBase: string, amplitude: number, ctr: { n: number }): unknown {
  if (typeof v === 'number' && Number.isFinite(v)) return jitterNumber(v, `${seedBase}|${ctr.n++}`, amplitude);
  if (Array.isArray(v)) return v.map((el) => jitterDeep(el, seedBase, amplitude, ctr));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = jitterDeep(val, seedBase, amplitude, ctr);
    return out;
  }
  return v;
}

/** "X%" 文字列の数値部のみ ±amplitude ジッタ (「%」記号・元の小数桁を維持)。数値でなければ原文維持。 */
export function jitterPercentString(s: string, seedStr: string, amplitude: number): string {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*%\s*$/.exec(s);
  if (!m) return s;
  const numStr = m[1];
  const decimals = (numStr.split('.')[1] || '').length;
  const rng = mulberry32(hashSeed(seedStr));
  const factor = 1 + (rng() * 2 - 1) * amplitude;
  const nn = Number(numStr) * factor;
  const out = decimals > 0 ? nn.toFixed(decimals) : String(Math.round(nn));
  return `${out}%`;
}

// LAiF「AI疾病発症予測」(format_id=Other / kind=ai_prediction) の item 内でジッタ対象のフィールド。
// 疾患名(項目名)・section・アドバイス(文章) は維持 (§5.4: 数値のみ±5%・名称/文章は不変)。
const AI_PRED_PCT_KEYS = ['5年発症率', '10年発症率'];         // "X%" 文字列
const AI_PRED_NUM_KEYS = ['相対リスク比', '昨年の相対リスク比']; // 数値

/** AI疾病発症予測 1 item を決定論ジッタ (発症率%/相対リスク比 のみ・疾患名/アドバイスは維持)。 */
export function jitterAiPredictionItem(item: unknown, seedBase: string, amplitude: number): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const src = item as Record<string, unknown>;
  const name = String(src['項目名'] ?? '');
  const out: Record<string, unknown> = { ...src };
  for (const k of AI_PRED_PCT_KEYS) {
    if (typeof src[k] === 'string') out[k] = jitterPercentString(src[k] as string, `${seedBase}|${name}|${k}`, amplitude);
  }
  for (const k of AI_PRED_NUM_KEYS) {
    if (typeof src[k] === 'number' && Number.isFinite(src[k] as number)) out[k] = jitterNumber(src[k] as number, `${seedBase}|${name}|${k}`, amplitude);
  }
  return out;
}
/** AI疾病発症予測 items[] を決定論ジッタ (item_count/pages 等の構造値は触らない)。 */
export function jitterAiPredictionItems(items: unknown[], seedBase: string, amplitude: number): { items: unknown[]; jittered: number } {
  let jittered = 0;
  const out = items.map((it) => {
    const before = it && typeof it === 'object' ? JSON.stringify(it) : '';
    const after = jitterAiPredictionItem(it, seedBase, amplitude);
    if (before && JSON.stringify(after) !== before) jittered++;
    return after;
  });
  return { items: out, jittered };
}

function randomUuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

export interface Snapshot {
  obj: Record<string, unknown>;
  jittered: number;
}

/**
 * 種(src)から 1 スナップショットを組み立てる。
 *   - measurement系: data.measurements[].value_num をジッタ (問診/非数値は維持)。
 *   - Other: data.payload 内の数値を再帰ジッタ。
 *   - それ以外(遺伝子等): data はそのまま (経年変化しない・ジッタ無し)。
 * client_id / test_date を上書きし、synthetic マーカーを付与する。
 */
export function buildSnapshot(params: {
  src: Record<string, unknown>;
  formatId: string;
  clientId: string;
  testDate: string;
  seedBase: string; // 例 `${clientId}|${formatId}|${occIndex}`
  amplitude: number;
  srcKey: string;
  exportedAt: string; // 呼び出し側で new Date().toISOString()
}): Snapshot {
  const { src, formatId, clientId, testDate, seedBase, amplitude, srcKey, exportedAt } = params;
  const srcData = src.data && typeof src.data === 'object' ? (src.data as Record<string, unknown>) : {};
  let dataOut: Record<string, unknown>;
  let jittered = 0;

  if (MEAS_FORMATS.has(formatId)) {
    const measurements = Array.isArray((srcData as { measurements?: unknown[] }).measurements)
      ? ((srcData as { measurements: Array<Record<string, unknown>> }).measurements)
      : [];
    const newMeas = measurements.map((m) => {
      const valueNum = m.value_num;
      const valueStr = typeof m.value === 'string' ? m.value : m.value == null ? null : String(m.value);
      if (typeof valueNum === 'number' && Number.isFinite(valueNum) && valueStr != null) {
        const j = jitterValue(valueStr, valueNum, `${seedBase}|${String(m.name ?? '')}`, amplitude);
        jittered++;
        return { ...m, value: j.value, value_num: j.value_num };
      }
      return { ...m };
    });
    dataOut = { ...srcData, measurements: newMeas };
  } else if (formatId === 'Other') {
    // LAiF AI疾病発症予測: 実納品は data.items[] (項目名/5年発症率/10年発症率/相対リスク比/昨年の相対リスク比/アドバイス)。
    // items 内の発症率%・相対リスク比のみジッタし、疾患名/アドバイス/section/item_count/pages は維持 (§5.4)。
    const itemsSrc = (srcData as { items?: unknown }).items;
    if (Array.isArray(itemsSrc)) {
      const j = jitterAiPredictionItems(itemsSrc, `${seedBase}|items`, amplitude);
      jittered = j.jittered;
      dataOut = { ...srcData, items: j.items, item_count: j.items.length };
    } else {
      // 後方互換: 旧 data.payload 形式の種は従来どおり再帰ジッタ。
      const ctr = { n: 0 };
      const payloadOut = jitterDeep((srcData as { payload?: unknown }).payload, `${seedBase}|payload`, amplitude, ctr);
      jittered = ctr.n;
      dataOut = { ...srcData, payload: payloadOut };
    }
  } else {
    // 遺伝子等: 経年変化しない → 種の data をそのまま (ジッタ無し)。
    dataOut = { ...srcData };
  }

  const obj: Record<string, unknown> = {
    ...src,
    client_id: clientId,
    diagnostic_id: randomUuid(),
    test_date: testDate,
    date_source: 'synthetic',
    synthetic: true,
    exported_at: exportedAt,
    source: {
      ...(src.source && typeof src.source === 'object' ? (src.source as Record<string, unknown>) : {}),
      note: `synthetic (integration test)。種=${srcKey.split('/').pop() ?? srcKey}・±${Math.round(amplitude * 100)}%ジッタ`,
    },
    synthetic_from: srcKey,
    data: dataOut,
  };
  return { obj, jittered };
}
