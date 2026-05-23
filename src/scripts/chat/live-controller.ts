/**
 * Live API 経由の問診チャットコントローラ。
 *
 * フロー:
 *   1. POST /api/live-token で ephemeral token を取得
 *   2. ブラウザから直接 Google の Live API に WebSocket 接続
 *   3. マイク音声をストリーム送信 / 24kHz PCM 応答を再生
 *   4. update_progress / flag_emergency の function call で UI を更新
 */

import {
  GoogleGenAI,
  Modality,
  Type,
  type Session,
  type LiveServerMessage,
  type ToolListUnion,
} from '@google/genai';
import { LiveAudioManager } from './live-audio-manager';
import {
  createEmptySession,
  loadChatSession,
  saveChatSession,
  type ChatMessage,
  type ChatSession,
} from '../../lib/session-store';

export interface LiveRefs {
  log: HTMLElement;
  micBtn: HTMLButtonElement;
  textInput: HTMLTextAreaElement;
  textSend: HTMLButtonElement;
  status: HTMLElement;
  progressFill: HTMLElement | null;
  progressText: HTMLElement | null;
  progressSection: HTMLElement | null;
  resumeBanner: HTMLElement | null;
  suggestRoot: HTMLElement | null;
}

const SESSION_ID = 'default';

const SECTIONS = [
  { id: 'basic', title: '基本情報' },
  { id: 'diet', title: '食生活' },
  { id: 'exercise', title: '運動' },
  { id: 'sleep', title: '睡眠について' },
  { id: 'stimulants', title: '嗜好品（喫煙・飲酒）' },
  { id: 'stress', title: 'ストレス・メンタル' },
  { id: 'symptoms', title: '現在の症状' },
];

const SYSTEM_INSTRUCTION = `あなたは医療機関の問診補助 AI です。

【会話のルール】
- 日本語で簡潔・丁寧に音声で対応してください。
- 診断や処方は行わず、症状の聞き取りと整理に専念してください。
- 危険兆候（胸痛・意識障害・激しい頭痛・呼吸困難・大量出血など）が疑われる場合は、ためらわず flag_emergency を呼んだうえで 119 への連絡や救急受診を促してください。
- 1 ターンで質問は 1 つまでに絞ってください。

【セクション】
以下のセクションを順に進めてください:
${SECTIONS.map((s, i) => `${i + 1}. ${s.title} (id: ${s.id})`).join('\n')}

【UI 更新ルール（必須）】
- 質問の直前、または回答を受けた直後に必ず update_progress を呼び、
  current section_id / section_title / 全体 percent(0-100) /
  suggestions(回答候補チップ・短文・最大4個) を更新してください。
- 全セクションが完了したら completed:true を渡してください。`;

const TOOLS: ToolListUnion = [
  {
    functionDeclarations: [
      {
        name: 'update_progress',
        description: '問診の進捗バーとサジェストチップを更新する',
        parameters: {
          type: Type.OBJECT,
          properties: {
            section_id: { type: Type.STRING },
            section_title: { type: Type.STRING },
            percent: { type: Type.NUMBER },
            suggestions: { type: Type.ARRAY, items: { type: Type.STRING } },
            completed: { type: Type.BOOLEAN },
          },
          required: ['section_id', 'section_title', 'percent'],
        },
      },
      {
        name: 'flag_emergency',
        description: '緊急対応が必要な所見を検知したときに呼ぶ',
        parameters: {
          type: Type.OBJECT,
          properties: {
            reason: { type: Type.STRING },
          },
          required: ['reason'],
        },
      },
    ],
  },
];

