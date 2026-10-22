import type { ChatMessage, ChatSession, ChatState, ConversationTurn } from './types';
import { describeAction } from './agentLoop';
import { parseJsonLoose } from './tools';

/**
 * Pure chat-state logic (ChatGPT/Gemini-style history with per-window
 * sessions). No storage, no chrome APIs — the store is a port, ids and
 * timestamps are passed in, so all of this is unit-testable.
 */

export const NEW_CHAT_TITLE = 'New chat';

export function emptyChatState(): ChatState {
  return { sessions: [], byTab: {} };
}

export function createSession(id: string, windowId: number, now: number, tabId?: number): ChatSession {
  return { id, windowId, tabId, title: NEW_CHAT_TITLE, createdAt: now, updatedAt: now, messages: [] };
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

export function activeSession(state: ChatState, tabId: number): ChatSession | null {
  const id = state.byTab[tabId];
  if (!id) return null;
  return state.sessions.find((s) => s.id === id) ?? null;
}

/**
 * Guarantee the tab has an active session: resume its own if it still
 * exists, otherwise create a fresh one bound to this tab. This is what
 * makes "different tab = different session" work — the panel follows
 * the active tab and each tab keeps its own chat.
 */
export function ensureTabSession(
  state: ChatState,
  windowId: number,
  tabId: number,
  newId: string,
  now: number,
): ChatState {
  if (activeSession(state, tabId)) return state;
  const session = createSession(newId, windowId, now, tabId);
  return {
    sessions: [...state.sessions, session],
    byTab: { ...state.byTab, [tabId]: session.id },
  };
}

/** Always start a brand-new session and bind the tab to it ("+ New chat"). */
export function startNewSession(
  state: ChatState,
  windowId: number,
  tabId: number,
  newId: string,
  now: number,
): ChatState {
  const session = createSession(newId, windowId, now, tabId);
  return {
    sessions: [...state.sessions, session],
    byTab: { ...state.byTab, [tabId]: session.id },
  };
}

/** Point a tab at an existing session (user picked it from history). */
export function setActiveSession(state: ChatState, tabId: number, sessionId: string): ChatState {
  if (!state.sessions.some((s) => s.id === sessionId)) return state;
  return { ...state, byTab: { ...state.byTab, [tabId]: sessionId } };
}

/** Empty a session in place (/reset): messages and compacted memory
 *  go away, the session (and its place in history) stays. */
export function clearSession(session: ChatSession, now: number): ChatSession {
  return {
    ...session,
    title: NEW_CHAT_TITLE,
    messages: [],
    compactSummary: undefined,
    compactCutoff: undefined,
    updatedAt: now,
  };
}

/** Compact digest of what a finished run actually DID, extracted from
 *  its step log — summaries alone can under-report (one run may save
 *  several records), and the model needs the actions to answer
 *  follow-ups like "how many did you add?" truthfully. */
export function actionsDigest(steps: string[]): string {
  const parts: string[] = [];
  for (const line of steps) {
    if (!line.startsWith('action: ')) continue;
    try {
      const parsed = parseJsonLoose(line.slice('action: '.length)) as {
        action?: Parameters<typeof describeAction>[0];
      };
      const a = parsed.action;
      if (!a || a.type === 'done' || a.type === 'ask_user') continue;
      parts.push(
        a.type === 'type'
          ? `${describeAction(a)} ${JSON.stringify((a as { text: string }).text.slice(0, 40))}`
          : describeAction(a),
      );
    } catch {
      // A truncated log line is not worth failing the send over.
    }
    if (parts.length >= 15) break;
  }
  return parts.join('; ');
}

/**
 * Earlier exchanges of a chat, handed to the next run so the model
 * remembers its own previous goals, results and actions. Local UI
 * notices are excluded. When the chat was /compact-ed, messages up to
 * the cutoff are replaced by the stored summary (kept pinned even when
 * many newer turns follow).
 */
export function buildConversation(session: ChatSession): ConversationTurn[] {
  const cutoff = session.compactCutoff ?? 0;
  const turns: ConversationTurn[] = [];
  for (const m of session.messages) {
    if (m.ts <= cutoff || m.local) continue;
    if (m.role === 'user') {
      turns.push({ role: 'user', content: m.content.slice(0, 500) });
    } else if (m.content && m.content !== 'Working on it…') {
      const digest = actionsDigest(m.steps ?? []);
      const content =
        (m.status ? `(${m.status}) ` : '') +
        m.content.slice(0, 600) +
        (digest ? `\nActions taken: ${digest}` : '');
      turns.push({ role: 'assistant', content });
    }
  }
  const recent = turns.slice(session.compactSummary ? -7 : -8);
  return session.compactSummary
    ? [
        {
          role: 'assistant',
          content: `[Compacted summary of the earlier conversation] ${session.compactSummary}`,
        },
        ...recent,
      ]
    : recent;
}

/** Remove a session and every window binding that pointed at it. */
export function removeSession(state: ChatState, sessionId: string): ChatState {
  const byTab = Object.fromEntries(
    Object.entries(state.byTab).filter(([, id]) => id !== sessionId),
  ) as Record<number, string>;
  return { sessions: state.sessions.filter((s) => s.id !== sessionId), byTab };
}
