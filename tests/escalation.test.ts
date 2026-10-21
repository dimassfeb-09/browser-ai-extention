import { describe, expect, it } from 'vitest';
import { ACTUATOR_LEVELS, isStuck, nextLevel, shouldEscalate } from '../src/core/escalation';

describe('escalation ladder', () => {
  it('climbs dom -> events -> execCommand -> coordinates -> cdp, then stops', () => {
    expect(ACTUATOR_LEVELS).toEqual(['dom', 'events', 'execCommand', 'coordinates', 'cdp']);
    expect(nextLevel(0)).toBe(1);
    expect(nextLevel(3)).toBe(4);
    expect(nextLevel(4)).toBeNull();
  });

  it('escalates only on failure', () => {
    expect(shouldEscalate({ ok: false, message: 'x', level: 0 })).toBe(true);
    expect(shouldEscalate({ ok: true, message: 'x', level: 0 })).toBe(false);
  });
});

describe('isStuck', () => {
  it('needs 3 identical hashes in a row', () => {
    expect(isStuck(['a', 'a'])).toBe(false);
    expect(isStuck(['a', 'b', 'b', 'b'])).toBe(true);
    expect(isStuck(['a', 'a', 'b'])).toBe(false);
  });
});
