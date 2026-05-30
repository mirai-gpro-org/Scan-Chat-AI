/**
 * AI 問診（Live API）コントローラ。
 *
 * UI:
 *   - 音声 / テキスト切替トグル
 *   - LLM が present_question ツールで質問種別を宣言 → 動的に widget を切替
 *     ( chip / multi / slider / stepper / text )
 *   - 補助テキスト入力（音声モードでも常時利用可）
 *   - ストリーミング transcript で AI/ユーザー発話をライブ表示
 */

import {
  GoogleGenAI,
  Modality,
  Type,
  type Session,
  type LiveServerMessage,
  type ToolListUnion,
} from '@google/genai';
import { marked } from 'marked';
import { LiveAudioManager } from './live-audio-manager';
import {
  clearChatSession,
  createEmptySession,
  loadChatSession,
  saveChatSession,
  type ChatMessage,
  type ChatSession,
} from '../../lib/session-store';

export interface LiveRefs {
  log: HTMLElement;
  status: HTMLElement;
  resetBtn: HTMLButtonElement;
  resumeBanner: HTMLElement | null;

  progressText: HTMLElement;
  sectionLabel: HTMLElement;
  sectionDots: HTMLElement[];

  modeToggle: HTMLElement;
  micBtn: HTMLButtonElement;
  startBtn: HTMLButtonElement;
  speakerBtn: HTMLButtonElement;

  startHero: HTMLElement;
  qaArea: HTMLElement;
  dualHint: HTMLElement;
  answerPanel: HTMLElement;
  questionText: HTMLElement;

  uiVoice: HTMLElement;
  uiChip: HTMLElement;
  uiMulti: HTMLElement;
  uiSlider: HTMLElement;
  uiStepper: HTMLElement;
  uiText: HTMLElement;

  sliderInput: HTMLInputElement;
  sliderValue: HTMLElement;
  sliderLow: HTMLElement;
  sliderHigh: HTMLElement;
  sliderSubmit: HTMLButtonElement;

  stepperValue: HTMLElement;
  stepperUnit: HTMLElement;
  stepperMinus: HTMLButtonElement;
  stepperPlus: HTMLButtonElement;
  stepperSubmit: HTMLButtonElement;

  textInput: HTMLTextAreaElement;
  textSubmit: HTMLButtonElement;

  multiOpen: HTMLButtonElement;
  multiSummary: HTMLElement;
  multiModal: HTMLElement;
  multiOptions: HTMLElement;
  multiTitle: HTMLElement;
  multiConfirm: HTMLButtonElement;

  fallbackZone: HTMLElement;
  fallbackInput: HTMLTextAreaElement;
  fallbackSend: HTMLButtonElement;

  skipBtn: HTMLButtonElement;

  /**
   * 任意。指定すると `/api/live-token` POST body に乗り、サーバが当該ユーザーの
   * 検査文脈を返す。返って来た文脈は system instruction の先頭に prepend される。
   * dev profile では URL `?u=<uuid>` を流用、本番では Auth 連携に置換予定。
   */
  diagnosticUserId?: string | null;
}

const SESSION_ID = 'default';

// 健康アドバイス用 問診票 (docs/20260331_AI参考問診票.png) 準拠の 5 セクション
const SECTIONS = [
  { id: 'lifestyle', title: '嗜好品' },        // 喫煙・飲酒・カフェイン
  { id: 'activity',  title: '運動・活動量' },
  { id: 'diet',      title: '食生活' },
  { id: 'sleep',     title: '睡眠' },
  { id: 'wellness',  title: '心身の健康' },
];

