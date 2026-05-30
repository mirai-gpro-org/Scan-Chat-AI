/**
 * /result/[id] ページのデータ取得ヘルパ。
 *
 * 設計指針 (docs/wellfort_app_design_concept.md, elith_report_integration.md):
 *   - test_artifacts.display_mode: 'single' (1枚表示) | 'three_mode' (a/b/c タブ)
 *   - a) サマリー版 = Elith JSON 「アブストラクト」セクション
 *   - b) 要注意抜粋  = 「医療受診の目安」 + 「必要とする栄養素/サプリ情報」
 *   - c) 全編        = 全10セクションを順に Markdown 表示
 *
 * Phase 1.0 では test_artifact_items は使わず、Elith JSON から動的抽出する。
 */

import { getServerSupabase } from './supabase';
import type { TestArtifact, DiagnosisResult } from '../types/supabase';
import { findSection, type ElithSection } from './elith-parser';
import { getElithSampleFor } from './elith-samples';

export interface ResultData {
  artifact: TestArtifact;
  latestResult: DiagnosisResult | null;
  sections: ElithSection[];
  /** a) アブストラクト本文 */
  summarySection: ElithSection | null;
  /** b) 要注意抜粋 (医療受診の目安 + 栄養素/サプリ) */
  highlightSections: ElithSection[];
  /** c) 全編で表示するセクション順 */
  fullSections: ElithSection[];
  /** UI モード判定 */
  isThreeMode: boolean;
  /** docs/kensa_sample から public/ にコピーした原本 PDF の path (test_type ベース) */
  samplePdfUrl: string | null;
  /** 原本 PDF の表示用ラベル */
  samplePdfLabel: string | null;
}

/**
 * test_type → public/kensa_sample/ にあるサンプル PDF への URL。
 * 本番では test_artifact_files.raw_pdf_redacted の Storage URL に置換予定 (Phase 1.5)。
 */
const SAMPLE_PDF_MAP: Record<string, { url: string; label: string }> = {
  blood:         { url: '/kensa_sample/blood.pdf',         label: '血液検査 (リージャー)' },
  cancer_urine:  { url: '/kensa_sample/cancer_urine.pdf',  label: 'がんリスク検査 (PREVENT)' },
  genetics:      { url: '/kensa_sample/genetics.pdf',      label: '遺伝子検査 (Genoplan My Book, 207pg)' },
  ai_prediction: { url: '/kensa_sample/ai_prediction.pdf', label: 'AI 疾病予測' },
};

/** Wellfort UI 表示順 (c) 全編で使用) */
const FULL_ORDER = [
  'アブストラクト',
  '総評',
  '検査値フィードバック',
  '食事アドバイス',
  '運動アドバイス',
  '睡眠・ストレス管理',
  'ライフスタイル総合',
  '医療受診の目安',
  '必要とする栄養素/サプリ情報',
  'リファレンス',
];

const HIGHLIGHT_NAMES = [
  '医療受診の目安',
  '必要とする栄養素/サプリ情報',
];

export async function loadResult(
  artifactId: string,
): Promise<ResultData | { error: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(artifactId)) {
    return { error: '不正な検査 ID です。' };
  }
  const sb = getServerSupabase();
  if (!sb) return { error: 'Supabase が未設定です。' };

  const { data: artifact, error: artErr } = await sb
    .schema('diagnosis')
    .from('test_artifacts')
    .select('*')
    .eq('id', artifactId)
    .maybeSingle();
  if (artErr) return { error: `test_artifacts: ${artErr.message}` };
  if (!artifact) return { error: '検査結果が見つかりません。' };

  // 同 diagnostic_user_id の最新 published diagnosis_results を取得
  // (Phase 1.0 簡略: artifact と diagnosis_results の直接紐付けはまだ無いため)
  const { data: latestResult } = await sb
    .schema('diagnosis')
    .from('diagnosis_results')
    .select('*')
    .eq('diagnostic_user_id', artifact.diagnostic_user_id)
    .in('status', ['published', 'extracted'])
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // 検査種別ごとの専用サンプル Elith を優先 (本番では artifact ごとの
  // 個別 diagnosis_results に紐付ける)
  const sampleSections = getElithSampleFor(artifact.test_type);
  const sections: ElithSection[] = sampleSections
    ?? ((latestResult?.report as ElithSection[] | null) ?? []);

  const summarySection = findSection(sections, 'アブストラクト');
  const highlightSections = HIGHLIGHT_NAMES
    .map((n) => findSection(sections, n))
    .filter((s): s is ElithSection => s != null);
  const fullSections = FULL_ORDER
    .map((n) => findSection(sections, n))
    .filter((s): s is ElithSection => s != null);

  const samplePdf = SAMPLE_PDF_MAP[artifact.test_type] ?? null;

  return {
    artifact,
    latestResult: latestResult ?? null,
    sections,
    summarySection,
    highlightSections,
    fullSections,
    isThreeMode: artifact.display_mode === 'three_mode',
    samplePdfUrl: samplePdf?.url ?? null,
    samplePdfLabel: samplePdf?.label ?? null,
  };
}
