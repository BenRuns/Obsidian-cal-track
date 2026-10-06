'use strict';

const { makeCustomFood, splitLeadingAmount } = require('./food');
const { normalizeUnit, isMassUnit, isVolumeUnit, MASS_UNITS, toGrams } = require('./units');
const {
  findTables,
  splitRow,
  joinRow,
  escapeCell,
  unescapeCell,
  formatNumber,
} = require('./table');

// ─── My foods file ────────────────────────────────────────────────────────────
//
// The local food database is an ordinary note in the vault, so it's visible,
// hand-editable and syncs with everything else:
//
//   | Food        | Per            | kcal | Protein | Carbs | Fat | Portions                  |
//   | Protein bar | 1 bar = 60 g   | 240  | 20      | 25    | 8   |                           |
//   | Bananas, raw| 100 g          | 89   | 1.09    | 22.8  | 0.33| medium = 118 g; cup = 150 g |
//   | Lasagna     | 1 slice        | 450  |         |       |     | big slice = 1.5 slice     |
//
// Per:      what the numbers are for. "100 g", "40 g", "1 bar = 60 g", or
//           "1 slice" (no weight: only slices, and portions defined in
//           slices, can be logged).
// Portions: extra units, ";"-separated, each "name = quantity unit". The
//           quantity can use any unit the food already understands.

const FILE_INTRO = [
  'Your foods for Cal Track. Edit freely — one row per food.',
  '',
  '- **Per**: what the numbers are for: `100 g`, `1 bar = 60 g`, or `1 slice` (no weight).',
  '- **Portions**: extra units, separated by `;` — e.g. `bowl = 300 g; scoop = 1.5 tbsp`.',
];
const COLUMNS = ['Food', 'Per', 'kcal', 'Protein', 'Carbs', 'Fat', 'Portions'];