const SYSTEM_INSTRUCTION = `あなたは健康問診の AI 看護師です。

【絶対ルール — 違反禁止】
A. 質問を発話する**全てのターン**で、必ず present_question を呼ぶ。呼ばずに質問だけ発話するのは禁止。
B. ツール構造（"call:", "present_question", "{", "}", "section_id" 等）を音声に絶対に含めない。発話は自然な日本語のみ。
C. 1 ターン = 1 質問。質問を統合・省略しない（例: 食事制限とサプリを一緒に聞かない）。
D. 診断・処方はしない。

【タップ回答への音声復唱】
タップで答えが届いたら、まず短く復唱:
- chip 単一: 「『◯◯』ですね。」
- multi 複数: 「『◯◯』と『◯◯』ですね。」
- stepper が 0: 「飲まないんですね」「ないんですね」 / 1 以上: 「◯◯本ですね」など単位付きで
- slider: 「◯◯点ですね。」
- text: 「『◯◯』ですね、ありがとうございます。」
復唱は 1 文だけ。続けて次の質問を発話し、必ず present_question を呼ぶ。

【質問順】各 Q◯-◯ は独立した 1 ターン。統合厳禁。

▽ 1. 嗜好品 (lifestyle, 0-18%)
  Q1-1 喫煙 [chip]: 吸わない🚭 / 以前吸っていた🍃 / 吸っている🚬
  Q1-2 よく飲むアルコール [multi]: ビール🍺 / 日本酒🍶 / 焼酎🥃 / ワイン🍷 / ハイボール・チューハイ🍹 / その他 / 飲まない🚫
    分岐: 「飲まない」or 空 → Q1-3 全スキップして Q1-4 へ / それ以外 → 選ばれた酒類だけ Q1-3 でループ。選ばれていない酒類は聞かない。
  Q1-3 各酒類1日量 [stepper]: 単位=ビール:缶/日本酒:合/他:杯, max=10
  Q1-4 カフェイン [chip]: 毎日☀️ / 週に数回📅 / 月に数回🗓 / ほとんど摂らない🚫

▽ 2. 運動・活動量 (activity, 20-35%)
  Q2-1 運動習慣 [chip]: 週3回以上🏃 / 週1-2回🚶 / ほとんどしない🧘
    分岐: 「ほとんどしない」→ Q2-2 をスキップして Q2-3 へ進む (運動していない人に時間を聞かない)
  Q2-2 運動時間 [chip] (Q2-1 が「週3回以上」or「週1-2回」の時のみ): 15分 / 30分 / 60分 / 60分以上💪
  Q2-3 座っている時間 [chip]: 4時間以下 / 5-8時間 / 9-12時間 / 13時間以上

▽ 3. 食生活 (diet, 40-60%)
  Q3-1 朝食 [chip]: 毎日☀️ / 週4-6回 / 週1-3回 / ほとんど食べない🚫
  Q3-2 外食 [chip]: 週5回以上 / 週2-4回 / 週1回 / ほとんどしない
  Q3-3 魚 [chip]: 週3回以上🐟 / 週1-2回 / 月数回 / ほとんど食べない🚫
  ★ Q3-4 野菜量 [chip] — 必ず chip UI で表示: 十分🥗 / 普通🥬 / 少ない🥦 / ほとんど食べない🚫
  ★ Q3-5 食事制限 [chip] — Q3-6 と統合せず単独で: 特になし✅ / ダイエット中⚖️ / ヴィーガン🌱 / 糖質制限🍞 / その他
    分岐: 「その他」 → 次ターンで [text] 内容入力
  ★ Q3-6 サプリメント [chip] — Q3-5 とは別ターンで: 摂っていない🚫 / 摂っている💊
    分岐: 「摂っている」 → 次ターンで [text] 種類入力

▽ 4. 睡眠 (sleep, 65-80%)
  ★ Q4-1 平均睡眠時間 [chip] — 必ず chip UI で: 5時間以下😴 / 6時間 / 7時間 / 8時間 / 9時間以上💤
  ★ Q4-2 睡眠の悩み [multi] — Q4-1 と統合せず別ターンで: 寝つきが悪い😣 / 夜中に目が覚める🌙 / 朝早く目覚める🌅 / いびき・無呼吸を指摘された😪 / 特になし✅

▽ 5. 心身の健康 (wellness, 85-100%)
  Q5-1 気になる症状 [multi]: 頭痛🤕 / 肩こり😣 / 腰痛🦴 / 関節痛🦵 / 冷え性🥶 / 倦怠感😪 / 消化不良😖 / 便秘・下痢🚽 / その他 / 特になし✅
  Q5-2 ストレス度 [slider] 1-10: 低=全くない, 高=非常に高い

【発話スタイル】
- 温かみのある優しい口調、簡潔に。
- ユーザーの質問・雑談には短く答え、すぐ問診に戻る（present_question を呼んで）。
- 「わからない/答えたくない/スキップ」は尊重し、次の質問へ。

【セッション開始時 — このターンは 1 回限り】
最初の発話 (1 ターンだけ、絶対に繰り返さない):
  「こんにちは、ウェルフォートの AI 問診です。まずは喫煙について — 普段たばこを吸われますか？」
同時に Q1-1 を present_question で呼ぶ。
2 ターン目以降は挨拶を**絶対に**繰り返さず、Q1-1 のユーザー回答に応じて Q1-2 へ進む。
同時に Q1-1 を呼ぶ。

【完了時】Q5-2 終了で complete_interview を呼び、優しくお礼を言う。
【緊急対応】胸痛/呼吸困難/意識消失/激しい頭痛/大量出血等 → 即 flag_emergency を呼び 119 を案内。`;

const TOOLS: ToolListUnion = [
  {
    functionDeclarations: [
      {
        name: 'present_question',
        description: '次の質問と、それに対する回答 UI を表示する',
        parameters: {
          type: Type.OBJECT,
          properties: {
            section_id: { type: Type.STRING },
            section_title: { type: Type.STRING },
            percent: { type: Type.NUMBER, description: '0-100 の全体進捗' },
            question: { type: Type.STRING, description: '画面に表示する質問文' },
            answer_kind: {
              type: Type.STRING,
              description: 'chip | multi | slider | stepper | text',
            },
            chips: {
              type: Type.ARRAY,
              description: '単一選択肢（answer_kind=chip 時）',
              items: {
                type: Type.OBJECT,
                properties: {
                  label: { type: Type.STRING },
                  emoji: { type: Type.STRING },
                },
              },
            },
            multi_options: {
              type: Type.ARRAY,
              description: '複数選択肢（answer_kind=multi 時）',
              items: {
                type: Type.OBJECT,
                properties: {
                  label: { type: Type.STRING },
                  emoji: { type: Type.STRING },
                },
              },
            },
            multi_title: {
              type: Type.STRING,
              description: 'モーダルのタイトル（answer_kind=multi 時）',
            },
            slider_low_label: { type: Type.STRING },
            slider_high_label: { type: Type.STRING },
            stepper_unit: { type: Type.STRING },
            stepper_max: { type: Type.NUMBER },
            allow_skip: { type: Type.BOOLEAN },
          },
          required: ['section_id', 'section_title', 'percent', 'question', 'answer_kind'],
        },
      },
      {
        name: 'complete_interview',
        description: '全ての問診が完了した時に呼ぶ',
        parameters: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
          },
        },
      },
      {
        name: 'flag_emergency',
        description: '緊急対応が必要な所見を検知した時に呼ぶ',
        parameters: {
          type: Type.OBJECT,
          properties: { reason: { type: Type.STRING } },
          required: ['reason'],
        },
      },
    ],
  },
];

interface ChoiceOption {
  label: string;
  emoji?: string;
}

interface PresentArgs {
  section_id?: string;
  section_title?: string;
  percent?: number;
  question?: string;
  answer_kind?: string;
  chips?: ChoiceOption[];
  multi_options?: ChoiceOption[];
  multi_title?: string;
  slider_low_label?: string;
  slider_high_label?: string;
  stepper_unit?: string;
  stepper_max?: number;
  allow_skip?: boolean;
}

/**
 * Live API (音声 + tool 並行) は時々 present_question を呼び忘れる。
 * AI の発話文に既知の Q キーワードを含む場合、選択肢を逆引きして自動表示する。
 * 順序は重要 — より具体的なパターンを先に。
 */
