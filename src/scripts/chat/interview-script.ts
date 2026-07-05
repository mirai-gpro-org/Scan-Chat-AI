/**
 * AI 問診票 — クライアント駆動エンジン (Phase 2.0)
 *
 * 設計思想:
 *   Live API (LLM) に質問順 / 選択肢 / 分岐を任せると tool calling の
 *   不安定さで「ループ・選択肢欠落・順序乱れ」が頻発する。
 *   そこで問診票本体をクライアント (TypeScript) で完全管理し、
 *   LLM の役割は「ユーザー回答の温かい復唱」「セクション切替の導線発話」
 *   だけに限定する。
 *
 * 問診内容:
 *   「ウェルテクト健康モニタリングサービス：共通アンケート」(PDF) を全面採用。
 *   実施検査 (Q EXAM-TYPE) の回答で、後半の検査別設問を出し分ける。
 *
 * 回答 UI:
 *   - text   : 自由入力 (数値入力ヒント可)
 *   - chip   : 単一選択 (選択肢が少ない)
 *   - multi  : 複数選択 (ボトムシート・チェックリスト / 選択肢が少ない)
 *   - wheel  : ホイール (ドラム) 選択モーダル。選択肢が多い設問向け。
 *              multi:true で複数選択に対応 (タップでトグル)。
 *   - slider : 1〜10 のスケール
 *   - matrix : 行 (項目) × 列 (頻度) のマトリクス選択 (Q 食品摂取頻度)
 *
 *   いずれの設問も「画面タップ」または「音声」で回答できる
 *   (音声回答は live-controller が選択肢へマッチングしてエンジンに反映)。
 */

export type SectionId =
  | 'basic'
  | 'health'
  | 'smoking'
  | 'drinking'
  | 'diet'
  | 'exercise'
  | 'meds'
  | 'sleep'
  | 'exam';

export interface ChoiceOpt {
  label: string;
  emoji?: string;
}

export type AnswerKind = 'text' | 'chip' | 'multi' | 'wheel' | 'slider' | 'matrix';

export type AnswerValue = string | string[] | number;
export type Answers = Record<string, AnswerValue>;

export interface QuestionDef {
  id: string;
  section_id: SectionId;
  section_title: string;
  question: string;
  answer_kind: AnswerKind;

  /** chip 用 */
  chips?: ChoiceOpt[];

  /** multi (ボトムシート) 用 */
  multi_options?: ChoiceOpt[];
  multi_title?: string;

  /** wheel 用 */
  wheel_options?: ChoiceOpt[];
  wheel_title?: string;
  /** wheel を複数選択にする */
  multi?: boolean;

  /** slider 用 */
  slider_low_label?: string;
  slider_high_label?: string;
  slider_min?: number;
  slider_max?: number;

  /** matrix 用 */
  matrix_rows?: string[];
  matrix_cols?: ChoiceOpt[];

  /** text 用 */
  placeholder?: string;
  /** 数値キーボードを促す */
  numeric?: boolean;
  /** 入力例 (UI のヒント / 音声導線) */
  example?: string;

  /** 表示条件。false なら設問をスキップする (分岐) */
  when?: (a: Answers) => boolean;
}

export const SECTIONS: { id: SectionId; title: string }[] = [
  { id: 'basic',      title: '基本情報' },
  { id: 'health',     title: '健康状態・既往歴' },
  { id: 'smoking',    title: '喫煙習慣' },
  { id: 'drinking',   title: '飲酒習慣' },
  { id: 'diet',       title: '食生活' },
  { id: 'exercise',   title: '運動習慣' },
  { id: 'meds',       title: '服薬・サプリメント' },
  { id: 'sleep',      title: '睡眠・ストレス' },
  { id: 'exam',       title: '実施検査の確認' },
];

const SECTION_TITLE: Record<SectionId, string> = Object.fromEntries(
  SECTIONS.map((s) => [s.id, s.title]),
) as Record<SectionId, string>;

