import type { Action, ActResult, ChatState, PageSnapshot, StepRecord } from './types';

/**
 * Ports (hexagonal architecture). The core depends only on these
 * interfaces; Chrome, the DOM and OpenAI live in adapters.
 * Tests substitute fakes for every port — no browser, no network.
 */
export interface BrowserDriver {
  observe(): Promise<PageSnapshot>;
  act(action: Action): Promise<ActResult>;
}

export interface LlmClient {
  nextAction(input: {
    goal: string;
    snapshot: PageSnapshot;
    history: StepRecord[];
  }): Promise<Action>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface Logger {
  log(event: string, data?: unknown): void;
}

/** Persistence for the whole chat state (history + per-window bindings). */
export interface ChatStore {
  load(): Promise<ChatState>;
  save(state: ChatState): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export const noopLogger: Logger = { log: () => undefined };
