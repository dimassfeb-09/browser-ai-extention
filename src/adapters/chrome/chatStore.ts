import { browser } from 'wxt/browser';
import type { ChatStore } from '../../core/ports';
import type { ChatState } from '../../core/types';
import { emptyChatState } from '../../core/chat';

const KEY = 'waa:chats:v1';

/** ChatStore backed by chrome.storage.local (survives browser restarts). */
export class ChromeChatStore implements ChatStore {
  async load(): Promise<ChatState> {
    const stored = await browser.storage.local.get(KEY);
    const raw = stored[KEY] as ChatState | undefined;
    if (!raw || !Array.isArray(raw.sessions) || typeof raw.byWindow !== 'object') {
      return emptyChatState();
    }
    return raw;
  }

  async save(state: ChatState): Promise<void> {
    await browser.storage.local.set({ [KEY]: state });
  }
}

/** The window this panel/page belongs to — the session binding key. */
export async function getCurrentWindowId(): Promise<number> {
  const win = await browser.windows.getCurrent();
  return win.id ?? -1;
}