const FALLBACK_QUESTIONS: Array<{ pattern: RegExp; args: PresentArgs }> = [
  // Q1-1 喫煙
  { pattern: /(たばこ|煙草|喫煙)/, args: {
    section_id: 'lifestyle', section_title: '嗜好品', percent: 5,
    question: '普段たばこを吸われますか？',
    answer_kind: 'chip',
    chips: [
      { label: '吸わない', emoji: '🚭' },
      { label: '以前吸っていた', emoji: '🍃' },
      { label: '吸っている', emoji: '🚬' },
    ],
  }},
  // Q1-4 カフェイン (より具体的に)
  { pattern: /(カフェイン|コーヒー)/, args: {
    section_id: 'lifestyle', section_title: '嗜好品', percent: 18,
    question: 'カフェイン入り飲料はどのくらい摂りますか？',
    answer_kind: 'chip',
    chips: [
      { label: '毎日', emoji: '☀️' },
      { label: '週に数回', emoji: '📅' },
      { label: '月に数回', emoji: '🗓' },
      { label: 'ほとんど摂らない', emoji: '🚫' },
    ],
  }},
  // Q1-2 アルコール
  { pattern: /(アルコール|お酒|飲酒|よく飲む)/, args: {
    section_id: 'lifestyle', section_title: '嗜好品', percent: 10,
    question: 'よく飲むアルコールを教えてください',
    answer_kind: 'multi',
    multi_title: 'よく飲むアルコールをすべて選んでください',
    multi_options: [
      { label: 'ビール', emoji: '🍺' },
      { label: '日本酒', emoji: '🍶' },
      { label: '焼酎', emoji: '🥃' },
      { label: 'ワイン', emoji: '🍷' },
      { label: 'ハイボール・チューハイ', emoji: '🍹' },
      { label: 'その他' },
      { label: '飲まない', emoji: '🚫' },
    ],
  }},
  // Q2-3 座っている時間
  { pattern: /(座って|座る|デスク).*(時間|どれくらい|どのくらい)/, args: {
    section_id: 'activity', section_title: '運動・活動量', percent: 33,
    question: '1日に座っている時間はどれくらいですか？',
    answer_kind: 'chip',
    chips: [
      { label: '4時間以下' },
      { label: '5-8時間' },
      { label: '9-12時間' },
      { label: '13時間以上' },
    ],
  }},
  // Q2-2 運動時間 (Q2-1 で「ほとんどしない」を選んだ場合はそもそも到達しない)
  { pattern: /(1回|一回|運動).*(時間|何分|長さ|分)/, args: {
    section_id: 'activity', section_title: '運動・活動量', percent: 28,
    question: '1回の運動時間はどれくらいですか？',
    answer_kind: 'chip',
    chips: [
      { label: '15分' },
      { label: '30分' },
      { label: '60分' },
      { label: '60分以上', emoji: '💪' },
    ],
  }},
  // Q2-1 運動習慣
  { pattern: /運動/, args: {
    section_id: 'activity', section_title: '運動・活動量', percent: 23,
    question: '普段、運動をする習慣はありますか？',
    answer_kind: 'chip',
    chips: [
      { label: '週3回以上', emoji: '🏃' },
      { label: '週1-2回', emoji: '🚶' },
      { label: 'ほとんどしない', emoji: '🧘' },
    ],
  }},
  // Q3-1 朝食
  { pattern: /朝食|朝.*食/, args: {
    section_id: 'diet', section_title: '食生活', percent: 42,
    question: '朝食はどのくらいの頻度で食べますか？',
    answer_kind: 'chip',
    chips: [
      { label: '毎日', emoji: '☀️' },
      { label: '週4-6回' },
      { label: '週1-3回' },
      { label: 'ほとんど食べない', emoji: '🚫' },
    ],
  }},
  // Q3-2 外食
  { pattern: /外食/, args: {
    section_id: 'diet', section_title: '食生活', percent: 46,
    question: '外食はどのくらいの頻度ですか？',
    answer_kind: 'chip',
    chips: [
      { label: '週5回以上' },
      { label: '週2-4回' },
      { label: '週1回' },
      { label: 'ほとんどしない' },
    ],
  }},
  // Q3-3 魚
  { pattern: /(魚|魚介)/, args: {
    section_id: 'diet', section_title: '食生活', percent: 50,
    question: '魚をどのくらいの頻度で食べますか？',
    answer_kind: 'chip',
    chips: [
      { label: '週3回以上', emoji: '🐟' },
      { label: '週1-2回' },
      { label: '月数回' },
      { label: 'ほとんど食べない', emoji: '🚫' },
    ],
  }},
  // Q3-4 野菜
  { pattern: /野菜/, args: {
    section_id: 'diet', section_title: '食生活', percent: 54,
    question: '野菜は十分に取れていますか？',
    answer_kind: 'chip',
    chips: [
      { label: '十分', emoji: '🥗' },
      { label: '普通', emoji: '🥬' },
      { label: '少ない', emoji: '🥦' },
      { label: 'ほとんど食べない', emoji: '🚫' },
    ],
  }},
  // Q3-5 食事制限
  { pattern: /(食事制限|ダイエット|ヴィーガン|糖質制限)/, args: {
    section_id: 'diet', section_title: '食生活', percent: 57,
    question: '食事制限はされていますか？',
    answer_kind: 'chip',
    chips: [
      { label: '特になし', emoji: '✅' },
      { label: 'ダイエット中', emoji: '⚖️' },
      { label: 'ヴィーガン', emoji: '🌱' },
      { label: '糖質制限', emoji: '🍞' },
      { label: 'その他' },
    ],
  }},
  // Q3-6 サプリ
  { pattern: /サプリ/, args: {
    section_id: 'diet', section_title: '食生活', percent: 60,
    question: 'サプリメントは摂取していますか？',
    answer_kind: 'chip',
    chips: [
      { label: '摂っていない', emoji: '🚫' },
      { label: '摂っている', emoji: '💊' },
    ],
  }},
  // Q4-1 睡眠時間
  { pattern: /(睡眠時間|何時間.*(寝|睡眠)|平均.*睡眠)/, args: {
    section_id: 'sleep', section_title: '睡眠', percent: 68,
    question: '平均的な睡眠時間はどのくらいですか？',
    answer_kind: 'chip',
    chips: [
      { label: '5時間以下', emoji: '😴' },
      { label: '6時間' },
      { label: '7時間' },
      { label: '8時間' },
      { label: '9時間以上', emoji: '💤' },
    ],
  }},
  // Q4-2 睡眠悩み
  { pattern: /(寝つき|無呼吸|いびき|夜中.*目|睡眠.*悩|睡眠.*問題)/, args: {
    section_id: 'sleep', section_title: '睡眠', percent: 76,
    question: '睡眠の悩みはありますか？',
    answer_kind: 'multi',
    multi_title: '当てはまるものをすべて選んでください',
    multi_options: [
      { label: '寝つきが悪い', emoji: '😣' },
      { label: '夜中に目が覚める', emoji: '🌙' },
      { label: '朝早く目覚める', emoji: '🌅' },
      { label: 'いびき・無呼吸を指摘された', emoji: '😪' },
      { label: '特になし', emoji: '✅' },
    ],
  }},
  // Q5-2 ストレス (slider 表現を先に判定)
  { pattern: /ストレス/, args: {
    section_id: 'wellness', section_title: '心身の健康', percent: 95,
    question: 'ストレス度はどれくらいですか？(1〜10)',
    answer_kind: 'slider',
    slider_low_label: '全くない',
    slider_high_label: '非常に高い',
  }},
  // Q5-1 症状
  { pattern: /(症状|気になる|頭痛|肩こり|腰痛|関節痛)/, args: {
    section_id: 'wellness', section_title: '心身の健康', percent: 88,
    question: '気になる症状はありますか？',
    answer_kind: 'multi',
    multi_title: '当てはまるものをすべて選んでください',
    multi_options: [
      { label: '頭痛', emoji: '🤕' },
      { label: '肩こり', emoji: '😣' },
      { label: '腰痛', emoji: '🦴' },
      { label: '関節痛', emoji: '🦵' },
      { label: '冷え性', emoji: '🥶' },
      { label: '倦怠感', emoji: '😪' },
      { label: '消化不良', emoji: '😖' },
      { label: '便秘・下痢', emoji: '🚽' },
      { label: 'その他' },
      { label: '特になし', emoji: '✅' },
    ],
  }},
];

