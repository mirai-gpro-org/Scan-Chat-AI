/**
 * POST /api/scan/save
 *
 * ユーザーがアプリ内でスキャンし、画面で確認まで済ませた検査票を保存する。
 * これが入るまで、**スキャン結果はアプリの DB に 1 行も残っていなかった**
 * (Elith 用に S3 へ書き出すだけだった)。設計は `src/lib/scan-persist.ts` の冒頭。
 *
 * 入力  { markdownClean: string, pageCount?: number, examDate?: string }
 * 出力  { ok: true, artifact_id, test_date, date_source, measurements }
 *
 * **本人の行としてしか保存しない。** 保存先の uid は Cookie から解決したものだけを使い、
 * リクエストの本文からは受け取らない (他人の検査結果を作れてしまうため)。
 */
import type { APIRoute } from 'astro';
import { resolveViewer } from '../../../lib/viewer';
import { getServerSupabase } from '../../../lib/supabase';
import { saveScanResult } from '../../../lib/scan-persist';

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const POST: APIRoute = async (ctx) => {
  const viewer = await resolveViewer(ctx);
  /*
   * `?u=` は admin の代理表示専用。**保存には使わない** — 代理表示中に保存すると
   * 相手の検査結果を勝手に作ることになる。自分の uid だけを保存先にする。
   */
  const uid = viewer.selfUid;
  if (!uid) return json({ ok: false, error: 'not_signed_in' }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await ctx.request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const markdownClean = typeof body.markdownClean === 'string' ? body.markdownClean : '';
  if (!markdownClean.trim()) return json({ ok: false, error: 'markdownClean is required' }, 400);

  const sb = getServerSupabase();
  if (!sb) return json({ ok: false, error: 'supabase_not_configured' }, 503);

  try {
    const r = await saveScanResult(sb as never, {
      diagnosticUserId: uid,
      markdownClean,
      pageCount: typeof body.pageCount === 'number' ? body.pageCount : 1,
      examDate: typeof body.examDate === 'string' ? body.examDate : null,
    });
    return json({
      ok: true,
      artifact_id: r.artifactId,
      test_date: r.testDate,
      date_source: r.dateSource,
      measurements: r.measurements,
    });
  } catch (err) {
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 500);
  }
};
