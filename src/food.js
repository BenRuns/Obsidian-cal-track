import { isMassUnit, isVolumeUnit, MASS_UNITS, normalizeUnit, VOLUME_UNITS } from './units.js';

// ─── Normalized food shape ────────────────────────────────────────────────────
//
// {
//   id:       'usda:171705' | 'off:3017620422003' | 'custom:protein bar',
//   source:   'usda' | 'off' | 'custom',
//   name:     'Bananas, raw',
//   brand:    '' | 'Fage',
//   per100g:  { kcal, protein, carbs, fat }   // null for any unknown macro
//   portions: [{ unit: 'medium', amount: 1, grams: 118 }, ...],
//   density:  g/ml, only when the source states it outright (optional)
//   noMass:   true when portions are the only usable units (custom foods
//             entered per serving with no weight)
// }

/** @typedef {import('./types').Food} Food */
/** @typedef {import('./types').Macro} Macro */
/** @typedef {import('./types').Nutrients} Nutrients */
/** @typedef {import('./types').Portion} Portion */
/** @typedef {import('./types').UsdaFoodJson} UsdaFoodJson */
/** @typedef {import('./types').UsdaNutrient} UsdaNutrient */
/** @typedef {import('./types').UsdaSearchJson} UsdaSearchJson */
/** @typedef {import('./types').OffProductJson} OffProductJson */
/** @typedef {import('./types').OffSearchJson} OffSearchJson */
/** @typedef {number | string | null | undefined} NumberLike */

/** @type {Macro[]} */
const MACROS = ['kcal', 'protein', 'carbs', 'fat'];

/** @returns {Nutrients} */
const noNutrients = () => ({ kcal: null, protein: null, carbs: null, fat: null });

/**
 * @param {unknown} v
 * @returns {number | null}
 */
function num(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

// "1", "0.5", "1/2", "1 1/2" → number; returns { amount, rest }.
/** @param {string | null | undefined} text */
function splitLeadingAmount(text) {
  const s = String(text || '').trim();
  const m = s.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d*\.?\d+)\s*(.*)$/);
  if (!m) return { amount: 1, rest: s };
  let amount;
  const parts = m[1].split(/\s+/);
  if (parts.length === 2) {
    const [n, d] = parts[1].split('/').map(Number);
    amount = Number(parts[0]) + n / d;
  } else if (m[1].includes('/')) {
    const [n, d] = m[1].split('/').map(Number);
    amount = n / d;
  } else {
    amount = Number(m[1]);
  }
  return { amount: amount > 0 ? amount : 1, rest: m[2] };
}

