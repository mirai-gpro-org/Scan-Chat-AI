/**
 * AI 問診票 — クライアント駆動エンジン (Phase 1.0)
 *
 * 設計思想:
 *   Live API (LLM) に質問順 / 選択肢 / 分岐を任せると tool calling の
 *   不安定さで「ループ・選択肢欠落・順序乱れ」が頻発する。
 *   そこで問診票本体をクライアント (TypeScript) で完全管理し、
 *   LLM の役割は「ユーザー回答の温かい復唱」「セクション切替の導線発話」
 *   だけに限定する。
 *
 * 流れ:
 *   1) engine.start()                    → 最初の Q (Q1-1)
 *   2) UI が Q を render (chip 等を表示)
 *   3) ユーザーが回答 (タップ or 音声)
 *   4) engine.recordAndAdvance(answer)    → 次の Q (or 完了)
 *   5) LLM に「ユーザー回答 + 次の Q (任意)」を user text で送信
 *      LLM は復唱と導線だけ発話。tool calling 一切不要。
 */

export type SectionId = 'lifestyle' | 'activity' | 'diet' | 'sleep' | 'wellness';

export interface ChoiceOpt {
  label: string;
  emoji?: string;
}

export type AnswerKind = 'chip' | 'multi' | 'slider' | 'stepper' | 'text';

export interface QuestionDef {
  id: string;
  section_id: SectionId;
  section_title: string;
  /** 進捗 0-100 (このQ表示時点) */
  percent: number;
  question: string;
  answer_kind: AnswerKind;
  chips?: ChoiceOpt[];
  multi_options?: ChoiceOpt[];
  multi_title?: string;
  slider_low_label?: string;
  slider_high_label?: string;
  stepper_unit?: string;
  stepper_max?: number;
  /** 任意分岐: 回答 (chip:string, multi:string[], slider/stepper:number, text:string) → 次の Q id */
  next?: (answer: AnswerValue) => string | null;
}

export type AnswerValue = string | string[] | number;

export const SECTIONS: { id: SectionId; title: string }[] = [
  { id: 'lifestyle', title: '嗜好品' },
  { id: 'activity',  title: '運動・活動量' },
  { id: 'diet',      title: '食生活' },
  { id: 'sleep',     title: '睡眠' },
  { id: 'wellness',  title: '心身の健康' },
];

