import type { LlmClient } from '../../core/ports';
import type { Action } from '../../core/types';
import { actionFromToolArgs, toolDefinitions } from '../../core/tools';
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
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI HTTP ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = (await res.json()) as ChatCompletionResponse;
    const message = data.choices?.[0]?.message;
    const toolCall = message?.tool_calls?.[0];
    if (toolCall?.function?.arguments) {
      // Validated by zod inside actionFromToolArgs before anything executes it.
      return actionFromToolArgs(toolCall.function.arguments);
    }
    if (message?.content) {
      return { type: 'done', summary: message.content.slice(0, 2_000) };
    }
    throw new Error('OpenAI response had neither a tool call nor content.');
  }
}
