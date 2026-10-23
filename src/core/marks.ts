import type { ElementRef, PageSnapshot } from './types';

/**
 * Set-of-marks planning (pure): decide WHICH elements get a numbered
 * badge on the screenshot and WHERE, in image pixels. The actual
 * drawing happens in the Chrome adapter (canvas); keeping the math
 * here makes it unit-testable without a browser.
 */
export interface MarkPlan {
  index: number;
  /** Badge anchor (top-left of the element outline), image pixels. */
  x: number;
  y: number;
  /** Element outline, image pixels. */
  w: number;
  h: number;
}

export const MAX_MARKS = 250;

/**
 * Map element bounds (viewport CSS pixels) into image pixels.
 * Elements without usable bounds, fully off-viewport elements, and
 * zero-size elements are skipped — a badge in empty space would only
 * confuse the model.
 */
export function planMarks(
  elements: ElementRef[],
  viewport: { width: number; height: number },
  image: { width: number; height: number },
  onlyIndices?: ReadonlySet<number>,
): MarkPlan[] {
  if (!viewport.width || !viewport.height || !image.width || !image.height) return [];
  const sx = image.width / viewport.width;
  const sy = image.height / viewport.height;
  const plans: MarkPlan[] = [];
  for (const el of elements) {
    if (plans.length >= MAX_MARKS) break;
    // Multi-frame pages: elements from sub-frames carry bounds in
    // their own frame's viewport, which do not map onto the tab
    // screenshot — marking them would put badges in wrong places.
    // Callers pass onlyIndices to restrict marks to top-frame rows.
    if (onlyIndices && !onlyIndices.has(el.index)) continue;
    const b = el.bounds;
    if (!b || b.width <= 0 || b.height <= 0) continue;
    if (b.x + b.width < 0 || b.y + b.height < 0 || b.x > viewport.width || b.y > viewport.height) {
      continue;
    }
    plans.push({
      index: el.index,
      x: Math.max(0, Math.round(b.x * sx)),
      y: Math.max(0, Math.round(b.y * sy)),
      w: Math.round(b.width * sx),
      h: Math.round(b.height * sy),
    });
  }
  return plans;
}

/**
 * Vision trigger: only spend image tokens when the page plausibly
 * hides content in pixels — a large image/canvas is present, or the
 * page has almost no readable text (canvas apps, scanned documents).
 * Ordinary DOM pages stay text-only.
 */
export function needsVision(snapshot: PageSnapshot): boolean {
  if (snapshot.visual) return true;
  return snapshot.elements.length > 0 && snapshot.text.trim().length < 100;
}
