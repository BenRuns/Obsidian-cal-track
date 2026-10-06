'use strict';

// ─── Units ────────────────────────────────────────────────────────────────────
//
// Every food's nutrition is stored per 100 g. A quantity + unit is turned into
// grams one of three ways:
//   - mass units convert directly (oz → g)
//   - volume units need the food's density, which is derived from any
//     volume-based portion the database gave us (e.g. "1 cup = 150 g")
//   - named portions ("medium", "slice", "serving") use their gram weight

const MASS_UNITS = {
  g: 1,
  mg: 0.001,
  kg: 1000,
  oz: 28.349523125,
  lb: 453.59237,
};

const VOLUME_UNITS = {
  ml: 1,
  l: 1000,
  tsp: 4.92892159375,
  tbsp: 14.78676478125,
  'fl oz': 29.5735295625,
  cup: 236.5882365,
};

const ALIASES = {
  gram: 'g',
  grams: 'g',
  gm: 'g',
  grm: 'g',
  milligram: 'mg',
  milligrams: 'mg',
  kilogram: 'kg',
  kilograms: 'kg',
  ounce: 'oz',
  ounces: 'oz',
  pound: 'lb',
  pounds: 'lb',
  lbs: 'lb',
  milliliter: 'ml',
  milliliters: 'ml',
  millilitre: 'ml',
  millilitres: 'ml',
  mlt: 'ml',
  liter: 'l',
  liters: 'l',
  litre: 'l',
  litres: 'l',
  teaspoon: 'tsp',
  teaspoons: 'tsp',
  tablespoon: 'tbsp',
  tablespoons: 'tbsp',
  tbs: 'tbsp',
  'fluid ounce': 'fl oz',
  'fluid ounces': 'fl oz',
  floz: 'fl oz',
  'fl. oz': 'fl oz',
  cups: 'cup',
  c: 'cup',
  servings: 'serving',
};

function normalizeUnit(unit) {
  const u = String(unit || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  return ALIASES[u] || u;
}

function isMassUnit(unit) {
  return Object.hasOwn(MASS_UNITS, normalizeUnit(unit));
}

function isVolumeUnit(unit) {
  return Object.hasOwn(VOLUME_UNITS, normalizeUnit(unit));
}

// Grams per millilitre, derived from the first volume-based portion. Returns
// null when the food has no volume portion (so cups/tbsp aren't offered).
function densityOf(food) {
  if (food.density > 0) return food.density;
  for (const p of food.portions || []) {
    const u = normalizeUnit(p.unit);
    if (isVolumeUnit(u) && p.amount > 0 && p.grams > 0) {
      return p.grams / (p.amount * VOLUME_UNITS[u]);
    }
  }
  return null;
}

function findPortion(food, unit) {
  const u = normalizeUnit(unit);
  return (food.portions || []).find((p) => normalizeUnit(p.unit) === u && p.grams > 0);
}

// Converts qty of unit into grams for this food, or null if impossible.
function toGrams(food, qty, unit) {
  const q = Number(qty);
  if (!Number.isFinite(q) || q < 0) return null;
  const u = normalizeUnit(unit);
  if (isMassUnit(u)) return food.noMass ? null : q * MASS_UNITS[u];
  // A named portion wins over a generic volume conversion, so "1 cup" uses the
  // database's own cup weight rather than one derived from another portion.
  const portion = findPortion(food, u);
  if (portion) return (q * portion.grams) / (portion.amount || 1);
  if (isVolumeUnit(u) && !food.noMass) {
    const density = densityOf(food);
    return density ? q * VOLUME_UNITS[u] * density : null;
  }
  return null;
}

// Units to offer in the picker for this food: named portions first (they're
// the most natural — "1 medium banana"), then mass, then volume if we know
// the density.
function unitsFor(food) {
  const seen = new Set();
  const out = [];
  const add = (u) => {
    const n = normalizeUnit(u);
    if (!n || seen.has(n)) return;
    seen.add(n);
    out.push(n);
  };
  for (const p of food.portions || []) if (p.grams > 0) add(p.unit);
  if (food.noMass) return out;
  for (const u of Object.keys(MASS_UNITS)) add(u);
  if (densityOf(food)) for (const u of Object.keys(VOLUME_UNITS)) add(u);
  return out;
}

module.exports = {
  MASS_UNITS,
  VOLUME_UNITS,
  normalizeUnit,
  isMassUnit,
  isVolumeUnit,
  densityOf,
  toGrams,
  unitsFor,
};
