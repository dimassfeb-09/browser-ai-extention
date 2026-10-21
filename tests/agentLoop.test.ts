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

  it('warns the model when an action had no effect, and lets it recover', async () => {
    // Regression test for the real Master Data failure log: a click that
    // changed nothing used to abort the run as "stuck" on the 3rd identical
    // observation, without the model ever being told.
    const notices: Array<string | undefined> = [];
    const script: Action[] = [
      { type: 'click', index: 0 },
      { type: 'click', index: 0 },
      { type: 'done', summary: 'recovered' },
    ];
    const llm: LlmClient = {
      nextAction: async (input) => {
        notices.push(input.notice);
        const next = script.shift();
        if (!next) throw new Error('script exhausted');
        return next;
      },
    };
    const staticDriver: BrowserDriver = {
      observe: async () => snap('https://example.com/', 'selalu-sama'),
      act: async () => ({ ok: true, message: 'clicked (nothing happened)', level: 0 }),
    };
    const result = await runAgent('coba lagi', {
      driver: staticDriver,
      llm,
      clock: fakeClock,
    });
    expect(result.status).toBe('done');
    expect(notices[0]).toBeUndefined();
    expect(notices[1]).toContain('did NOT change');
    expect(notices[2]).toContain('did NOT change');
  });

  it('passes the conversation history through to the LLM (cross-run memory)', async () => {
    const seen: Array<unknown> = [];
    const llm: LlmClient = {
      nextAction: async (input) => {
        seen.push(input.conversation);
        return { type: 'done', summary: 'ok' };
      },
    };
    const conversation = [
      { role: 'user', content: 'Fill randomly value' } as const,
      { role: 'assistant', content: '(done) Filled and saved one record.' } as const,
    ];
    await runAgent('berapa yang kamu tambah?', {
      driver: new FakeDriver(),
      llm,
      clock: fakeClock,
      conversation,
    });
    expect(seen[0]).toEqual(conversation);
  });

  it('warns after navigation that a submit likely completed the goal (no re-fill)', async () => {
    // Regression: one "fill randomly" goal produced THREE saved records —
    // after the save the page navigated to the list and the model simply
    // started the form again, with nothing telling it the job was done.
    let observed = 0;
    const navDriver: BrowserDriver = {
      observe: async () => {
        observed++;
        return observed === 1
          ? snap('https://example.com/form', 'form')
          : snap('https://example.com/list', 'list');
      },
      act: async () => ({ ok: true, message: 'ok', level: 0 }),
    };
    const notices: Array<string | undefined> = [];
    const llm: LlmClient = {
      nextAction: async (input) => {
        notices.push(input.notice);
        return notices.length === 1
          ? { type: 'click', index: 0 }
          : { type: 'done', summary: 'verified in list' };
      },
    };
    const result = await runAgent('fill one record', { driver: navDriver, llm, clock: fakeClock });
    expect(result.status).toBe('done');
    expect(notices[0]).toBeUndefined();
    expect(notices[1]).toContain('navigated');
    expect(notices[1]).toContain('do NOT start the same form again');
  });

  it('stops a model that insists on the identical no-effect action, without executing it endlessly', async () => {
    let actCount = 0;
    const staticDriver: BrowserDriver = {
      observe: async () => snap('https://example.com/', 'selalu-sama'),
      act: async () => {
        actCount++;
        return { ok: true, message: 'clicked (nothing happened)', level: 0 };
      },
    };
    const result = await runAgent('ngeyel', {
      driver: staticDriver,
      llm: new ScriptedLlm(
        Array.from({ length: 10 }, () => ({ type: 'click', index: 0 }) as Action),
      ),
      clock: fakeClock,
    });
    expect(result.status).toBe('stuck');
    expect(result.summary).toContain('click [0]');
    expect(actCount).toBe(2); // 3rd identical proposal is refused, not executed
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
