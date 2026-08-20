#!/usr/bin/env node
/**
 * 実物の Elith サンプル JSON (docs/elith/2026_05_24 Elith_demo.json, 10 セクション × 約 21K 字)
 * を seed 済の 80000001 レコードに後置きで読み込ませる。
 *
 * 使い方:
 *   1) `supabase start` で local stack を起動
 *   2) `supabase db reset` でマイグレ + seed.sql 適用
 *   3) `node supabase/load_elith_demo.mjs` を実行
 *
 * 環境変数:
 *   SUPABASE_URL                  default: http://127.0.0.1:54321
 *   SUPABASE_SERVICE_ROLE_KEY     必須 (`supabase status` で確認)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const samplePath = join(repoRoot, 'docs/elith/2026_05_24 Elith_demo.json');

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_KEY) {
  console.error('error: SUPABASE_SERVICE_ROLE_KEY が未設定です。');
  console.error('       `supabase status` の service_role_key を export してください。');
  process.exit(1);
}

const sample = JSON.parse(readFileSync(samplePath, 'utf-8'));
console.log(`loaded ${sample.length} sections from ${samplePath}`);
const totalChars = sample.reduce((sum, s) => sum + (s.char_count || 0), 0);
console.log(`total chars: ${totalChars}`);

// アブストラクト = サマリー版
const abstract = sample.find((s) => s.section_name === 'アブストラクト');
// 医療受診の目安 = 要注意抜粋の素材
const urgent = sample.find((s) => s.section_name === '医療受診の目安');

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  db: { schema: 'diagnosis' },
  auth: { persistSession: false, autoRefreshToken: false },
});

const targetId = '80000001-0000-0000-0000-000000000000';
// OEM デモ顧客 "山田 太郎" (da000001) の最新結果にも同じフル JSON を流し込む。
// (demo_oem_account.sql 適用後に有効。未適用なら更新 0 件で無害にスキップ)
const demoTargetId = '8a000001-0000-0000-0000-000000000000';

for (const id of [targetId, demoTargetId]) {
  const { data, error } = await supabase
    .from('diagnosis_results')
    .update({
      report: sample,
      summary_text: abstract?.text ?? null,
      highlights_text: urgent?.text ?? null,
      extracted_at: new Date().toISOString(),
      extracted_by_model: 'gemini-2.5-flash',
      status: 'published',
    })
    .eq('id', id)
    .select('id, schema_version, status');

  if (error) {
    console.error(`update failed (${id}):`, error);
    process.exit(1);
  }
  if (!data || data.length === 0) {
    console.warn(`  skipped (no row): ${id}`);
    continue;
  }
  console.log('updated', data[0]);
}

console.log(`  sections embedded: ${sample.length}`);
console.log(`  total chars      : ${totalChars}`);
console.log('Elith demo loaded into diagnosis.diagnosis_results id =', targetId, '+', demoTargetId);
