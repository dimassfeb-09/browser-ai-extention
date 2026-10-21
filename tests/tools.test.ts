import { describe, expect, it } from 'vitest';
import { actionFromToolArgs, parseAction } from '../src/core/tools';

describe('parseAction (LLM output is untrusted)', () => {
  it('accepts a valid action', () => {
    expect(parseAction({ type: 'click', index: 3 })).toEqual({ type: 'click', index: 3 });
  });
  it('rejects a negative index and an oversized wait', () => {
    expect(() => parseAction({ type: 'click', index: -1 })).toThrow();
    expect(() => parseAction({ type: 'wait', ms: 999_999 })).toThrow();
  });
  it('rejects unknown action types', () => {
    expect(() => parseAction({ type: 'delete_everything' })).toThrow();
  });
});

describe('actionFromToolArgs', () => {
  it('maps flat tool args (object or JSON string) into Actions', () => {
    expect(actionFromToolArgs({ type: 'type', index: 2, text: 'halo' })).toEqual({
      type: 'type',
      index: 2,
      text: 'halo',
    });
    expect(actionFromToolArgs('{"type":"scroll","direction":"down"}')).toEqual({
      type: 'scroll',
      direction: 'down',
      amount: undefined,
    });
    expect(actionFromToolArgs({ type: 'done', summary: 'selesai' })).toEqual({
      type: 'done',
      summary: 'selesai',
    });
  });
  it('throws on a navigate without a valid URL instead of executing garbage', () => {
    expect(() => actionFromToolArgs({ type: 'navigate', url: 'bukan-url' })).toThrow();
  });
  it('maps click_at with coordinates and rejects negative offsets', () => {
    expect(actionFromToolArgs({ type: 'click_at', index: 2, x: 120, y: 40 })).toEqual({
      type: 'click_at',
      index: 2,
      x: 120,
      y: 40,
    });
    expect(() => parseAction({ type: 'click_at', index: 2, x: -5, y: 0 })).toThrow();
  });
  it('treats null as "field not provided" (models send null for unused fields)', () => {
    expect(
      actionFromToolArgs({ type: 'click', index: 4, text: null, url: null, ms: null }),
    ).toEqual({ type: 'click', index: 4 });
    expect(actionFromToolArgs({ type: 'done', summary: null })).toEqual({
      type: 'done',
      summary: 'Done.',
    });
  });
});
