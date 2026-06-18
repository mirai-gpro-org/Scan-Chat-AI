/**
 * チャット / スキャンのレジューム用 localStorage ラッパ。
 * SSR からも import される可能性があるので `typeof window` ガードを徹底。
 */

const KEY_PREFIX = 'scan-chat-ai:';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  ts: number;
}

export interface ChatSession {
  id: string;
  messages: ChatMessage[];
  /** 0-100 の進捗（問診完了度） */
  progress: number;
  updatedAt: number;
}

function safeStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadChatSession(id = 'default'): ChatSession | null {
  const store = safeStorage();
  if (!store) return null;
  const raw = store.getItem(`${KEY_PREFIX}chat:${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ChatSession;
  } catch {
    return null;
  }
}

export function saveChatSession(session: ChatSession): void {
  const store = safeStorage();
  if (!store) return;
  const next: ChatSession = { ...session, updatedAt: Date.now() };
  store.setItem(`${KEY_PREFIX}chat:${session.id}`, JSON.stringify(next));
}

export function clearChatSession(id = 'default'): void {
  const store = safeStorage();
  if (!store) return;
  store.removeItem(`${KEY_PREFIX}chat:${id}`);
}

export function createEmptySession(id = 'default'): ChatSession {
  return { id, messages: [], progress: 0, updatedAt: Date.now() };
}

/**
 * 問診結果ファイル。
 * 氏名は問診で尋ねず、内部で取得済のユーザー名 (`userName`) を付与する。
 * `answers` は設問 id → 回答値のマップ。
 */
export interface InterviewResult {
  id: string;
  diagnosticUserId: string | null;
  /** 内部で取得済のユーザー名 (customer.family_name) */
  userName: string | null;
  answers: Record<string, string | string[] | number>;
  completedAt: number;
}

export function saveInterviewResult(result: InterviewResult): void {
  const store = safeStorage();
  if (!store) return;
  store.setItem(`${KEY_PREFIX}result:${result.id}`, JSON.stringify(result));
}

export function loadInterviewResult(id = 'default'): InterviewResult | null {
  const store = safeStorage();
  if (!store) return null;
  const raw = store.getItem(`${KEY_PREFIX}result:${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as InterviewResult;
  } catch {
    return null;
  }
}

export function clearInterviewResult(id = 'default'): void {
  const store = safeStorage();
  if (!store) return;
  store.removeItem(`${KEY_PREFIX}result:${id}`);
}
