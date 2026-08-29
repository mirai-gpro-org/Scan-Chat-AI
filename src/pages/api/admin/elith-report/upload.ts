/**
 * admin: Elith の AI疾病予防報告書 (PDF) 取込 API — パイプライン⑥ の暫定実装。
 *
 * 経路: Elith → S3 → (Wellfort 管理者が取得) → 本 API → 原本ストレージ + diagnosis_results
 *   `docs/lab/lab_data_pipeline_master_spec.md:24,96` の「AI診断結果(PDF)を受取→Webアプリへ表示」。
 *
 * 【暫定である理由】受取仕様 (命名規則・出力トリガ・世代管理・ひも付け・受領確認) は同 :98 のとおり
 *   未確定。確定するまでは「管理者が手で上げる」経路だけを用意し、自動受信は作らない。
 *   世代管理は暫定で、同一ユーザーの既存行を `status='superseded'` に落として新しい行を足す。
 *
 * 【責務の分界】UI は wellfort-site 側 (CLAUDE.md「admin UI は wellfort-site に置く」)。
 *   本ファイルは API のみ。認可は Bearer ADMIN_API_KEY (wellfort_admin_lab_upload_spec §6-1)。
 *
 * 【原則】レポート本文の要約・解釈はしない。`sections` は呼び出し側が渡した本文をそのまま格納する
 *   (表示側 report.astro もレポート自身の章をそのまま出すだけ)。
 */

import type { APIRoute } from 'astro';
import { getServerSupabase } from '../../../../lib/supabase';
import { putOriginal } from '../../../../lib/originals-storage';
import { isAdminAuthorized } from '../../../../lib/api-auth';

export const prerender = false;

const MAX_FILE_SIZE = 40 * 1024 * 1024; // 40 MB (レポート PDF は数百 KB 〜 数 MB)

function authorized(request: Request): boolean {
  // 認可の実装は src/lib/api-auth.ts に集約 (キー未設定の本番は拒否＝fail-closed)。
  return isAdminAuthorized(request);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PDF のページ数をバイト列から数える (依存追加なしの暫定)。
 * `/Type /Page` を数える素朴な方法で、オブジェクトストリーム圧縮された PDF では
 * 数え落とす。**推定できないときは null を返し、0 や当て推量を書かない**。
 * 呼び出し側が `pages` を明示していればそちらを優先する。
 */
function guessPageCount(bytes: Uint8Array): number | null {
  const text = new TextDecoder('latin1').decode(bytes);
  const m = text.match(/\/Type\s*\/Page(?![sA-Za-z])/g);
  const n = m ? m.length : 0;
  return n > 0 ? n : null;
}

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  const sb = getServerSupabase();
  if (!sb) return json({ ok: false, error: 'supabase not configured' }, 503);

  const form = await request.formData().catch(() => null);
  if (!form) return json({ ok: false, error: 'invalid form data' }, 400);

  const diagnosticUserId = String(form.get('diagnostic_user_id') ?? '').trim();
  if (!UUID_RE.test(diagnosticUserId)) {
    return json({ ok: false, error: 'invalid diagnostic_user_id' }, 400);
  }

  const file = form.get('file');
  if (!(file instanceof File)) return json({ ok: false, error: 'no file' }, 400);
  if (!file.name.toLowerCase().endsWith('.pdf')) return json({ ok: false, error: 'pdf only' }, 400);
  if (file.size > MAX_FILE_SIZE) {
    return json({ ok: false, error: 'too_large', detail: `> ${MAX_FILE_SIZE / 1024 / 1024} MB` }, 413);
  }

  // レポート本文 (章配列)。渡されなければ空配列 = PDF のみの取込。
  let sections: unknown = [];
  const rawSections = form.get('sections');
  if (typeof rawSections === 'string' && rawSections.trim()) {
    try {
      sections = JSON.parse(rawSections);
    } catch {
      return json({ ok: false, error: 'invalid sections json' }, 400);
    }
    if (!Array.isArray(sections)) return json({ ok: false, error: 'sections must be an array' }, 400);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  // PII を含まない diagnostic_user_id のみでパスを作る (customer スキーマの値は使わない)。
  const key = `elith_reports/${diagnosticUserId}/${yyyy}/${mm}/${file.name}`;

  let stored;
  try {
    stored = await putOriginal({ key, contentType: 'application/pdf', body: bytes });
  } catch (e) {
    return json({ ok: false, error: 'storage_failed', detail: String((e as Error)?.message ?? e) }, 502);
  }

  const pagesParam = Number(form.get('pages'));
  const pages = Number.isFinite(pagesParam) && pagesParam > 0 ? Math.trunc(pagesParam) : guessPageCount(bytes);

  const receivedAt = now.toISOString();
  const db = sb.schema('diagnosis') as unknown as { from: (t: string) => any };

  // 世代管理 (暫定): 既存の同ユーザー行を superseded に落としてから新しい行を足す。
  const { error: supErr } = await db
    .from('diagnosis_results')
    .update({ status: 'superseded' })
    .eq('diagnostic_user_id', diagnosticUserId)
    .neq('status', 'superseded');
  if (supErr) return json({ ok: false, error: 'db_failed', detail: supErr.message }, 500);

  const { data, error } = await db
    .from('diagnosis_results')
    .insert({
      diagnostic_user_id:     diagnosticUserId,
      diagnostic_id:          crypto.randomUUID(),
      report:                 sections,
      status:                 'received',
      received_at:            receivedAt,
      report_pdf_url:         stored.storageUrl,
      report_pdf_sha256:      stored.sha256,
      report_pdf_pages:       pages,
      report_pdf_received_at: receivedAt,
    })
    .select('id')
    .single();
  if (error) return json({ ok: false, error: 'db_failed', detail: error.message }, 500);

  return json({
    ok: true,
    id: data?.id ?? null,
    backend: stored.backend,
    storage_url: stored.storageUrl,
    sha256: stored.sha256,
    pages,
    sections: Array.isArray(sections) ? sections.length : 0,
  });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
