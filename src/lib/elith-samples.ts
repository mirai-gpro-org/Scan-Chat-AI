/**
 * 検査種別ごとの Elith レポートサンプル (`docs/kensa_sample/` の本物 PDF を要約)。
 *
 * 本番では Elith 社から検査ごとの個別 JSON が届くが、Phase 1.0 デモでは
 * 4 種類のサンプル PDF の中身を要約した固定 JSON を返す。
 *
 * 本文中の `[p<N>]` 表記は PDF 原本の該当ページへの deep link マーカー。
 * Markdown レンダリング時に <a data-pdf-page="N"> に変換される。
 */

import type { ElithSection } from './elith-parser';

/** 血液検査 (リージャー、1pg) — 物部 慶幸 2025-05-26 採血 */
export const ELITH_SAMPLE_BLOOD: ElithSection[] = [
  {
    section_name: 'アブストラクト',
    char_count: 320,
    text: 'メタボリックシンドローム＆生活習慣病セルフチェック (リージャーラボラトリー) の結果、**血糖値 116 mg/dL** [p1] と **中性脂肪 151 mg/dL** [p1] が基準値を超過、**腹囲 86 cm** [p1] も基準上限を超えました。LDL 138 mg/dL・総コレ 219 mg/dL も上限ギリギリです。HbA1c は 5.5 % と正常域ですが、糖代謝・脂質代謝の改善が必要です。アンケートではほぼ毎日のアルコール摂取と肉料理・揚げ物・塩辛い味の頻度が高いと回答 [p1]。生活習慣の見直しで十分改善可能な領域です。',
  },
  {
    section_name: '医療受診の目安',
    char_count: 200,
    text: '糖尿病予備軍 (空腹時血糖 100-125 mg/dL) に該当する可能性が高いため、**1〜3 ヶ月後の再検査** [p1]、または内科での **HbA1c 再測定** を推奨します。中性脂肪・腹囲も合わせるとメタボリックシンドローム診断基準に近づいているため、定期的な経過観察を。',
  },
  {
    section_name: '必要とする栄養素/サプリ情報',
    char_count: 180,
    text: '食物繊維 (1日 20g 以上、野菜・海藻) と **マグネシウム** [p1]、ビタミン B 群が糖代謝の正常化に寄与します。アルコール摂取は休肝日を週 2 日設け、純エタノール換算で 1 日 20g 以下を目安に。',
  },
];

/** がんリスク検査 (PREVENT メディカル ALA-PDS、3pg) */
export const ELITH_SAMPLE_CANCER_URINE: ElithSection[] = [
  {
    section_name: 'アブストラクト',
    char_count: 290,
    text: 'PREVENT メディカルの **ALA-PDS がんリスクチェック** (尿検査) の結果、PDS index は **中リスク域** [p1] に該当しました。胃がん・大腸がん・前立腺がんの優先確認が推奨されるレベルです。前回比でわずかに上昇傾向のため、生活習慣 (塩分摂取・喫煙) の見直しと、年齢に応じた精密検査を計画的に進めることをおすすめします [p2]。',
  },
  {
    section_name: '医療受診の目安',
    char_count: 200,
    text: '中リスク域では現時点で精密検査は必須ではありませんが、**56 歳という年齢を踏まえ、胃カメラ・大腸カメラの年 1 回受診** [p3] を推奨します。50 歳以上の方には PSA (前立腺特異抗原) 検査もご検討ください。',
  },
  {
    section_name: '必要とする栄養素/サプリ情報',
    char_count: 170,
    text: '抗酸化栄養素 (**ビタミン C・E、リコピン**、緑黄色野菜) [p2] の摂取を意識してください。胃がんリスク低減には塩分制限 (6g/日 以下) と緑茶のカテキン、ピロリ菌検査が有効とされています。',
  },
];