export async function initLiveController(refs: LiveRefs): Promise<void> {
  const session: ChatSession = loadChatSession(SESSION_ID) ?? createEmptySession(SESSION_ID);
  const audio = new LiveAudioManager();
  let liveSession: Session | null = null;
  let connecting = false;
  let assistantBuf = '';
  let userBuf = '';

  if (session.messages.length > 0 && refs.resumeBanner) {
    refs.resumeBanner.hidden = false;
  }
  renderAll();

  refs.micBtn.addEventListener('click', async () => {
    if (liveSession) {
      stopLive();
      return;
    }
    if (connecting) return;
    connecting = true;
    setStatus('接続中…');
    refs.micBtn.disabled = true;
    try {
      await startLive();
    } catch (err) {
      setStatus(`接続失敗: ${describeErr(err)}`);
      appendSystem(`音声セッション開始に失敗しました: ${describeErr(err)}`);
      stopLive();
    } finally {
      connecting = false;
      refs.micBtn.disabled = false;
    }
  });

  refs.textSend.addEventListener('click', () => sendText());
  refs.textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendText();
    }
  });

  refs.suggestRoot?.addEventListener('suggest-chip:select', (e) => {
    const detail = (e as CustomEvent<{ value: string }>).detail;
    refs.textInput.value = detail.value;
    sendText();
  });

  async function startLive(): Promise<void> {
    const res = await fetch('/api/live-token', { method: 'POST' });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`token mint ${res.status}: ${body}`);
    }
    const { token, model } = (await res.json()) as { token: string; model: string };

    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });
    liveSession = await ai.live.connect({
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        speechConfig: { languageCode: 'ja-JP' },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        tools: TOOLS,
      },
      callbacks: {
        onopen: () => {
          setStatus('🎙️ 話してください');
          refs.micBtn.textContent = '⏹ 終了';
        },
        onmessage: (msg) => handleServerMessage(msg),
        onerror: (e) => {
          const m = (e as { message?: string })?.message ?? String(e);
          setStatus(`エラー: ${m}`);
          appendSystem(`サーバーエラー: ${m}`);
        },
        onclose: (e) => {
          const reason = (e as { reason?: string })?.reason;
          setStatus(reason ? `切断: ${reason}` : '切断');
          liveSession = null;
          refs.micBtn.textContent = '🎙️ 話す';
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
    try {
      liveSession?.close();
    } catch {}
    liveSession = null;
    refs.micBtn.textContent = '🎙️ 話す';
    setStatus('停止しました');
  }

  function sendText(): void {
    const text = refs.textInput.value.trim();
    if (!text) return;
    refs.textInput.value = '';
    appendMessage({ role: 'user', text, ts: Date.now() });
    if (!liveSession) {
      appendSystem('まず🎙️ボタンで音声セッションを開始してください。');
      return;
    }
    liveSession.sendRealtimeInput({ text });
  }

  function handleServerMessage(msg: LiveServerMessage): void {
    // 1) 音声 chunk
    const parts = msg.serverContent?.modelTurn?.parts ?? [];
    for (const p of parts) {
      const mime = p.inlineData?.mimeType ?? '';
      const data = p.inlineData?.data;
      if (data && mime.startsWith('audio/pcm')) {
        audio.playPcm(data);
      }
    }

    // 2) 文字起こし (input / output)
    const inText = msg.serverContent?.inputTranscription?.text;
    if (inText) userBuf += inText;
    const outText = msg.serverContent?.outputTranscription?.text;
    if (outText) assistantBuf += outText;

    // 3) turn 完了でログ確定
    if (msg.serverContent?.turnComplete) {
      const u = userBuf.trim();
      const a = assistantBuf.trim();
      userBuf = '';
      assistantBuf = '';
      if (u) appendMessage({ role: 'user', text: u, ts: Date.now() });
      if (a) appendMessage({ role: 'assistant', text: a, ts: Date.now() });
    }

    // 4) tool call
    const calls = msg.toolCall?.functionCalls;
    if (calls && calls.length > 0 && liveSession) {
      const responses = calls.map((fc) => handleFunctionCall(fc));
      liveSession.sendToolResponse({ functionResponses: responses });
    }

    // 5) 割り込み（ユーザーが AI 発話に被せた）
    if (msg.serverContent?.interrupted) {
      audio.flushPlayback();
    }

    // 6) サーバ強制クローズ予告
    if (msg.goAway) {
      setStatus('まもなくセッションが終了します（再接続してください）');
    }
  }

  function handleFunctionCall(fc: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  }): { id: string; name: string; response: Record<string, unknown> } {
    const id = fc.id ?? '';
    const name = fc.name ?? '';
    try {
      if (name === 'update_progress') {
        const args = fc.args ?? {};
        const percent = clamp(Math.round(Number(args.percent) || 0), 0, 100);
        session.progress = percent;
        saveChatSession(session);
        renderProgress(String(args.section_title ?? ''));
        const suggestions = Array.isArray(args.suggestions)
          ? (args.suggestions as unknown[]).filter((s): s is string => typeof s === 'string')
          : [];
        updateSuggestions(suggestions);
        if (args.completed) appendSystem('問診が完了しました。');
      } else if (name === 'flag_emergency') {
        const reason = String((fc.args as { reason?: unknown })?.reason ?? '緊急の可能性');
        appendSystem(`⚠️ 緊急: ${reason} — 119 または救急受診を検討してください。`);
      }
      return { id, name, response: { result: 'ok' } };
    } catch (err) {
      return { id, name, response: { result: 'error', detail: String(err) } };
    }
  }

  function appendMessage(msg: ChatMessage): void {
    session.messages.push(msg);
    saveChatSession(session);
    renderMessage(msg);
    refs.log.scrollTop = refs.log.scrollHeight;
  }

  function appendSystem(text: string): void {
    appendMessage({ role: 'system', text, ts: Date.now() });
  }

  function setStatus(text: string): void {
    refs.status.textContent = text;
  }

  function renderAll(): void {
    refs.log.innerHTML = '';
    session.messages.forEach(renderMessage);
    renderProgress();
    refs.log.scrollTop = refs.log.scrollHeight;
  }

  function renderMessage(msg: ChatMessage): void {
    const wrap = document.createElement('div');
    wrap.className = 'flex w-full';
    const bubble = document.createElement('div');
    bubble.className = bubbleClass(msg.role);
    bubble.textContent = msg.text;
    if (msg.role === 'user') wrap.classList.add('justify-end');
    if (msg.role === 'system') wrap.classList.add('justify-center');
    wrap.appendChild(bubble);
    refs.log.appendChild(wrap);
  }

  function renderProgress(sectionTitle?: string): void {
    if (refs.progressFill) refs.progressFill.style.width = `${session.progress}%`;
    if (refs.progressText) refs.progressText.textContent = `${session.progress}%`;
    if (refs.progressSection && sectionTitle !== undefined) {
      refs.progressSection.textContent = sectionTitle ? ` — ${sectionTitle}` : '';
    }
  }

  function updateSuggestions(items: string[]): void {
    if (!refs.suggestRoot) return;
    refs.suggestRoot.dispatchEvent(
      new CustomEvent<{ items: string[] }>('suggest-chips:set', { detail: { items } }),
    );
  }
}

function bubbleClass(role: ChatMessage['role']): string {
  const base =
    'max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm shadow-sm';
  switch (role) {
    case 'user':
      return `${base} bg-brand-600 text-white`;
    case 'assistant':
      return `${base} bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100`;
    case 'system':
    default:
      return `${base} bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100`;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function describeErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
