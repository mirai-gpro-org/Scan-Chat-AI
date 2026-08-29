/**
 * admin: Elith の AI疾病予防報告書 取込 API — パイプライン⑥。
 *
 * 経路: Elith → S3 → (Wellfort 管理者が取得) → 本 API → 原本ストレージ + diagnosis_results
 *   `docs/lab/lab_data_pipeline_master_spec.md:24,96` の「AI診断結果を受取→Webアプリへ表示」。
 *
 * 【受領は 1 件 = 3 ファイル】(`docs/elith/ai_prevention_report_generation_spec.md` §2 / §8.2)
 *   | 受領物                | フォーム項目     | 格納先                        |
 *   |----------------------|-----------------|------------------------------|
 *   | `report_text.json`   | `report_text`   | `report` (jsonb)             |
 *   | `health_checkup.json`| `health_checkup`| `checkup_values` (jsonb)     |
 *   | 組版済み PDF          | `file`          | `report_pdf_*` (原本として保管) |
 *
 *   **PDF は JSON の部分集合**で固有情報がゼロ (実測: JSON 19,870 字 / PDF 19,827 字) なので、
 *   表示の主役は JSON。PDF は原本として残すだけ (§2.3)。
 *
 * 【後方互換】旧形式 (セクション配列) の `sections` と、PDF だけの取込も引き続き受ける。
 *   wellfort-site 側の既存 admin UI を壊さないため。
 *
 * 【暫定である理由】受取仕様 (命名規則・出力トリガ・世代管理・ひも付け・受領確認) は
 *   `lab_data_pipeline_master_spec.md:98` のとおり未確定。確定するまでは「管理者が手で上げる」
 *   経路だけを用意し、自動受信は作らない。世代管理は暫定で、同一ユーザーの既存行を
 *   `status='superseded'` に落として新しい行を足す。
 *
 * 【責務の分界】UI は wellfort-site 側 (CLAUDE.md「admin UI は wellfort-site に置く」)。
 *   本ファイルは API のみ。認可は Bearer ADMIN_API_KEY (wellfort_admin_lab_upload_spec §6-1)。
 *
 * 【原則】レポート本文の要約・解釈はしない。受け取った本文をそのまま格納する。
 */

import type { APIRoute } from 'astro';
import { getServerSupabase } from '../../../../lib/supabase';
import { putOriginal } from '../../../../lib/originals-storage';
import { isAdminAuthorized } from '../../../../lib/api-auth';
import { parseReportText, parseCheckup } from '../../../../lib/report-adapter';

export const prerender = false;

const MAX_FILE_SIZE = 40 * 1024 * 1024; // 40 MB (レポート PDF は数百 KB 〜 数 MB)
/** JSON 2 点の上限。実測は report_text が約 59 KB / health_checkup が約 2 KB。 */
const MAX_JSON_SIZE = 8 * 1024 * 1024;

/** 新形式 (dict) と旧形式 (配列) を区別するための版。 */
const SCHEMA_V2 = 'elith-v2.0';
const SCHEMA_V1 = 'elith-v1.0';

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

