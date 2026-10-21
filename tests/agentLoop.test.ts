import { describe, expect, it } from 'vitest';
import { runAgent } from '../src/core/agentLoop';
import type { BrowserDriver, Clock, LlmClient } from '../src/core/ports';
import type { Action, PageSnapshot } from '../src/core/types';

const fakeClock: Clock = { now: () => 0, sleep: async () => undefined };

function snap(url: string, label: string): PageSnapshot {
  return {
    url,
    title: 't',
    text: '',
    capturedAt: 0,
    elements: [
      {
        index: 0,
        tag: 'button',
        label,
        fingerprint: { tag: 'button', label, cssPath: 'body > button' },
      },
    ],
  };
}

/** Driver whose page changes after every successful act (like a real dynamic page). */
class FakeDriver implements BrowserDriver {
  private n = 0;
  async observe(): Promise<PageSnapshot> {
    return snap('https://example.com/', `step-page-${this.n}`);
  }
  async act(action: Action) {
    this.n++;
    return { ok: true, message: `did ${action.type}`, level: 0 };
  }
}

class ScriptedLlm implements LlmClient {
  constructor(private readonly script: Action[]) {}
  async nextAction(): Promise<Action> {
    const next = this.script.shift();
    if (!next) throw new Error('script exhausted');
    return next;
  }
}

describe('runAgent', () => {
  it('runs observe -> act -> observe -> done and records history', async () => {
    const result = await runAgent('klik tombolnya', {
      driver: new FakeDriver(),
      llm: new ScriptedLlm([
        { type: 'click', index: 0 },
        { type: 'done', summary: 'sudah diklik' },
      ]),
      clock: fakeClock,
    });
    expect(result.status).toBe('done');
    expect(result.summary).toBe('sudah diklik');
    expect(result.history).toHaveLength(2);
    expect(result.history[0]?.result?.ok).toBe(true);
  });

  it('stops at max_steps', async () => {
    const result = await runAgent('tidak selesai', {
      driver: new FakeDriver(),
      llm: new ScriptedLlm(
        Array.from({ length: 10 }, () => ({ type: 'click', index: 0 }) as Action),
      ),
      clock: fakeClock,
      maxSteps: 3,
    });
    expect(result.status).toBe('max_steps');
    expect(result.history).toHaveLength(3);
  });

  it('detects a stuck page (snapshot never changes, model keeps clicking)', async () => {
    const staticDriver: BrowserDriver = {
      observe: async () => snap('https://example.com/', 'selalu-sama'),
      act: async () => ({ ok: true, message: 'clicked (nothing happened)', level: 0 }),
    };
    const result = await runAgent('stuck', {
      driver: staticDriver,
      llm: new ScriptedLlm(
        Array.from({ length: 10 }, () => ({ type: 'click', index: 0 }) as Action),
      ),
      clock: fakeClock,
    });
    expect(result.status).toBe('stuck');
  });

  it('returns needs_user on ask_user', async () => {
    const result = await runAgent('login', {
      driver: new FakeDriver(),
      llm: new ScriptedLlm([{ type: 'ask_user', question: 'OTP-nya berapa?' }]),
      clock: fakeClock,
    });
    expect(result.status).toBe('needs_user');
    expect(result.summary).toBe('OTP-nya berapa?');
  });

  it('honors the abort signal', async () => {
    const result = await runAgent('batal', {
      driver: new FakeDriver(),
      llm: new ScriptedLlm([{ type: 'done', summary: 'x' }]),
      clock: fakeClock,
      signal: { aborted: true },
    });
    expect(result.status).toBe('aborted');
    expect(result.history).toHaveLength(0);
  });

  it('turns observe failures into an error result instead of throwing', async () => {
    const broken: BrowserDriver = {
      observe: async () => {
        throw new Error('tab gone');
      },
      act: async () => ({ ok: true, message: '', level: 0 }),
    };
    const result = await runAgent('x', {
      driver: broken,
      llm: new ScriptedLlm([]),
      clock: fakeClock,
    });
    expect(result.status).toBe('error');
    expect(result.summary).toContain('tab gone');
  });
});
