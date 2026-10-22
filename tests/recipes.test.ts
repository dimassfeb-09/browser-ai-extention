import { describe, expect, it } from 'vitest';
import {
  deleteRecipe,
  findRecipe,
  formatRecipes,
  normalizeRecipes,
  saveRecipe,
} from '../src/core/recipes';

describe('recipes', () => {
  it('normalizes and de-duplicates by name', () => {
    const raw = [
      { name: '  Foo  ', goal: '  do x  ', createdAt: 1 },
      { name: 'foo', goal: 'do y', createdAt: 2 },
      { name: '', goal: 'no' },
      { name: 'ok', goal: '' },
    ];
    const out = normalizeRecipes(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'foo', goal: 'do y' });
  });

  it('saves and replaces', () => {
    let r = saveRecipe([], 'Bar', 'open page', 10);
    expect(r).toHaveLength(1);
    r = saveRecipe(r, 'bar', 'open other', 20);
    expect(r).toHaveLength(1);
    expect(findRecipe(r, 'BAR')?.goal).toBe('open other');
  });

  it('deletes', () => {
    const r = saveRecipe([], 'Bar', 'open page', 10);
    expect(deleteRecipe(r, 'bar')).toHaveLength(0);
  });

  it('formats empty and list', () => {
    expect(formatRecipes([])).toContain('No saved recipes');
    expect(formatRecipes(saveRecipe([], 'Bar', 'open page', 10))).toContain('Bar — open page');
  });
});
