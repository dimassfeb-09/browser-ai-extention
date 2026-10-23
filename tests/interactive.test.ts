import { describe, expect, it } from 'vitest';
import {
  deriveChecked,
  deriveState,
  interactivityScore,
  isInteractive,
} from '../src/core/interactive';

describe('interactivityScore', () => {
  it('always includes native controls (the pre-heuristic behaviour)', () => {
    expect(isInteractive({ tag: 'button' })).toBe(true);
    expect(isInteractive({ tag: 'input' })).toBe(true);
    expect(isInteractive({ tag: 'select' })).toBe(true);
    expect(isInteractive({ tag: 'a', href: true })).toBe(true);
    expect(isInteractive({ tag: 'a' })).toBe(false); // anchor without href is text
  });

  it('includes interactive ARIA roles, incl. ones the old selector missed', () => {
    for (const role of ['radio', 'checkbox', 'option', 'switch', 'slider', 'tab', 'combobox']) {
      expect(isInteractive({ tag: 'div', role }), role).toBe(true);
    }
  });

  it('catches framework widgets from behaviour signals alone', () => {
    // A clickable card: no role, no tabindex, no handler attribute —
    // only the pointer cursor gives it away.
    expect(isInteractive({ tag: 'div', cursorPointer: true })).toBe(true);
    // Google-style wiring and inline handlers.
    expect(isInteractive({ tag: 'div', clickHandler: true })).toBe(true);
    expect(isInteractive({ tag: 'span', tabIndexAttr: true })).toBe(true);
    expect(isInteractive({ tag: 'div', contentEditable: true })).toBe(true);
  });

  it('leaves plain content out (noise control)', () => {
    expect(isInteractive({ tag: 'div' })).toBe(false);
    expect(isInteractive({ tag: 'p' })).toBe(false);
    expect(isInteractive({ tag: 'span', role: 'presentation' })).toBe(false);
    expect(interactivityScore({ tag: 'div' })).toBe(0);
  });
});

describe('deriveChecked', () => {
  it('prefers the native input state', () => {
    expect(deriveChecked({ nativeType: 'radio', nativeChecked: true, ariaChecked: 'false' })).toBe(true);
  });

  it('reads aria-checked for ARIA widgets', () => {
    expect(deriveChecked({ ariaChecked: 'true' })).toBe(true);
    expect(deriveChecked({ ariaChecked: 'false' })).toBe(false);
  });

  it('falls back to Radix-style data-state when aria is absent', () => {
    expect(deriveChecked({ dataState: 'checked' })).toBe(true);
    expect(deriveChecked({ dataState: 'unchecked' })).toBe(false);
  });

  it('uses aria-selected for options/tabs and stays silent otherwise', () => {
    expect(deriveChecked({ ariaSelected: 'true' })).toBe(true);
    expect(deriveChecked({})).toBeUndefined();
    expect(deriveChecked({ dataState: 'open' })).toBeUndefined();
  });
});

describe('deriveState', () => {
  it('gathers ARIA state tokens', () => {
    expect(deriveState({ ariaExpanded: 'true' })).toBe('expanded');
    expect(deriveState({ ariaPressed: 'true', ariaCurrent: 'page' })).toBe('pressed current');
    expect(deriveState({ ariaExpanded: 'false' })).toBeUndefined();
  });

  it('maps data-state conventions', () => {
    expect(deriveState({ dataState: 'open' })).toBe('expanded');
    expect(deriveState({ dataState: 'on' })).toBe('on');
    expect(deriveState({ dataState: 'closed' })).toBeUndefined();
  });

  it('reads class conventions without duplicating tokens', () => {
    expect(deriveState({ classTokens: ['card', 'selected'] })).toBe('selected');
    expect(deriveState({ ariaExpanded: 'true', dataState: 'open', classTokens: ['x'] })).toBe('expanded');
    expect(deriveState({ classTokens: ['card'] })).toBeUndefined();
  });
});