// ── 選択肢マスタ ───────────────────────────────────────────────

const opt = (labels: string[]): ChoiceOpt[] => labels.map((label) => ({ label }));

/** 疾患リスト (現病歴 / 既往歴 共通) */
const DISEASES = opt([
  'なし', '胃がん', '大腸がん', '肺がん', '乳がん', '肝臓がん',
  '甲状腺機能低下症', '甲状腺機能亢進症', '高脂血症', '高血圧', '骨粗鬆症',
  '脳梗塞', '脳卒中', '脳出血', '大動脈瘤', '不整脈', '心筋梗塞', '狭心症',
  'アルツハイマー病', 'うつ病', '1型糖尿病', '2型糖尿病', '肺気腫', '喘息',
  'COPD', '人工透析', 'その他',
]);

const SYMPTOMS: ChoiceOpt[] = [
  { label: 'なし', emoji: '✅' },
  { label: '頭痛', emoji: '🤕' },
  { label: '肩こり', emoji: '😣' },
  { label: '腰痛', emoji: '🦴' },
  { label: '眼精疲労', emoji: '👀' },
  { label: '冷え性', emoji: '🥶' },
  { label: '便秘・下痢', emoji: '🚽' },
  { label: '慢性的な疲労感', emoji: '😪' },
  { label: 'その他' },
];

const EXERCISE_TYPES: ChoiceOpt[] = [
  { label: 'ウォーキング', emoji: '🚶' },
  { label: 'ジョギング・ランニング', emoji: '🏃' },
  { label: '水泳', emoji: '🏊' },
  { label: '筋力トレーニング', emoji: '💪' },
  { label: 'ヨガ・ストレッチ', emoji: '🧘' },
  { label: 'スポーツ（球技・武道等）', emoji: '⚽' },
  { label: '自転車', emoji: '🚲' },
  { label: 'その他' },
];

const FOOD_ROWS = [
  '野菜・海藻類', 'フルーツ', '魚・海産物', '赤身肉・加工肉',
  '揚げ物・脂っこい食事', '塩分の多い食事', '間食・甘いもの',
  'カフェイン（コーヒー、エナジードリンクなど）', 'ご飯（お米）',
];
const FOOD_COLS = opt(['ほぼ毎日', '週4〜5回', '週2〜3回', '週1回以下', 'ほとんど摂らない']);

// 実施検査タイプ (Q EXAM-TYPE のラベル — when 分岐で参照)
const T_WELLTECT = 'ウェルテクト（下記検査の複数パッケージ）';
const T_GENE = '遺伝子検査（唾液検査）のみ';
const T_CANCER = 'がんリスク検査（尿検査）のみ';
const T_BLOOD = '血液検査のみ';
const T_AIPRED = 'AI疾病予測のみ';
const T_AIPREV = 'AI疾病予防のみ';

/**
 * DB の test_type コード → EXAM-TYPE ラベル。
 * 「今回実施する検査」は申込情報 (customer.lab_tests.test_type 等) から供給し、
 * EXAM-TYPE 設問はユーザーに尋ねない (A案)。コードは lab-results/upload・
 * dashboard-queries 等と共通 (blood / cancer_urine / genetics / ai_prediction)。
 */
export const TEST_TYPE_TO_EXAM_LABEL: Record<string, string> = {
  blood: T_BLOOD,
  cancer_urine: T_CANCER,
  genetics: T_GENE,
  ai_prediction: T_AIPRED,
};

