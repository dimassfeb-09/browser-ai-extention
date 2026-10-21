import { describe, expect, it } from 'vitest';
import {
  activeSession,
  addMessage,
  createSession,
  emptyChatState,
  ensureWindowSession,
  removeSession,
  setActiveSession,
  sortedSessions,
  startNewSession,
  titleFromText,
  upsertSession,
} from '../src/core/chat';
import type { ChatMessage } from '../src/core/types';

const msg = (id: string, role: 'user' | 'assistant', content: string, ts: number): ChatMessage => ({
  id,
  role,
  content,
  ts,
});

describe('chat sessions', () => {
  it('title comes from the first user message, and only the first', () => {
    let s = createSession('s1', 1, 100);
    s = addMessage(s, msg('m1', 'user', 'Isi form pendaftaran siswa baru', 110));
    expect(s.title).toBe('Isi form pendaftaran siswa baru');
    s = addMessage(s, msg('m2', 'user', 'Pesan kedua tidak mengganti judul', 120));
    expect(s.title).toBe('Isi form pendaftaran siswa baru');
    expect(s.updatedAt).toBe(120);
    expect(s.messages).toHaveLength(2);
  });

  it('titleFromText truncates long goals', () => {
    const t = titleFromText('a'.repeat(100));
    expect(t.length).toBe(42);
    expect(t.endsWith('…')).toBe(true);
    expect(titleFromText('   ')).toBe('New chat');
  });

  it('different windows get different sessions; same window resumes its own', () => {
    let state = emptyChatState();
    state = ensureWindowSession(state, 1, 'win1-session', 100);
    state = ensureWindowSession(state, 2, 'win2-session', 101);
    expect(state.sessions).toHaveLength(2);
    expect(activeSession(state, 1)?.id).toBe('win1-session');
    expect(activeSession(state, 2)?.id).toBe('win2-session');

    // Reopening in window 1 must NOT create a third session.
    state = ensureWindowSession(state, 1, 'should-not-be-used', 102);
    expect(state.sessions).toHaveLength(2);
    expect(activeSession(state, 1)?.id).toBe('win1-session');
  });

  it('startNewSession always creates a fresh session for that window only', () => {
    let state = ensureWindowSession(emptyChatState(), 1, 'a', 100);
    state = startNewSession(state, 1, 'b', 110);
    expect(state.sessions).toHaveLength(2);
    expect(activeSession(state, 1)?.id).toBe('b');
  });

  it('a window can open a session from history (shared list, per-window pointer)', () => {
    let state = ensureWindowSession(emptyChatState(), 1, 'a', 100);
    state = ensureWindowSession(state, 2, 'b', 101);
    state = setActiveSession(state, 2, 'a');
    expect(activeSession(state, 2)?.id).toBe('a');
    expect(activeSession(state, 1)?.id).toBe('a'); // window 1 untouched value-wise
    expect(setActiveSession(state, 2, 'tidak-ada')).toBe(state);
  });

  it('removeSession also drops window bindings to it', () => {
    let state = ensureWindowSession(emptyChatState(), 1, 'a', 100);
    state = removeSession(state, 'a');
    expect(state.sessions).toHaveLength(0);
    expect(activeSession(state, 1)).toBeNull();
    state = ensureWindowSession(state, 1, 'baru', 200);
    expect(activeSession(state, 1)?.id).toBe('baru');
  });

  it('history is sorted by most recently updated', () => {
    let state = emptyChatState();
    state = upsertSession(state, { ...createSession('old', 1, 100), updatedAt: 100 });
    state = upsertSession(state, { ...createSession('new', 1, 100), updatedAt: 300 });
    state = upsertSession(state, { ...createSession('mid', 1, 100), updatedAt: 200 });
    expect(sortedSessions(state).map((s) => s.id)).toEqual(['new', 'mid', 'old']);
  });
});
