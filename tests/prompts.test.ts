import { describe, expect, it } from 'vitest';
import { buildUserPrompt, formatSnapshot } from '../src/core/prompts';
import type { ElementRef, PageSnapshot } from '../src/core/types';

function makeElements(n: number): ElementRef[] {
  // Deliberately fat fingerprints/bounds: the raw JSON of this snapshot is
  // far beyond the old 12k budget, which used to silently drop late elements.
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    tag: 'button',
    label: `Tombol ${i}`,
    fingerprint: {
      tag: 'button',
      label: `Tombol ${i}`,
      cssPath: `body > div.app-shell > main > section.panel-${'x'.repeat(60)} > div:nth-of-type(${i}) > button`,
    },
    bounds: { x: 100 + i, y: 200 + i, width: 120, height: 32 },
  }));
}

function snap(elements: ElementRef[]): PageSnapshot {
  return { url: 'https://example.com/', title: 'App', elements, text: 'isi halaman', capturedAt: 0 };
}

describe('formatSnapshot', () => {
  it('keeps late elements that the old JSON budget would have dropped', () => {
    const out = formatSnapshot(snap(makeElements(90)));
    expect(JSON.stringify(snap(makeElements(90))).length).toBeGreaterThan(12_000);
    expect(out).toContain('Tombol 89');
    expect(out).not.toContain('more elements not shown');
  });

  it('shows a truncation notice instead of silently cutting when truly over budget', () => {
    const out = formatSnapshot(snap(makeElements(400)));
    expect(out).toContain('more elements not shown');
  });

  it('renders row context so identical row buttons are distinguishable', () => {
    const elements: ElementRef[] = [
      {
        index: 7,
        tag: 'button',
        label: 'Edit',
        context: 'USR-023 Nama23 Aktif',
        fingerprint: { tag: 'button', label: 'Edit', cssPath: 'body > table > tr > td > button' },
      },
    ];
    const out = formatSnapshot(snap(elements));
    expect(out).toContain('ctx="USR-023 Nama23 Aktif"');
  });

  it('renders input type and disabled state (what the model needs for forms)', () => {
    const elements: ElementRef[] = [
      {
        index: 0,
        tag: 'input',
        inputType: 'email',
        disabled: true,
        label: 'Email',
        fingerprint: { tag: 'input', label: 'Email', cssPath: 'body > input' },
      },
    ];
    const out = formatSnapshot(snap(elements));
    expect(out).toContain('<input type="email">');
    expect(out).toContain('DISABLED');
  });
});

describe('formatSnapshot viewport windowing', () => {
  const VP = { width: 1000, height: 800 };
  function el(index: number, label: string, y: number): ElementRef {
    return {
      index,
      tag: 'button',
      label,
      fingerprint: { tag: 'button', label, cssPath: `body > button:nth-of-type(${index})` },
      bounds: { x: 10, y, width: 120, height: 32 },
    };
  }
  function snapVp(elements: ElementRef[]): PageSnapshot {
    return { url: 'https://example.com/', title: 'App', elements, text: 'isi', capturedAt: 0, viewport: VP };
  }

  it('renders the visible band first, then below the fold, then scrolled-past', () => {
    const out = formatSnapshot(
      snapVp([el(0, 'Bawah', 5000), el(1, 'Terlihat', 100), el(2, 'Lewat', -500)]),
    );
    const pos = (s: string) => out.indexOf(s);
    expect(pos('Terlihat')).toBeGreaterThanOrEqual(0);
    expect(pos('Terlihat')).toBeLessThan(pos('Bawah'));
    expect(pos('Bawah')).toBeLessThan(pos('Lewat'));
    // Indices are untouched by the render order — actions still map.
    expect(out).toContain('[0] <button> "Bawah"');
    expect(out).toContain('[1] <button> "Terlihat"');
  });

  it('when the budget overflows, below-fold elements are hidden with a scroll-down notice', () => {
    // Fat visible elements exhaust the 16k render budget on their own.
    const fat = Array.from({ length: 130 }, (_, i) => el(i, `Tombol ${'x'.repeat(110)} ${i}`, 10 + i));
    const below = el(999, 'TargetBawah', 9000);
    const out = formatSnapshot(snapVp([...fat, below]));
    expect(out).not.toContain('TargetBawah');
    expect(out).toContain('below the viewport');
    expect(out).toContain('scroll down to reveal them');
  });

  it('scrolling the window (same DOM, new bounds) changes which elements render', () => {
    const before = formatSnapshot(snapVp([el(0, 'Pertama', 100), el(1, 'Terakhir', 9000)]));
    const after = formatSnapshot(snapVp([el(0, 'Pertama', -9000), el(1, 'Terakhir', 100)]));
    // After the scroll, the last element leads the render.
    expect(after.indexOf('Terakhir')).toBeLessThan(after.indexOf('Pertama'));
    expect(before.indexOf('Pertama')).toBeLessThan(before.indexOf('Terakhir'));
  });
});

