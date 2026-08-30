import type { APIRoute } from 'astro';
import { resolveViewer, VIEWER_COOKIE, verifyViewer, uidEntryAllowed } from '../../../lib/viewer';
import { demoFallbackEnabled } from '../../../lib/demo-data';
import { getServerSupabase } from '../../../lib/supabase';

export const prerender = false;

/**
 * **自己診断。** 「なぜ報告書が空なのか」を 1 回で確定させるための口（2026-08-30）。
 *
 * 【なぜ作ったか】本番の状態が外から観測できず、**仮説を立てて潰す往復で 2 時間溶かした**。
 * 判定は静かに外れるうえ、分岐が多い（Cookie 経路 / `?u=` 経路 / 代理表示 /
 * env 2 つ / 受領データの有無）。**画面を見ても、どれで落ちているか区別がつかない。**
 * → **答えを 1 つの JSON で出す。**
 *
 * 【出すもの】**閲覧している本人の話だけ**。他人のことは何も返さない。
 *   uid は既に `/dashboard` のデバッグ欄に出ている値。氏名・メール・検査値は返さない。
 */
export const GET: APIRoute = async (ctx) => {
  const viewer = await resolveViewer(ctx);
  const raw = ctx.cookies.get(VIEWER_COOKIE)?.value;
  const verified = await verifyViewer(raw);
  const url = new URL(ctx.request.url);

  // 閲覧者の解決がどの経路で起きたか
  const path = verified ? 'cookie'
    : (uidEntryAllowed() && url.searchParams.get('u')) ? 'uid_entry(?u=)'
    : 'anonymous';

  const demoOk = viewer.isAdmin && !viewer.impersonating;

  // 受領データが在るか (在れば admin かどうかに関係なく紙面が出るはず)
  let rows: number | null = null;
  let latest: string | null = null;
  let dbError: string | null = null;
  const sb = getServerSupabase();
  if (sb && viewer.uid) {
    try {
      const { data, error } = await (sb.schema('diagnosis') as any)
        .from('diagnosis_results')
        .select('received_at, status')
        .eq('diagnostic_user_id', viewer.uid)
        .neq('status', 'superseded')
        .not('report', 'is', null)
        .order('received_at', { ascending: false });
      if (error) dbError = error.message;
      else { rows = (data ?? []).length; latest = (data ?? [])[0]?.received_at ?? null; }
    } catch (e) { dbError = String((e as Error)?.message ?? e); }
  }

  const body = {
    // ① 閲覧者
    viewer: {
      resolved_by: path,
      uid: viewer.uid,
      self_uid: viewer.selfUid,
      impersonating: viewer.impersonating,
      is_admin: viewer.isAdmin,
      admin_by: viewer.adminBy,
    },
    // ② Cookie の中身 (署名は検証済み。値そのものは返さない)
    cookie: {
      present: !!raw,
      valid: !!verified,
      format: verified ? (verified.legacy ? '旧 (3分割・admin フラグ無し)' : '新 (4分割)') : null,
      admin_flag: verified ? verified.admin : null,
      needs_refresh: viewer.cookieStale,
    },
    // ③ 環境スイッチ
    env: {
      PUBLIC_DEMO_FALLBACK: import.meta.env.PUBLIC_DEMO_FALLBACK ?? '(未設定)',
      ALLOW_UID_ENTRY: uidEntryAllowed() ? 'on' : '(off/未設定)',
      auth_enabled: !!import.meta.env.PUBLIC_GOOGLE_CLIENT_ID,
      supabase: !!sb,
    },
    // ④ デモ表示の可否 (report.astro が loadReportVM に渡す値と同じ)
    demo: {
      viewer_is_admin_passed: demoOk,
      demo_fallback_enabled: demoFallbackEnabled(viewer.uid, demoOk),
    },
    // ⑤ 受領データ (在れば admin と無関係に紙面が出る)
    received: { rows, latest_received_at: latest, db_error: dbError },
    // ⑥ 読み方
    hint: rows && rows > 0
      ? '受領データが在ります。これで紙面が空なら原因はアダプタ側です。'
      : (demoFallbackEnabled(viewer.uid, demoOk)
          ? 'デモは出せる状態です。これで紙面が空なら原因はアダプタ側です。'
          : '受領データが無く、デモも出せない状態＝仕様どおり空になります。上の viewer / cookie / env のどれが原因かを見てください。'),
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
};
