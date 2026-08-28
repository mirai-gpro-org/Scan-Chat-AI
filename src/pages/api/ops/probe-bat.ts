/**
 * ops: 現地実行スクリプト (`デメカル接続チェック.bat`) の配布口。
 *
 * なぜ必要か: .bat はメール添付でも ChatWork でも
 * **セキュリティポリシーで弾かれる** (2026-08-28 実測)。URL なら渡せるので、
 * その場で組み立ててダウンロードさせる。
 *
 * 設計方針 (`probe-upload.ts` と同じ):
 *   ・**既定 off の fail-closed**。env `PROBE_UPLOAD_TOKEN` が設定されている
 *     ときだけ配る。未設定なら 503 (何も出さない)。
 *   ・認可はそのトークン自身 (`?k=`)。**`ADMIN_API_KEY` は使わない**。
 *     env を消せば配布も回収口も同時に閉じる = 後始末が 1 手で済む。
 *   ・**トークンをここで注入する**ので、リポジトリにもメール添付にも乗らない
 *     (`.ps1` はプレースホルダのまま commit されている)。
 *   ・検索避け: `noindex` を付け、キャッシュさせない。
 *
 * 手順書: `docs/lab/demecal_powershell_probe_guide.md`
 */

import type { APIRoute } from 'astro';
// scripts/ の .ps1 をビルド時に文字列として取り込む (実行時の fs 読みは Vercel で不可)。
import PROBE_PS1 from '../../../../scripts/demecal-probe.ps1?raw';
import { buildProbeBat } from '../../../lib/probe-bat';

export const prerender = false;

/** 保存されるファイル名。手順書と揃えること。 */
const FILENAME_JA = 'デメカル接続チェック.bat';
/** RFC 6266 の ASCII フォールバック (日本語を解釈しないクライアント用)。 */
const FILENAME_ASCII = 'demecal-check.bat';

function env(name: string): string | undefined {
  const m = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (m != null && m !== '') return m;
  const p = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return p != null && p !== '' ? p : undefined;
}

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': 'noindex' },
  });
}

export const GET: APIRoute = async ({ url }) => {
  const expected = env('PROBE_UPLOAD_TOKEN');
  if (!expected) return text('disabled (PROBE_UPLOAD_TOKEN 未設定)', 503);

  const given = (url.searchParams.get('k') || '').trim();
  if (given !== expected) return text('unauthorized', 401);

  let bat: Uint8Array;
  try {
    bat = buildProbeBat(PROBE_PS1, expected).bytes;
  } catch (err) {
    return text(`build_failed: ${err instanceof Error ? err.message : String(err)}`, 500);
  }

  return new Response(bat as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(bat.byteLength),
      'content-disposition':
        `attachment; filename="${FILENAME_ASCII}"; `
        + `filename*=UTF-8''${encodeURIComponent(FILENAME_JA)}`,
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
};
