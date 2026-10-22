import type { LlmClient } from '../../core/ports';
import type { Action } from '../../core/types';
import { actionFromToolArgs, parseJsonLoose, toolDefinitions } from '../../core/tools';
import { buildSystemPrompt, buildUserPrompt } from '../../core/prompts';

export interface OpenAiConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
  fetchFn?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
    };
  }>;
}

/**
 * Thin chat-completions client over fetch (no SDK): full control over
 * the tool loop, and trivially mockable in tests via fetchFn.
 * BYOK — the key comes from extension storage, set by the user.
 */
export class ChatCompletionsClient implements LlmClient {
  private readonly baseURL: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly config: OpenAiConfig) {
    this.baseURL = (config.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    // Wrap the global fetch: calling a stored bare `fetch` reference as a
    // method throws "Illegal invocation" in a real browser.
    this.fetchFn = config.fetchFn ?? ((...args) => fetch(...args));
  }

  async nextAction(input: Parameters<LlmClient['nextAction']>[0]): Promise<Action> {
    const res = await this.fetchFn(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          {
            role: 'user',
            content: buildUserPrompt(input.goal, input.snapshot, input.history, input.notice, input.conversation),
          },
        ],
        tools: toolDefinitions,
        tool_choice: { type: 'function', function: { name: 'browser_action' } },
        stream: true,
      }),
    });

    if (!res.ok) {
      const body = await (typeof res.text === 'function' ? res.text() : Promise.resolve('')).catch(() => '');
      throw new Error(`OpenAI HTTP ${res.status}: ${body.slice(0, 300)}`);
    }

    const contentType = (res.headers?.get?.('content-type') ?? '').toLowerCase();
    // Non-streaming fallback (e.g. test fakes or proxies that ignore stream=true).
    if (!contentType.includes('text/event-stream') || !res.body) {
      const data = (await (typeof res.json === 'function' ? res.json() : Promise.resolve({}))) as ChatCompletionResponse;
      const message = data.choices?.[0]?.message;
      const toolCall = message?.tool_calls?.[0];
      if (toolCall?.function?.arguments) {
        return actionFromToolArgs(toolCall.function.arguments);
      }
      if (message?.content) {
        return { type: 'done', summary: message.content.slice(0, 2_000) };
      }
      throw new Error('OpenAI response had neither a tool call nor content.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let toolArgs = '';
    let rawText = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      rawText += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json: any;
        try { json = parseJsonLoose(payload); } catch { continue; }
        const delta = json?.choices?.[0]?.delta;
        if (typeof delta?.content === 'string' && delta.content) {
          content += delta.content;
          input.onToken?.(delta.content);
        }
        const tc = delta?.tool_calls?.[0];
        if (typeof tc?.function?.arguments === 'string') {
          toolArgs += tc.function.arguments;
        }
      }
    }
    if (buffer.trim().startsWith('data:')) {
      const payload = buffer.trim().slice(5).trim();
      if (payload && payload !== '[DONE]') {
        try {
          const json = parseJsonLoose(payload) as any;
          const delta = json?.choices?.[0]?.delta;
          if (typeof delta?.content === 'string' && delta.content) {
            content += delta.content;
            input.onToken?.(delta.content);
          }
          const tc = delta?.tool_calls?.[0];
          if (typeof tc?.function?.arguments === 'string') toolArgs += tc.function.arguments;
        } catch {
          // ignore trailing parse errors
        }
      }
    }

    if (!toolArgs.trim() && !content) {
      // Some providers/proxies ignore stream=true but still return JSON
      // (or wrap it without SSE framing). Try to recover from the raw body.
      try {
        const data = parseJsonLoose(rawText) as ChatCompletionResponse;
        const message = data.choices?.[0]?.message;
        const toolCall = message?.tool_calls?.[0];
        if (toolCall?.function?.arguments) {
          return actionFromToolArgs(toolCall.function.arguments);
        }
        if (message?.content) {
          return { type: 'done', summary: message.content.slice(0, 2_000) };
        }
      } catch {
        // fall through to non-stream fallback
      }
      // Fallback for providers/proxies that do not actually stream: retry
      // without stream=true and parse as plain JSON (pre-streaming behavior).
      try {
        const res2 = await this.fetchFn(`${this.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify({
            model: this.config.model,
            messages: [
              { role: 'system', content: buildSystemPrompt() },
              {
                role: 'user',
                content: buildUserPrompt(input.goal, input.snapshot, input.history, input.notice, input.conversation),
              },
            ],
            tools: toolDefinitions,
            tool_choice: { type: 'function', function: { name: 'browser_action' } },
            stream: false,
          }),
        });
        if (res2.ok) {
          const data = (await (typeof res2.json === 'function' ? res2.json() : Promise.resolve({}))) as ChatCompletionResponse;
          const message = data.choices?.[0]?.message;
          const toolCall = message?.tool_calls?.[0];
          if (toolCall?.function?.arguments) return actionFromToolArgs(toolCall.function.arguments);
          if (message?.content) return { type: 'done', summary: message.content.slice(0, 2_000) };
        }
      } catch {
        // fall through
      }
      throw new Error(`OpenAI response had neither a tool call nor content. Raw: ${rawText.slice(0, 300)}`);
    }
    if (toolArgs.trim()) {
      return actionFromToolArgs(toolArgs);
    }
    if (content) {
      return { type: 'done', summary: content.slice(0, 2_000) };
    }
    throw new Error('OpenAI response had neither a tool call nor content.');
  }

  /** Plain completion without tools — used by /compact to summarize a
   *  chat's history into a brief the agent can carry forward. */
  async summarize(system: string, user: string): Promise<string> {
    const res = await this.fetchFn(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('Summarize failed: the model returned an empty response.');
    return content;
  }
}
