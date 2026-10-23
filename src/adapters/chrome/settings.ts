import { browser } from 'wxt/browser';
import type { Recipe } from '../../core/recipes';
import { normalizeRecipes } from '../../core/recipes';

export interface Settings {
  apiKey: string;
  model: string;
  baseURL: string;
  /** Step budget per run. 0 = no limit (stuck/repetition guards and the
   *  Stop button still apply). Multi-part goals need ~8 steps per part. */
  maxSteps: number;
  /** Cached model ids returned by the last successful /models fetch. */
  models?: string[];
  /** UI color scheme. */
  theme?: 'dark' | 'light';
  /** Reusable goals (macros) saved by the user. */
  recipes?: Recipe[];
  /** When true, state-changing browser actions ask for approval before running. */
  actionGuardrails?: boolean;
  /** Screenshot observation: on pages whose content lives in pixels
   *  (large images, canvas), attach a marked screenshot so the model
   *  can see it. Default on; text-only pages never send one. */
  vision?: boolean;
  /** When set, guardrails are bypassed (actions run directly) for the whole run. */
  actionGuardrailsBypass?: boolean;
}

const KEY = 'waa:settings';

export const defaultSettings: Settings = {
  apiKey: '',
  model: 'gpt-4o-mini',
  baseURL: 'https://api.openai.com/v1',
  maxSteps: 100,
  vision: true,
};

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(KEY);
  const raw = (stored[KEY] ?? {}) as Partial<Settings>;
  const merged: Settings = { ...defaultSettings, ...raw };
  if (!merged.model) merged.model = defaultSettings.model;
  if (!merged.baseURL) merged.baseURL = defaultSettings.baseURL;
  if (!Array.isArray(merged.models)) merged.models = [];
  if (merged.models.length === 0 && merged.model) merged.models = [merged.model];
  merged.recipes = normalizeRecipes(merged.recipes);
  if (typeof merged.actionGuardrails !== 'boolean') merged.actionGuardrails = false;
  if (typeof merged.actionGuardrailsBypass !== 'boolean') merged.actionGuardrailsBypass = false;
  return merged;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ [KEY]: settings });
}
