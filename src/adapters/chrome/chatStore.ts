import { browser } from 'wxt/browser';
import type { ChatStore } from '../../core/ports';
import type { ChatState } from '../../core/types';
import { emptyChatState } from '../../core/chat';

const KEY = 'waa:chats:v1';

/** ChatStore backed by chrome.storage.local (survives browser restarts). */
export class ChromeChatStore implements ChatStore {
  async load(): Promise<ChatState> {
    const stored = await browser.storage.local.get(KEY);
    const raw = stored[KEY] as (ChatState & { byWindow?: Record<number, string> }) | undefined;
    if (!raw || !Array.isArray(raw.sessions)) {
      return emptyChatState();
    }
    if (typeof raw.byTab !== 'object' || raw.byTab === null) {
      // Migration from the per-window era: sessions survive, the old
      // per-window bindings are dropped (tabs start fresh bindings).
      return { sessions: raw.sessions, byTab: {} };
    }
    return { sessions: raw.sessions, byTab: raw.byTab };
  }

  async save(state: ChatState): Promise<void> {
    await browser.storage.local.set({ [KEY]: state });
  }
}

/** The window this panel/page belongs to. */
export async function getCurrentWindowId(): Promise<number> {
  const win = await browser.windows.getCurrent();
  return win.id ?? -1;
}

/** The active tab of that window — the session binding key (sessions
 *  are per tab; the panel view follows the active tab). */
export async function getActiveTabId(windowId: number): Promise<number> {
  const [tab] = await browser.tabs.query({ active: true, windowId });
  return tab?.id ?? -1;
}
