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

  it('sends the marked screenshot as an image part when the snapshot has one', async () => {
    const bodies: Array<{ messages: Array<{ content: unknown }> }> = [];
    const fetchFn = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({
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
        text: async () => '',
      } as Response;
    }) as typeof fetch;
    const client = new ChatCompletionsClient({ apiKey: 'sk-test', model: 'gpt-4o-mini', fetchFn });
    const withShot: PageSnapshot = { ...snapshot, screenshot: 'data:image/jpeg;base64,AAAA' };
    await expect(client.nextAction({ goal: 'jawab', snapshot: withShot, history: [] })).resolves.toEqual({
      type: 'click',
      index: 0,
    });
    const content = bodies[0]!.messages[1]!.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content.find((part) => part.type === 'image_url')).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,AAAA' },
    });
  });

  it('falls back to text-only for the rest of the run when the endpoint rejects images', async () => {
    const bodies: Array<{ messages: Array<{ content: unknown }> }> = [];
    let calls = 0;
    const fetchFn = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      calls++;
      if (calls === 1) {
        return {
          ok: false,
          status: 400,
          text: async () => 'This model does not support image input.',
          json: async () => ({}),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                tool_calls: [
                  { function: { name: 'browser_action', arguments: '{"type":"done","summary":"ok"}' } },
                ],
              },
            },
          ],
        }),
        text: async () => '',
      } as Response;
    }) as typeof fetch;
    const client = new ChatCompletionsClient({ apiKey: 'sk-test', model: 'text-only-model', fetchFn });
    const withShot: PageSnapshot = { ...snapshot, screenshot: 'data:image/jpeg;base64,AAAA' };
    await expect(client.nextAction({ goal: 'g', snapshot: withShot, history: [] })).resolves.toEqual({
      type: 'done',
      summary: 'ok',
    });
    expect(calls).toBe(2);
    expect(typeof bodies[1]!.messages[1]!.content).toBe('string');
    // Sticky: the next step does not try the image again.
    await client.nextAction({ goal: 'g', snapshot: withShot, history: [] });
    expect(calls).toBe(3);
    expect(typeof bodies[2]!.messages[1]!.content).toBe('string');
  });
});
