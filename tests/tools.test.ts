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
});
