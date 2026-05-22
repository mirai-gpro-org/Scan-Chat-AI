/**
 * チャット雛形コントローラ。
 * /api/chat は構造化レスポンス { text, section:{id,title,percent}, suggestions[], completed } を返す。
 * 音声 LiveAPI への接続は次フェーズ（PUBLIC_VOICE_BACKEND_URL）。
 */

import {
  createEmptySession,
  loadChatSession,
  saveChatSession,
  type ChatMessage,
  type ChatSession,
} from '../lib/session-store';

interface ChatRefs {
  log: HTMLElement;
  input: HTMLTextAreaElement;
  send: HTMLButtonElement;
  progressFill: HTMLElement | null;
  progressText: HTMLElement | null;
  progressSection: HTMLElement | null;
  resumeBanner: HTMLElement | null;
  toggleRoot: HTMLElement | null;
  suggestRoot: HTMLElement | null;
}

interface ChatResponse {
  text: string;
  section?: { id: string; title: string; percent: number };
  suggestions?: string[];
  completed?: boolean;
}

const SESSION_ID = 'default';

export function initChatController(refs: ChatRefs): void {
  const session: ChatSession = loadChatSession(SESSION_ID) ?? createEmptySession(SESSION_ID);
  let mode: 'text' | 'voice' = 'text';
  let currentSectionId = 'basic';

  if (session.messages.length > 0 && refs.resumeBanner) {
    refs.resumeBanner.hidden = false;
  }
  renderAll();

  refs.send.addEventListener('click', () => handleSubmit());
  refs.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  });

  refs.toggleRoot?.addEventListener('chat-toggle:change', (e) => {
    const detail = (e as CustomEvent<{ mode: 'text' | 'voice' }>).detail;
    mode = detail.mode;
    if (mode === 'voice') {
      appendSystem('音声モードは次フェーズで接続予定です（PUBLIC_VOICE_BACKEND_URL）。');
    }
  });

  refs.suggestRoot?.addEventListener('suggest-chip:select', (e) => {
    const detail = (e as CustomEvent<{ value: string }>).detail;
    refs.input.value = detail.value;
    // チップ選択は即送信（提案書「親指1つでポンポンと選択」UX）
    handleSubmit();
  });

  async function handleSubmit(): Promise<void> {
    const text = refs.input.value.trim();
    if (!text) return;
    refs.input.value = '';
    appendMessage({ role: 'user', text, ts: Date.now() });
    setBusy(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: session.messages.map(({ role, text }) => ({ role, text })),
          currentSection: currentSectionId,
        }),
      });
      if (!res.ok) {
        const detail = await safeJson(res);
        appendSystem(`通信エラー (${res.status}): ${detail?.error ?? '不明'}`);
        return;
      }
      const data = (await res.json()) as ChatResponse;
      const reply = (data.text ?? '').trim() || '（応答が空でした）';
      appendMessage({ role: 'assistant', text: reply, ts: Date.now() });

      if (data.section) {
        currentSectionId = data.section.id;
        session.progress = Math.max(0, Math.min(100, Math.round(data.section.percent ?? 0)));
        saveChatSession(session);
        renderProgress(`${data.section.title}`);
      }
      updateSuggestions(data.suggestions ?? []);
    } catch (err) {
      appendSystem(`通信エラー: ${String(err)}`);
    } finally {
      setBusy(false);
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

  function setBusy(busy: boolean): void {
    refs.send.disabled = busy;
    refs.input.disabled = busy;
    refs.send.textContent = busy ? '送信中…' : '送信';
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
    if (refs.progressFill) {
      refs.progressFill.style.width = `${session.progress}%`;
    }
    if (refs.progressText) {
      refs.progressText.textContent = `${session.progress}%`;
    }
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

async function safeJson(res: Response): Promise<{ error?: string } | null> {
  try {
    return (await res.json()) as { error?: string };
  } catch {
    return null;
  }
}
