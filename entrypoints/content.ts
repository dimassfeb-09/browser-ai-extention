import { defineContentScript } from '#imports';
import { browser } from 'wxt/browser';
import type { Action, ActResult, ElementRef, PageSnapshot } from '../src/core/types';
import { cleanElements } from '../src/core/snapshot';
import type { ContentRequest, ContentResponse } from '../src/adapters/chrome/protocol';

/**
 * Content script: the ONLY place that touches the live DOM.
 * It turns the page into a serializable PageSnapshot for the agent,
 * and executes primitive actions with an escalation ladder:
 *   level 0  plain DOM (click(), native setter + input/change)
 *   level 1  full event sequence (pointer/mouse/keyboard per char)
 *   level 2  execCommand('insertText') for rich-text/contenteditable
 * Verification happens after typing: if the value did not stick
 * (controlled React/Vue inputs revert), escalate to the next level.
 */

const INTERACTIVE =
  'a[href], button, input, select, textarea, [role="button"], [role="link"], [contenteditable="true"], [tabindex]';

let lastElements: HTMLElement[] = [];

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function labelOf(el: HTMLElement): string {
  const input = el as HTMLInputElement;
  return (
    el.getAttribute('aria-label') ||
    (el as HTMLElement).innerText ||
    input.value ||
    input.placeholder ||
    input.name ||
    el.getAttribute('title') ||
    ''
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function cssPathOf(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.documentElement && parts.length < 8) {
    let part = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ');
}

function collectRaw(): Array<{ meta: Omit<ElementRef, 'index'>; el: HTMLElement }> {
  const found: HTMLElement[] = [];
  const walk = (root: Node) => {
    const els = (root as Element).querySelectorAll?.(INTERACTIVE);
    els?.forEach((e) => found.push(e as HTMLElement));
    (root as Element).querySelectorAll?.('*').forEach((e) => {
      if ((e as HTMLElement).shadowRoot) walk((e as HTMLElement).shadowRoot!);
    });
  };
  if (document.body) walk(document.body);

  const raw: Array<{ meta: Omit<ElementRef, 'index'>; el: HTMLElement }> = [];
  for (const el of found) {
    if (!isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    const input = el as HTMLInputElement;
    const label = labelOf(el);
    raw.push({
      el,
      meta: {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') ?? undefined,
        label,
        value: 'value' in input && input.type !== 'password' ? String(input.value ?? '') : undefined,
        placeholder: input.placeholder || undefined,
        href: el instanceof HTMLAnchorElement ? el.href : undefined,
        fingerprint: { tag: el.tagName.toLowerCase(), label, cssPath: cssPathOf(el) },
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      },
    });
  }
  return raw;
}

function observe(): PageSnapshot {
  const raw = collectRaw();
  const byPath = new Map(raw.map((r) => [r.meta.fingerprint.cssPath, r.el]));
  const elements = cleanElements(raw.map((r) => r.meta));
  lastElements = elements.map((ref) => byPath.get(ref.fingerprint.cssPath)!).filter(Boolean);
  return {
    url: location.href,
    title: document.title,
    elements,
    text: (document.body?.innerText ?? '').slice(0, 6_000),
    capturedAt: Date.now(),
  };
}

/** The React/Vue-proof value setter: use the prototype's native setter so
 *  React's per-element value tracker is bypassed, then fire input/change. */
function nativeSetValue(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto =
    el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, text);
  else el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function typeInto(el: HTMLElement, text: string): ActResult {
  el.scrollIntoView({ block: 'center' });
  el.focus();

  if (el.isContentEditable) {
    document.execCommand('selectAll', false);
    const ok = document.execCommand('insertText', false, text);
    return { ok, message: ok ? 'Typed via execCommand' : 'execCommand failed', level: 2 };
  }

  const input = el as HTMLInputElement | HTMLTextAreaElement;

  // level 0 — native setter
  nativeSetValue(input, text);
  if (input.value === text) return { ok: true, message: 'Typed (native setter)', level: 0 };

  // level 1 — per-character event sequence
  nativeSetValue(input, '');
  for (const ch of text) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
    nativeSetValue(input, input.value + ch);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (input.value === text) return { ok: true, message: 'Typed (event sequence)', level: 1 };

  // level 2 — execCommand fallback
  el.focus();
  document.execCommand('selectAll', false);
  document.execCommand('insertText', false, text);
  const ok = input.value === text;
  return { ok, message: ok ? 'Typed (execCommand)' : `Value did not stick (now: ${input.value})`, level: 2 };
}

function act(action: Action): ActResult {
  switch (action.type) {
    case 'click': {
      const el = lastElements[action.index];
      if (!el) return { ok: false, message: `No element at index ${action.index} — re-observe.`, level: 0 };
      el.scrollIntoView({ block: 'center' });
      el.focus?.();
      el.click();
      return { ok: true, message: `Clicked [${action.index}] <${el.tagName.toLowerCase()}>`, level: 0 };
    }
    case 'type': {
      const el = lastElements[action.index];
      if (!el) return { ok: false, message: `No element at index ${action.index} — re-observe.`, level: 0 };
      return typeInto(el, action.text);
    }
    case 'scroll': {
      const amount = action.amount ?? Math.round(window.innerHeight * 0.9);
      window.scrollBy(0, action.direction === 'down' ? amount : -amount);
      return { ok: true, message: `Scrolled ${action.direction} ${amount}px`, level: 0 };
    }
    case 'navigate': {
      location.href = action.url;
      return { ok: true, message: `Navigating to ${action.url}`, level: 0 };
    }
    default:
      return { ok: false, message: `Action ${action.type} is handled by the agent loop, not the page.`, level: 0 };
  }
}

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    browser.runtime.onMessage.addListener(
      (message: ContentRequest, _sender, sendResponse: (r: ContentResponse) => void) => {
        try {
          if (message.kind === 'waa:observe') {
            sendResponse({ kind: 'waa:snapshot', snapshot: observe() });
          } else if (message.kind === 'waa:act') {
            sendResponse({ kind: 'waa:act-result', result: act(message.action) });
          }
        } catch (err) {
          sendResponse({
            kind: 'waa:error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return true;
      },
    );
  },
});
