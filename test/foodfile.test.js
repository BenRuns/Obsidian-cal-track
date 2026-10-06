'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePer,
  parseFoodFile,
  upsertFood,
  withPortion,
  newFileLines,
} = require('../src/foodfile');
const { makeCustomFood, nutrientsFor, displayName } = require('../src/food');
const { toGrams, unitsFor } = require('../src/units');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const kcalOf = (food, qty, unit) => nutrientsFor(food, toGrams(food, qty, unit)).kcal;

const FILE = `Some intro text.

| Food | Per | kcal | Protein | Carbs | Fat | Portions |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Protein bar | 1 bar = 60 g | 240 | 20 | 25 | 8 | |
| Bananas, raw | 100 g | 89 | 1.09 | 22.8 | 0.33 | medium = 118 g; cup = 150 g |
| Lasagna | 1 slice | 450 | | | | big slice = 1.5 slice |
| Oats | 40 g | 150 | 5 | 27 | 2.5 | bowl = 1.5 serving; scoop = 0.5 cup |
| Broken row | 1 cup | | | | | |
`;

test('parsePer', () => {
  assert.deepEqual(parsePer('1 bar = 60 g'), { amount: 1, unit: 'bar', grams: 60 });
  assert.deepEqual(parsePer('100 g'), { amount: 100, unit: 'g', grams: null });
  assert.deepEqual(parsePer('2 tbsp = 1 oz'), { amount: 2, unit: 'tbsp', grams: 28.349523125 });
  assert.deepEqual(parsePer(''), { amount: 100, unit: 'g', grams: 100 });
  assert.deepEqual(parsePer('1 slice'), { amount: 1, unit: 'slice', grams: null });
});

test('parseFoodFile reads every kind of row and skips rows without kcal', () => {
  const foods = parseFoodFile(FILE);
  assert.deepEqual(
    foods.map((f) => f.name),
    ['Protein bar', 'Bananas, raw', 'Lasagna', 'Oats'],
  );
  const [bar, banana, lasagna, oats] = foods;
  assert.equal(bar.id, 'local:protein bar');
  assert.equal(bar.source, 'local');

  // Label serving with a weight: bar, serving and grams all work.
  assert.equal(kcalOf(bar, 1, 'bar'), 240);
  assert.equal(kcalOf(bar, 30, 'g'), 120);

  // Per 100 g reference row with database portions — no bogus "serving".
  assert.deepEqual(unitsFor(banana).slice(0, 3), ['medium', 'cup', 'g']);
  near(kcalOf(banana, 1, 'medium'), 105.02);

  // Weightless: only slices and portions defined in slices.
  assert.deepEqual(unitsFor(lasagna), ['slice', 'serving', 'big slice']);
  assert.equal(kcalOf(lasagna, 1, 'big slice'), 675);
  assert.equal(toGrams(lasagna, 100, 'g'), null);

  // Portions can build on Per and on each other.
  assert.equal(kcalOf(oats, 1, 'bowl'), 225);
  assert.equal(toGrams(oats, 1, 'scoop'), null); // no density → cup unknown → skipped
  assert.ok(!unitsFor(oats).includes('scoop'));
});

test('upsertFood creates a file with intro and table', () => {
  const bar = makeCustomFood({
    name: 'Protein bar',
    servingUnit: 'bar',
    servingGrams: 60,
    kcal: 240,
    protein: 20,
  });
  const text = upsertFood('', bar);
  const lines = text.trimEnd().split('\n');
  assert.deepEqual(lines.slice(0, -1), newFileLines());
  assert.equal(lines.at(-1), '| Protein bar | 1 bar = 60 g | 240 | 20 |  |  |  |');
});

test('upsertFood appends to an existing file and replaces by name', () => {
  const salmon = {
    id: 'usda:1',
    source: 'usda',
    name: 'Salmon, cooked',
    brand: '',
    per100g: { kcal: 206, protein: 22.1, carbs: 0, fat: 12.4 },
    portions: [{ unit: 'fillet', amount: 1, grams: 154 }],
  };
  let text = upsertFood(FILE, salmon);
  assert.match(
    text,
    /\| Broken row [^\n]*\n\| Salmon, cooked \| 100 g \| 206 \| 22\.1 \| 0 \| 12\.4 \| fillet = 154 g \|\n$/,
  );
  assert.ok(text.startsWith('Some intro text.'));

  // Save a custom portion → same row, updated.
  const local = parseFoodFile(text).find((f) => f.name === 'Salmon, cooked');
  const withBowl = withPortion(local, 'my plate', 6, 'oz');
  text = upsertFood(text, withBowl);
  const rows = text.split('\n').filter((l) => l.startsWith('| Salmon'));
  assert.equal(rows.length, 1);
  assert.equal(
    rows[0],
    '| Salmon, cooked | 100 g | 206 | 22.1 | 0 | 12.4 | fillet = 154 g; my plate = 6 oz |',
  );
  const reread = parseFoodFile(text).find((f) => f.name === 'Salmon, cooked');
  near(kcalOf(reread, 1, 'my plate'), (206 * 6 * 28.349523125) / 100);
});

test('round trip keeps custom foods identical in use', () => {
  const foods = [
    makeCustomFood({
      name: 'Bar',
      servingUnit: 'bar',
      servingGrams: 60,
      kcal: 240,
      protein: 20,
      carbs: 25,
      fat: 8,
    }),
    makeCustomFood({ name: 'Pie', servingUnit: 'slice', kcal: 410 }),
    makeCustomFood({
      name: 'Granola',
      servingAmount: 0.5,
      servingUnit: 'cup',
      servingGrams: 55,
      kcal: 250,
    }),
    makeCustomFood({ name: 'Rice', servingAmount: 45, servingUnit: 'g', kcal: 160 }),
  ];
  let text = '';
  for (const f of foods) text = upsertFood(text, f);
  const back = parseFoodFile(text);
  assert.equal(back.length, foods.length);
  for (const [i, f] of foods.entries()) {
    const b = back[i];
    assert.equal(displayName(b), displayName(f));
    assert.deepEqual(unitsFor(b), unitsFor(f), f.name);
    for (const u of unitsFor(f)) near(kcalOf(b, 2, u), kcalOf(f, 2, u));
  }
});

test('branded liquids keep their per-ml density', () => {
  const milk = {
    id: 'usda:4',
    source: 'usda',
    name: 'Oat Milk',
    brand: 'Oatly',
    per100g: { kcal: 50, protein: 1, carbs: 7, fat: 2 },
    portions: [{ unit: 'serving', amount: 1, grams: 240 }],
    density: 1,
  };
  const [back] = parseFoodFile(upsertFood('', milk));
  assert.equal(back.name, 'Oat Milk (Oatly)');
  assert.equal(kcalOf(back, 250, 'ml'), 125);
  assert.equal(kcalOf(back, 1, 'serving'), 120);
});

test('withPortion rejects units the food cannot convert', () => {
  const pie = makeCustomFood({ name: 'Pie', servingUnit: 'slice', kcal: 410 });
  assert.equal(withPortion(pie, 'big', 100, 'g'), null);
  assert.equal(withPortion(pie, '', 1, 'slice'), null);
  assert.equal(kcalOf(withPortion(pie, 'half', 0.5, 'slice'), 1, 'half'), 205);
});

test('food names with pipes survive the file', () => {
  const f = makeCustomFood({ name: 'Mac | cheese', kcal: 300 });
  const [back] = parseFoodFile(upsertFood('', f));
  assert.equal(back.name, 'Mac | cheese');
});
