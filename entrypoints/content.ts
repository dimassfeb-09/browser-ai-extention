import { defineContentScript } from '#imports';
import { browser } from 'wxt/browser';
import type { Action, ActResult, ElementRef, PageSnapshot } from '../src/core/types';
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
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

  const aria = clean(el.getAttribute('aria-label'));
  if (aria) return aria;

  // aria-labelledby: resolve the referenced elements' text.
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = clean(
      labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' '),
    );
    if (text) return text;
  }

  // Associated <label> elements — most CMS/admin forms put the field name
  // in a separate <label for> or a wrapping <label>, never inside the
  // control itself. Without this, form fields reach the model anonymous
  // and "fill the blank fields" tasks are guesswork.
  const labels = (input as HTMLInputElement).labels;
  if (labels && labels.length > 0) {
    const text = clean(Array.from(labels).map((l) => l.textContent ?? '').join(' '));
    if (text) return text;
  }

  return (
    clean((el as HTMLElement).innerText) ||
    clean(el.textContent) ||
    clean(input.value) ||
    clean(input.placeholder) ||
    clean(input.name) ||
    clean(el.getAttribute('title'))
  );
}

function cssPathOf(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.documentElement && parts.length < 8) {
    let part = node.tagName.toLowerCase();
    // parentNode (not parentElement): shadow-root children have no
    // parentElement, which used to collapse every shadow subtree into
    // identical paths.
    const parentNode = node.parentNode;
    if (parentNode) {
      const siblings = Array.from(parentNode.childNodes).filter(
        (c): c is Element => c instanceof Element && c.tagName === node!.tagName,
      );
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    if (node.parentElement) {
      node = node.parentElement;
    } else {
      // Cross the shadow boundary to the host so paths stay unique.
      const root = node.getRootNode();
      node = root instanceof ShadowRoot ? root.host : null;
    }
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
    const rowHost = el.closest('tr, [role="row"], li');
    let context: string | undefined;
    if (rowHost && rowHost !== el) {
      const t = (rowHost.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 90);
      if (t && t !== label) context = t;
    }
    raw.push({
      el,
      meta: {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') ?? undefined,
        label,
        context,
        inputType: el instanceof HTMLInputElement ? el.type : undefined,
        disabled:
          (el as HTMLInputElement).disabled === true ||
          el.getAttribute('aria-disabled') === 'true',
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
  // Dedupe + index + lastElements all from the SAME filtered raw list.
  // (Indexing the metadata and resolving elements back through a
  // cssPath map desynced whenever two elements shared a path — e.g.
  // identical subtrees inside a shadow root: the model would be shown
  // "Nama" but the action landed on the Email input.)
  const seen = new Set<string>();
  const elements: ElementRef[] = [];
  lastElements = [];
  for (const r of collectRaw()) {
    const label = r.meta.label.replace(/\s+/g, ' ').trim().slice(0, 120);
    const key = `${r.meta.fingerprint.cssPath}::${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    elements.push({ ...r.meta, label, index: elements.length });
    lastElements.push(r.el);
  }
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

/** Masked inputs (phone, currency, NPWP…) reformat while typing, so the
 *  stored value legitimately differs from the raw text. Compare digit
 *  sequences as a fallback — a correctly masked fill is not a failure. */
function valuesMatch(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  const digits = (s: string) => s.replace(/\D/g, '');
  const a = digits(actual);
  const e = digits(expected);
  return e.length >= 3 && a === e;
}

/** OTP-style split inputs (maxlength=1 boxes): one "type" of the whole
 *  code distributes characters across the following boxes. Returns null
 *  when the target is not an OTP box. */
function typeOtp(el: HTMLElement, text: string): ActResult | null {
  if (!(el instanceof HTMLInputElement) || el.maxLength !== 1 || text.length <= 1) return null;
  const scope = el.closest('form') ?? el.parentElement?.parentElement ?? document.body;
  const boxes = Array.from(scope.querySelectorAll('input')).filter(
    (b) => b.maxLength === 1 && isVisible(b),
  );
  const start = boxes.indexOf(el);
  if (start === -1 || boxes.length - start < 2) return null;
  const chars = text.replace(/\s/g, '');
  for (let i = 0; i < chars.length && start + i < boxes.length; i++) {
    const box = boxes[start + i]!;
    box.focus();
    nativeSetValue(box, chars[i]!);
  }
  const joined = boxes
    .slice(start, start + chars.length)
    .map((b) => b.value)
    .join('');
  const ok = joined === chars;
  return {
    ok,
    message: ok ? `Typed (OTP split across ${chars.length} boxes)` : `OTP split incomplete (${joined})`,
    level: 1,
  };
}

function typeInto(el: HTMLElement, text: string): ActResult {
  el.scrollIntoView({ block: 'center' });
  el.focus();

  if (el.tagName === 'SELECT') {
    // The model sends the option's visible text or its value — accept both.
    const sel = el as unknown as HTMLSelectElement;
    const option = Array.from(sel.options).find(
      (o) => o.value === text || o.text === text || o.label === text,
    );
    sel.value = option ? option.value : text;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const ok = sel.value === (option ? option.value : text);
    return {
      ok,
      message: ok ? `Selected "${text}"` : `Could not select "${text}"`,
      level: 0,
    };
  }

  if (el.isContentEditable) {
    document.execCommand('selectAll', false);
    const ok = document.execCommand('insertText', false, text);
    return { ok, message: ok ? 'Typed via execCommand' : 'execCommand failed', level: 2 };
  }

  const otp = typeOtp(el, text);
  if (otp) return otp;

  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
    // Canvas / tabindex widgets: there is no value to set — the widget
    // reads keystrokes. Send a full per-character keyboard sequence.
    for (const ch of text) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
    }
    return { ok: true, message: 'Typed (keyboard sequence)', level: 1 };
  }

  const input = el as HTMLInputElement | HTMLTextAreaElement;

  // level 0 — native setter
  nativeSetValue(input, text);
  if (valuesMatch(input.value, text)) return { ok: true, message: 'Typed (native setter)', level: 0 };

  // level 1 — per-character event sequence
  nativeSetValue(input, '');
  for (const ch of text) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
    nativeSetValue(input, input.value + ch);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (valuesMatch(input.value, text)) return { ok: true, message: 'Typed (event sequence)', level: 1 };

  // level 2 — execCommand fallback
  el.focus();
  document.execCommand('selectAll', false);
  document.execCommand('insertText', false, text);
  const ok = valuesMatch(input.value, text);
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
    case 'click_at': {
      const el = lastElements[action.index];
      if (!el) return { ok: false, message: `No element at index ${action.index} — re-observe.`, level: 3 };
      el.scrollIntoView({ block: 'center' });
      const rect = el.getBoundingClientRect();
      const clientX = rect.left + action.x;
      const clientY = rect.top + action.y;
      const init: MouseEventInit = {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        button: 0,
      };
      el.focus?.();
      el.dispatchEvent(new PointerEvent('pointerdown', init));
      el.dispatchEvent(new MouseEvent('mousedown', init));
      el.dispatchEvent(new PointerEvent('pointerup', init));
      el.dispatchEvent(new MouseEvent('mouseup', init));
      el.dispatchEvent(new MouseEvent('click', init));
      return {
        ok: true,
        message: `Clicked [${action.index}] at (${action.x},${action.y}) inside <${el.tagName.toLowerCase()}>`,
        level: 3,
      };
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
  // Forms inside iframes are everywhere (embeds, payment widgets, legacy
  // admin apps). The driver merges per-frame snapshots and routes
  // actions back by frameId.
  allFrames: true,
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