function num(s) {
  const n = parseFloat(String(s ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// "60 g" / "2 oz" → grams, else null.
function parseMass(text) {
  const { amount, rest } = splitLeadingAmount(text);
  const unit = normalizeUnit(rest);
  return isMassUnit(unit) ? amount * MASS_UNITS[unit] : null;
}

// "1 bar = 60 g" → { amount: 1, unit: 'bar', grams: 60 }
function parsePer(text) {
  const [left, right] = String(text || '').split('=');
  if (!left.trim()) return { amount: 100, unit: 'g', grams: 100 };
  const { amount, rest } = splitLeadingAmount(left);
  const unit = normalizeUnit(rest) || 'serving';
  return { amount, unit, grams: right ? parseMass(right) : null };
}

function isPer100g(per) {
  return per.unit === 'g' && per.amount === 100;
}

function foodFromCells(get) {
  const name = unescapeCell(get('food')).trim();
  const kcal = num(get('kcal'));
  if (!name || kcal === null) return null;
  const per = parsePer(get('per'));
  const food = makeCustomFood({
    name,
    servingAmount: per.amount,
    servingUnit: per.unit,
    servingGrams: per.grams,
    kcal,
    protein: num(get('protein')),
    carbs: num(get('carbs')),
    fat: num(get('fat')),
  });
  food.id = `local:${name.toLowerCase()}`;
  food.source = 'local';
  // A per-100 g row is reference data, not a label serving.
  if (isPer100g(per)) food.portions = food.portions.filter((p) => p.unit !== 'serving');

  for (const spec of unescapeCell(get('portions')).split(';')) {
    const [label, def] = spec.split('=');
    if (!def) continue;
    const unit = normalizeUnit(label);
    const { amount, rest } = splitLeadingAmount(def);
    const defUnit = normalizeUnit(rest);
    const grams = toGrams(food, amount, defUnit);
    if (!unit || !(grams > 0)) continue;
    food.portions = food.portions.filter((p) => p.unit !== unit);
    food.portions.push({ unit, amount: 1, grams, def: `${formatNumber(amount, 3)} ${defUnit}` });
  }
  return food;
}

function parseFoodFile(text) {
  const lines = String(text || '').split('\n');
  const foods = [];
  for (const t of findTables(lines)) {
    for (let i = t.start + 2; i <= t.end; i++) {
      const cells = splitRow(lines[i]);
      const get = (k) => (t.cols[k] === undefined ? '' : (cells[t.cols[k]] ?? ''));
      const food = foodFromCells(get);
      if (food) foods.push(food);
    }
  }
  return foods;
}

// ─── Writing ──────────────────────────────────────────────────────────────────

function perOf(food) {
  if (food.per) return food.per;
  return { amount: 100, unit: 'g', grams: 100 };
}

function perText(per) {
  const amt = formatNumber(per.amount, 3);
  if (isMassUnit(per.unit)) return `${amt} ${per.unit}`;
  return per.grams > 0
    ? `${amt} ${per.unit} = ${formatNumber(per.grams, 1)} g`
    : `${amt} ${per.unit}`;
}

// Cell text for each column key.
function foodCells(food) {
  const per = perOf(food);
  // Grams the row's numbers are for. Weightless foods use the 100 g stand-in
  // makeCustomFood gave them, so per100g already holds per-serving values.
  const basis = food.noMass
    ? 100
    : per.grams > 0
      ? per.grams
      : toGrams(food, per.amount, per.unit) || 100;
  const scaled = (k, d) => {
    const v = food.per100g?.[k];
    return v === null || v === undefined ? '' : formatNumber((v * basis) / 100, d);
  };

  const portions = [];
  for (const p of food.portions || []) {
    const perUnit = p.grams / (p.amount || 1);
    // makeCustomFood re-creates these two from Per on the way back in.
    if (p.unit === per.unit) continue;
    if (p.unit === 'serving' && Math.abs(perUnit - basis) < 1e-9 && food.per) continue;
    let def = p.def;
    if (!def) {
      def = food.noMass
        ? `${formatNumber((perUnit / basis) * per.amount, 3)} ${per.unit}`
        : `${formatNumber(perUnit, 1)} g`;
    }
    portions.push(`${p.unit} = ${def}`);
  }
  // Branded liquids: keep "per 100 ml" usable when no volume portion says it.
  if (food.density && !(food.portions || []).some((p) => isVolumeUnit(p.unit))) {
    portions.push(`ml = ${formatNumber(food.density, 3)} g`);
  }

  const name = food.brand ? `${food.name} (${food.brand})` : food.name;
  return {
    food: escapeCell(name),
    per: perText(per),
    kcal: scaled('kcal', 1),
    protein: scaled('protein', 2),
    carbs: scaled('carbs', 2),
    fat: scaled('fat', 2),
    portions: escapeCell(portions.join('; ')),
  };
}

function newFileLines() {
  return [
    ...FILE_INTRO,
    '',
    joinRow(COLUMNS),
    joinRow(COLUMNS.map((c) => (['kcal', 'Protein', 'Carbs', 'Fat'].includes(c) ? '---:' : '---'))),
  ];
}

// Adds the food to the file, or replaces the row with the same name.
// Returns the new file text.
function upsertFood(text, food) {
  let lines = text?.trim() ? text.replace(/\n+$/, '').split('\n') : [];
  let table = findTables(lines)[0];
  if (!table) {
    lines = lines.length
      ? [...lines, '', ...newFileLines().slice(FILE_INTRO.length + 1)]
      : newFileLines();
    table = findTables(lines)[0];
  }
  const values = foodCells(food);
  const key = unescapeCell(values.food).toLowerCase();

  let at = -1;
  for (let i = table.start + 2; i <= table.end; i++) {
    const name = unescapeCell(splitRow(lines[i])[table.cols.food] ?? '')
      .trim()
      .toLowerCase();
    if (name === key) at = i;
  }
  const cells = at >= 0 ? splitRow(lines[at]) : [];
  while (cells.length < table.width) cells.push('');
  for (const [k, v] of Object.entries(values)) {
    if (table.cols[k] !== undefined) cells[table.cols[k]] = v;
  }
  const row = joinRow(cells);
  if (at >= 0) lines[at] = row;
  else lines.splice(table.end + 1, 0, row);
  return `${lines.join('\n')}\n`;
}

// Returns a copy of the food with a named portion added or replaced.
// qty/unit must be something toGrams understands for this food.
function withPortion(food, name, qty, unit) {
  const label = normalizeUnit(name);
  const grams = toGrams(food, qty, unit);
  if (!label || !(grams > 0)) return null;
  const portion = {
    unit: label,
    amount: 1,
    grams,
    def: `${formatNumber(Number(qty), 3)} ${normalizeUnit(unit)}`,
  };
  return { ...food, portions: [...food.portions.filter((p) => p.unit !== label), portion] };
}

module.exports = { parsePer, parseFoodFile, foodCells, upsertFood, withPortion, newFileLines };
