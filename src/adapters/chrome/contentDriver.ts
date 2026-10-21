import { browser } from 'wxt/browser';
import type { BrowserDriver } from '../../core/ports';
import type { Action, ActResult, PageSnapshot } from '../../core/types';
import type { ContentRequest, ContentResponse } from './protocol';

/**
 * BrowserDriver that talks to the content script in the active tab.
 * Runs in the side panel; the content script owns the live DOM.
 */
export class TabContentDriver implements BrowserDriver {
  constructor(private readonly tabId?: number) {}

  private async send(request: ContentRequest): Promise<ContentResponse> {
    const tabId = this.tabId ?? (await this.activeTabId());
    let response: ContentResponse;
    try {
      response = (await browser.tabs.sendMessage(tabId, request)) as ContentResponse;
    } catch {
      // Fall back: inject the content script into tabs that existed before
      // the extension was installed / where auto-injection missed, then retry.
      try {
        await browser.scripting.executeScript({
          target: { tabId },
          files: ['/content-scripts/content.js'],
        });
        response = (await browser.tabs.sendMessage(tabId, request)) as ContentResponse;
      } catch {
        throw new Error(
          'Cannot reach the content script on this tab. Reload the tab (or open a normal http(s) page) and try again.',
        );
      }
    }
    if (!response || response.kind === 'waa:error') {
      throw new Error(
        response && 'message' in response ? response.message : 'Empty content-script response.',
      );
    }
    return response;
  }

  private async activeTabId(): Promise<number> {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab.');
    return tab.id;
  }

  async observe(): Promise<PageSnapshot> {
    const res = await this.send({ kind: 'waa:observe' });
    if (res.kind !== 'waa:snapshot') throw new Error('Unexpected observe response.');
    return res.snapshot;
  }

  async act(action: Action): Promise<ActResult> {
    const res = await this.send({ kind: 'waa:act', action });
    if (res.kind !== 'waa:act-result') throw new Error('Unexpected act response.');
    return res.result;
  }
}
