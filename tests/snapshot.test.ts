import { describe, expect, it } from 'vitest';
import {
  cleanElements,
  findByFingerprint,
  hashSnapshot,
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
