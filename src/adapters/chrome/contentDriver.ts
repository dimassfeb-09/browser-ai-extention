import { browser } from 'wxt/browser';
import type { BrowserDriver } from '../../core/ports';
import type { Action, ActResult, PageSnapshot } from '../../core/types';
import { mergeSnapshots } from '../../core/snapshot';
import { needsVision } from '../../core/marks';
import { captureAndMark } from './screenshot';
import type { ContentRequest, ContentResponse } from './protocol';

interface FrameRoute {
  frameId: number;
  localIndex: number;
}

/**
 * BrowserDriver that talks to the content scripts in the active tab.
 * Runs in the side panel; the content scripts own the live DOM.
 *
 * Multi-frame: observe() collects a snapshot from EVERY frame (forms
 * inside iframes are otherwise invisible), merges them into one
 * snapshot, and remembers which frame each merged index came from so
 * act() can route click/type back to the right frame with its local
 * index.
 */
export class TabContentDriver implements BrowserDriver {
  private lastRouting: FrameRoute[] = [];

  constructor(
    private readonly tabId?: number,
    private readonly opts: { vision?: boolean } = {},
  ) {}

  private async sendToFrame(
    tabId: number,
    frameId: number,
    request: ContentRequest,
  ): Promise<ContentResponse> {
    let response: ContentResponse;
    try {
      response = (await browser.tabs.sendMessage(tabId, request, {
        frameId,
      })) as ContentResponse;
    } catch {
      // Fall back: inject the content script into tabs/frames that
      // existed before the extension was installed, then retry once.
      try {
        await browser.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          files: ['/content-scripts/content.js'],
        });
        response = (await browser.tabs.sendMessage(tabId, request, {
          frameId,
        })) as ContentResponse;
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
    if (this.tabId) return this.tabId;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab.');
    return tab.id;
  }

  private async frameIds(tabId: number): Promise<number[]> {
    try {
      const frames = await browser.webNavigation.getAllFrames({ tabId });
      if (frames && frames.length > 0) return frames.map((f) => f.frameId);
    } catch {
      // webNavigation unavailable — fall through to the top frame only.
    }
    return [0];
  }

  async observe(): Promise<PageSnapshot> {
    const tabId = await this.activeTabId();
    const frameIds = await this.frameIds(tabId);
    const snapshots: PageSnapshot[] = [];
    const routing: FrameRoute[] = [];
    for (const frameId of frameIds) {
      try {
        const res = await this.sendToFrame(tabId, frameId, { kind: 'waa:observe' });
        if (res.kind !== 'waa:snapshot') continue;
        for (const el of res.snapshot.elements) {
          routing.push({ frameId, localIndex: el.index });
        }
        snapshots.push(res.snapshot);
      } catch {
        // Frames without a content script (about:blank, internal pages)
        // are skipped; if ALL frames fail the throw below reports it.
        if (frameId === 0 && snapshots.length === 0) throw new Error(
          'Cannot reach the content script on this tab. Reload the tab (or open a normal http(s) page) and try again.',
        );
      }
    }
    if (snapshots.length === 0) {
      throw new Error('No frame on this tab could be observed.');
    }
    this.lastRouting = routing;
    const merged = mergeSnapshots(snapshots);
    // Screenshot observation: only when the page plausibly hides
    // content in pixels (needsVision) — ordinary DOM pages stay
    // text-only and free. captureAndMark returns null when the
    // pinned tab is not the visible one; the run continues text-only.
    if (this.opts.vision && needsVision(merged)) {
      // Sub-frame elements carry bounds in their own frame's viewport,
      // which cannot be mapped onto the tab screenshot — restrict the
      // marks to top-frame elements so no badge lands in a wrong spot.
      const multiFrame = routing.some((r) => r.frameId !== 0);
      const only = multiFrame
        ? new Set(routing.flatMap((r, i) => (r.frameId === 0 ? [i] : [])))
        : undefined;
      const shot = await captureAndMark(tabId, merged, only);
      if (shot) merged.screenshot = shot;
    }
    return merged;
  }

  async act(action: Action): Promise<ActResult> {
    const tabId = await this.activeTabId();
    let frameId = 0;
    let routed: Action = action;
    if (action.type === 'click' || action.type === 'click_at' || action.type === 'type') {
      const route = this.lastRouting[action.index];
      if (route) {
        frameId = route.frameId;
        routed = { ...action, index: route.localIndex };
      }
    }
    const res = await this.sendToFrame(tabId, frameId, { kind: 'waa:act', action: routed });
    if (res.kind !== 'waa:act-result') throw new Error('Unexpected act response.');
    return res.result;
  }
}