/** DB test_type コード配列 → EXAM-TYPE 用ラベル配列 (未知コードは除外・重複排除)。 */
export function examLabelsFromTestTypes(codes: readonly string[]): string[] {
  const out: string[] = [];
  for (const c of codes) {
    const label = TEST_TYPE_TO_EXAM_LABEL[c];
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

// ── 分岐ヘルパ ─────────────────────────────────────────────────

function asArray(v: AnswerValue | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (v == null || v === '') return [];
  return [String(v)];
}

/** 現病歴 (H-CURRENT) で「なし」以外の疾患を 1 つ以上選んでいるか */
function hasCurrentDisease(a: Answers): boolean {
  return asArray(a['H-CURRENT']).some((x) => x !== 'なし');
}

// ── 問診票本体 (PDF「共通アンケート」全 81 問を反映) ────────────

const RAW: Omit<QuestionDef, 'section_title'>[] = [
  // ───── 基本情報 ─────
  // ※「氏名」「生年月日」「生物学的性別」は問診で尋ねない。顧客DB (customer_profiles)
  //   から内部取得した値を問診結果へ自動付与する (live-controller の showCompletion 参照)。
  {
    id: 'B-HEIGHT', section_id: 'basic', answer_kind: 'text', numeric: true,
    question: '身長を教えてください。（cm）',
    example: '172cm → 172',
    placeholder: '例：172',
  },
  {
    id: 'B-WEIGHT', section_id: 'basic', answer_kind: 'text', numeric: true,
    question: '体重を教えてください。（kg・数字のみ）',
    example: '65kg → 65',
    placeholder: '例：65',
  },
  {
    id: 'B-WEIGHT-CHANGE', section_id: 'basic', answer_kind: 'multi',
    question: 'ご自身の体重変化について、該当するものを教えてください。',
    multi_title: '該当するものをすべて選んでください',
    multi_options: opt([
      '20歳の頃と比べて、今は10kg以上増加した',
      'この1年間で体重の増加が3kg以上あった',
      '該当するものはない',
    ]),
  },

  // ───── 健康状態、既往歴・現病歴 ─────
  {
    id: 'H-SYMPTOMS', section_id: 'health', answer_kind: 'wheel', multi: true,
    question: '現在気になる自覚症状を教えてください。',
    wheel_title: '気になる自覚症状（複数選択可）',
    wheel_options: SYMPTOMS,
  },
  {
    id: 'H-CURRENT', section_id: 'health', answer_kind: 'wheel', multi: true,
    question: '現在罹患している疾患を教えてください。',
    wheel_title: '現在罹患している疾患（複数選択可）',
    wheel_options: DISEASES,
  },
  {
    id: 'H-PAST', section_id: 'health', answer_kind: 'wheel', multi: true,
    question: '過去に罹患した疾患名を教えてください。',
    wheel_title: '過去に罹患した疾患（複数選択可）',
    wheel_options: DISEASES,
  },
  {
    id: 'H-TREAT-STATUS', section_id: 'health', answer_kind: 'chip',
    question: '選択いただいた疾患の治療状況を教えてください。',
    chips: opt(['未治療', '治療中', '経過観察中', '完治']),
    when: hasCurrentDisease,
  },
  {
    id: 'H-TREAT-DETAIL', section_id: 'health', answer_kind: 'text',
    question: '選択いただいた疾患の発症時期・治療法を教えてください。',
    example: '2020年3月・外科手術',
    placeholder: '例：2020年3月・外科手術',
    when: hasCurrentDisease,
  },

  // ───── 喫煙習慣 ─────
  {
    id: 'S-STATUS', section_id: 'smoking', answer_kind: 'chip',
    question: '喫煙習慣はありますか？',
    chips: [
      { label: '現在吸っている', emoji: '🚬' },
      { label: '過去に吸っていたが現在は吸わない', emoji: '🍃' },
      { label: '吸ったことはない', emoji: '🚭' },
    ],
  },
  {
    id: 'S-QUIT-AGE', section_id: 'smoking', answer_kind: 'chip',
    question: '喫煙を止めた年齢を教えてください。',
    chips: opt(['30歳未満', '30〜39歳', '40〜49歳', '50〜59歳', '60歳以上']),
    when: (a) => a['S-STATUS'] === '過去に吸っていたが現在は吸わない',
  },
  {
    id: 'S-COUNT', section_id: 'smoking', answer_kind: 'chip',
    question: '1日の喫煙本数を教えてください。（喫煙者は現在、禁煙者は過去の本数）',
    chips: opt(['5本未満', '5〜10本', '11〜20本', '21〜30本', '31本以上']),
    when: (a) => a['S-STATUS'] !== '吸ったことはない',
  },
  {
    id: 'S-YEARS', section_id: 'smoking', answer_kind: 'chip',
    question: '喫煙している／していた年数を教えてください。',
    chips: opt(['5年未満', '5〜10年', '10〜20年', '20〜30年', '30年以上']),
    when: (a) => a['S-STATUS'] !== '吸ったことはない',
  },

  // ───── 飲酒習慣 ─────
  {
    id: 'D-FREQ', section_id: 'drinking', answer_kind: 'wheel',
    question: '現在の飲酒習慣はありますか？',
    wheel_title: '飲酒の頻度を選んでください',
    wheel_options: opt([
      '毎日飲む', '週4〜5日飲む', '週2〜3日飲む', '月2〜4回飲む',
      '月1回以下飲む', '過去飲んでいたが、現在はまったく飲まない', '元々まったく飲まない',
    ]),
  },
  {
    id: 'D-UNTIL-AGE', section_id: 'drinking', answer_kind: 'chip',
    question: '何歳まで飲酒されていたか教えてください。',
    chips: opt(['30歳未満', '30〜39歳', '40〜49歳', '50〜59歳', '60歳以上']),
    // 「何歳まで飲酒していたか」は過去にやめた人だけに聞く (喫煙の S-QUIT-AGE と同じ設計)。
    // 現在の飲酒者には出さない (毎日飲む人に「何歳まで」は不自然)。
    when: (a) => a['D-FREQ'] === '過去飲んでいたが、現在はまったく飲まない',
  },
  {
    id: 'D-YEARS', section_id: 'drinking', answer_kind: 'chip',
    question: '飲酒している／していた年数を教えてください。',
    chips: opt(['5年未満', '5〜10年', '10〜20年', '20〜30年', '30年以上']),
    when: (a) => a['D-FREQ'] !== '元々まったく飲まない',
  },
  {
    id: 'D-AMOUNT', section_id: 'drinking', answer_kind: 'chip',
    question: '飲酒する／していた際の、1回あたりの飲酒量を教えてください。',
    chips: opt(['1合未満（ビール中瓶1本未満）', '1〜2合', '2〜3合', '3合以上']),
    when: (a) => a['D-FREQ'] !== '元々まったく飲まない',
  },

  // ───── 食生活 ─────
  {
    id: 'F-HABITS', section_id: 'diet', answer_kind: 'wheel', multi: true,
    question: '食事について、以下のうち該当するものを教えてください。',
    wheel_title: '食事について該当するもの（複数選択可）',
    wheel_options: opt([
      '朝食を抜くことが多い', '何でも食べる', '嚙みづらい', '噛めない',
      '食べる速度が早い', '食べる速度が遅い',
      '就寝2時間前以内の食事が週3回以上ある', '外食が多い',
    ]),
  },
  {
    id: 'F-FREQ', section_id: 'diet', answer_kind: 'matrix',
    question: '以下の食品の摂取頻度を教えてください。',
    matrix_rows: FOOD_ROWS,
    matrix_cols: FOOD_COLS,
  },
  {
    id: 'F-CAFFEINE', section_id: 'diet', answer_kind: 'chip',
    question: 'カフェイン（コーヒー・お茶・エナジードリンク等）の1日あたりの摂取量を教えてください。',
    chips: opt(['ほとんど摂らない', '1日1〜2杯', '1日3〜4杯', '1日5杯以上']),
  },
  {
    id: 'F-RICE', section_id: 'diet', answer_kind: 'chip',
    question: '1回あたりのご飯（お米）の量を教えてください。',
    chips: opt(['ほとんど食べない', '茶碗軽め（約100g）', '茶碗1杯（約150g）', '大盛り以上（約250g〜）']),
  },
  {
    id: 'F-VEG', section_id: 'diet', answer_kind: 'chip',
    question: '1回あたりの野菜摂取量に対して、ご自身のお考えを教えてください。',
    chips: [
      { label: '十分に摂れている', emoji: '🥗' },
      { label: '普通', emoji: '🥬' },
      { label: '不足していると感じる', emoji: '🥦' },
    ],
  },
  {
    id: 'F-DIET-RESTRICT', section_id: 'diet', answer_kind: 'chip',
    question: 'ダイエットのための食事制限について教えてください。',
    chips: opt(['食事制限している', '食事制限していない']),
  },
  {
    id: 'F-DIET-METHOD', section_id: 'diet', answer_kind: 'multi',
    question: '食事方法で意識しているものがあれば教えてください。',
    multi_title: '意識している食事方法（複数選択可）',
    multi_options: opt(['ヴィーガン・ベジタリアン', '野菜中心', '糖質制限', '外食中心', 'その他']),
  },

  // ───── 運動習慣 ─────
  {
    id: 'E-FREQ', section_id: 'exercise', answer_kind: 'chip',
    question: '週あたりの運動頻度を教えてください。',
    chips: [
      { label: 'ほぼ毎日（週5日以上）', emoji: '🏃' },
      { label: '週3〜4日', emoji: '🚶' },
      { label: '週1〜2日' },
      { label: 'ほとんどしない', emoji: '🧘' },
    ],
  },
  {
    id: 'E-TIME', section_id: 'exercise', answer_kind: 'chip',
    question: '1回あたりの運動時間を教えてください。',
    chips: opt(['30分未満', '30〜60分', '60〜90分', '90分以上']),
    when: (a) => a['E-FREQ'] !== 'ほとんどしない',
  },
  {
    id: 'E-SPEED', section_id: 'exercise', answer_kind: 'chip',
    question: '同年代の人と比較した歩く速さを教えてください。',
    chips: [{ label: '速い', emoji: '⚡' }, { label: '遅い', emoji: '🐢' }],
  },
  {
    id: 'E-SITTING', section_id: 'exercise', answer_kind: 'chip',
    question: '1日のうち座りっぱなしの時間を教えてください。',
    chips: opt(['3時間未満', '3〜6時間', '6〜9時間', '9〜12時間', '12時間以上']),
  },
  {
    id: 'E-TYPE', section_id: 'exercise', answer_kind: 'wheel',
    question: '主な運動の種類を教えてください。',
    wheel_title: '主な運動の種類を選んでください',
    wheel_options: EXERCISE_TYPES,
    when: (a) => a['E-FREQ'] !== 'ほとんどしない',
  },

  // ───── 服薬・サプリメント ─────
  {
    id: 'M-HAS', section_id: 'meds', answer_kind: 'chip',
    question: '現在服用中の薬・定期的に摂取しているサプリメント・健康食品はありますか？',
    chips: [{ label: 'ある', emoji: '💊' }, { label: 'ない', emoji: '🚫' }],
  },
  {
    id: 'M-NAME', section_id: 'meds', answer_kind: 'text',
    question: '服用中の薬・サプリメント・健康食品の名前を教えてください。（薬は用途もあれば）',
    placeholder: '例：ロキソニン（頭痛）、ビタミンC',
    when: (a) => a['M-HAS'] === 'ある',
  },
  {
    id: 'M-PERIOD', section_id: 'meds', answer_kind: 'chip',
    question: 'その薬・サプリメント・健康食品の摂取期間を教えてください。',
    chips: opt(['1カ月未満', '1〜3カ月', '4〜6カ月', '7〜11カ月', '1年以上']),
    when: (a) => a['M-HAS'] === 'ある',
  },
  {
    id: 'M-FREQ', section_id: 'meds', answer_kind: 'chip',
    question: 'その薬・サプリメント・健康食品の摂取頻度を教えてください。',
    chips: opt(['週1〜3回', '週4〜6回', '毎日']),
    when: (a) => a['M-HAS'] === 'ある',
  },

  // ───── 睡眠・ストレス ─────
  {
    id: 'SL-HOURS', section_id: 'sleep', answer_kind: 'chip',
    question: '平均的な睡眠時間を教えてください。',
    chips: [
      { label: '5時間未満', emoji: '😴' },
      { label: '5〜6時間' },
      { label: '6〜7時間' },
      { label: '7〜8時間' },
      { label: '8時間以上', emoji: '💤' },
    ],
  },
  {
    id: 'SL-QUALITY', section_id: 'sleep', answer_kind: 'chip',
    question: '睡眠の質を教えてください。',
    chips: opt(['とても良い', '良い', '普通', '悪い', 'とても悪い']),
  },
  {
    id: 'SL-STRESS', section_id: 'sleep', answer_kind: 'slider',
    question: '仕事・家庭・環境など含む総合的なストレスについて点数をつけてください。（1〜10）',
    slider_low_label: '全くない',
    slider_high_label: '非常に強い',
    slider_min: 1, slider_max: 10,
  },

  // ───── 実施検査確認 ─────
  // 通常は申込情報 (customer.lab_tests.test_type) から供給され、この設問は提示しない。
  // 申込情報が取れない場合のみフォールバックで提示する (複数検査可＝multi)。
  {
    id: 'EXAM-TYPE', section_id: 'exam', answer_kind: 'wheel', multi: true,
    question: '今回実施いただく／いただいた検査について、当てはまるものを教えてください。',
    wheel_title: '実施する検査を選んでください（複数選択可）',
    wheel_options: opt([T_WELLTECT, T_GENE, T_CANCER, T_BLOOD, T_AIPRED, T_AIPREV]),
  },

  // ───── 検査別の詳細 (EXAM-TYPE で出し分け) ─────

  // 血液検査: 結果 (腹囲/血圧 等) はデメカルから取得するため問診では聴取しない
  //   (旧 EX-WAIST / EX-BP を削除。CLAUDE.md「血液=デメカル取得」)。

  // がんリスク検査: 採取条件・結果は検査機関(PREVENT)側で取得し admin バッチ処理するため
  //   問診では聴取しない (旧 EX-USERID / EX-URINE-DT / EX-URINE-ALC / EX-URINE-MED /
  //   EX-URINE-MED-NAME / EX-ALA-DT / EX-URINATE / EX-URINATE-CNT / EX-FROZEN を削除)。
  //   根拠: CLAUDE.md「がんリスク = Wellfort が検査機関から手動取得 → admin バッチ」。

  // 遺伝子検査 / AI疾病予測 の検査固有設問は、この AI 問診 (Elith 用・生活習慣問診) では
  //   聴取しない。遺伝子検査に必要な家族歴・人種・出生地等の問診は、遺伝子検査の実施時に
  //   別途行う。旧: EX-FAM-CANCER1/2 / EX-FAM-DISEASE / EX-HAIR / EX-FAM-HAIR / EX-NATION /
  //   EX-BIRTH / EX-FATHER / EX-MOTHER / EX-WEIGHT-CHG を削除。

  // ※「個人情報の取り扱いについて同意します」(旧 C-CONSENT) は削除。
  //   参考問診票 (docs/20260331_AI参考問診票.png) / 要件定義書の AI問診=5セクション
  //   (嗜好品・運動・食生活・睡眠・心身) に同意設問は無く、心身(ストレス)で終了する。
  //   同意はアプリ登録/オンボーディングで取得する範疇であり、音声問診の設問ではない。
];

/** 問診票本体 (section_title を補完して Record 化) */
export const QUESTIONS: Record<string, QuestionDef> = Object.fromEntries(
  RAW.map((q) => [q.id, { ...q, section_title: SECTION_TITLE[q.section_id] }]),
);

/** 問診票の定義順 (分岐は when で間引く) */
export const ORDER: string[] = RAW.map((q) => q.id);

/** answers を踏まえて、表示すべき設問 id 列を返す */
export function resolvePath(answers: Answers): string[] {
  return ORDER.filter((id) => {
    const q = QUESTIONS[id];
    return q.when ? q.when(answers) : true;
  });
}

export const FIRST_QUESTION_ID = ORDER[0];

/** 問診エンジン本体 */
export class InterviewEngine {
  private currentId: string | null = null;
  private readonly answers: Map<string, AnswerValue> = new Map();
  /** 申込情報等から供給済で、ユーザーに提示しない設問 id (例 EXAM-TYPE) */
  private readonly seeded: Set<string> = new Set();

  /**
   * 問診を開始する。
   * @param seed 申込情報等から供給する既知回答 (例 `{ 'EXAM-TYPE': [...] }`)。
   *   指定した設問は「値だけ保持し、ユーザーには提示しない」。
   *   空値 (null / 空配列) は無視し、通常どおり設問を提示する (フォールバック)。
   */
  start(seed: Answers = {}): QuestionDef {
    this.answers.clear();
    this.seeded.clear();
    for (const [id, v] of Object.entries(seed)) {
      if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
      this.answers.set(id, v);
      this.seeded.add(id);
    }
    const path = this.visiblePath();
    this.currentId = path[0] ?? FIRST_QUESTION_ID;
    return QUESTIONS[this.currentId];
  }

  /** when 分岐を適用し、さらに seed 済 (提示しない) 設問を除いた提示対象の id 列 */
  private visiblePath(): string[] {
    return resolvePath(this.answersObj()).filter((id) => !this.seeded.has(id));
  }

  current(): QuestionDef | null {
    return this.currentId ? QUESTIONS[this.currentId] ?? null : null;
  }

  private answersObj(): Answers {
    return Object.fromEntries(this.answers);
  }

  /**
   * 現在 Q に回答を記録し、次の Q を返す。
   * isComplete=true なら問診終了 (next は null)。
   */
  recordAndAdvance(answer: AnswerValue): { next: QuestionDef | null; isComplete: boolean } {
    if (!this.currentId) {
      throw new Error('Interview not started — call start() first');
    }
    this.answers.set(this.currentId, answer);
    const path = this.visiblePath();
    const idx = path.indexOf(this.currentId);
    const nextId = idx >= 0 && idx < path.length - 1 ? path[idx + 1] : null;
    if (!nextId || !QUESTIONS[nextId]) {
      this.currentId = null;
      return { next: null, isComplete: true };
    }
    this.currentId = nextId;
    return { next: QUESTIONS[nextId], isComplete: false };
  }

  /** 現在の進捗 (0-100) — 表示中の設問が、表示対象列の何番目かで算出 */
  currentPercent(): number {
    if (!this.currentId) return 100;
    const path = this.visiblePath();
    const idx = path.indexOf(this.currentId);
    if (idx < 0 || path.length <= 1) return 0;
    return Math.round((idx / (path.length - 1)) * 100);
  }

  /** 回答済の設問を { id: value, ... } として返す */
  getAnswers(): Answers {
    return this.answersObj();
  }

  /** セクションが変わったかどうかを判定する補助 */
  static isSectionChanged(prev: QuestionDef | null, next: QuestionDef | null): boolean {
    if (!prev || !next) return false;
    return prev.section_id !== next.section_id;
  }

  reset(): void {
    this.currentId = null;
    this.answers.clear();
    this.seeded.clear();
  }
}

/** 表示用: 回答を人間が読める短い文字列にまとめる */
export function formatAnswerLabel(q: QuestionDef, a: AnswerValue): string {
  if (q.answer_kind === 'multi' || (q.answer_kind === 'wheel' && q.multi)) {
    const arr = Array.isArray(a) ? a : [];
    return arr.length === 0 ? 'なし' : arr.join('、');
  }
  if (q.answer_kind === 'slider') {
    return `${a} / ${q.slider_max ?? 10}`;
  }
  return String(a);
}
