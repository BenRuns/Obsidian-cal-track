'use strict';

// Combos: several foods saved as one My foods entry ("my usual breakfast",
// "chili, makes 6"). Logged as a single row; its numbers are the sum of its
// ingredients, divided by the servings it makes. The ingredients are kept
// (an Ingredients column in My foods) so the combo can be edited later.

const { MACROS, makeCustomFood } = require('./food');
const { formatNumber } = require('./table');

// items: [{ name, qty, unit, grams, nutrients }] — nutrients are totals for
// that amount, grams null when the food has no known weight.
// Returns a food (like makeCustomFood's) or null when calories are unknown.
function makeCombo({ name, items, servings = 1 }) {
  const n = Number(servings) > 0 ? Number(servings) : 1;
  if (!items.length) return null;
  const sums = {};
  for (const k of MACROS) {
    const vals = items.map((i) => i.nutrients?.[k]).filter((v) => v !== null && v !== undefined);
    sums[k] = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  }
  if (sums.kcal === null) return null;
  const weighed = items.every((i) => i.grams > 0);
  const totalGrams = weighed ? items.reduce((a, i) => a + i.grams, 0) : null;
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
      grams: serving.grams * n,
      def: `${formatNumber(n, 3)} serving`,
    });
  }
  food.ingredients = items.map((i) => ({ name: i.name, qty: Number(i.qty), unit: i.unit }));
  food.servings = n;
  return food;
}

// [{ name, qty, unit }] ⇄ "Oats (40 g); Bananas, raw (1 medium)"
function ingredientsText(ingredients) {
  return (ingredients || [])
    .map((i) => `${String(i.name).replace(/;/g, ',')} (${formatNumber(i.qty, 3)} ${i.unit})`)
    .join('; ');
}

function parseIngredients(text) {
  const out = [];
  for (const part of String(text || '').split(';')) {
    // The last "(amount unit)" — names can have their own parentheses.
    const m = part.trim().match(/^(.*\S)\s*\(\s*(\d+(?:\.\d+)?)\s*([^()]*?)\s*\)$/);
    if (m) out.push({ name: m[1], qty: Number(m[2]), unit: m[3] || 'serving' });
  }
  return out;
}

module.exports = { makeCombo, ingredientsText, parseIngredients };
