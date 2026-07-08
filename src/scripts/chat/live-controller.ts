/**
 * AI 問診コントローラ (Phase 1.0 — engine 駆動)
 *
 * 設計:
 *   - 問診票本体 (Q1-1〜Q5-2, 分岐, 進捗) はクライアントの InterviewEngine が制御
 *   - Live API (LLM) は「ユーザー回答の温かい復唱」「セクション切替の導線発話」だけを担当
 *   - LLM が問診順を決めないので、ループ・選択肢欠落・順序乱れが構造的にゼロ
 *
 * UI:
 *   - 音声 / テキスト切替トグル
 *   - 質問は engine が出す → 動的に widget を切替 (chip/multi/slider/stepper)
 *   - 補助テキスト入力 (音声モードでも常時利用可)
 *   - ストリーミング transcript で AI/ユーザー発話をライブ表示
 */

import {
  GoogleGenAI,
  Modality,
  ActivityHandling,
  type Session,
  type LiveServerMessage,
} from '@google/genai';
import { marked } from 'marked';
import { LiveAudioManager } from './live-audio-manager';
import {
  clearChatSession,
  clearInterviewResult,
  createEmptySession,
  loadChatSession,
  saveChatSession,
  saveInterviewResult,
  type ChatMessage,
  type ChatSession,
} from '../../lib/session-store';
import {
  InterviewEngine,
  SECTIONS as INTERVIEW_SECTIONS,
  type QuestionDef,
  type AnswerValue,
} from './interview-script';
import { openWheelPicker, openMatrixPicker, formatMatrix, closeAllPickers } from './wheel-picker';
import { getOrCreateDiagnosticId } from '../../lib/diagnostic-id';

export interface LiveRefs {
  log: HTMLElement;
  status: HTMLElement;
  resetBtn: HTMLButtonElement;
  resumeBanner: HTMLElement | null;

  progressText: HTMLElement;
  sectionLabel: HTMLElement;
  /** セクション dot を動的生成するコンテナ */
  sectionDots: HTMLElement;

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
  uiWheel: HTMLElement;
  uiMatrix: HTMLElement;
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
  textExample: HTMLElement;

  multiOpen: HTMLButtonElement;
  multiSummary: HTMLElement;
  multiModal: HTMLElement;
  multiOptions: HTMLElement;
  multiTitle: HTMLElement;
  multiConfirm: HTMLButtonElement;