/** 問診票本体 */
export const QUESTIONS: Record<string, QuestionDef> = {
  'Q1-1': {
    id: 'Q1-1', section_id: 'lifestyle', section_title: '嗜好品', percent: 5,
    question: '普段たばこを吸われますか？',
    answer_kind: 'chip',
    chips: [
      { label: '吸わない',         emoji: '🚭' },
      { label: '以前吸っていた',   emoji: '🍃' },
      { label: '吸っている',       emoji: '🚬' },
    ],
  },
  'Q1-2': {
    id: 'Q1-2', section_id: 'lifestyle', section_title: '嗜好品', percent: 10,
    question: 'よく飲むアルコールはありますか？',
    answer_kind: 'multi',
    multi_title: 'よく飲むアルコールをすべて選んでください',
    multi_options: [
      { label: 'ビール',                 emoji: '🍺' },
      { label: '日本酒',                 emoji: '🍶' },
      { label: '焼酎',                   emoji: '🥃' },
      { label: 'ワイン',                 emoji: '🍷' },
      { label: 'ハイボール・チューハイ', emoji: '🍹' },
      { label: 'その他' },
      { label: '飲まない',               emoji: '🚫' },
    ],
    next: (a) => {
      const arr = Array.isArray(a) ? a : [];
      const onlyNone = arr.length === 0 || (arr.length === 1 && arr[0] === '飲まない');
      // 飲まないなら Q1-3 (酒量) をスキップして Q1-4 へ
      return onlyNone ? 'Q1-4' : 'Q1-3';
    },
  },
  'Q1-3': {
    id: 'Q1-3', section_id: 'lifestyle', section_title: '嗜好品', percent: 15,
    question: '1日に飲むお酒の量はどれくらいですか？',
    answer_kind: 'stepper',
    stepper_unit: '杯',
    stepper_max: 10,
  },
  'Q1-4': {
    id: 'Q1-4', section_id: 'lifestyle', section_title: '嗜好品', percent: 18,
    question: 'カフェイン入り飲料はどのくらい摂りますか？',
    answer_kind: 'chip',
    chips: [
      { label: '毎日',           emoji: '☀️' },
      { label: '週に数回',       emoji: '📅' },
      { label: '月に数回',       emoji: '🗓' },
      { label: 'ほとんど摂らない', emoji: '🚫' },
    ],
  },
  'Q2-1': {
    id: 'Q2-1', section_id: 'activity', section_title: '運動・活動量', percent: 23,
    question: '普段、運動をする習慣はありますか？',
    answer_kind: 'chip',
    chips: [
      { label: '週3回以上',     emoji: '🏃' },
      { label: '週1-2回',       emoji: '🚶' },
      { label: 'ほとんどしない', emoji: '🧘' },
    ],
    next: (a) => (a === 'ほとんどしない' ? 'Q2-3' : 'Q2-2'),
  },
  'Q2-2': {
    id: 'Q2-2', section_id: 'activity', section_title: '運動・活動量', percent: 28,
    question: '1回の運動時間はどれくらいですか？',
    answer_kind: 'chip',
    chips: [
      { label: '15分' },
      { label: '30分' },
      { label: '60分' },
      { label: '60分以上', emoji: '💪' },
    ],
  },
  'Q2-3': {
    id: 'Q2-3', section_id: 'activity', section_title: '運動・活動量', percent: 33,
    question: '1日に座っている時間はどれくらいですか？',
    answer_kind: 'chip',
    chips: [
      { label: '4時間以下' },
      { label: '5-8時間' },
      { label: '9-12時間' },
      { label: '13時間以上' },
    ],
  },
  'Q3-1': {
    id: 'Q3-1', section_id: 'diet', section_title: '食生活', percent: 42,
    question: '朝食はどのくらいの頻度で食べますか？',
    answer_kind: 'chip',
    chips: [
      { label: '毎日',             emoji: '☀️' },
      { label: '週4-6回' },
      { label: '週1-3回' },
      { label: 'ほとんど食べない', emoji: '🚫' },
    ],
  },
  'Q3-2': {
    id: 'Q3-2', section_id: 'diet', section_title: '食生活', percent: 46,
    question: '外食はどのくらいの頻度ですか？',
    answer_kind: 'chip',
    chips: [
      { label: '週5回以上' },
      { label: '週2-4回' },
      { label: '週1回' },
      { label: 'ほとんどしない' },
    ],
  },
  'Q3-3': {
    id: 'Q3-3', section_id: 'diet', section_title: '食生活', percent: 50,
    question: '魚をどのくらいの頻度で食べますか？',
    answer_kind: 'chip',
    chips: [
      { label: '週3回以上',         emoji: '🐟' },
      { label: '週1-2回' },
      { label: '月数回' },
      { label: 'ほとんど食べない', emoji: '🚫' },
    ],
  },
  'Q3-4': {
    id: 'Q3-4', section_id: 'diet', section_title: '食生活', percent: 54,
    question: '野菜はしっかり摂れていますか？',
    answer_kind: 'chip',
    chips: [
      { label: '十分',               emoji: '🥗' },
      { label: '普通',               emoji: '🥬' },
      { label: '少ない',             emoji: '🥦' },
      { label: 'ほとんど食べない',   emoji: '🚫' },
    ],
  },
  'Q3-5': {
    id: 'Q3-5', section_id: 'diet', section_title: '食生活', percent: 57,
    question: '食事制限はされていますか？',
    answer_kind: 'chip',
    chips: [
      { label: '特になし',       emoji: '✅' },
      { label: 'ダイエット中',   emoji: '⚖️' },
      { label: 'ヴィーガン',     emoji: '🌱' },
      { label: '糖質制限',       emoji: '🍞' },
      { label: 'その他' },
    ],
  },
  'Q3-6': {
    id: 'Q3-6', section_id: 'diet', section_title: '食生活', percent: 60,
    question: 'サプリメントは摂取していますか？',
    answer_kind: 'chip',
    chips: [
      { label: '摂っていない', emoji: '🚫' },
      { label: '摂っている',   emoji: '💊' },
    ],
  },
  'Q4-1': {
    id: 'Q4-1', section_id: 'sleep', section_title: '睡眠', percent: 68,
    question: '平均的な睡眠時間はどのくらいですか？',
    answer_kind: 'chip',
    chips: [
      { label: '5時間以下', emoji: '😴' },
      { label: '6時間' },
      { label: '7時間' },
      { label: '8時間' },
      { label: '9時間以上', emoji: '💤' },
    ],
  },
  'Q4-2': {
    id: 'Q4-2', section_id: 'sleep', section_title: '睡眠', percent: 76,
    question: '睡眠の悩みはありますか？',
    answer_kind: 'multi',
    multi_title: '当てはまるものをすべて選んでください',
    multi_options: [
      { label: '寝つきが悪い',                   emoji: '😣' },
      { label: '夜中に目が覚める',               emoji: '🌙' },
      { label: '朝早く目覚める',                 emoji: '🌅' },
      { label: 'いびき・無呼吸を指摘された',     emoji: '😪' },
      { label: '特になし',                       emoji: '✅' },
    ],
  },
  'Q5-1': {
    id: 'Q5-1', section_id: 'wellness', section_title: '心身の健康', percent: 88,
    question: '気になる症状はありますか？',
    answer_kind: 'multi',
    multi_title: '当てはまるものをすべて選んでください',
    multi_options: [
      { label: '頭痛',           emoji: '🤕' },
      { label: '肩こり',         emoji: '😣' },
      { label: '腰痛',           emoji: '🦴' },
      { label: '関節痛',         emoji: '🦵' },
      { label: '冷え性',         emoji: '🥶' },
      { label: '倦怠感',         emoji: '😪' },
      { label: '消化不良',       emoji: '😖' },
      { label: '便秘・下痢',     emoji: '🚽' },
      { label: 'その他' },
      { label: '特になし',       emoji: '✅' },
    ],
  },
  'Q5-2': {
    id: 'Q5-2', section_id: 'wellness', section_title: '心身の健康', percent: 95,
    question: 'ストレス度はどれくらいですか？(1〜10)',
    answer_kind: 'slider',
    slider_low_label: '全くない',
    slider_high_label: '非常に高い',
  },
};