describe('buildUserPrompt', () => {
  it('includes the act result MESSAGES, not just ok/failed (the model needs the why)', () => {
    const out = buildUserPrompt('isi form', snap(makeElements(1)), [
      {
        step: 1,
        snapshotHash: 'h',
        action: { type: 'click', index: 0 },
        result: { ok: true, message: 'Clicked [0] <button>', level: 0 },
      },
    ]);
    expect(out).toContain('Clicked [0] <button>');
  });

  it('surfaces the harness notice prominently', () => {
    const out = buildUserPrompt('x', snap(makeElements(1)), [], 'The page did NOT change…');
    expect(out).toContain('HARNESS NOTICE: The page did NOT change…');
  });

  it('renders recent steps WITH the typed text (the model must see what it already entered)', () => {
    const out = buildUserPrompt('isi form', snap(makeElements(1)), [
      {
        step: 19,
        snapshotHash: 'h',
        action: { type: 'type', index: 53, text: 'Random Toll Segment 77' },
        result: { ok: true, message: 'Typed (native setter)', level: 0 },
      },
    ]);
    expect(out).toContain('type [53] "Random Toll Segment 77"');
  });

  it('renders the conversation so follow-ups are answered from the agent\'s own record', () => {
    const out = buildUserPrompt('berapa data yang kamu tambah?', snap(makeElements(1)), [], undefined, [
      { role: 'user', content: 'Fill randomly value' },
      {
        role: 'assistant',
        content: '(done) Filled a random value and saved it.\nActions taken: click [54]; type [53] "Random Toll Segment 77"',
      },
    ]);
    expect(out).toContain('Conversation so far');
    expect(out).toContain('USER: Fill randomly value');
    expect(out).toContain('YOU: (done) Filled a random value');
  });

  it('mentions the attached screenshot only when the snapshot carries one', () => {
    const withShot = buildUserPrompt('jawab soal', { ...snap(makeElements(1)), screenshot: 'data:image/jpeg;base64,AAAA' }, []);
    expect(withShot).toContain('A screenshot of the page is attached');
    const without = buildUserPrompt('jawab soal', snap(makeElements(1)), []);
    expect(without).not.toContain('A screenshot of the page is attached');
  });
});

describe('formatSnapshot checked state (ARIA widgets)', () => {
  it('marks a selected radio/checkbox as CHECKED and leaves unselected ones unmarked', () => {
    const els: ElementRef[] = [
      { index: 0, tag: 'div', role: 'radio', label: 'Kuning', checked: true, fingerprint: { tag: 'div', label: 'Kuning', cssPath: 'body > div > div' } },
      { index: 1, tag: 'div', role: 'radio', label: 'Merah', checked: false, fingerprint: { tag: 'div', label: 'Merah', cssPath: 'body > div > div' } },
    ];
    const lines = formatSnapshot(snap(els)).split('\n');
    expect(lines.find((l) => l.includes('Kuning'))).toContain('CHECKED');
    expect(lines.find((l) => l.includes('Merah'))).not.toContain('CHECKED');
  });

  it('renders generic widget state tokens', () => {
    const els: ElementRef[] = [
      { index: 0, tag: 'div', role: 'button', label: 'Detail Harga', state: 'expanded', fingerprint: { tag: 'div', label: 'Detail Harga', cssPath: 'body > div' } },
    ];
    expect(formatSnapshot(snap(els))).toContain('state=expanded');
  });
});
