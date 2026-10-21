import type { ChatMessage, ChatSession, ChatState } from './types';

/**
 * Pure chat-state logic (ChatGPT/Gemini-style history with per-window
 * sessions). No storage, no chrome APIs — the store is a port, ids and
 * timestamps are passed in, so all of this is unit-testable.
 */

export const NEW_CHAT_TITLE = 'New chat';

export function emptyChatState(): ChatState {
  return { sessions: [], byWindow: {} };
}

export function createSession(id: string, windowId: number, now: number): ChatSession {
  return { id, windowId, title: NEW_CHAT_TITLE, createdAt: now, updatedAt: now, messages: [] };
}

/** Session title comes from the first user message, ChatGPT-style. */
export function titleFromText(text: string, max = 42): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return NEW_CHAT_TITLE;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function addMessage(session: ChatSession, message: ChatMessage): ChatSession {
  const messages = [...session.messages, message];
  const title =
    session.title === NEW_CHAT_TITLE && message.role === 'user'
      ? titleFromText(message.content)
      : session.title;
  return { ...session, messages, title, updatedAt: message.ts };
}

export function upsertSession(state: ChatState, session: ChatSession): ChatState {
  const exists = state.sessions.some((s) => s.id === session.id);
  return {
    ...state,
    sessions: exists
      ? state.sessions.map((s) => (s.id === session.id ? session : s))
      : [...state.sessions, session],
  };
}

export function sortedSessions(state: ChatState): ChatSession[] {
  return [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function activeSession(state: ChatState, windowId: number): ChatSession | null {
  const id = state.byWindow[windowId];
  if (!id) return null;
  return state.sessions.find((s) => s.id === id) ?? null;
}

/**
 * Guarantee the window has an active session: resume its own if it
 * still exists, otherwise create a fresh one bound to this window.
 * This is what makes "different window = different session" work.
 */
export function ensureWindowSession(
  state: ChatState,
  windowId: number,
  newId: string,
  now: number,
): ChatState {
  if (activeSession(state, windowId)) return state;
  const session = createSession(newId, windowId, now);
  return {
    sessions: [...state.sessions, session],
    byWindow: { ...state.byWindow, [windowId]: session.id },
  };
}

/** Always start a brand-new session and bind the window to it ("+ New chat"). */
export function startNewSession(
  state: ChatState,
  windowId: number,
  newId: string,
  now: number,
): ChatState {
  const session = createSession(newId, windowId, now);
  return {
    sessions: [...state.sessions, session],
    byWindow: { ...state.byWindow, [windowId]: session.id },
  };
}

/** Point a window at an existing session (user picked it from history). */
export function setActiveSession(state: ChatState, windowId: number, sessionId: string): ChatState {
  if (!state.sessions.some((s) => s.id === sessionId)) return state;
  return { ...state, byWindow: { ...state.byWindow, [windowId]: sessionId } };
}

/** Remove a session and every window binding that pointed at it. */
export function removeSession(state: ChatState, sessionId: string): ChatState {
  const byWindow = Object.fromEntries(
    Object.entries(state.byWindow).filter(([, id]) => id !== sessionId),
  ) as Record<number, string>;
  return { sessions: state.sessions.filter((s) => s.id !== sessionId), byWindow };
}
