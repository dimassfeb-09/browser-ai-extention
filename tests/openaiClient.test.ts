import { describe, expect, it } from 'vitest';
import { ChatCompletionsClient } from '../src/adapters/openai/client';
import type { PageSnapshot } from '../src/core/types';

const snapshot: PageSnapshot = {
  url: 'https://example.com/',
  title: 'Example',
  text: 'halo',
  capturedAt: 0,
  elements: [
    {
      index: 0,
      tag: 'button',
      label: 'Login',
      fingerprint: { tag: 'button', label: 'Login', cssPath: 'body > button' },
    },
  ],
};

function fakeFetchReturning(payload: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({
      ok,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }) as Response) as typeof fetch;
}

describe('ChatCompletionsClient', () => {
  it('maps a tool_call response into a validated Action', async () => {
    const client = new ChatCompletionsClient({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchFn: fakeFetchReturning({
        choices: [
          {
            message: {
              tool_calls: [
                { function: { name: 'browser_action', arguments: '{"type":"click","index":0}' } },
              ],
            },
          },
        ],
      }),
    });
    await expect(client.nextAction({ goal: 'login', snapshot, history: [] })).resolves.toEqual({
      type: 'click',
      index: 0,
    });
  });

  it('treats a plain text reply as done', async () => {
    const client = new ChatCompletionsClient({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchFn: fakeFetchReturning({ choices: [{ message: { content: 'Sudah selesai.' } }] }),
    });
    await expect(client.nextAction({ goal: 'x', snapshot, history: [] })).resolves.toEqual({
      type: 'done',
      summary: 'Sudah selesai.',
    });
  });

  it('throws a clean error on HTTP failure (without leaking the key)', async () => {
    const client = new ChatCompletionsClient({
      apiKey: 'sk-super-secret',
      model: 'gpt-4o-mini',
      fetchFn: fakeFetchReturning({ error: 'nope' }, false, 401),
    });
    await expect(client.nextAction({ goal: 'x', snapshot, history: [] })).rejects.toThrow(
      'OpenAI HTTP 401',
    );
    await expect(client.nextAction({ goal: 'x', snapshot, history: [] })).rejects.not.toThrow(
      'sk-super-secret',
    );
  });

  it('summarize returns the plain content of a tool-less completion', async () => {
    const client = new ChatCompletionsClient({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchFn: fakeFetchReturning({
        choices: [{ message: { content: '  Ringkasan: user subscribe, berhasil.  ' } }],
      }),
    });
    await expect(client.summarize('sys', 'USER: …')).resolves.toBe(
      'Ringkasan: user subscribe, berhasil.',
    );
  });

  it('summarize throws on an empty completion', async () => {
    const client = new ChatCompletionsClient({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchFn: fakeFetchReturning({ choices: [{ message: { content: ' ' } }] }),
    });
    await expect(client.summarize('sys', 'x')).rejects.toThrow('empty response');
  });
});