function matchFallbackQuestion(text: string): PresentArgs | null {
  // 復唱や前置き ("『毎日』ですね。次に運動について...") が混ざると
  // 古い質問のキーワードに誤マッチするため、必ず最後の疑問文だけを対象にする。
  const target = extractLastQuestion(text);
  for (const fb of FALLBACK_QUESTIONS) {
    if (fb.pattern.test(target)) return fb.args;
  }
  return null;
}

/** AI 発話全体から「?」「？」で終わる最後の文だけ取り出す。 */
function extractLastQuestion(text: string): string {
  const matches = text.match(/[^。.!?？\n]+[?？]/g);
  if (!matches || matches.length === 0) return text.slice(-80);
  return matches[matches.length - 1];
}

export async function initLiveController(refs: LiveRefs): Promise<void> {
  let session: ChatSession = loadChatSession(SESSION_ID) ?? createEmptySession(SESSION_ID);
  const audio = new LiveAudioManager();
  let liveSession: Session | null = null;
  let connecting = false;

  // ライブストリーミング transcript 用の DOM/buffer
  let assistantStreamBubble: HTMLElement | null = null;
  let userStreamBubble: HTMLElement | null = null;
  let assistantBuf = '';
  let userBuf = '';

  let mode: 'voice' | 'text' = 'voice';
  let currentPresent: PresentArgs | null = null;
  let muted = false;
  let presentQuestionCalledThisTurn = false;

  if (session.messages.length > 0 && refs.resumeBanner) {
    refs.resumeBanner.hidden = false;
  }
  renderHistory();
  setConnected(false);
  applyModeUI();
  refs.fallbackZone.hidden = false; // 補助テキスト入力は常時表示

  // ── イベント結線 ──────────────────────────────────

  refs.resetBtn.addEventListener('click', () => {
    if (!confirm('問診をリセットしますか？（履歴が削除されます）')) return;
    stopLive();
    clearChatSession(SESSION_ID);
    session = createEmptySession(SESSION_ID);
    currentPresent = null;
    refs.resumeBanner && (refs.resumeBanner.hidden = true);
    renderHistory();
    renderProgress(0, '準備中…');
    renderSectionDots(-1);
    refs.questionText.textContent = '…';
    showWidget('voice');
    setConnected(false);
  });

  // 開始: 大型 hero ボタン
  refs.startBtn.addEventListener('click', () => toggleSession());
  // 中断: コンパクト top-right ボタン
  refs.micBtn.addEventListener('click', () => toggleSession());

  // スピーカー ON/OFF（AI の音声出力のみ。テキスト/UI は影響なし）
  refs.speakerBtn.addEventListener('click', () => {
    muted = !muted;
    refs.speakerBtn.classList.toggle('muted', muted);
    refs.speakerBtn.setAttribute('aria-label', muted ? '音声 OFF（クリックでON）' : '音声 ON（クリックでOFF）');
    if (muted) {
      // 再生途中の音声を即座に止める
      audio.flushPlayback();
    }
  });

  async function toggleSession(): Promise<void> {
    if (liveSession) {
      stopLive();
      return;
    }
    if (connecting) return;
    connecting = true;
    setStatus('接続中…');
    refs.startBtn.disabled = true;
    refs.micBtn.disabled = true;
    try {
      await startLive();
    } catch (err) {
      setStatus(`接続失敗: ${describeErr(err)}`);
      appendMessage({ role: 'system', text: `接続失敗: ${describeErr(err)}`, ts: Date.now() });
      stopLive();
    } finally {
      connecting = false;
      refs.startBtn.disabled = false;
      refs.micBtn.disabled = false;
    }
  }

  refs.modeToggle.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const pill = target.closest<HTMLElement>('[data-mode]');
    if (!pill) return;
    const next = pill.dataset.mode as 'voice' | 'text';
    if (next === mode) return;
    mode = next;
    applyModeUI();
  });

  // chip 選択
  refs.uiChip.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-chip]');
    if (!btn) return;
    const label = btn.dataset.chip ?? '';
    // フラッシュ視覚フィードバック
    btn.classList.add('flash', 'selected');
    submitAnswer(label);
  });

  // multi モーダル
  refs.multiOpen.addEventListener('click', () => openMultiModal());
  refs.multiModal.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-close-modal]')) closeMultiModal();
  });
  refs.multiConfirm.addEventListener('click', () => {
    const checked = refs.multiOptions.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked');
    const labels = Array.from(checked).map((c) => c.value);
    closeMultiModal();
    if (labels.length === 0) {
      submitAnswer('特になし');
    } else {
      refs.multiSummary.textContent = `選択: ${labels.join('、')}`;
      submitAnswer(labels.join('、'));
    }
  });

  // slider
  refs.sliderInput.addEventListener('input', () => {
    refs.sliderValue.textContent = refs.sliderInput.value;
  });
  refs.sliderSubmit.addEventListener('click', () => {
    submitAnswer(`${refs.sliderInput.value} / 10`);
  });

  // stepper
  refs.stepperMinus.addEventListener('click', () => stepStep(-1));
  refs.stepperPlus.addEventListener('click', () => stepStep(+1));
  refs.stepperSubmit.addEventListener('click', () => {
    const unit = refs.stepperUnit.textContent ?? '';
    submitAnswer(`${refs.stepperValue.textContent}${unit}`);
  });

  // free text
  refs.textSubmit.addEventListener('click', () => {
    const t = refs.textInput.value.trim();
    if (!t) return;
    refs.textInput.value = '';
    submitAnswer(t);
  });
  refs.textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      refs.textSubmit.click();
    }
  });

  // fallback (常時併設) — 自由入力、質問にしばられず会話可能
  refs.fallbackSend.addEventListener('click', () => sendFallback());
  refs.fallbackInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendFallback();
    }
  });

  // skip
  refs.skipBtn.addEventListener('click', () => submitAnswer('スキップします'));

  // ── ヘルパ ──────────────────────────────────────

  function setStatus(text: string): void {
    refs.status.textContent = text;
  }

  function setConnected(state: boolean): void {
    refs.startHero.hidden = state;
    refs.qaArea.hidden = !state;
    if (state) {
      refs.micBtn.classList.add('active');
      const lbl = refs.micBtn.querySelector('.mic-label') as HTMLElement | null;
      const icn = refs.micBtn.querySelector('.mic-icon') as HTMLElement | null;
      if (lbl) lbl.textContent = '中断';
      if (icn) icn.textContent = '⏸';
      refs.micBtn.setAttribute('aria-label', '問診を中断');
    } else {
      refs.micBtn.classList.remove('active');
      const lbl = refs.micBtn.querySelector('.mic-label') as HTMLElement | null;
      const icn = refs.micBtn.querySelector('.mic-icon') as HTMLElement | null;
      if (lbl) lbl.textContent = '中断';
      if (icn) icn.textContent = '⏸';
    }
  }

  function applyModeUI(): void {
    refs.modeToggle.querySelectorAll<HTMLElement>('[data-mode]').forEach((p) => {
      p.classList.toggle('on', p.dataset.mode === mode);
      p.setAttribute('aria-selected', String(p.dataset.mode === mode));
    });
    if (currentPresent) {
      showWidget(mapKind(currentPresent.answer_kind));
    } else {
      // 質問待機中: モードに応じたプレースホルダ
      if (mode === 'voice') {
        showWidget('voice');
      } else {
        showWidget('text');
        refs.textInput.placeholder = '右上の🎙開始を押すか、ここに入力して開始してください';
      }
    }
  }

  function mapKind(k?: string): WidgetKey {
    switch (k) {
      case 'chip': return 'chip';
      case 'multi': return 'multi';
      case 'slider': return 'slider';
      case 'stepper': return 'stepper';
      case 'text': return 'text';
      default: return 'voice';
    }
  }

  type WidgetKey = 'voice' | 'chip' | 'multi' | 'slider' | 'stepper' | 'text';

  function showWidget(key: WidgetKey): void {
    const map: Record<WidgetKey, HTMLElement> = {
      voice: refs.uiVoice,
      chip: refs.uiChip,
      multi: refs.uiMulti,
      slider: refs.uiSlider,
      stepper: refs.uiStepper,
      text: refs.uiText,
    };
    for (const [k, el] of Object.entries(map)) {
      el.hidden = k !== key;
    }
    // 自由記述 widget が出ているときは補助テキスト入力を非表示（重複防止）
    refs.fallbackZone.hidden = key === 'text';
    // 「音声でも・タップでも」ヒント: chip/multi/slider/stepper の時に表示
    refs.dualHint.hidden = !(key === 'chip' || key === 'multi' || key === 'slider' || key === 'stepper');
  }

  function stepStep(delta: number): void {
    const cur = parseInt(refs.stepperValue.textContent ?? '0', 10) || 0;
    const max = parseInt(refs.stepperValue.dataset.max ?? '99', 10);
    const next = Math.max(0, Math.min(max, cur + delta));
    refs.stepperValue.textContent = String(next);
  }

  function openMultiModal(): void {
    refs.multiModal.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeMultiModal(): void {
    refs.multiModal.hidden = true;
    document.body.style.overflow = '';
  }

  function submitAnswer(text: string): void {
    if (!text) return;
    appendMessage({ role: 'user', text, ts: Date.now() });
    sendToModel(text);
    // 回答送ったら voice/loading 表示に戻す（次の present_question を待つ）
    refs.questionText.textContent = '…';
    showWidget('voice');
    refs.skipBtn.hidden = true;
    currentPresent = null;
    presentQuestionCalledThisTurn = false;
  }

  function sendFallback(): void {
    const t = refs.fallbackInput.value.trim();
    if (!t) return;
    refs.fallbackInput.value = '';
    appendMessage({ role: 'user', text: t, ts: Date.now() });
    sendToModel(t);
    presentQuestionCalledThisTurn = false;
  }

  // AI が tool 呼び忘れで質問だけしてきた時のヒント表示
  function flashFallback(): void {
    refs.fallbackZone.hidden = false;
    refs.fallbackInput.placeholder = 'AI の質問にお答えください（音声でもOK）';
    refs.fallbackInput.classList.add('ring-2', 'ring-amber-400', 'border-amber-400');
    refs.fallbackInput.focus();
    setTimeout(() => {
      refs.fallbackInput.classList.remove('ring-2', 'ring-amber-400', 'border-amber-400');
    }, 2400);
  }

  function sendToModel(text: string): void {
    if (!liveSession) {
      appendMessage({
        role: 'system',
        text: 'まず🎙ボタンで問診セッションを開始してください。',
        ts: Date.now(),
      });
      return;
    }
    liveSession.sendRealtimeInput({ text });
  }

  // ── Live API 接続 ──────────────────────────────

  async function startLive(): Promise<void> {
    const res = await fetch('/api/live-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ diagnosticUserId: refs.diagnosticUserId ?? null }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`token mint ${res.status}: ${body}`);
    }
    const { token, model, userContext } = (await res.json()) as {
      token: string;
      model: string;
      userContext?: string | null;
    };

    // NOTE: userContext 注入は AI ループの原因となったため一時 OFF。
    // 後で再有効化する場合は連結ロジックを再設計する。
    void userContext;
    const instruction = SYSTEM_INSTRUCTION;

    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });
    liveSession = await ai.live.connect({
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: { parts: [{ text: instruction }] },
        speechConfig: { languageCode: 'ja-JP' },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        tools: TOOLS,
      },
      callbacks: {
        onopen: () => {
          setStatus('🎙 接続済 — 話せます / タップ可');
          setConnected(true);
          // セッション開始直後に AI を kickoff（ユーザーには見せない）。
          // 公式ガイドに従い "discrete な初回入力" は sendClientContent({turnComplete:true})
          // で投げる。sendRealtimeInput はストリーミング向けで turn 完結が曖昧になり、
          // モデルが挨拶を繰り返す原因になり得る。
          setTimeout(() => {
            try {
              liveSession?.sendClientContent({
                turns: [{ role: 'user', parts: [{ text: '問診を始めてください。挨拶は短く 1 回だけにして、すぐに Q1-1 (喫煙) を present_question で呼んでください。' }] }],
                turnComplete: true,
              });
            } catch {}
          }, 250);
        },
        onmessage: (msg) => handleServerMessage(msg),
        onerror: (e) => {
          const m = (e as { message?: string })?.message ?? String(e);
          setStatus(`エラー: ${m}`);
          appendMessage({ role: 'system', text: `サーバエラー: ${m}`, ts: Date.now() });
        },
        onclose: (e) => {
          const reason = (e as { reason?: string })?.reason;
          setStatus(reason ? `切断: ${reason}` : '切断');
          liveSession = null;
          setConnected(false);
        },
      },
    });

    await audio.start((b64) => {
      if (!liveSession) return;
      liveSession.sendRealtimeInput({
        audio: { data: b64, mimeType: 'audio/pcm;rate=16000' },
      });
    });
  }

  function stopLive(): void {
    audio.stop();
    try { liveSession?.close(); } catch {}
    liveSession = null;
    setConnected(false);
    setStatus('停止');
  }

  // ── サーバメッセージ ────────────────────────────

  function handleServerMessage(msg: LiveServerMessage): void {
    // 1) PCM 音声 chunk → 再生（muted 中はスキップ）。
    //    VAD / echo / barge-in は Live API サーバ側が処理するため、ここで mic を
    //    gating しない（barge-in が壊れる）。
    const parts = msg.serverContent?.modelTurn?.parts ?? [];
    for (const p of parts) {
      const mime = p.inlineData?.mimeType ?? '';
      const data = p.inlineData?.data;
      if (data && mime.startsWith('audio/pcm') && !muted) audio.playPcm(data);
    }

    // 2) ストリーミング transcript (入力 = ユーザー)
    const inText = msg.serverContent?.inputTranscription?.text;
    if (inText) {
      userBuf += inText;
      ensureStreamBubble('user').textContent = userBuf;
      refs.log.scrollTop = refs.log.scrollHeight;
    }
    // (出力 = AI) — cleanTranscript で関数呼び出し漏れを除去してから表示
    const outText = msg.serverContent?.outputTranscription?.text;
    if (outText) {
      assistantBuf += outText;
      ensureStreamBubble('assistant').textContent = cleanTranscript(assistantBuf);
      refs.log.scrollTop = refs.log.scrollHeight;
    }

    // 3) turn 完了で確定
    if (msg.serverContent?.turnComplete) {
      const cleanedAssistant = cleanTranscript(assistantBuf);
      finalizeStream('user', userBuf);
      finalizeStream('assistant', assistantBuf);
      userBuf = '';
      assistantBuf = '';

      // セーフネット: AI が「?」で終わる質問をしたのに present_question を呼ばなかった
      //   ① 既知の Q キーワードにマッチすれば、対応する選択肢を自動表示
      //   ② マッチしなければ voice + 補助テキスト入力で回答可能に
      if (!presentQuestionCalledThisTurn && /[?？][\s」』）)]*$/.test(cleanedAssistant)) {
        const lastQ = extractLastQuestion(cleanedAssistant);
        const fb = matchFallbackQuestion(cleanedAssistant);
        if (fb) {
          applyPresentQuestion({ ...fb, question: lastQ });
        } else {
          refs.questionText.textContent = lastQ;
          showWidget('voice');
          flashFallback();
        }
      }
    }

    // 4) tool call
    const calls = msg.toolCall?.functionCalls;
    if (calls && calls.length > 0 && liveSession) {
      const responses = calls.map((fc) => handleFunctionCall(fc));
      liveSession.sendToolResponse({ functionResponses: responses });
    }

    // 5) 割り込み
    if (msg.serverContent?.interrupted) audio.flushPlayback();

    if (msg.goAway) setStatus('まもなく切断（再接続してください）');
  }

  function handleFunctionCall(fc: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  }): { id: string; name: string; response: Record<string, unknown> } {
    const id = fc.id ?? '';
    const name = fc.name ?? '';
    try {
      if (name === 'present_question') {
        applyPresentQuestion(fc.args as PresentArgs);
      } else if (name === 'complete_interview') {
        const summary = String((fc.args as { summary?: unknown })?.summary ?? '問診ありがとうございました');
        appendMessage({ role: 'system', text: `✅ 問診完了: ${summary}`, ts: Date.now() });
        renderProgress(100, '完了');
        renderSectionDots(SECTIONS.length);
        refs.questionText.textContent = '✨ お疲れさまでした。ダッシュボードで「今日の気付き」をご覧ください。';
        showWidget('voice');
        // ダッシュボード側 HealthInsightCard が完了を検知できるよう保存
        session.progress = 100;
        saveChatSession(session);
      } else if (name === 'flag_emergency') {
        const reason = String((fc.args as { reason?: unknown })?.reason ?? '緊急の可能性');
        appendMessage({
          role: 'system',
          text: `⚠️ 緊急: ${reason} — 119 または救急受診を検討してください。`,
          ts: Date.now(),
        });
      }
      return { id, name, response: { result: 'ok' } };
    } catch (err) {
      return { id, name, response: { result: 'error', detail: String(err) } };
    }
  }

  function applyPresentQuestion(args: PresentArgs): void {
    // 保険: AI が present_question を呼んだが chips/multi_options が空のケース
    //   → 質問テキストから fallback を引いて補完する (UI 上「空の選択肢領域」を防ぐ)
    const kind = mapKind(args.answer_kind);
    if ((kind === 'chip' && (!args.chips || args.chips.length === 0)) ||
        (kind === 'multi' && (!args.multi_options || args.multi_options.length === 0))) {
      const fb = matchFallbackQuestion(args.question ?? '');
      if (fb) {
        args = {
          ...fb,
          ...args,
          chips: args.chips && args.chips.length > 0 ? args.chips : fb.chips,
          multi_options: args.multi_options && args.multi_options.length > 0 ? args.multi_options : fb.multi_options,
          multi_title: args.multi_title ?? fb.multi_title,
          answer_kind: fb.answer_kind,
        };
      }
    }

    currentPresent = args;
    presentQuestionCalledThisTurn = true;

    const percent = clamp(Math.round(Number(args.percent) || 0), 0, 100);
    session.progress = percent;
    saveChatSession(session);
    renderProgress(percent, args.section_title ?? '');

    const sectionIdx = SECTIONS.findIndex((s) => s.id === args.section_id);
    renderSectionDots(sectionIdx);

    refs.questionText.textContent = args.question ?? '';
    refs.skipBtn.hidden = !args.allow_skip;

    const finalKind = mapKind(args.answer_kind);

    if (finalKind === 'chip') {
      renderChips(args.chips ?? []);
    } else if (finalKind === 'multi') {
      renderMulti(args.multi_options ?? [], args.multi_title ?? '該当するものをすべて選んでください');
    } else if (finalKind === 'slider') {
      refs.sliderLow.textContent = args.slider_low_label ?? '低い';
      refs.sliderHigh.textContent = args.slider_high_label ?? '高い';
      refs.sliderInput.value = '5';
      refs.sliderValue.textContent = '5';
    } else if (finalKind === 'stepper') {
      refs.stepperUnit.textContent = args.stepper_unit ?? '本';
      refs.stepperValue.textContent = '0';
      refs.stepperValue.dataset.max = String(args.stepper_max ?? 99);
    }

    showWidget(finalKind);
  }

  function renderChips(chips: ChoiceOption[]): void {
    refs.uiChip.innerHTML = '';
    for (const c of chips) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice-card';
      btn.dataset.chip = c.label;
      btn.innerHTML = `${c.emoji ? `<span class="emoji">${escapeHtml(c.emoji)}</span>` : ''}<span class="flex-1">${escapeHtml(c.label)}</span><span class="text-slate-400">›</span>`;
      refs.uiChip.appendChild(btn);
    }
    // stagger アニメーション再トリガ
    refs.uiChip.classList.remove('stagger');
    void refs.uiChip.offsetWidth;
    refs.uiChip.classList.add('stagger');
  }

  function renderMulti(opts: ChoiceOption[], title: string): void {
    refs.multiTitle.textContent = title;
    refs.multiSummary.textContent = '';
    refs.multiOptions.innerHTML = '';
    for (const o of opts) {
      const id = `m-${Math.random().toString(36).slice(2, 8)}`;
      const wrap = document.createElement('label');
      wrap.className = 'choice-card cursor-pointer';
      wrap.setAttribute('for', id);
      wrap.innerHTML = `
        <input id="${id}" type="checkbox" value="${escapeAttr(o.label)}" class="h-5 w-5 accent-brand-600" />
        ${o.emoji ? `<span class="emoji">${escapeHtml(o.emoji)}</span>` : ''}
        <span class="flex-1">${escapeHtml(o.label)}</span>
      `;
      refs.multiOptions.appendChild(wrap);
    }
  }

  // ── 進捗 / セクション dots ───────────────────────

  function renderProgress(percent: number, sectionTitle: string): void {
    refs.progressText.textContent = `${percent}%`;
    refs.sectionLabel.textContent = sectionTitle ? sectionTitle : '進行中…';
  }

  function renderSectionDots(currentIdx: number): void {
    refs.sectionDots.forEach((dot, i) => {
      dot.classList.remove('done', 'current');
      if (i < currentIdx) dot.classList.add('done');
      else if (i === currentIdx) dot.classList.add('current');
    });
  }

  // ── ログ ────────────────────────────────────────

  function appendMessage(msg: ChatMessage): void {
    clearEmptyState();
    session.messages.push(msg);
    saveChatSession(session);
    renderMessage(msg);
    refs.log.scrollTop = refs.log.scrollHeight;
  }

  function renderHistory(): void {
    refs.log.innerHTML = '';
    if (session.messages.length === 0) {
      // 空状態のプレースホルダ
      const empty = document.createElement('div');
      empty.className = 'flex h-full flex-col items-center justify-center gap-2 py-6 text-center text-slate-400';
      empty.innerHTML = '<span class="text-4xl">💬</span><p class="text-xs">下の <span class="font-medium text-brand-600">🩺 問診を開始</span> ボタンから始めてください</p>';
      refs.log.appendChild(empty);
    } else {
      session.messages.forEach(renderMessage);
    }
    renderProgress(session.progress, '');
    refs.log.scrollTop = refs.log.scrollHeight;
  }

  // 初回メッセージ追加時に空状態を消す
  function clearEmptyState(): void {
    refs.log.querySelector('#chat-empty')?.remove();
  }

  function renderMessage(msg: ChatMessage): void {
    const wrap = document.createElement('div');
    wrap.className = 'flex w-full bubble-in';
    const bubble = document.createElement('div');
    bubble.className = bubbleClass(msg.role);
    if (msg.role === 'assistant') {
      bubble.classList.add('md-region');
      bubble.innerHTML = renderMarkdown(msg.text);
    } else {
      bubble.textContent = msg.text;
    }
    if (msg.role === 'user') wrap.classList.add('justify-end');
    if (msg.role === 'system') wrap.classList.add('justify-center');
    wrap.appendChild(bubble);
    refs.log.appendChild(wrap);
  }

  function ensureStreamBubble(role: 'assistant' | 'user'): HTMLElement {
    const existing = role === 'assistant' ? assistantStreamBubble : userStreamBubble;
    if (existing && existing.isConnected) return existing;
    clearEmptyState();
    const wrap = document.createElement('div');
    wrap.className = 'flex w-full bubble-in';
    if (role === 'user') wrap.classList.add('justify-end');
    const bubble = document.createElement('div');
    bubble.className = `${bubbleClass(role)} typing-caret`;
    bubble.textContent = '';
    wrap.appendChild(bubble);
    refs.log.appendChild(wrap);
    if (role === 'assistant') assistantStreamBubble = bubble;
    else userStreamBubble = bubble;
    return bubble;
  }

  function finalizeStream(role: 'assistant' | 'user', buf: string): void {
    const bubble = role === 'assistant' ? assistantStreamBubble : userStreamBubble;
    // AI 側は最終 transcript も cleanTranscript で関数呼び出し漏れを除去
    const cleaned = role === 'assistant' ? cleanTranscript(buf) : buf.trim();

    // 重複抑止: 直前メッセージと同 role + 同テキスト ならスキップ
    //   (echo loop で AI が同じ挨拶を繰り返した場合の保険)
    const lastMsg = session.messages[session.messages.length - 1];
    const isDup = cleaned && lastMsg && lastMsg.role === role && lastMsg.text === cleaned;

    if (!bubble) {
      if (cleaned && !isDup) appendMessage({ role, text: cleaned, ts: Date.now() });
      return;
    }
    bubble.classList.remove('typing-caret');
    if (!cleaned || isDup) {
      bubble.parentElement?.remove();
    } else {
      session.messages.push({ role, text: cleaned, ts: Date.now() });
      saveChatSession(session);
      if (role === 'assistant') {
        bubble.classList.add('md-region');
        bubble.innerHTML = renderMarkdown(cleaned);
      } else {
        bubble.textContent = cleaned;
      }
    }
    if (role === 'assistant') assistantStreamBubble = null;
    else userStreamBubble = null;
  }
}

