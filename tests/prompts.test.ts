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
