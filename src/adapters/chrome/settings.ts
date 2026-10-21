import { browser } from 'wxt/browser';

export interface Settings {
  apiKey: string;
  model: string;
  baseURL: string;
  /** Step budget per run. 0 = no limit (stuck/repetition guards and the
   *  Stop button still apply). Multi-part goals need ~8 steps per part. */
  maxSteps: number;
}

const KEY = 'waa:settings';

export const defaultSettings: Settings = {
  apiKey: '',
  model: 'gpt-4o-mini',
  baseURL: 'https://api.openai.com/v1',
  maxSteps: 100,
};

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(KEY);
  const raw = stored[KEY] as Partial<Settings> | undefined;
  return { ...defaultSettings, ...(raw ?? {}) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ [KEY]: settings });
}
