/**
 * Heuristic interactivity + generic widget state (pure — unit-tested).
 *
 * The collector used to carry a fixed selector whitelist of what
 * counts as interactive. Every framework that renders controls
 * differently (Google Forms' role-only divs were the case that bit)
 * needed a new patch. Instead, the content script now extracts cheap
 * SIGNALS from each element and this module scores them: anything
 * that behaves like a control — native tag, interactive ARIA role,
 * click-handler attribute, tabindex, or even just a pointer cursor —
 * is collected, whatever framework rendered it.
 */

export interface InteractivitySignals {
  /** Lowercase tag name. */
  tag: string;
  /** Anchor that actually links somewhere (a[href]). */
  href?: boolean;
  /** The element's ARIA role, if any. */
  role?: string;
  contentEditable?: boolean;
  /** A tabindex attribute is present (any value, incl. -1). */
  tabIndexAttr?: boolean;
  /** A click-handler-ish attribute is present (onclick, jsaction,
   *  data-action) — frameworks wire behaviour through these. */
  clickHandler?: boolean;
  /** Computed cursor is `pointer`. */
  cursorPointer?: boolean;
}

/** ARIA roles that are interactive by definition. gridcell is
 *  deliberately absent: data grids expose their cells through
 *  tabindex already, and indexing every cell would flood snapshots. */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'radio',
  'checkbox',
  'option',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'combobox',
  'listbox',
  'slider',
  'spinbutton',
  'textbox',
  'searchbox',
  'treeitem',
]);

const NATIVE_SCORE = 100;
const ROLE_SCORE = 80;
const EDITABLE_SCORE = 80;
const HANDLER_SCORE = 50;
const TABINDEX_SCORE = 40;
const CURSOR_SCORE = 40;

/** Minimum score for an element to enter the snapshot. Tuned so any
 *  single strong signal qualifies — including every element the old
 *  fixed selector used to catch. */
export const INTERACTIVE_THRESHOLD = 40;

export function interactivityScore(s: InteractivitySignals): number {
  let score = 0;
  if (
    s.tag === 'button' ||
    s.tag === 'input' ||
    s.tag === 'select' ||
    s.tag === 'textarea' ||
    s.tag === 'summary' ||
    (s.tag === 'a' && s.href)
  ) {
    score = Math.max(score, NATIVE_SCORE);
  }
  if (s.role && INTERACTIVE_ROLES.has(s.role)) score = Math.max(score, ROLE_SCORE);
  if (s.contentEditable) score = Math.max(score, EDITABLE_SCORE);
  if (s.clickHandler) score = Math.max(score, HANDLER_SCORE);
  if (s.tabIndexAttr) score = Math.max(score, TABINDEX_SCORE);
  if (s.cursorPointer) score = Math.max(score, CURSOR_SCORE);
  return score;
}

export function isInteractive(s: InteractivitySignals): boolean {
  return interactivityScore(s) >= INTERACTIVE_THRESHOLD;
}

/**
 * Selection state across conventions, in precedence order:
 * native input > aria-checked > data-state (Radix-style) >
 * aria-selected. Returns undefined when the element carries no
 * selection semantics at all.
 */
export function deriveChecked(input: {
  nativeType?: string;
  nativeChecked?: boolean;
  ariaChecked?: string | null;
  dataState?: string | null;
  ariaSelected?: string | null;
}): boolean | undefined {
  if (
    (input.nativeType === 'checkbox' || input.nativeType === 'radio') &&
    input.nativeChecked != null
  ) {
    return input.nativeChecked;
  }
  if (input.ariaChecked != null) return input.ariaChecked === 'true';
  if (input.dataState === 'checked') return true;
  if (input.dataState === 'unchecked') return false;
  if (input.ariaSelected != null) return input.ariaSelected === 'true';
  return undefined;
}

/**
 * Generic widget state as a compact token string ("expanded",
 * "pressed selected", …) gathered from ARIA state attributes,
 * Radix-style data-state, and the de-facto class conventions
 * (active / selected). Annotation only — state never makes an
 * element interactive by itself.
 */
export function deriveState(input: {
  ariaExpanded?: string | null;
  ariaPressed?: string | null;
  ariaCurrent?: string | null;
  dataState?: string | null;
  classTokens?: readonly string[];
}): string | undefined {
  const tokens: string[] = [];
  const add = (t: string) => {
    if (!tokens.includes(t)) tokens.push(t);
  };
  if (input.ariaExpanded === 'true') add('expanded');
  if (input.ariaPressed === 'true') add('pressed');
  if (input.ariaCurrent && input.ariaCurrent !== 'false') add('current');
  switch (input.dataState) {
    case 'open':
      add('expanded');
      break;
    case 'on':
      add('on');
      break;
    case 'active':
      add('active');
      break;
    case 'selected':
      add('selected');
      break;
  }
  const classes = input.classTokens ?? [];
  if (classes.includes('active') || classes.includes('is-active')) add('active');
  if (classes.includes('selected') || classes.includes('is-selected')) add('selected');
  return tokens.length > 0 ? tokens.join(' ') : undefined;
}
