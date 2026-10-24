// Combos: several foods saved as one My foods entry ("my usual breakfast",
// "chili, makes 6"). Logged as a single row; its numbers are the sum of its
// ingredients, divided by the servings it makes. The ingredients are kept
// (an Ingredients column in My foods) so the combo can be edited later.

import { MACROS, makeCustomFood } from './food.js';
import { formatNumber } from './table.js';

/** @typedef {import('./types').Food} Food */
/** @typedef {import('./types').Ingredient} Ingredient */
/** @typedef {import('./types').Nutrients} Nutrients */

// items: [{ name, qty, unit, grams, nutrients }] — nutrients are totals for
// that amount, grams null when the food has no known weight.
// Returns a food (like makeCustomFood's) or null when calories are unknown.
/**
 * @param {{ name: string, items: { name: string, qty: number | string, unit: string, grams: number | null, nutrients?: Nutrients }[], servings?: number }} combo
 * @returns {Food | null}
 */
function makeCombo({ name, items, servings = 1 }) {
  const n = Number(servings) > 0 ? Number(servings) : 1;
  if (!items.length) return null;
  /** @type {Nutrients} */
  const sums = { kcal: null, protein: null, carbs: null, fat: null };
  for (const k of MACROS) {
    for (const i of items) {
      const v = i.nutrients?.[k];
      if (v !== null && v !== undefined) sums[k] = (sums[k] ?? 0) + v;
    }
  }
  if (sums.kcal === null) return null;
  const weighed = items.every((i) => i.grams !== null && i.grams > 0);
  const totalGrams = weighed ? items.reduce((a, i) => a + (i.grams ?? 0), 0) : null;
  const food = makeCustomFood({
    name,
    servingAmount: 1,
    servingUnit: 'serving',
    servingGrams: totalGrams === null ? null : totalGrams / n,
    kcal: sums.kcal / n,
    protein: sums.protein === null ? null : sums.protein / n,
    carbs: sums.carbs === null ? null : sums.carbs / n,
    fat: sums.fat === null ? null : sums.fat / n,
  });
  if (n !== 1) {
    const serving = food.portions.find((p) => p.unit === 'serving');
    food.portions.push({
      unit: 'batch',
      amount: 1,
      grams: (serving?.grams ?? 0) * n,
      def: `${formatNumber(n, 3)} serving`,
    });
  }
  food.ingredients = items.map((i) => ({ name: i.name, qty: Number(i.qty), unit: i.unit }));
  food.servings = n;
  return food;
}

// [{ name, qty, unit }] ⇄ "Oats (40 g); Bananas, raw (1 medium)"
/** @param {Ingredient[] | undefined} ingredients */
function ingredientsText(ingredients) {
  return (ingredients || [])
    .map((i) => `${String(i.name).replace(/;/g, ',')} (${formatNumber(i.qty, 3)} ${i.unit})`)
    .join('; ');
}

/** @param {string | null | undefined} text */
function parseIngredients(text) {
  /** @type {Ingredient[]} */
  const out = [];
  for (const part of String(text || '').split(';')) {
    // The last "(amount unit)" — names can have their own parentheses.
    const m = part.trim().match(/^(.*\S)\s*\(\s*(\d+(?:\.\d+)?)\s*([^()]*?)\s*\)$/);
    if (m) out.push({ name: m[1], qty: Number(m[2]), unit: m[3] || 'serving' });
  }
  return out;
}

export { ingredientsText, makeCombo, parseIngredients };
