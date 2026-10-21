import { describe, expect, it } from 'vitest';
import {
  activeSession,
  addMessage,
  buildConversation,
  clearSession,
  createSession,
  emptyChatState,
  ensureTabSession,
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
    state = ensureTabSession(state, 1, 11, 'tab1-session', 100);
    state = ensureTabSession(state, 1, 22, 'tab2-session', 101);
    expect(state.sessions).toHaveLength(2);
    expect(activeSession(state, 11)?.id).toBe('tab1-session');
    expect(activeSession(state, 22)?.id).toBe('tab2-session');

    // Reopening in window 1 must NOT create a third session.
    state = ensureTabSession(state, 1, 11, 'should-not-be-used', 102);
    expect(state.sessions).toHaveLength(2);
    expect(activeSession(state, 11)?.id).toBe('tab1-session');
  });

  it('startNewSession always creates a fresh session for that tab only', () => {
    let state = ensureTabSession(emptyChatState(), 1, 11, 'a', 100);
    state = startNewSession(state, 1, 11, 'b', 110);
    expect(state.sessions).toHaveLength(2);
    expect(activeSession(state, 11)?.id).toBe('b');
  });

  it('a window can open a session from history (shared list, per-window pointer)', () => {
    let state = ensureTabSession(emptyChatState(), 1, 11, 'a', 100);
    state = ensureTabSession(state, 1, 22, 'b', 101);
    state = setActiveSession(state, 22, 'a');
    expect(activeSession(state, 22)?.id).toBe('a');
    expect(activeSession(state, 11)?.id).toBe('a'); // tab 1 untouched value-wise
    expect(setActiveSession(state, 22, 'tidak-ada')).toBe(state);
  });

  it('removeSession also drops window bindings to it', () => {
    let state = ensureTabSession(emptyChatState(), 1, 11, 'a', 100);
    state = removeSession(state, 'a');
    expect(state.sessions).toHaveLength(0);
    expect(activeSession(state, 11)).toBeNull();
    state = ensureTabSession(state, 1, 11, 'baru', 200);
    expect(activeSession(state, 11)?.id).toBe('baru');
  });

  it('history is sorted by most recently updated', () => {
    let state = emptyChatState();
    state = upsertSession(state, { ...createSession('old', 1, 100), updatedAt: 100 });
    state = upsertSession(state, { ...createSession('new', 1, 100), updatedAt: 300 });
    state = upsertSession(state, { ...createSession('mid', 1, 100), updatedAt: 200 });
    expect(sortedSessions(state).map((s) => s.id)).toEqual(['new', 'mid', 'old']);
  });
});

describe('buildConversation + compact', () => {
  it('builds user/assistant turns and skips placeholders and local notices', () => {
    let s = createSession('s1', 1, 100);
    s = addMessage(s, msg('m1', 'user', 'Subscribe dong', 110));
    s = addMessage(s, { ...msg('m2', 'assistant', 'Working on it…', 111) });
    s = addMessage(s, { ...msg('m3', 'assistant', 'Berhasil subscribe.', 112), status: 'done' });
    s = addMessage(s, { ...msg('m4', 'assistant', 'Model switched.', 113), local: true });
    const turns = buildConversation(s);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(turns[1]?.content).toContain('(done) Berhasil subscribe.');
  });

  it('after /compact, folded messages are replaced by the pinned summary', () => {
    let s = createSession('s1', 1, 100);
    s = addMessage(s, msg('m1', 'user', 'Goal lama', 110));
    s = addMessage(s, { ...msg('m2', 'assistant', 'Hasil lama.', 120), status: 'done' });
    s = addMessage(s, msg('m3', 'user', 'Goal baru', 130));
    s = { ...s, compactSummary: 'User asked Goal lama; done: Hasil lama.', compactCutoff: 120 };
    const turns = buildConversation(s);
    expect(turns[0]?.content).toContain('[Compacted summary');
    expect(turns[0]?.content).toContain('Goal lama; done: Hasil lama.');
    expect(turns.map((t) => t.content)).not.toContain('Goal lama');
    expect(turns[1]).toEqual({ role: 'user', content: 'Goal baru' });
  });

  it('clearSession empties messages and compact memory but keeps identity', () => {
    let s = createSession('s1', 1, 100);
    s = addMessage(s, msg('m1', 'user', 'Halo', 110));
    s = { ...s, compactSummary: 'ringkasan', compactCutoff: 110 };
    const cleared = clearSession(s, 500);
    expect(cleared.id).toBe('s1');
    expect(cleared.messages).toEqual([]);
    expect(cleared.compactSummary).toBeUndefined();
    expect(cleared.title).toBe('New chat');
    expect(cleared.updatedAt).toBe(500);
  });
});