/**
 * モデルが稀に関数呼び出しを音声で読み上げてしまった場合に備えた保険。
 * "call:present_question{...}" や "present_question(...)" を末尾まで除去する。
 * 本来はプロンプトで抑止しているが、漏れたものを表示しないためのセーフネット。
 */
function cleanTranscript(text: string): string {
  let out = text;
  // "call:" 以降を末尾まで除去（最も典型的な漏れパターン）
  out = out.replace(/\s*\bcall\s*:\s*[\s\S]*$/i, '');
  // 単独で "present_question{" や "present_question(" が出てきた場合も末尾まで除去
  out = out.replace(/\s*\bpresent_question\b\s*[\({][\s\S]*$/i, '');
  // "complete_interview" や "flag_emergency" が音声化されても同様に除去
  out = out.replace(/\s*\b(complete_interview|flag_emergency)\b\s*[\({][\s\S]*$/i, '');
  return out.trim();
}

function bubbleClass(role: ChatMessage['role']): string {
  const base = 'max-w-[82%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm shadow-sm';
  switch (role) {
    case 'user':
      return `${base} bg-gradient-to-br from-brand-600 to-brand-700 text-white`;
    case 'assistant':
      return `${base} bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100`;
    case 'system':
    default:
      return `${base} bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100`;
  }
}

function renderMarkdown(text: string): string {
  try {
    return marked.parse(text, { async: false }) as string;
  } catch {
    return escapeHtml(text);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function describeErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
