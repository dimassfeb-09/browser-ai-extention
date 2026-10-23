import { browser } from 'wxt/browser';
import type { PageSnapshot } from '../../core/types';
import { planMarks } from '../../core/marks';

/**
 * Screenshot observation (set-of-marks): capture the visible tab,
 * draw a numbered badge + outline for every snapshot element at its
 * bounds, and return the marked image as a data URL for the model.
 *
 * captureVisibleTab only ever captures the ACTIVE tab of a window —
 * when the run's pinned tab is in the background this returns null
 * and the run simply continues text-only until the user comes back.
 * Every failure is swallowed to null for the same reason: a missing
 * screenshot must never break an otherwise working run.
 */
const MAX_WIDTH = 1280;

export async function captureAndMark(
  tabId: number,
  snapshot: PageSnapshot,
  onlyIndices?: ReadonlySet<number>,
): Promise<string | null> {
  try {
    if (!snapshot.viewport) return null;
    const tab = await browser.tabs.get(tabId);
    if (!tab.active || tab.windowId == null) return null;
    const raw = await browser.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: 85,
    });
    return await drawMarks(raw, snapshot, onlyIndices);
  } catch {
    return null;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('screenshot image failed to load'));
    img.src = src;
  });
}

async function drawMarks(
  dataUrl: string,
  snapshot: PageSnapshot,
  onlyIndices?: ReadonlySet<number>,
): Promise<string | null> {
  const img = await loadImage(dataUrl);
  const down = img.naturalWidth > MAX_WIDTH ? MAX_WIDTH / img.naturalWidth : 1;
  const w = Math.round(img.naturalWidth * down);
  const h = Math.round(img.naturalHeight * down);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);

  const plans = planMarks(snapshot.elements, snapshot.viewport!, { width: w, height: h }, onlyIndices);
  const fontSize = Math.max(11, Math.round(w / 80));
  const pad = 3;
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textBaseline = 'top';
  ctx.lineWidth = Math.max(2, Math.round(w / 640));
  for (const m of plans) {
    ctx.strokeStyle = 'rgba(220, 38, 38, 0.85)';
    ctx.strokeRect(m.x, m.y, m.w, m.h);
    const label = String(m.index);
    const tw = Math.ceil(ctx.measureText(label).width) + pad * 2;
    const th = fontSize + pad * 2;
    const bx = Math.max(0, Math.min(m.x, w - tw));
    const by = Math.max(0, m.y - th);
    ctx.fillStyle = 'rgba(220, 38, 38, 0.92)';
    ctx.fillRect(bx, by, tw, th);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, bx + pad, by + pad);
  }
  return canvas.toDataURL('image/jpeg', 0.85);
}
