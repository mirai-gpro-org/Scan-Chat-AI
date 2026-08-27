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
 * 氏名・生年月日・生物学的性別は問診で尋ねず、顧客DBから内部取得した値
 * (`userName` / `dateOfBirth` / `sex`) を付与する。
 * `answers` は設問 id → 回答値のマップ。
 */
export interface InterviewResult {
  id: string;
  diagnosticUserId: string | null;
  /** 内部で取得済のユーザー名 (customer.family_name) */
  userName: string | null;
  /** 内部で取得済の生年月日 (customer.date_of_birth) */
  dateOfBirth: string | null;
  /** 内部で取得済の生物学的性別 (customer.sex) */
  sex: string | null;
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

/**
 * 問診の途中経過 (中止して再開するため)。
 *
 * `InterviewResult` は**完了時にだけ**書かれるので、途中で中止すると回答が消えていた。
 * 「回答済の問診を記憶して中止する」を選んだときにここへ退避し、次回の開始時に復元する。
 * 「回答を全てクリアして中止する」を選んだときは削除する。
 *
 * PII は入れない (問診の回答 id → 値だけ。氏名・生年月日は customer 側にのみ存在する)。
 */
export interface InterviewProgress {
  id: string;
  /** 設問 id → 回答値 */
  answers: Record<string, string | string[] | number>;
  /** 申込情報等から供給済でユーザーに提示しない設問 id (例 EXAM-TYPE) */
  seeded: string[];
  /** 中止した時点で表示していた設問 id。null なら先頭から。 */
  currentId: string | null;
  updatedAt: number;
}

export function saveInterviewProgress(progress: Omit<InterviewProgress, 'updatedAt'>): void {
  const store = safeStorage();
  if (!store) return;
  const next: InterviewProgress = { ...progress, updatedAt: Date.now() };
  store.setItem(`${KEY_PREFIX}progress:${progress.id}`, JSON.stringify(next));
}

export function loadInterviewProgress(id = 'default'): InterviewProgress | null {
  const store = safeStorage();
  if (!store) return null;
  const raw = store.getItem(`${KEY_PREFIX}progress:${id}`);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as InterviewProgress;
    // 壊れた値で復元して落ちないよう最低限だけ検証する
    if (!p || typeof p !== 'object' || typeof p.answers !== 'object' || p.answers === null) return null;
    return { ...p, seeded: Array.isArray(p.seeded) ? p.seeded : [] };
  } catch {
    return null;
  }
}

export function clearInterviewProgress(id = 'default'): void {
  const store = safeStorage();
  if (!store) return;
  store.removeItem(`${KEY_PREFIX}progress:${id}`);
}
