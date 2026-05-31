/**
 * 検査結果ファイル一括アップロード API。
 *
 * Phase 1.0 簡略実装:
 *   - Supabase Storage への保存と test_artifacts 作成のみ
 *   - 顧客自動紐付け (Workflow 1) と LLM 解析は後続フェーズで実装
 */

import type { APIRoute } from 'astro';
import { getServerSupabase } from '../../../../lib/supabase';

export const prerender = false;

const LAB_COMPANY_TO_TEST_TYPE: Record<string, string> = {
  rieger:   'blood',
  prevent:  'cancer_urine',
  genoplan: 'genetics',
  laif:     'ai_prediction',
};

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
const MAX_FILES = 100;

export const POST: APIRoute = async ({ request }) => {
  const sb = getServerSupabase();
  if (!sb) return json({ error: 'supabase not configured' }, 503);

  const formData = await request.formData().catch(() => null);
  if (!formData) return json({ error: 'invalid form data' }, 400);

  const labCompany = String(formData.get('lab_company') ?? '');
  const testType = LAB_COMPANY_TO_TEST_TYPE[labCompany];
  if (!testType) return json({ error: 'invalid lab_company' }, 400);

  const files = formData.getAll('files').filter((v): v is File => v instanceof File);
  if (files.length === 0) return json({ error: 'no files' }, 400);
  if (files.length > MAX_FILES) return json({ error: `too many files (max ${MAX_FILES})` }, 413);

  const uploaded: { filename: string; status: 'success'; artifact_id: string }[] = [];
  const failed:   { filename: string; status: string; detail?: string }[]         = [];

  for (const file of files) {
    try {
      if (file.size > MAX_FILE_SIZE) {
        failed.push({ filename: file.name, status: 'too_large', detail: `> ${MAX_FILE_SIZE / 1024 / 1024} MB` });
        continue;
      }

      // 保存 path: lab_results/<company>/YYYY/MM/<filename>
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const storagePath = `lab_results/${labCompany}/${yyyy}/${mm}/${file.name}`;

      // Supabase Storage に保存
      const arrayBuffer = await file.arrayBuffer();
      const { error: storageErr } = await sb.storage
        .from('lab-results')
        .upload(storagePath, arrayBuffer, {
          contentType: file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'),
          upsert: false,
        });
      if (storageErr) {
        // duplicate or other error
        failed.push({ filename: file.name, status: 'storage_error', detail: storageErr.message });
        continue;
      }

      // test_artifacts に INSERT (顧客未割当)
      // Phase 1.0: diagnostic_user_id は仮で UNASSIGNED uuid を使う
      // (本実装では Workflow 1 の CSV 連携で割当)
      const UNASSIGNED_UID = '00000000-0000-0000-0000-000000000000';

      const fileKind = file.name.toLowerCase().endsWith('.csv') ? 'raw_csv' : 'raw_pdf_redacted';

      const { data: artifactRow, error: artErr } = await sb
        .schema('diagnosis')
        .from('test_artifacts')
        .insert({
          diagnostic_user_id: UNASSIGNED_UID,
          source: 'wellfort_lab',
          test_type: testType,
          schema_version: '1.0',
          display_mode: 'single',
          imported_by: 'wellfort_admin_upload',
          status: 'active',
          notes: `uploaded via /admin/lab-results/upload`,
        })
        .select('id')
        .single();
      if (artErr || !artifactRow) {
        failed.push({ filename: file.name, status: 'db_error', detail: artErr?.message ?? 'insert failed' });
        continue;
      }

      // test_artifact_files に INSERT
      const { error: fileErr } = await sb
        .schema('diagnosis')
        .from('test_artifact_files')
        .insert({
          test_artifact_id: artifactRow.id,
          file_kind: fileKind,
          storage_url: storagePath,
          sha256: '',
          size_bytes: file.size,
        });
      if (fileErr) {
        failed.push({ filename: file.name, status: 'db_error', detail: fileErr.message });
        continue;
      }

      uploaded.push({ filename: file.name, status: 'success', artifact_id: artifactRow.id });
    } catch (err) {
      failed.push({ filename: file.name, status: 'exception', detail: String(err) });
    }
  }

  return json({ lab_company: labCompany, uploaded, failed }, failed.length > 0 ? 207 : 200);
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
