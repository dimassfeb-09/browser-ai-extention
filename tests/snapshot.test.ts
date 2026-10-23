import { describe, expect, it } from 'vitest';
import {
  cleanElements,
  findByFingerprint,
  hashSnapshot,
  mergeSnapshots,
  truncateSnapshot,
} from '../src/core/snapshot';
import type { ElementRef, PageSnapshot } from '../src/core/types';

const el = (label: string, cssPath: string, value?: string): Omit<ElementRef, 'index'> => ({
  tag: 'button',
  label,
  value,
  fingerprint: { tag: 'button', label, cssPath },
});

function snapshot(elements: ElementRef[], text = 'hello'): PageSnapshot {
  return { url: 'https://example.com/', title: 'Example', elements, text, capturedAt: 1 };
}

describe('cleanElements', () => {
  it('dedupes by cssPath+label and re-indexes in order', () => {
    const cleaned = cleanElements([
      el('Login', 'body > button'),
      el('Login', 'body > button'),
      el('Daftar', 'body > a'),
    ]);
    expect(cleaned).toHaveLength(2);
    expect(cleaned.map((e) => e.index)).toEqual([0, 1]);
    expect(cleaned[1]?.label).toBe('Daftar');
  });

  it('trims and normalizes whitespace in labels', () => {
    expect(cleanElements([el('  Klik\n  Saya  ', 'body > button')])[0]?.label).toBe('Klik Saya');
  });
});

describe('hashSnapshot', () => {
  it('changes when the page changes, stable when it does not', () => {
    const a = snapshot(cleanElements([el('Login', 'body > button')]));
    const b = snapshot(cleanElements([el('Login', 'body > button')]));
    const c = snapshot(cleanElements([el('Logout', 'body > button')]));
    expect(hashSnapshot(a)).toBe(hashSnapshot(b));
    expect(hashSnapshot(a)).not.toBe(hashSnapshot(c));
  });
});

describe('truncateSnapshot', () => {
  it('fits an oversized snapshot into the budget', () => {
    const many = cleanElements(
      Array.from({ length: 300 }, (_, i) => el(`Item ${i} `.repeat(10), `body > div > button:nth-of-type(${i})`)),
    );
    const out = truncateSnapshot(snapshot(many, 'x'.repeat(50_000)), 12_000);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(12_100);
    expect(out.elements.length).toBeLessThan(300);
  });
});

describe('mergeSnapshots (multi-frame pages)', () => {
  it('re-indexes elements across frames in order and keeps the top frame identity', () => {
    const top: PageSnapshot = {
      url: 'https://example.com/parent',
      title: 'Parent',
      text: 'parent text',
      capturedAt: 5,
      elements: cleanElements([el('Menu', 'body > button')]),
    };
    const frame: PageSnapshot = {
      url: 'https://example.com/inner',
      title: 'Inner',
      text: 'inner text',
      capturedAt: 9,
      elements: cleanElements([el('Kode', 'body > input'), el('Proses', 'body > button')]),
    };
    const merged = mergeSnapshots([top, frame]);
    expect(merged.url).toBe('https://example.com/parent');
    expect(merged.elements.map((e) => [e.index, e.label])).toEqual([
      [0, 'Menu'],
      [1, 'Kode'],
      [2, 'Proses'],
    ]);
    expect(merged.text).toContain('parent text');
    expect(merged.text).toContain('inner text');
    expect(merged.capturedAt).toBe(9);
  });

  it('handles an empty list without crashing', () => {
    expect(mergeSnapshots([]).elements).toEqual([]);
  });
});

describe('findByFingerprint', () => {
  const elements = cleanElements([el('Login', 'body > button'), el('Daftar', 'body > a')]);
  it('prefers exact cssPath match', () => {
    expect(findByFingerprint(elements, { tag: 'a', label: 'Daftar', cssPath: 'body > a' })?.label).toBe('Daftar');
  });
  it('falls back to tag+label when the path moved (re-render)', () => {
    const found = findByFingerprint(elements, { tag: 'button', label: 'Login', cssPath: 'body > div > button' });
    expect(found?.index).toBe(0);
  });
  it('returns null when the element is really gone', () => {
    expect(findByFingerprint(elements, { tag: 'button', label: 'Hilang', cssPath: 'x' })).toBeNull();
  });
});

describe('hashSnapshot', () => {
  it('changes when only a checked state flips (radio selection is a page change)', () => {
    const base = el('Kuning', 'body > div');
    const a = snapshot([{ ...base, index: 0, checked: false }]);
    const b = snapshot([{ ...base, index: 0, checked: true }]);
    expect(hashSnapshot(a)).not.toBe(hashSnapshot(b));
  });

  it('changes when only a generic state token flips (menu opens)', () => {
    const base = el('Detail', 'body > div');
    const a = snapshot([{ ...base, index: 0 }]);
    const b = snapshot([{ ...base, index: 0, state: 'expanded' }]);
    expect(hashSnapshot(a)).not.toBe(hashSnapshot(b));
  });

  it('changes when the visible window moves (a productive scroll is a page change)', () => {
    const VP = { width: 1000, height: 800 };
    const at = (y: number): ElementRef => ({
      ...el('Soal', 'body > div'),
      index: 0,
      bounds: { x: 0, y, width: 100, height: 40 },
    });
    const top = { ...snapshot([at(100)]), viewport: VP };
    const scrolled = { ...snapshot([at(5000)]), viewport: VP };
    expect(hashSnapshot(top)).not.toBe(hashSnapshot(scrolled));
    // Same window, same page: stable.
    expect(hashSnapshot(top)).toBe(hashSnapshot({ ...snapshot([at(100)]), viewport: VP }));
    // Without viewport geometry the window term is empty (legacy snapshots).
    expect(hashSnapshot(snapshot([at(100)]))).toBe(hashSnapshot(snapshot([at(5000)])));
  });
});