// Shortens a portion description to a unit name for the picker:
// "cup, sliced" → "cup", "medium (7\" to 7-7/8\" long)" → "medium",
// "tbsp" → "tbsp", "NLEA serving" → "nlea serving".
/** @param {string | null | undefined} text */
function portionUnit(text) {
  const head = String(text || '')
    .split(/[,(]/)[0]
    .trim()
    .toLowerCase();
  if (!head) return '';
  const n = normalizeUnit(head);
  if (isVolumeUnit(n) || isMassUnit(n)) return n;
  // "cup sliced" style (no comma): keep a leading volume unit if present.
  const first = n.split(/\s+/)[0];
  if (isVolumeUnit(normalizeUnit(first))) return normalizeUnit(first);
  return n;
}

/**
 * @param {string | undefined} text
 * @param {unknown} grams
 * @param {number} [amountOverride]
 * @returns {Portion | null}
 */
function makePortion(text, grams, amountOverride) {
  const g = num(grams);
  if (!g || g <= 0) return null;
  const { amount, rest } = splitLeadingAmount(text);
  const unit = portionUnit(rest);
  if (!unit || /quantity not specified/.test(unit)) return null;
  // A mass "portion" (e.g. "1 oz = 28 g") adds nothing over direct conversion.
  if (isMassUnit(unit)) return null;
  return { unit, amount: amountOverride || amount, grams: g };
}

/**
 * @param {(Portion | null)[]} portions
 * @returns {Portion[]}
 */
function dedupePortions(portions) {
  const seen = new Set();
  return /** @type {Portion[]} */ (
    portions.filter((p) => {
      if (!p || seen.has(p.unit)) return false;
      seen.add(p.unit);
      return true;
    })
  );
}

// USDA branded descriptions come back ALL CAPS ("GREEK NONFAT YOGURT").
/** @param {string | undefined} s */
function tidyCase(s) {
  const str = String(s || '').trim();
  if (str && str === str.toUpperCase() && /[A-Z]/.test(str)) {
    return str
      .toLowerCase()
      .replace(
        /(^|[\s(/-])([a-z])/g,
        (/** @type {string} */ _, /** @type {string} */ a, /** @type {string} */ b) =>
          a + b.toUpperCase(),
      );
  }
  return str;
}

// ─── USDA FoodData Central ────────────────────────────────────────────────────

// Energy can appear as 1008 (Energy), or 2047/2048 (Atwater general/specific,
// used by Foundation foods). 1062 is kJ — never use it as kcal.
const USDA_NUTRIENTS = {
  kcal: { ids: [1008, 2048, 2047], numbers: ['208', '958', '957'] },
  protein: { ids: [1003], numbers: ['203'] },
  carbs: { ids: [1005], numbers: ['205'] },
  fat: { ids: [1004], numbers: ['204'] },
};

// Search results use flat { nutrientId, nutrientNumber, unitName, value };
// the /food/{id} endpoint nests { nutrient: { id, number, unitName }, amount }.
/**
 * @param {UsdaNutrient[] | undefined} foodNutrients
 * @param {Macro} key
 */
function usdaNutrientValue(foodNutrients, key) {
  const spec = USDA_NUTRIENTS[key];
  const flat = (foodNutrients || []).map((n) => ({
    id: num(n.nutrientId ?? n.nutrient?.id),
    number: String(n.nutrientNumber ?? n.nutrient?.number ?? ''),
    unit: String(n.unitName ?? n.nutrient?.unitName ?? '').toLowerCase(),
    value: num(n.value ?? n.amount),
  }));
  for (let i = 0; i < spec.ids.length; i++) {
    const hit = flat.find(
      (n) =>
        (n.id === spec.ids[i] || n.number === spec.numbers[i]) &&
        n.value !== null &&
        (key !== 'kcal' || n.unit === '' || n.unit === 'kcal'),
    );
    if (hit) return hit.value;
  }
  return null;
}

/**
 * @param {UsdaFoodJson} f
 * @returns {Food}
 */
function parseUsdaFood(f) {
  const per100g = noNutrients();
  for (const k of MACROS) per100g[k] = usdaNutrientValue(f.foodNutrients, k);

  /** @type {(Portion | null)[]} */
  const portions = [];
  let density;

  // Branded foods: one label serving, stated in g or ml.
  const servingSize = num(f.servingSize);
  const servingUnit = normalizeUnit(f.servingSizeUnit);
  if (servingSize > 0 && (servingUnit === 'g' || servingUnit === 'ml')) {
    // Branded nutrients are per 100 g, or per 100 ml for liquids. Treating a
    // ml-labelled product as 1 g/ml is the same assumption the label makes.
    if (servingUnit === 'ml') density = 1;
    portions.push({ unit: 'serving', amount: 1, grams: servingSize });
    const household = makePortion(f.householdServingFullText, servingSize);
    if (household) portions.push(household);
  }

  // Search results: foodMeasures. Detail endpoint: foodPortions.
  for (const m of f.foodMeasures || []) {
    portions.push(makePortion(m.disseminationText, m.gramWeight));
  }
  for (const p of f.foodPortions || []) {
    const unitName = p.measureUnit?.name;
    const known = unitName && unitName !== 'undetermined';
    // Foundation: amount + measureUnit ("cup") + modifier ("sliced").
    // SR Legacy: measureUnit undetermined, unit lives in modifier.
    // Survey: portionDescription "1 medium".
    const text = known
      ? `${p.amount ?? 1} ${unitName}`
      : p.portionDescription || `${p.amount ?? 1} ${p.modifier || ''}`;
    portions.push(makePortion(text, p.gramWeight));
  }

  /** @type {Food} */
  const food = {
    id: `usda:${f.fdcId}`,
    source: 'usda',
    name: tidyCase(f.description),
    brand: tidyCase(f.brandName || f.brandOwner || ''),
    per100g,
    portions: dedupePortions(portions),
  };
  if (density) food.density = density;
  return food;
}

/** @param {UsdaSearchJson | null | undefined} json */
function parseUsdaSearch(json) {
  return (json?.foods || []).map(parseUsdaFood).filter((f) => f.per100g.kcal !== null);
}

// ─── Open Food Facts ──────────────────────────────────────────────────────────

/**
 * @param {OffProductJson} p
 * @returns {Food}
 */
function parseOffProduct(p) {
  const n = p.nutriments || {};
  let kcal = num(n['energy-kcal_100g']);
  // Some products only list kJ.
  const kj = num(n.energy_100g);
  if (kcal === null && kj !== null) kcal = kj / 4.184;
  const per100g = {
    kcal,
    protein: num(n.proteins_100g),
    carbs: num(n.carbohydrates_100g),
    fat: num(n.fat_100g),
  };
  /** @type {(Portion | null)[]} */
  const portions = [];
  const servingGrams = num(p.serving_quantity);
  if (servingGrams > 0) {
    portions.push({ unit: 'serving', amount: 1, grams: servingGrams });
    // "1 cup (227 g)" → also offer cups.
    const household = makePortion(String(p.serving_size || '').split('(')[0], servingGrams);
    if (household) portions.push(household);
  }
  return {
    id: `off:${p.code}`,
    source: 'off',
    name: String(p.product_name || '').trim(),
    // A comma-separated string from the product API, a list from Search-a-licious.
    brand: (Array.isArray(p.brands) ? p.brands.join(',') : String(p.brands || ''))
      .split(',')[0]
      .trim(),
    per100g,
    portions: dedupePortions(portions),
  };
}

/** @param {OffSearchJson | null | undefined} json */
function parseOffSearch(json) {
  return (json?.products || [])
    .map(parseOffProduct)
    .filter((f) => f.name && f.per100g.kcal !== null);
}

// ─── Custom foods ─────────────────────────────────────────────────────────────

// A food the user typed in from a label: macros per one serving of
// `servingAmount servingUnit` (e.g. 1 bar, 30 g, 2 tbsp).
// Numbers may be strings, as typed into a form.
/**
 * @param {{ name: string, servingAmount?: NumberLike, servingUnit?: string, servingGrams?: NumberLike, kcal?: NumberLike, protein?: NumberLike, carbs?: NumberLike, fat?: NumberLike }} label
 * @returns {Food}
 */
function makeCustomFood({
  name,
  servingAmount,
  servingUnit,
  servingGrams,
  kcal,
  protein,
  carbs,
  fat,
}) {
  const given = num(servingAmount);
  const amount = given !== null && given > 0 ? given : 1;
  const unit = normalizeUnit(servingUnit) || 'serving';
  let grams = num(servingGrams);
  if (!(grams > 0) && isMassUnit(unit)) grams = amount * MASS_UNITS[unit];
  const noMass = !(grams > 0);
  // Without a weight, pretend a serving weighs 100 g and only offer the
  // serving unit — the per-100 g math then works out to per-serving.
  const basis = noMass || grams === null ? 100 : grams;
  const per100g = noNutrients();
  const vals = { kcal, protein, carbs, fat };
  for (const k of MACROS) {
    const v = num(vals[k]);
    per100g[k] = v === null ? null : (v * 100) / basis;
  }
  /** @type {Portion[]} */
  const portions = [];
  if (!isMassUnit(unit)) portions.push({ unit, amount, grams: basis });
  if (unit !== 'serving') portions.push({ unit: 'serving', amount: 1, grams: basis });
  /** @type {Food} */
  const food = {
    id: `custom:${String(name).trim().toLowerCase()}`,
    source: 'custom',
    name: String(name).trim(),
    brand: '',
    per100g,
    portions,
  };
  // What the label's numbers were for, so the food can be written back out
  // the way it was entered (see foodfile.js).
  food.per = { amount, unit, grams: noMass ? null : grams };
  if (noMass) food.noMass = true;
  else if (isVolumeUnit(unit)) food.density = grams / (amount * VOLUME_UNITS[unit]);
  return food;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** @param {Pick<Food, 'name' | 'brand'>} food */
function displayName(food) {
  return food.brand ? `${food.name} (${food.brand})` : food.name;
}

/**
 * @param {Food} food
 * @param {number | null} grams
 */
function nutrientsFor(food, grams) {
  const out = noNutrients();
  for (const k of MACROS) {
    const v = food.per100g?.[k];
    out[k] = v === null || v === undefined || grams === null ? null : (v * grams) / 100;
  }
  return out;
}

export {
  displayName,
  MACROS,
  makeCustomFood,
  nutrientsFor,
  parseOffProduct,
  parseOffSearch,
  parseUsdaFood,
  parseUsdaSearch,
  portionUnit,
  splitLeadingAmount,
  tidyCase,
};