  wheelOpen: HTMLButtonElement;
  wheelSummary: HTMLElement;
  matrixOpen: HTMLButtonElement;
  matrixSummary: HTMLElement;

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

// 問診票のセクションは interview-script.ts に集約済 (INTERVIEW_SECTIONS を使用)
const SECTIONS = INTERVIEW_SECTIONS;

const SYSTEM_INSTRUCTION = `あなたはウェルフォートの健康問診を担当する AI 看護師アシスタントです。問診票本体 (質問順・選択肢・分岐) は画面のシステムが自動で出します。あなたは「画面に出ている質問を温かく読み上げる係」です。

【絶対ルール】
A. 自分で勝手に質問を考えない。ユーザー回答後にこちらから指定された質問文だけを読み上げる。指定がないターンでは質問を発話しない。
B. 選択肢や入力例を長々と読み上げない (画面に表示されています)。回答方法が必要なときだけ「画面で回して選ぶか、声でお答えください」と一言添える程度にする。
C. ツール呼び出しは一切不要 (廃止済)。
D. 診断・処方は禁止。
E. 指示文の言い回し (「次の質問」「発話手順」「①②③」「〜してください」等) は指示であって発話内容ではありません。絶対に声に出さないでください。実際に読み上げるのは「」で囲まれた文だけです。
F. 同じ質問を二度読み上げない。指定された質問文は一度だけ読みます。次に読む質問は毎回こちらが指定するので、指定される前に自分から次の質問を推測・先読みして話さないでください。
G. 医療上の免責・注意書き (「診断ではありません」「医療機関を受診してください」等) を自分から付け足さないでください (画面に表示済みです)。
H. 音声で回答が届いたときは、短い復唱を一度だけ返し、次の質問はこちらの指定を待ってから読み上げてください (指定前に質問を続けない)。

【ターン構成】
ユーザー回答が届いたら、以下の順で 1〜3 文を発話:
  ① 短く温かく復唱: 「『◯◯』ですね、ありがとうございます」
  ② セクションが変わるときだけ「次は◯◯についてお伺いしますね」と一言
  ③ 続けて、依頼された質問本文をそのまま自然に読み上げる: 「『xxx』」

【セッション開始時】(1 ターン限り)
最初の発話: 「こんにちは、ウェルフォートの AI 問診です。画面の質問に、タップでも音声でもお答えいただけます。」と前置きしてから、最初の質問文を読み上げる。

【問診完了時】
「お疲れさまでした、ご協力ありがとうございました」と一言お礼。

【緊急対応】
胸痛 / 呼吸困難 / 意識消失 / 激しい頭痛 / 大量出血等を訴えたら、即座に「すぐに 119 番にお電話ください」と案内する。`;

const _OBSOLETE_SYSTEM_INSTRUCTION = `あなたは健康問診の AI 看護師です。

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
void _OBSOLETE_SYSTEM_INSTRUCTION;

// TOOLS は廃止。engine 駆動になったため tool calling 一切不要 (定数自体も削除)。

// (旧 _OBSOLETE_TOOLS の Gemini Type 依存定義は engine 駆動化により全削除済)

// 旧 ChoiceOption / PresentArgs / FALLBACK_QUESTIONS / matchFallbackQuestion /
// extractLastQuestion は engine 駆動化 (interview-script.ts) により全削除済。
// 必要な型は QuestionDef / AnswerValue (interview-script から import)。
type ChoiceOption = { label: string; emoji?: string };

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
  /** 直近の assistant 完了発話 (ループ検出用) */
  let lastFinalizedAssistant = '';
  let lastFinalizedAssistantAt = 0;
  let duplicateAssistantCount = 0;

  let mode: 'voice' | 'text' = 'voice';
  let currentQ: QuestionDef | null = null;
  /** 回答受付〜次設問表示までの間は音声回答の二重取り込みを抑止する */
  let advancing = false;
  let muted = false;
  /** 内部で取得済の顧客プロフィール (氏名・生年月日・性別は問診で尋ねず結果へ付与) */
  let userProfile: { name: string | null; dateOfBirth: string | null; sex: string | null } | null = null;
  /** 申込情報から供給する EXAM-TYPE (今回実施検査)。空なら問診で通常設問として尋ねる。 */
  let seededExamTypes: string[] = [];
  const engine = new InterviewEngine();
  // 後方互換: 旧 fallback パス由来の参照を温存 (本実装では未使用)
  let presentQuestionCalledThisTurn = false;
  void presentQuestionCalledThisTurn;

  // セクション dot を SECTIONS に合わせて動的生成
  const sectionDotEls: HTMLElement[] = [];
  buildSectionDots();

  if (session.messages.length > 0 && refs.resumeBanner) {
    refs.resumeBanner.hidden = false;
  }
  renderHistory();
  setConnected(false);
  applyModeUI();
  refs.fallbackZone.hidden = false; // 補助テキスト入力は常時表示

  function buildSectionDots(): void {
    refs.sectionDots.innerHTML = '';
    sectionDotEls.length = 0;
    SECTIONS.forEach((s, i) => {
      const dot = document.createElement('div');
      dot.className = 'section-dot';
      dot.dataset.sectionDot = String(i);
      dot.title = s.title;
      refs.sectionDots.appendChild(dot);
      sectionDotEls.push(dot);
    });
  }

  // ── イベント結線 ──────────────────────────────────

  refs.resetBtn.addEventListener('click', () => {
    if (!confirm('問診をリセットしますか？（履歴が削除されます）')) return;
    stopLive();
    closeAllPickers();
    closeMultiModal();
    clearChatSession(SESSION_ID);
    clearInterviewResult(SESSION_ID);
    session = createEmptySession(SESSION_ID);
    currentQ = null;
    advancing = false;
    engine.reset();
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

  // wheel (ホイール選択モーダル)
  refs.wheelOpen.addEventListener('click', () => void openWheelForCurrent());
  // matrix (項目 × 頻度)
  refs.matrixOpen.addEventListener('click', () => void openMatrixForCurrent());

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
    if (currentQ) {
      showWidget(mapKind(currentQ.answer_kind));
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
      case 'wheel': return 'wheel';
      case 'matrix': return 'matrix';
      case 'slider': return 'slider';
      case 'stepper': return 'stepper';
      case 'text': return 'text';
      default: return 'voice';
    }
  }

  type WidgetKey = 'voice' | 'chip' | 'multi' | 'wheel' | 'matrix' | 'slider' | 'stepper' | 'text';

  function showWidget(key: WidgetKey): void {
    const map: Record<WidgetKey, HTMLElement> = {
      voice: refs.uiVoice,
      chip: refs.uiChip,
      multi: refs.uiMulti,
      wheel: refs.uiWheel,
      matrix: refs.uiMatrix,
      slider: refs.uiSlider,
      stepper: refs.uiStepper,
      text: refs.uiText,
    };
    for (const [k, el] of Object.entries(map)) {
      el.hidden = k !== key;
    }
    // 自由記述 widget が出ているときは補助テキスト入力を非表示（重複防止）
    refs.fallbackZone.hidden = key === 'text';
    // 「音声でも・タップでも」ヒント: 選択式 widget の時に表示
    refs.dualHint.hidden = !(
      key === 'chip' || key === 'multi' || key === 'wheel' ||
      key === 'matrix' || key === 'slider' || key === 'stepper'
    );
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

  /** 現在の wheel 設問でホイール選択モーダルを開く */
  async function openWheelForCurrent(): Promise<void> {
    const q = currentQ;
    if (!q || q.answer_kind !== 'wheel') return;
    const initial = q.multi
      ? (engine.getAnswers()[q.id] as string[] | undefined) ?? []
      : [];
    const result = await openWheelPicker({
      title: q.wheel_title ?? q.question,
      options: q.wheel_options ?? [],
      multi: !!q.multi,
      initial,
    });
    if (result === null) return; // キャンセル
    if (q.multi) {
      submitAnswer(result.length === 0 ? 'なし' : result.join('、'));
    } else {
      if (result.length === 0) return;
      submitAnswer(result[0]);
    }
  }

  /** 現在の matrix 設問でマトリクス選択モーダルを開く */
  async function openMatrixForCurrent(): Promise<void> {
    const q = currentQ;
    if (!q || q.answer_kind !== 'matrix') return;
    const result = await openMatrixPicker({
      title: q.question,
      rows: q.matrix_rows ?? [],
      cols: q.matrix_cols ?? [],
    });
    if (result === null) return;
    submitAnswer(formatMatrix(result));
  }

  /**
   * ユーザー回答を受けて engine から次の Q を決定し、画面を即更新する。
   * AI には「回答に対する温かい復唱 (+任意のセクション導線)」だけ依頼する。
   * AI に「次の質問は何か」は伝えず、質問を発話させない。
   */
  function submitAnswer(rawAnswer: string, opts: { silent?: boolean } = {}): void {
    if (!rawAnswer) return;
    const cq = currentQ;
    if (!cq) {
      // 未開始時は単純に AI へ渡す (例: 「リセット後の自由発話」)
      if (!opts.silent) appendMessage({ role: 'user', text: rawAnswer, ts: Date.now() });
      sendToModel(rawAnswer);
      return;
    }

    // 音声回答 (silent) は transcript バブルが既に出ているので二重表示しない
    if (!opts.silent) appendMessage({ role: 'user', text: rawAnswer, ts: Date.now() });

    // 受付〜次設問表示までは音声の二重取り込みを止める
    advancing = true;
    // 開いているモーダル (ホイール/マトリクス/複数選択) を閉じる
    closeAllPickers();
    closeMultiModal();

    const answerValue = toAnswerValue(cq, rawAnswer);
    const { next, isComplete } = engine.recordAndAdvance(answerValue);

    if (isComplete || !next) {
      showCompletion();
      sendToModel(`ユーザーが最後の質問「${cq.question}」に「${rawAnswer}」と回答し、これで全問終了です。「お疲れさまでした、ご協力ありがとうございました」と温かく一言だけお願いします。質問は絶対に発話しないでください。`);
      return;
    }

    const sectionChanged = cq.section_id !== next.section_id;

    // ━━ フライング防止: 次の Q 表示を AI 復唱開始と同期させる ━━
    //   engine 駆動で即座に applyQuestionToUI を呼ぶと、AI の音声復唱が
    //   始まる前に次の選択肢が画面に出てしまい違和感が出る。
    //   1) 即時: 受付確認の中間表示 + 選択肢を隠す
    //   2) AI 依頼を送信
    //   3) AI 音声の最初の chunk が来る or タイムアウト (1.6s) で次の Q 表示
    refs.questionText.textContent = `✅ 「${rawAnswer}」で承りました…`;
    showWidget('voice');
    refs.skipBtn.hidden = true;

    // AI 依頼: (タップ回答) 復唱 + 次の質問 / (音声回答) 次の質問のみ
    //   ★ 音声二重復唱の防止: 音声回答 (silent) では Live API がユーザー発話に自発応答して
    //     既に復唱しているため、ここで復唱を再依頼すると復唱が 2 回になる。silent 時は
    //     復唱 (①) を外し「次の質問の読み上げ」だけ依頼する。タップ回答は発話が無く自発
    //     応答も無いので従来どおり復唱込みで依頼する。
    //     ※ 復唱除去のみを単独適用 (ターン制御には手を入れない = 読み上げ途切れを回避)。
    //   ※ 発話させたい内容は「」内だけ。指示語 (「次の質問」等) は声に出させない (ルールE)。
    const sectionLead = sectionChanged ? `「次は${next.section_title}についてお伺いしますね」と一言添えてから、` : '';
    let msg: string;
    if (opts.silent) {
      // 音声回答: 復唱は自発応答済み。ここでは質問文を一度だけ読ませる。
      msg = `${sectionLead}この質問文だけをそのまま一度だけ読み上げてください: 「${next.question}」。復唱・相槌・前置き・補足説明・免責は不要です。選択肢は読み上げないでください。`;
    } else {
      // タップ/テキスト回答: 自発応答が無いので復唱込み。
      msg = `ユーザーは画面で「${rawAnswer}」と回答しました。まず「『${rawAnswer}』ですね、ありがとうございます」とだけ一度復唱し、${sectionLead}続けてこの質問文をそのまま一度だけ読み上げてください: 「${next.question}」。それ以外 (補足説明・免責・選択肢の読み上げ) はしないでください。`;
    }
    sendToModel(msg);

    // AI 音声の最初の chunk が再生開始した瞬間 (≒ 復唱開始) に次の Q を表示。
    // 公式 audio chunk が来るのを待つため、1 回限りのリスナーを登録。
    // タイムアウト (2 秒) でも fall-through し、必ず表示する。
    schedulePendingQuestion(next);
  }

  /** AI 音声開始 or タイムアウト で次の Q を画面に反映する */
  let pendingNextQuestion: QuestionDef | null = null;
  function schedulePendingQuestion(q: QuestionDef): void {
    pendingNextQuestion = q;
    const fallbackTimer = setTimeout(() => {
      if (pendingNextQuestion === q) {
        applyQuestionToUI(q);
        pendingNextQuestion = null;
      }
    }, 2000);
    // audioFirstChunkResolvers を介して、AI 音声 1st chunk 検出時に解決
    audioFirstChunkResolvers.push(() => {
      clearTimeout(fallbackTimer);
      if (pendingNextQuestion === q) {
        applyQuestionToUI(q);
        pendingNextQuestion = null;
      }
    });
  }
  /** 次の AI 音声 chunk 受信時に発火するワンショットコールバック群 */
  const audioFirstChunkResolvers: Array<() => void> = [];

  /** UI に入る生文字列を engine が扱える型に変換 */
  function toAnswerValue(q: QuestionDef, raw: string): AnswerValue {
    if (q.answer_kind === 'multi' || (q.answer_kind === 'wheel' && q.multi)) {
      return raw.split('、').map((s) => s.trim()).filter(Boolean);
    }
    if (q.answer_kind === 'slider') {
      const m = /(-?\d+(?:\.\d+)?)/.exec(raw);
      return m ? Number(m[1]) : (q.slider_min ?? 1);
    }
    return raw;
  }

  /**
   * 音声 transcript を現在設問の回答として取り込む。
   * 選択式は選択肢へマッチング、自由記述は transcript をそのまま採用する。
   */
  function maybeHandleVoiceAnswer(transcript: string): void {
    if (advancing) return; // 受付処理中は無視 (二重取り込み防止)
    const q = currentQ;
    if (!q) return;
    const ans = interpretVoiceAnswer(q, transcript);
    if (ans == null) return;
    if (Array.isArray(ans)) {
      submitAnswer(ans.length ? ans.join('、') : 'なし', { silent: true });
    } else {
      submitAnswer(ans, { silent: true });
    }
  }

  /** transcript を設問種別ごとに解釈。マッチしなければ null (タップ待ち) */
  function interpretVoiceAnswer(q: QuestionDef, transcript: string): string | string[] | null {
    const t = normalizeVoice(transcript);
    if (!t) return null;

    if (q.answer_kind === 'text') {
      // 自由記述は発話をそのまま回答に採用 (元の transcript を保持)
      return transcript.trim();
    }

    if (q.answer_kind === 'slider') {
      const min = q.slider_min ?? 1;
      const max = q.slider_max ?? 10;
      const m = /(-?\d+)/.exec(transcript);
      if (!m) return null;
      const n = Math.max(min, Math.min(max, Number(m[1])));
      return String(n);
    }

    if (q.answer_kind === 'matrix') {
      return null; // マトリクスはタップ操作のみ
    }

    const options =
      q.answer_kind === 'chip' ? (q.chips ?? [])
      : q.answer_kind === 'multi' ? (q.multi_options ?? [])
      : (q.wheel_options ?? []);
    if (options.length === 0) return null;

    const isMulti = q.answer_kind === 'multi' || (q.answer_kind === 'wheel' && q.multi);

    const matched = options
      .map((o) => ({ label: o.label, core: normalizeVoice(o.label) }))
      .filter(({ core }) => core && (t.includes(core) || core.includes(t)));

    if (matched.length === 0) return null;

    if (isMulti) {
      return matched.map((m) => m.label);
    }
    // 単一: 最も具体的 (核が長い) 候補を採用
    matched.sort((a, b) => b.core.length - a.core.length);
    return matched[0].label;
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
    const { token, model, userContext, userProfile: fetchedProfile, examTypes } = (await res.json()) as {
      token: string;
      model: string;
      userContext?: string | null;
      userProfile?: { name: string | null; dateOfBirth: string | null; sex: string | null } | null;
      examTypes?: string[] | null;
    };
    // 氏名・生年月日・性別は問診で尋ねない。内部取得値を結果へ付与するため保持する。
    userProfile = fetchedProfile ?? null;
    // 今回実施検査 (EXAM-TYPE) も申込情報から供給し、問診では尋ねない (A案)。
    seededExamTypes = Array.isArray(examTypes) ? examTypes.filter((x) => typeof x === 'string') : [];

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
        // VAD / barge-in は LLM (サーバ) 側に委ねる:
        //   - automaticActivityDetection: 既定 ON のまま (ユーザー回答の終端検出には必要)
        //   - activityHandling: NO_INTERRUPTION で AI 発話中の barge-in を抑止
        //     (周辺ノイズで AI 発話が途中で切れる現象を防ぐ)
        realtimeInputConfig: {
          activityHandling: ActivityHandling.NO_INTERRUPTION,
        },
        // engine 駆動で tool calling は使わない → tools フィールド自体を渡さない
      },
      callbacks: {
        onopen: () => {
          setStatus('🎙 接続済 — 話せます / タップ可');
          setConnected(true);
          // engine 起動: 最初の Q を画面に即表示 (AI を待たない)
          // EXAM-TYPE は申込情報から供給し設問を提示しない (空なら通常設問にフォールバック)。
          const firstQ = engine.start(
            seededExamTypes.length > 0 ? { 'EXAM-TYPE': seededExamTypes } : {},
          );
          applyQuestionToUI(firstQ);
          // AI には「挨拶 + Q1-1 の読み上げ」だけを依頼
          setTimeout(() => {
            try {
              liveSession?.sendClientContent({
                turns: [{ role: 'user', parts: [{ text:
                  `問診を始めます。次の 2 文を発話してください:
  ① 「こんにちは、ウェルフォートの AI 問診です。画面の質問に、タップでも音声でもお答えいただけます。」
  ② 続けて画面に表示されている最初の質問を読み上げ: 「${firstQ.question}」
選択肢や入力例は読み上げないでください (画面に表示されています)。挨拶と質問を 1 回だけ、絶対に繰り返さないでください。`
                } ] }],
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
      if (data && mime.startsWith('audio/pcm') && !muted) {
        audio.playPcm(data);
        // 最初の音声 chunk = AI 復唱開始 → pending な次の Q を表示
        if (audioFirstChunkResolvers.length > 0) {
          const cbs = audioFirstChunkResolvers.splice(0, audioFirstChunkResolvers.length);
          for (const cb of cbs) {
            try { cb(); } catch {}
          }
        }
      }
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
      const finishedUser = userBuf.trim();
      finalizeStream('user', userBuf);
      finalizeStream('assistant', assistantBuf);
      userBuf = '';
      assistantBuf = '';

      // 音声回答 → 選択肢へマッチングして engine に反映 (タップと等価)
      if (finishedUser) maybeHandleVoiceAnswer(finishedUser);

      // ループ検出: 直近 10 秒以内に同じ発話を完了したら重複カウント
      const now = Date.now();
      const isDuplicate =
        cleanedAssistant.length > 10 &&
        cleanedAssistant === lastFinalizedAssistant &&
        now - lastFinalizedAssistantAt < 15_000;
      if (isDuplicate) {
        duplicateAssistantCount += 1;
      } else {
        duplicateAssistantCount = 0;
        lastFinalizedAssistant = cleanedAssistant;
        lastFinalizedAssistantAt = now;
      }

      // 重複 2 回 (合計 3 回同じ発話) でセッション切断 — AI の発話ループから抜けるため
      if (duplicateAssistantCount >= 2) {
        appendMessage({
          role: 'system',
          text: '⚠️ AI が同じ質問を繰り返しているため、セッションを自動切断しました。「リセット」ボタンで再開してください。',
          ts: Date.now(),
        });
        setStatus('🔌 自動切断 — リセットして再開してください');
        stopLive();
        duplicateAssistantCount = 0;
        lastFinalizedAssistant = '';
        return;
      }

      // engine 駆動なので AI 発話に対する fallback / present_question 推定は不要。
      // (重複発話の自動切断ガードは残してある — 上で処理済)
    }

    // 4) tool call (engine 駆動では使わないが、AI が誤って呼んだ場合のため response は返す)
    const calls = msg.toolCall?.functionCalls;
    if (calls && calls.length > 0 && liveSession) {
      const responses = calls.map((fc) => ({
        id: fc.id ?? '',
        name: fc.name ?? '',
        response: { result: 'ignored — engine 駆動で tool は廃止しました' },
      }));
      liveSession.sendToolResponse({ functionResponses: responses });
    }

    // 5) 割り込み
    if (msg.serverContent?.interrupted) audio.flushPlayback();

    if (msg.goAway) setStatus('まもなく切断（再接続してください）');
  }

  // 旧 handleFunctionCall (present_question / complete_interview / flag_emergency) は
  // engine 駆動化に伴い削除。tool 呼び出しは handleServerMessage の section 4 で
  // 一括 ignored 応答を返す。

  /** engine から受け取った Q を画面に反映する (engine 駆動の核) */
  function applyQuestionToUI(q: QuestionDef): void {
    currentQ = q;
    advancing = false; // 次設問が出たので音声回答の受付を再開

    const percent = clamp(engine.currentPercent(), 0, 100);
    session.progress = percent;
    saveChatSession(session);
    renderProgress(percent, q.section_title);

    const sectionIdx = SECTIONS.findIndex((s) => s.id === q.section_id);
    renderSectionDots(sectionIdx);

    refs.questionText.textContent = q.question;
    refs.skipBtn.hidden = true; // engine 版ではスキップ未対応 (将来追加)

    const kind = mapKind(q.answer_kind);
    if (kind === 'chip') {
      renderChips(q.chips ?? []);
    } else if (kind === 'multi') {
      renderMulti(q.multi_options ?? [], q.multi_title ?? '該当するものをすべて選んでください');
    } else if (kind === 'wheel') {
      refs.wheelSummary.textContent = '';
      refs.wheelOpen.textContent = q.multi ? '🎡 回して選ぶ（複数可）' : '🎡 回して選ぶ';
    } else if (kind === 'matrix') {
      refs.matrixSummary.textContent = '';
    } else if (kind === 'slider') {
      const min = q.slider_min ?? 1;
      const max = q.slider_max ?? 10;
      const mid = String(Math.round((min + max) / 2));
      refs.sliderInput.min = String(min);
      refs.sliderInput.max = String(max);
      refs.sliderLow.textContent = q.slider_low_label ?? '低い';
      refs.sliderHigh.textContent = q.slider_high_label ?? '高い';
      refs.sliderInput.value = mid;
      refs.sliderValue.textContent = mid;
    } else if (kind === 'text') {
      refs.textInput.value = '';
      refs.textInput.placeholder = q.placeholder ?? '自由にお答えください';
      refs.textInput.setAttribute('inputmode', q.numeric ? 'numeric' : 'text');
      if (q.example) {
        refs.textExample.textContent = `入力例：${q.example}`;
        refs.textExample.hidden = false;
      } else {
        refs.textExample.hidden = true;
      }
    }
    showWidget(kind);

    // 選択肢が多い設問はモーダルを自動展開 (タップ一手間を省く)
    if (kind === 'multi') {
      setTimeout(() => openMultiModal(), 150);
    } else if (kind === 'wheel') {
      setTimeout(() => void openWheelForCurrent(), 150);
    } else if (kind === 'matrix') {
      setTimeout(() => void openMatrixForCurrent(), 150);
    }
  }

  /** 問診結果を S3 (Elith 連携) へ書き出す。テスト用・fire-and-forget。 */
  async function exportInterviewToS3(opts: {
    uid: string | null;
    answers: Record<string, AnswerValue>;
    completedAt: number;
  }): Promise<void> {
    try {
      await fetch('/api/interview/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          diagnosticId: getOrCreateDiagnosticId(),
          diagnosticUserId: opts.uid,
          userName: userProfile?.name ?? null,
          dateOfBirth: userProfile?.dateOfBirth ?? null,
          sex: userProfile?.sex ?? null,
          answers: opts.answers,
          completedAt: opts.completedAt,
        }),
      });
    } catch {
      /* テスト用途のため失敗は握りつぶす (UI を止めない) */
    }
  }

  /** 問診完了表示 + chat session を完了状態にして HealthInsightCard を起動 */
  function showCompletion(): void {
    currentQ = null;
    advancing = false;
    renderProgress(100, '完了');
    renderSectionDots(SECTIONS.length);

    // 問診結果ファイルを生成。氏名・生年月日・性別は尋ねず、内部取得値を付与する。
    const uid = refs.diagnosticUserId?.trim() || null;
    const answers = engine.getAnswers();
    const completedAt = Date.now();
    saveInterviewResult({
      id: SESSION_ID,
      diagnosticUserId: uid,
      userName: userProfile?.name ?? null,
      dateOfBirth: userProfile?.dateOfBirth ?? null,
      sex: userProfile?.sex ?? null,
      answers,
      completedAt,
    });

    // S3 (Elith 連携) へ書き出し。スキャンと同じ diagnostic_id フォルダに同居させる。
    // テスト用途のため fire-and-forget (失敗してもUIは止めない)。
    void exportInterviewToS3({ uid, answers, completedAt });

    const dashUrl = uid ? `/dashboard?u=${encodeURIComponent(uid)}` : '/dashboard';

    refs.questionText.innerHTML = `
      <div class="flex flex-col items-center gap-3 py-2">
        <p class="text-center text-base font-semibold text-slate-800 dark:text-slate-100">
          ✨ お疲れさまでした、ご協力ありがとうございました。
        </p>
        <p class="text-center text-xs text-slate-600 dark:text-slate-300">
          ダッシュボードに「今日の気付き」が自動生成されます。
        </p>
        <a
          href="${dashUrl}"
          class="mt-1 inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-brand-600 to-cyan-600 px-5 py-2 text-sm font-medium text-white shadow-md hover:from-brand-700 hover:to-cyan-700"
        >
          📊 ダッシュボードで結果を見る ›
        </a>
      </div>
    `;
    showWidget('voice');
    session.progress = 100;
    saveChatSession(session);
    appendMessage({
      role: 'system',
      text: '✅ 問診完了 — ダッシュボードで「今日の気付き」をご確認ください。',
      ts: Date.now(),
    });
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
    sectionDotEls.forEach((dot, i) => {
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

/**
 * 音声マッチング用の正規化。
 * NFKC 正規化 → 括弧書き / 記号 / 空白を除去 → 小文字化。
 * 例: 「ほぼ毎日（週5日以上）」→「ほぼ毎日」
 */
function normalizeVoice(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s　・、。，．,.!！?？「」『』〜~ー\-/]/g, '')
    .toLowerCase();
}

function describeErr(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message;
    const name = err.name;
    // マイク権限関連: ユーザーに「何をすればよいか」を伝える
    if (name === 'NotAllowedError' || /permission/i.test(msg)) {
      return 'マイクの使用が許可されていません。\nブラウザの URL バーの 🎙 アイコンをタップ → 許可を選んでから再度お試しください。\n(iOS Safari の場合: 設定 → Safari → カメラ・マイクのアクセス → 確認 or 許可)';
    }
    if (name === 'NotFoundError' || /no .*device/i.test(msg)) {
      return 'マイクが見つかりません。マイクが接続されているか、他のアプリで占有されていないかご確認ください。';
    }
    if (name === 'NotReadableError') {
      return 'マイクが他のアプリで使用中です。他のアプリ (Zoom / Teams 等) を閉じてからお試しください。';
    }
    return msg;
  }
  return String(err);
}