/** デフォルトの問診順 */
export const SEQUENCE: string[] = [
  'Q1-1', 'Q1-2', 'Q1-3', 'Q1-4',
  'Q2-1', 'Q2-2', 'Q2-3',
  'Q3-1', 'Q3-2', 'Q3-3', 'Q3-4', 'Q3-5', 'Q3-6',
  'Q4-1', 'Q4-2',
  'Q5-1', 'Q5-2',
];

export const FIRST_QUESTION_ID = 'Q1-1';

/** 標準的な次の Q id を返す。分岐がある Q は QuestionDef.next を使う。 */
export function defaultNextId(currentId: string): string | null {
  const idx = SEQUENCE.indexOf(currentId);
  if (idx < 0 || idx >= SEQUENCE.length - 1) return null;
  return SEQUENCE[idx + 1];
}

/** 問診エンジン本体 */
export class InterviewEngine {
  private currentId: string | null = null;
  private readonly answers: Map<string, AnswerValue> = new Map();

  start(): QuestionDef {
    this.currentId = FIRST_QUESTION_ID;
    this.answers.clear();
    return QUESTIONS[FIRST_QUESTION_ID];
  }

  current(): QuestionDef | null {
    return this.currentId ? QUESTIONS[this.currentId] ?? null : null;
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
    const q = QUESTIONS[this.currentId];
    const nextId = q.next ? q.next(answer) : defaultNextId(this.currentId);
    if (!nextId || !QUESTIONS[nextId]) {
      this.currentId = null;
      return { next: null, isComplete: true };
    }
    this.currentId = nextId;
    return { next: QUESTIONS[nextId], isComplete: false };
  }

  /** 回答済の Q1-1〜 を { Q1-1: ..., Q1-2: [...], ... } として返す */
  getAnswers(): Record<string, AnswerValue> {
    return Object.fromEntries(this.answers);
  }

  /** 問診票全体のセクションが変わったかどうかを判定する補助 */
  static isSectionChanged(prev: QuestionDef | null, next: QuestionDef | null): boolean {
    if (!prev || !next) return false;
    return prev.section_id !== next.section_id;
  }

  reset(): void {
    this.currentId = null;
    this.answers.clear();
  }
}

/** 表示用: 回答を人間が読める短い文字列にまとめる */
export function formatAnswerLabel(q: QuestionDef, a: AnswerValue): string {
  if (q.answer_kind === 'multi') {
    const arr = Array.isArray(a) ? a : [];
    return arr.length === 0 ? 'なし' : arr.join('、');
  }
  if (q.answer_kind === 'slider') {
    return `${a} / 10`;
  }
  if (q.answer_kind === 'stepper') {
    return `${a}${q.stepper_unit ?? ''}`;
  }
  return String(a);
}
