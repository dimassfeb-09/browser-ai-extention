import { describe, expect, it } from 'vitest';
import { needsVision, planMarks } from '../src/core/marks';
import type { ElementRef, PageSnapshot } from '../src/core/types';

function el(index: number, bounds?: ElementRef['bounds']): ElementRef {
  return {
    index,
    tag: 'button',
    label: `B${index}`,
    fingerprint: { tag: 'button', label: `B${index}`, cssPath: `button:nth(${index})` },
    bounds,
  };
}

const viewport = { width: 1000, height: 500 };

describe('planMarks', () => {
  it('scales CSS-pixel bounds into image pixels', () => {
    const plans = planMarks([el(3, { x: 100, y: 50, width: 200, height: 40 })], viewport, {
      width: 2000,
      height: 1000,
    });
    expect(plans).toEqual([{ index: 3, x: 200, y: 100, w: 400, h: 80 }]);
  });

  it('skips elements without bounds, zero-size, or fully off-viewport', () => {
    const plans = planMarks(
      [
        el(0),
        el(1, { x: 10, y: 10, width: 0, height: 10 }),
        el(2, { x: -500, y: 0, width: 100, height: 10 }),
        el(3, { x: 0, y: 900, width: 100, height: 10 }),
        el(4, { x: 10, y: 10, width: 50, height: 20 }),
      ],
      viewport,
      { width: 1000, height: 500 },
    );
    expect(plans.map((p) => p.index)).toEqual([4]);
  });

  it('clamps partially off-screen elements to the image edge', () => {
    const plans = planMarks([el(1, { x: -20, y: -5, width: 100, height: 50 })], viewport, {
      width: 1000,
      height: 500,
    });
    expect(plans[0]!.x).toBe(0);
    expect(plans[0]!.y).toBe(0);
  });

  it('restricts marks to the given index set (multi-frame pages)', () => {
    const els = [
      el(0, { x: 10, y: 10, width: 50, height: 20 }),
      el(1, { x: 100, y: 10, width: 50, height: 20 }),
      el(2, { x: 200, y: 10, width: 50, height: 20 }),
    ];
    const all = planMarks(els, viewport, { width: 1000, height: 500 });
    expect(all.map((p) => p.index)).toEqual([0, 1, 2]);
    const topOnly = planMarks(els, viewport, { width: 1000, height: 500 }, new Set([0, 2]));
    expect(topOnly.map((p) => p.index)).toEqual([0, 2]);
  });

  it('returns nothing for a degenerate viewport or image', () => {
    expect(planMarks([el(0, { x: 0, y: 0, width: 10, height: 10 })], { width: 0, height: 0 }, { width: 100, height: 100 })).toEqual([]);
  });
});

describe('needsVision', () => {
  const base: PageSnapshot = { url: 'u', title: 't', elements: [], text: '', capturedAt: 0 };
  it('triggers on substantial visual content', () => {
    expect(needsVision({ ...base, visual: true, text: 'lots of text '.repeat(50) })).toBe(true);
  });
  it('triggers when the page has elements but almost no readable text', () => {
    expect(needsVision({ ...base, elements: [el(0)], text: 'OK' })).toBe(true);
  });
  it('stays off for ordinary text-rich pages', () => {
    expect(needsVision({ ...base, elements: [el(0)], text: 'A normal form page. '.repeat(20) })).toBe(false);
  });
  it('stays off for empty pages', () => {
    expect(needsVision(base)).toBe(false);
  });
});
