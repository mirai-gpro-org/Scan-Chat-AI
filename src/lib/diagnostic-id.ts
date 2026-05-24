/**
 * docs/diagnostic_session_data_spec.md §2.2 準拠の diagnostic_id 発番・永続化。
 *
 * - 形式: 標準 UUID v4
 * - 発番者: Scan-Chat-AI クライアント (将来マイページ側に移譲する可能性あり)
 * - 発番タイミング: 撮影開始時 (= 最初に getOrCreateDiagnosticId が呼ばれた時)
 * - 永続化: クライアント localStorage (Phase 0)。
 *   Phase 1 以降は Supabase / API に同期される予定。
 */

const STORAGE_KEY = 'scan-chat-ai.diagnostic_id';

/**
 * localStorage に既存の diagnostic_id があれば返す。
 * 無ければ UUID v4 を新規発番して保存し、それを返す。
 */
export function getOrCreateDiagnosticId(): string {
  if (typeof window === 'undefined') return '';
  let id = window.localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = window.crypto.randomUUID();
    window.localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}

/** 「新しい検査セッションを開始する」用。明示的なユーザー操作でのみ呼ぶこと。 */
export function resetDiagnosticId(): string {
  if (typeof window === 'undefined') return '';
  const id = window.crypto.randomUUID();
  window.localStorage.setItem(STORAGE_KEY, id);
  return id;
}

/** 現在の diagnostic_id を取得。無ければ null。 */
export function peekDiagnosticId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(STORAGE_KEY);
}