/** 遺伝子検査 (Genoplan My Book、207pg、2023-02-24) */
export const ELITH_SAMPLE_GENETICS: ElithSection[] = [
  {
    section_name: 'アブストラクト',
    char_count: 410,
    text: 'ジェノプラン My Book (207 ページ) は、認証キー CBAD-DMID-BOAQ で 25 の主要項目を分析した結果です [p4]。注目所見:\n\n①**脂質代謝**: LDL コレステロール上昇しやすい遺伝子型 [p18]\n②**糖代謝**: インスリン感受性低下傾向 [p35]\n③**カフェイン代謝**: 速いタイプ [p52]\n④**アルコール分解能**: ALDH2 ヘテロ型 (中程度) [p64]\n⑤**運動効果**: 筋肥大効果が高い体質 [p98]\n\n総合的に生活習慣病リスクは中等度、適切な食事と運動で大幅にリスク低減可能です。',
  },
  {
    section_name: '医療受診の目安',
    char_count: 230,
    text: '現時点で受診を要する所見はありませんが、**ALDH2 ヘテロ型** [p64] のためアルコール代謝負荷が大きく、肝機能 (AST/ALT/γ-GT) の定期的なフォローを推奨します。心臓疾患の家族歴がある場合は **循環器内科への相談** [p120] もご検討ください。',
  },
  {
    section_name: '必要とする栄養素/サプリ情報',
    char_count: 200,
    text: '**ω-3 脂肪酸 (EPA/DHA)、葉酸、ビタミン B 群** [p155] が脂質・糖代謝に有効です。カフェイン代謝が速いタイプ [p52] のため、コーヒー摂取は 1 日 3 杯まで安全範囲。お酒は適量を心がけてください。',
  },
];

/** AI 疾病予測 (LAiF、9pg、2024-09-12) */
export const ELITH_SAMPLE_AI_PREDICTION: ElithSection[] = [
  {
    section_name: 'アブストラクト',
    char_count: 460,
    text: 'AI 疾病発症予測システム (LAiF、460 万人の医療データベース解析) の結果 [p1]、特に注目すべき高リスク項目:\n\n①**うつ病** — 相対リスク比 **3.3**、5 年発症率 12.5%、10 年 23.4% [p2]\n②**高血圧** — 相対リスク比 **1.7**、5 年 17.5%、10 年 31.9% [p2]\n③**胃がん** — 相対リスク比 **1.6**、5 年 9.9%、10 年 18.9% [p2]\n④**心不全 / すい臓がん** — 相対リスク比 1.4 [p2]\n\n生活習慣病・循環器・悪性腫瘍リスクが平均より高めです。早期の生活改善で大幅な低減が期待できます [p3]。',
  },
  {
    section_name: '医療受診の目安',
    char_count: 280,
    text: '**うつ病リスクが平均の 3.3 倍** [p2] と非常に高く、ストレスチェックや **心療内科・精神科への相談** を強く推奨します。高血圧については毎日の家庭血圧測定と内科への定期受診を [p3]。胃がんリスク上昇のため **胃カメラを年 1 回** [p2] ご検討ください。',
  },
  {
    section_name: '必要とする栄養素/サプリ情報',
    char_count: 220,
    text: '高血圧対策に **カリウム** (野菜・果物)、**マグネシウム** [p3]。胃がん予防には食塩制限 (6g/日 以下) と **ピロリ菌検査** [p2]。うつ予防には **ω-3 脂肪酸 / ビタミン D / トリプトファン** を含む食材を意識してください [p3]。',
  },
];

/** 人間ドック (ユーザー UL、8pg) — サンプル PDF 無し / 簡易テンプレ */
export const ELITH_SAMPLE_HEALTH_CHECKUP: ElithSection[] = [
  {
    section_name: 'アブストラクト',
    char_count: 250,
    text: '人間ドック (某総合病院) の結果は OCR / LLM 解析中です。スキャンが完了次第、主要所見の要約をここに表示します。原本 PDF は「全編」タブからご確認いただけます。',
  },
];

export function getElithSampleFor(testType: string): ElithSection[] | null {
  switch (testType) {
    case 'blood':          return ELITH_SAMPLE_BLOOD;
    case 'cancer_urine':   return ELITH_SAMPLE_CANCER_URINE;
    case 'genetics':       return ELITH_SAMPLE_GENETICS;
    case 'ai_prediction':  return ELITH_SAMPLE_AI_PREDICTION;
    case 'health_checkup': return ELITH_SAMPLE_HEALTH_CHECKUP;
    default:               return null;
  }
}