/** フォーム項目を文字列で取り出す。File でも文字列でも受ける (admin UI がどちらでも組めるように)。 */
async function readTextField(form: FormData, name: string): Promise<{ text: string } | { error: string }> {
  const v = form.get(name);
  if (v == null) return { text: '' };
  if (typeof v === 'string') {
    if (v.length > MAX_JSON_SIZE) return { error: `${name}_too_large` };
    return { text: v };
  }
  if (v instanceof File) {
    if (v.size > MAX_JSON_SIZE) return { error: `${name}_too_large` };
    return { text: await v.text() };
  }
  return { error: `invalid ${name}` };
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

  // ── ① report_text.json (新形式 dict) / sections (旧形式 配列) ──────────────
  let report: unknown = [];
  let schemaVersion = SCHEMA_V1;

  const rt = await readTextField(form, 'report_text');
  if ('error' in rt) return json({ ok: false, error: rt.error }, 413);
  const legacy = await readTextField(form, 'sections');
  if ('error' in legacy) return json({ ok: false, error: legacy.error }, 413);

  if (rt.text.trim()) {
    try {
      report = JSON.parse(rt.text);
    } catch {
      return json({ ok: false, error: 'invalid report_text json' }, 400);
    }
    if (!report || typeof report !== 'object') {
      return json({ ok: false, error: 'report_text must be an object or array' }, 400);
    }
    schemaVersion = Array.isArray(report) ? SCHEMA_V1 : SCHEMA_V2;
  } else if (legacy.text.trim()) {
    try {
      report = JSON.parse(legacy.text);
    } catch {
      return json({ ok: false, error: 'invalid sections json' }, 400);
    }
    if (!Array.isArray(report)) return json({ ok: false, error: 'sections must be an array' }, 400);
  }

  // ── ② health_checkup.json ─────────────────────────────────────────────
  let checkup: unknown = null;
  const hc = await readTextField(form, 'health_checkup');
  if ('error' in hc) return json({ ok: false, error: hc.error }, 413);
  if (hc.text.trim()) {
    try {
      checkup = JSON.parse(hc.text);
    } catch {
      return json({ ok: false, error: 'invalid health_checkup json' }, 400);
    }
    if (!checkup || typeof checkup !== 'object' || Array.isArray(checkup)) {
      return json({ ok: false, error: 'health_checkup must be an object' }, 400);
    }
  }

  // ── ③ 組版済み PDF (原本として保管・任意) ─────────────────────────────
  const file = form.get('file');
  const hasPdf = file instanceof File;
  if (hasPdf) {
    if (!file.name.toLowerCase().endsWith('.pdf')) return json({ ok: false, error: 'pdf only' }, 400);
    if (file.size > MAX_FILE_SIZE) {
      return json({ ok: false, error: 'too_large', detail: `> ${MAX_FILE_SIZE / 1024 / 1024} MB` }, 413);
    }
  }

  // 3 つとも無いなら取り込むものが無い。**空の行を作らない。**
  const hasReport = Array.isArray(report) ? report.length > 0 : Object.keys(report as object).length > 0;
  if (!hasReport && !checkup && !hasPdf) {
    return json({ ok: false, error: 'nothing_to_ingest', detail: 'report_text / health_checkup / file のいずれかが要る' }, 400);
  }

  const now = new Date();
  const receivedAt = now.toISOString();

  let stored: Awaited<ReturnType<typeof putOriginal>> | null = null;
  let pages: number | null = null;
  if (hasPdf) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    // PII を含まない diagnostic_user_id のみでパスを作る (customer スキーマの値は使わない)。
    const key = `elith_reports/${diagnosticUserId}/${yyyy}/${mm}/${file.name}`;
    try {
      stored = await putOriginal({ key, contentType: 'application/pdf', body: bytes });
    } catch (e) {
      return json({ ok: false, error: 'storage_failed', detail: String((e as Error)?.message ?? e) }, 502);
    }
    const pagesParam = Number(form.get('pages'));
    pages = Number.isFinite(pagesParam) && pagesParam > 0 ? Math.trunc(pagesParam) : guessPageCount(bytes);
  }

  const db = sb.schema('diagnosis') as unknown as { from: (t: string) => any };

  // 世代管理 (暫定): 既存の同ユーザー行を superseded に落としてから新しい行を足す。
  const { error: supErr } = await db
    .from('diagnosis_results')
    .update({ status: 'superseded' })
    .eq('diagnostic_user_id', diagnosticUserId)
    .neq('status', 'superseded');
  if (supErr) return json({ ok: false, error: 'db_failed', detail: supErr.message }, 500);

  const row: Record<string, unknown> = {
    diagnostic_user_id: diagnosticUserId,
    diagnostic_id:      crypto.randomUUID(),
    report,
    schema_version:     schemaVersion,
    checkup_values:     checkup,
    status:             'received',
    received_at:        receivedAt,
  };
  if (stored) {
    row.report_pdf_url         = stored.storageUrl;
    row.report_pdf_sha256      = stored.sha256;
    row.report_pdf_pages       = pages;
    row.report_pdf_received_at = receivedAt;
  }

  const { data, error } = await db.from('diagnosis_results').insert(row).select('id').single();
  if (error) return json({ ok: false, error: 'db_failed', detail: error.message }, 500);

  /*
    取り込めた中身を数で返す (spec §1.3.6 の抽出監査と同じ趣旨)。
    **表示側と同じアダプタで数える** — ここだけ別の数え方をすると、
    「取り込めたつもりで画面が空」を検知できない。
  */
  const parsed = parseReportText(report);
  const measurements = parseCheckup(checkup);
  const warnings: string[] = [];
  if (hasReport && parsed.byKey.size === 0) warnings.push('report_text からセクションを 1 つも読めなかった');
  if (checkup && measurements.length === 0) warnings.push('health_checkup から検査値を 1 つも読めなかった');
  if (!hasReport) warnings.push('report_text が無いので本文が表示されない');

  return json({
    ok: true,
    id: data?.id ?? null,
    schema_version: schemaVersion,
    sections: parsed.byKey.size,
    section_names: [...parsed.byKey.values()].map((s) => s.section_name),
    health_age: parsed.healthAge,
    measurements: measurements.length,
    pdf: stored
      ? { backend: stored.backend, storage_url: stored.storageUrl, sha256: stored.sha256, pages }
      : null,
    warnings,
  });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
