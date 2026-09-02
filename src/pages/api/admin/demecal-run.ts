/**
 * admin: デメカル自動取得の**実行ログ**。
 *
 * 正本: `docs/lab/demecal_unattended_spec.md §3.2`。
 *
 * 【なぜ要るか】無人運用の本体はここ。**誰も見ていない**ので、
 * 走ったか／失敗したかがサーバ側に残らないと運用できない。
 * 「黙って数週間止まっていた」を検知するための唯一の材料。
 *
 * 認可 = **admin キー または 取り込み専用キー** (`x-intake-key`)。
 * 専用PC に `ADMIN_API_KEY` を置かないための分離 (`§3.1`)。
 *
 * 保存先は S3 の `{prefix}state/demecal_runs.json` (`demecal-state.ts` と同じ置き方)。
 * **DB を使わない**のは、この記録が「PC が生きているか」の運用情報であって
 * 診断データではないため。S3 なら鍵がサーバ側だけで完結する。
 *
 * 【PII を書かせない】受け取るのは件数・範囲・状態だけ。
 * **CSV の中身や受診者の情報は一切受け取らない** (`error` も文字列長で切る)。
 */

import type { APIRoute } from 'astro';
import { getS3Config, isS3Configured, getObjectText, putFiles } from '../../../lib/s3';
import { isLabIntakeEndpointAuthorized } from '../../../lib/api-auth';

export const prerender = false;

/** 直近何件を残すか。無人運用の見張りに使うだけなので多くは要らない。 */
const KEEP = 60;
/** 最後の成功からこの日数を超えたら「止まっている」とみなす。 */
const STALE_DAYS = 8;

interface RunRecord {
  started_at: string;
  finished_at: string;
  result: 'ok' | 'fail';
  stage?: string;
  rows?: number;
  range?: { from?: string; to?: string };
  error?: string;
  host?: string;
  script_version?: string;
  cert_expires_on?: string;
  cert_days_left?: number;
  received_at: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function runsKey(prefix: string): string {
  const clean = prefix ? prefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
  return `${clean}state/demecal_runs.json`;
}

async function readRuns(prefix: string): Promise<RunRecord[]> {
  try {
    const txt = await getObjectText(runsKey(prefix));
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr as RunRecord[] : [];
  } catch {
    return []; // 未作成 = まだ 1 度も走っていない。エラーにしない。
  }
}

function str(v: unknown, max = 300): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export const POST: APIRoute = async ({ request }) => {
  if (!isLabIntakeEndpointAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!isS3Configured()) return json({ ok: false, error: 's3_not_configured' }, 400);

  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const result = body.result === 'ok' ? 'ok' : body.result === 'fail' ? 'fail' : null;
  if (!result) return json({ ok: false, error: 'result は "ok" か "fail"' }, 400);

  const rec: RunRecord = {
    started_at: str(body.started_at) ?? '',
    finished_at: str(body.finished_at) ?? '',
    result,
    stage: str(body.stage, 80),
    rows: num(body.rows),
    range: (body.range && typeof body.range === 'object')
      ? {
        from: str((body.range as Record<string, unknown>).from, 20),
        to: str((body.range as Record<string, unknown>).to, 20),
      }
      : undefined,
    // **中身は書かせない。** 例外メッセージだけを長さで切って残す。
    error: str(body.error, 300),
    host: str(body.host, 60),
    script_version: str(body.script_version, 40),
    cert_expires_on: str(body.cert_expires_on, 20),
    cert_days_left: num(body.cert_days_left),
    received_at: new Date().toISOString(),
  };

  const cfg = getS3Config();
  const prefix = cfg?.prefix ?? '';
  const runs = await readRuns(prefix);
  // 新しい順に持つ。古いものから捨てる。
  const next = [rec, ...runs].slice(0, KEEP);
  // `S3PutFile` は `bytes` も要る (`demecal-state.ts:79` と同じ書き方に揃える)。
  const payload = JSON.stringify(next, null, 2);
  await putFiles([{
    key: runsKey(prefix),
    contentType: 'application/json; charset=utf-8',
    body: payload,
    bytes: new TextEncoder().encode(payload).length,
  }]);

  return json({ ok: true, stored: next.length });
};

export const GET: APIRoute = async ({ request }) => {
  if (!isLabIntakeEndpointAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!isS3Configured()) return json({ ok: false, error: 's3_not_configured' }, 400);

  const cfg = getS3Config();
  const runs = await readRuns(cfg?.prefix ?? '');
  const lastOk = runs.find((r) => r.result === 'ok');
  const days = lastOk?.received_at
    ? Math.floor((Date.now() - Date.parse(lastOk.received_at)) / 86_400_000)
    : null;

  return json({
    ok: true,
    runs,
    health: {
      last_success_at: lastOk?.received_at ?? null,
      days_since_success: days,
      cert_days_left: runs[0]?.cert_days_left ?? null,
      // **一度も走っていない場合も stale** (「記録が無い」を「正常」に見せない)。
      stale: days === null || days > STALE_DAYS,
    },
  });
};
