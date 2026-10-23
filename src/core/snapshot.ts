import type { ElementRef, Fingerprint, PageSnapshot } from './types';

/** Stable-enough hash of what the agent "sees"; used for stuck detection. */
export function hashSnapshot(snapshot: PageSnapshot): string {
  const parts = [
    snapshot.url,
    ...snapshot.elements.map(
      (el) => `${el.index}:${el.tag}:${el.label}:${el.value ?? ''}:${el.checked ?? ''}:${el.context ?? ''}`,
    ),
  ];
  let hash = 5381;
  const joined = parts.join('|');
  for (let i = 0; i < joined.length; i++) {
    hash = ((hash << 5) + hash + joined.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

/**
 * Clean raw collected elements: trim labels, drop exact duplicates
 * (same element collected twice via nested traversal), re-index.
 */
export function cleanElements(raw: Array<Omit<ElementRef, 'index'>>): ElementRef[] {
  const seen = new Set<string>();
  const out: ElementRef[] = [];
  for (const el of raw) {
    const label = el.label.replace(/\s+/g, ' ').trim().slice(0, 120);
    const key = `${el.fingerprint.cssPath}::${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...el, label, index: out.length });
  }
  return out;
}

/**
 * Fit a snapshot into a character budget for the model: page text is
 * trimmed first, then elements are dropped from the end (the collector
 * emits them in DOM order, so the top of the page survives).
 */
export function truncateSnapshot(snapshot: PageSnapshot, maxChars = 12_000): PageSnapshot {
  const render = (s: PageSnapshot) => JSON.stringify(s).length;
  if (render(snapshot) <= maxChars) return snapshot;

  let textBudget = snapshot.text;
  while (render({ ...snapshot, text: textBudget }) > maxChars && textBudget.length > 0) {
    textBudget = textBudget.slice(0, Math.floor(textBudget.length * 0.7));
  }
  let elements = snapshot.elements;
  while (
    render({ ...snapshot, text: textBudget, elements }) > maxChars &&
    elements.length > 0
  ) {
    elements = elements.slice(0, Math.floor(elements.length * 0.8));
  }
  return { ...snapshot, text: textBudget, elements };
}

/**
 * Merge per-frame snapshots (top frame first) into one page snapshot
 * with fresh sequential indices. The driver keeps the index -> frame
 * routing table; element identity inside a frame is untouched.
 */
export function mergeSnapshots(snapshots: PageSnapshot[]): PageSnapshot {
  const first = snapshots[0];
  if (!first) {
    return { url: '', title: '', elements: [], text: '', capturedAt: Date.now() };
  }
  const elements: ElementRef[] = [];
  for (const snap of snapshots) {
    for (const el of snap.elements) {
      elements.push({ ...el, index: elements.length });
    }
  }
  return {
    url: first.url,
    title: first.title,
    elements,
    text: snapshots.map((s) => s.text).filter(Boolean).join('\n'),
    capturedAt: Math.max(...snapshots.map((s) => s.capturedAt)),
    viewport: first.viewport,
    visual: snapshots.some((s) => s.visual),
  };
}

/**
 * Re-resolve an element after a re-render: exact cssPath first,
 * then tag+label fingerprint match. Null when it is really gone.
 */
export function findByFingerprint(
  elements: ElementRef[],
  fingerprint: Fingerprint,
): ElementRef | null {
  const exact = elements.find((el) => el.fingerprint.cssPath === fingerprint.cssPath);
  if (exact) return exact;
  const fuzzy = elements.find(
    (el) => el.fingerprint.tag === fingerprint.tag && el.fingerprint.label === fingerprint.label,
  );
  return fuzzy ?? null;
}
