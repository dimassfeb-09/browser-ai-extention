import type { ActResult } from './types';

/**
 * Actuator escalation ladder, weakest/cheapest first:
 *  0 dom          — el.click(), native value setter + input/change events
 *  1 events       — full pointer/mouse/keyboard event sequence
 *  2 execCommand  — document.execCommand('insertText') for rich text editors
 *  3 coordinates  — dispatch at the element's bounding-box point
 *  4 cdp          — chrome.debugger / CDP Input.* (browser-level, last resort)
 * The content script implements 0–3 today; 4 is reserved for the CDP driver.
 */
export const ACTUATOR_LEVELS = ['dom', 'events', 'execCommand', 'coordinates', 'cdp'] as const;
export type ActuatorLevel = (typeof ACTUATOR_LEVELS)[number];

export function nextLevel(current: number): number | null {
  const next = current + 1;
  return next < ACTUATOR_LEVELS.length ? next : null;
}

export function shouldEscalate(result: ActResult): boolean {
  return !result.ok;
}

/** True when the last `threshold` observations are identical — the agent is going in circles. */
export function isStuck(hashes: string[], threshold = 3): boolean {
  if (hashes.length < threshold) return false;
  const tail = hashes.slice(-threshold);
  return tail.every((h) => h === tail[0]);
}
