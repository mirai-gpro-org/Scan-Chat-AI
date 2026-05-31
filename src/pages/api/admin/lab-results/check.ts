/**
 * 検査結果ファイルの重複チェック API。
 *
 * 既存の diagnosis.test_artifact_files (file storage_url の basename) を参照し、
 * 同一 lab_company × filename が登録済かを返す。
 *
 * Phase 1.0 簡略実装:
 *   - test_artifact_files テーブルに既存データが少ないため、
 *     現状は全て new 扱いで返す (将来 storage 連携時に拡張)
 */

import type { APIRoute } from 'astro';
import { getServerSupabase } from '../../../../lib/supabase';

export const prerender = false;

type CheckRequest = { lab_company?: string; filenames?: string[] };
type CheckResultItem = { filename: string; status: 'new' | 'duplicate'; existing_artifact_id?: string };

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null) as CheckRequest | null;
  const filenames = Array.isArray(body?.filenames) ? body.filenames.filter((f) => typeof f === 'string') : [];
  if (filenames.length === 0) {
    return json({ error: 'filenames is required' }, 400);
  }

  const sb = getServerSupabase();
  if (!sb) return json({ error: 'supabase not configured' }, 503);

  // 既存 test_artifact_files から storage_url を取得 (basename で比較)
  const { data: existing } = await sb
    .schema('diagnosis')
    .from('test_artifact_files')
    .select('test_artifact_id, storage_url');

  const existingBasenames = new Map<string, string>();
  for (const row of existing ?? []) {
    const url = row.storage_url ?? '';
    const basename = url.split('/').pop() ?? '';
    if (basename) existingBasenames.set(basename.toLowerCase(), row.test_artifact_id);
  }

  const results: CheckResultItem[] = filenames.map((fn) => {
    const existing_artifact_id = existingBasenames.get(fn.toLowerCase());
    return existing_artifact_id
      ? { filename: fn, status: 'duplicate' as const, existing_artifact_id }
      : { filename: fn, status: 'new' as const };
  });

  return json({ lab_company: body?.lab_company ?? null, results });
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
