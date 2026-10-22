export interface Recipe {
  name: string;
  goal: string;
  createdAt?: number;
}

function key(name: string): string {
  return name.trim().toLowerCase();
}

export function normalizeRecipeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/** Stable, case-insensitive list normalization: drop malformed entries
 *  and de-duplicate by name (last wins). */
export function normalizeRecipes(raw: unknown): Recipe[] {
  if (!Array.isArray(raw)) return [];
  const byKey = new Map<string, Recipe>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Partial<Recipe>;
    if (typeof r.name !== 'string' || typeof r.goal !== 'string') continue;
    const name = normalizeRecipeName(r.name);
    const goal = r.goal.trim();
    if (!name || !goal) continue;
    byKey.set(key(name), { name, goal, createdAt: typeof r.createdAt === 'number' ? r.createdAt : undefined });
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findRecipe(recipes: Recipe[], name: string): Recipe | undefined {
  return recipes.find((r) => key(r.name) === key(name));
}

/** Replace an existing recipe of the same name, or append a new one. */
export function saveRecipe(recipes: Recipe[], name: string, goal: string, now = Date.now()): Recipe[] {
  const cleanName = normalizeRecipeName(name);
  const cleanGoal = goal.trim();
  const next = recipes.filter((r) => key(r.name) !== key(cleanName));
  next.push({ name: cleanName, goal: cleanGoal, createdAt: now });
  return next.sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteRecipe(recipes: Recipe[], name: string): Recipe[] {
  return recipes.filter((r) => key(r.name) !== key(name));
}

export function formatRecipes(recipes: Recipe[]): string {
  if (recipes.length === 0) return 'No saved recipes yet. Save one with /recipe save <name> (uses your last goal) or /recipe save <name> <goal>.';
  return [
    'Saved recipes:',
    ...recipes.map((r) => `• ${r.name} — ${r.goal}`),
    '',
    'Run one with /recipe run <name>.',
  ].join('\n');
}
