/**
 * admin: Elith の AI疾病予防報告書 取込 API — パイプライン⑥。
 *
 * 正本: docs/elith/ai_prevention_report_generation_spec.md §8
 *
 * 【受領は 1 件 = 3 ファイル】(spec §2)
 *   | 受領物                | フォーム項目     | 格納先                        |
 *   |-----------------------|------------------|-------------------------------|
 *   | `report_text.json`    | `report_text`    | `report` (jsonb)              |
 *   | `health_checkup.json` | `health_checkup` | `checkup_values` (jsonb)      |
 *   | 組版済み PDF          | `file`           | `report_pdf_*` (**原本保管**) |
 *
 *   **PDF は任意**。表示の主役は JSON で、PDF は JSON の部分集合 (固有情報ゼロ・spec §2.3)。
 *   旧 `sections` (配列) も後方互換で受ける。**3 つとも無ければ 400** (空の行を作らない)。
 *
 * 【暫定である理由】受取仕様 (命名規則・出力トリガ・世代管理・ひも付け・受領確認) は
 *   `docs/lab/lab_data_pipeline_master_spec.md:98` のとおり未確定。確定するまでは
 *   「管理者が手で上げる」経路だけを用意し、自動受信は作らない。
 *
 * 【責務の分界】UI は wellfort-site 側 (CLAUDE.md「admin UI は wellfort-site に置く」)。
 *   本ファイルは API のみ。認可は Bearer ADMIN_API_KEY。
 *
 * 【原則】本文の要約・解釈はしない。受領したものをそのまま格納する。
 *   応答の件数は**表示と同じアダプタ**で数える — 別の数え方をすると
 *   「取り込めたつもりで画面が空」を検知できない (spec §1.3.6)。
 */

import type { APIRoute } from 'astro';
import { getServerSupabase } from '../../../../lib/supabase';
import { putOriginal } from '../../../../lib/originals-storage';
import { isAdminAuthorized } from '../../../../lib/api-auth';
import { buildReportVM } from '../../../../lib/report-adapter';

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

  /** File でも文字列でも JSON を受ける (wellfort-site 側の実装に依存させない)。 */
  const readJson = async (name: string): Promise<{ ok: true; value: unknown } | { ok: false } | null> => {
    const v = form.get(name);
    let raw: string;
    if (v instanceof File) raw = (await v.text()).trim();
    else if (typeof v === 'string') raw = v.trim();
    else return null;
    if (!raw) return null;
    try { return { ok: true, value: JSON.parse(raw) }; } catch { return { ok: false }; }
  };

  // report_text.json (新形式 dict)。無ければ旧 sections (配列) を見る。
  let report: unknown = null;
  let schemaVersion = 'elith-v1.0';
  const rt = await readJson('report_text');
  if (rt && !rt.ok) return json({ ok: false, error: 'invalid report_text json' }, 400);
  if (rt?.ok) {
    if (!rt.value || typeof rt.value !== 'object') {
      return json({ ok: false, error: 'report_text must be an object or array' }, 400);
    }
    report = rt.value;
    // 新形式 (dict) を入れたときだけ版を上げる。配列で来たら旧形式のまま。
    schemaVersion = Array.isArray(rt.value) ? 'elith-v1.0' : 'elith-v2.0';
  } else {
    const legacy = await readJson('sections');
    if (legacy && !legacy.ok) return json({ ok: false, error: 'invalid sections json' }, 400);
    if (legacy?.ok) {
      if (!Array.isArray(legacy.value)) return json({ ok: false, error: 'sections must be an array' }, 400);
      report = legacy.value;
    }
  }

  // health_checkup.json (40 項目)。
  let checkup: Record<string, { date?: string; value?: unknown }[]> | null = null;
  const hc = await readJson('health_checkup');
  if (hc && !hc.ok) return json({ ok: false, error: 'invalid health_checkup json' }, 400);
  if (hc?.ok) {
    if (!hc.value || typeof hc.value !== 'object' || Array.isArray(hc.value)) {
      return json({ ok: false, error: 'health_checkup must be an object' }, 400);
    }
    checkup = hc.value as Record<string, { date?: string; value?: unknown }[]>;
  }

  // PDF は任意 (原本として保管するだけ)。
  const file = form.get('file');
  if (file instanceof File) {
    if (!file.name.toLowerCase().endsWith('.pdf')) return json({ ok: false, error: 'pdf only' }, 400);
    if (file.size > MAX_FILE_SIZE) {
      return json({ ok: false, error: 'too_large', detail: `> ${MAX_FILE_SIZE / 1024 / 1024} MB` }, 413);
    }
  } else if (report === null && checkup === null) {
    // 3 つとも無い = 取り込むものが無い。**空の行を作らない。**
    return json({ ok: false, error: 'nothing_to_ingest',
      detail: 'report_text / health_checkup / file のいずれかが要る' }, 400);
  }

  const now = new Date();
  let stored: { storageUrl: string; sha256: string; backend: string } | null = null;
  let pages: number | null = null;

  if (file instanceof File) {
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
      report:                 report,
      checkup_values:         checkup,
      schema_version:         schemaVersion,
      status:                 'received',
      received_at:            receivedAt,
      report_pdf_url:         stored?.storageUrl ?? null,
      report_pdf_sha256:      stored?.sha256 ?? null,
      report_pdf_pages:       pages,
      report_pdf_received_at: stored ? receivedAt : null,
    })
    .select('id')
    .single();
  if (error) return json({ ok: false, error: 'db_failed', detail: error.message }, 500);

  // 取り込めた中身を**表示と同じアダプタで数えて**返す。
  // 別の数え方をすると「取り込めたつもりで画面が空」を検知できない (spec §1.3.6)。
  const vm = buildReportVM({
    reportText: report, checkup, name: '', issuedOn: receivedAt.slice(0, 10),
    isSample: false, hasCancerRisk: false, cycleSeq: null, chronologicalAge: null,
  });

  return json({
    ok: true,
    id: data?.id ?? null,
    schema_version: schemaVersion,
    pdf: stored ? { backend: stored.backend, storage_url: stored.storageUrl, sha256: stored.sha256, pages } : null,
    ingested: {
      sections: vm.audit.sections.length,
      section_names: vm.audit.sections,
      wellness_age: vm.cover.wellnessAge,
      measurements: vm.audit.measurementCount,
      references: vm.audit.referenceCount,
      topics: vm.audit.topicCount,
      digest_cards: vm.audit.digestCards,
      empty_cards: vm.audit.emptyCards,
    },
    warnings: vm.audit.anomalies,
  });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
