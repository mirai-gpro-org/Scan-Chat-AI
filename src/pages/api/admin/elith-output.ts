import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../lib/api-auth';
import { getS3Config, isS3Configured, listObjects, getObjectText } from '../../../lib/s3';

/**
 * admin: **Elith からの下り（Elith → Wellfort）を S3 から読む**（読み取り専用）。
 *
 * 【なぜサーバ側か】AWS の鍵は Vercel 本番 env のみ。**operator PC・クライアントに置かない**
 *   (CLAUDE.md 環境変数・キー管理)。したがって S3 を読む処理は必ずここを通す。
 *
 * 【経路の根拠】`lab_data_pipeline_master_spec.md` ⑥
 *   「Elith は AI 診断結果を**所定の S3 バケットに出力**、Wellfort が受取ってアプリへ表示」。
 *   **バケットは設定済**。ただし **受取仕様（命名規則・出力トリガ・世代管理・ひも付け・
 *   受領確認）は未確定**（同 ⑥／仕様書 §6.1 の R-2）。
 *   → **この口は「読むだけ」に留める。** 取り込み（DB 書き込み）も命名規則の決め打ちもしない。
 *   決まっていないことに実装で答えを出さないため（仕様書 §6）。
 *
 * 【上りと混ぜない】同 ⑥ の注記「上り書き出し（⑤）と下り受取（⑥）は**別 S3 経路・別仕様**」。
 *   そこで**読める範囲を `output/` 配下だけに限定**する。上り (`user/…`) や他の資産は読めない。
 *   これが無いと admin キー 1 本でバケット全体が覗ける。
 *
 * 【使い方】認可 = Bearer `ADMIN_API_KEY`。
 *   GET ?prefix=output/user/elith-test-001/   → 一覧 { objects: [{key,size}] }
 *   GET ?key=output/user/elith-test-001/x.json → そのオブジェクトの中身 (テキスト)
 */
export const prerender = false;

/** 下り専用。ここを広げると上りのデータまで読めてしまう。 */
const ALLOWED_ROOT = 'output/';
/** 1 オブジェクトの上限。報告書 JSON は数十 KB なので充分な余裕を見た値。 */
const MAX_BYTES = 8 * 1024 * 1024;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** `output/` 配下に閉じているか。`..` や絶対パス・別ルートを弾く。 */
function allowed(p: string): boolean {
  return p.startsWith(ALLOWED_ROOT) && !p.includes('..') && !p.startsWith('/');
}

export const GET: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!isS3Configured()) {
    return json({ ok: false, error: 's3 not configured (AWS_REGION が未設定)' }, 503);
  }
  const cfg = getS3Config()!;
  const url = new URL(request.url);
  const key = url.searchParams.get('key')?.trim();
  const prefix = url.searchParams.get('prefix')?.trim();

  try {
    if (key) {
      if (!allowed(key)) return json({ ok: false, error: `key は ${ALLOWED_ROOT} 配下のみ` }, 400);
      const text = await getObjectText(key);
      const bytes = new TextEncoder().encode(text).length;
      if (bytes > MAX_BYTES) return json({ ok: false, error: `too large (${bytes} bytes)` }, 413);
      // 中身は加工しない。JSON かどうかの判定もしない (受取仕様が未確定なので決め打たない)。
      return json({ ok: true, bucket: cfg.bucket, region: cfg.region, key, bytes, text });
    }
    const p = prefix ?? ALLOWED_ROOT;
    if (!allowed(p)) return json({ ok: false, error: `prefix は ${ALLOWED_ROOT} 配下のみ` }, 400);
    const objects = await listObjects(p);
    return json({ ok: true, bucket: cfg.bucket, region: cfg.region, prefix: p, count: objects.length, objects });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
  }
};
