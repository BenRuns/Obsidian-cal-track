// Fixtures follow the documented response shapes of USDA FoodData Central
// (https://fdc.nal.usda.gov/api-guide) and Open Food Facts
// (https://openfoodfacts.github.io/openfoodfacts-server/api/).

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  displayName,
  makeCustomFood,
  nutrientsFor,
  parseOffSearch,
  parseUsdaFood,
  parseUsdaSearch,
  portionUnit,
  splitLeadingAmount,
  tidyCase,
} from '../src/food.js';
import { toGrams } from '../src/units.js';

const usdaSearch = {
  foods: [
    {
      fdcId: 173944,
      description: 'Bananas, raw',
      dataType: 'SR Legacy',
      foodNutrients: [
        { nutrientId: 1003, nutrientNumber: '203', unitName: 'G', value: 1.09 },
        { nutrientId: 1004, nutrientNumber: '204', unitName: 'G', value: 0.33 },
        { nutrientId: 1005, nutrientNumber: '205', unitName: 'G', value: 22.8 },
        { nutrientId: 1062, nutrientNumber: '268', unitName: 'kJ', value: 371 },
        { nutrientId: 1008, nutrientNumber: '208', unitName: 'KCAL', value: 89 },
      ],
      foodMeasures: [
        { disseminationText: '1 cup, mashed', gramWeight: 225 },
        { disseminationText: '1 medium (7" to 7-7/8" long)', gramWeight: 118 },
        { disseminationText: 'Quantity not specified', gramWeight: 118 },
      ],
    },
    {
      fdcId: 2345678,
      description: 'GREEK NONFAT YOGURT',
      dataType: 'Branded',
      brandOwner: 'FAGE USA DAIRY INDUSTRY INC.',
      brandName: 'FAGE',
      servingSize: 170,
      servingSizeUnit: 'GRM',
      householdServingFullText: '3/4 cup',
      foodNutrients: [
        { nutrientId: 1008, unitName: 'KCAL', value: 53 },
        { nutrientId: 1003, unitName: 'G', value: 10.3 },
      ],
    },
    {
      // No calories at all — must be dropped.
      fdcId: 1,
      description: 'Water, mystery',
      foodNutrients: [{ nutrientId: 1003, value: 0 }],
    },
  ],
};

test('splitLeadingAmount parses decimals, fractions and mixed numbers', () => {
  assert.deepEqual(splitLeadingAmount('1 cup'), { amount: 1, rest: 'cup' });
  assert.deepEqual(splitLeadingAmount('3/4 cup'), { amount: 0.75, rest: 'cup' });
  assert.deepEqual(splitLeadingAmount('1 1/2 tbsp'), { amount: 1.5, rest: 'tbsp' });
  assert.deepEqual(splitLeadingAmount('0.5 oz'), { amount: 0.5, rest: 'oz' });
  assert.deepEqual(splitLeadingAmount('medium'), { amount: 1, rest: 'medium' });
});

test('portionUnit shortens descriptions to a unit name', () => {
  assert.equal(portionUnit('cup, mashed'), 'cup');
  assert.equal(portionUnit('medium (7" to 7-7/8" long)'), 'medium');
  assert.equal(portionUnit('Tablespoons'), 'tbsp');
  assert.equal(portionUnit('cup sliced'), 'cup');
  assert.equal(portionUnit('NLEA serving'), 'nlea serving');
});

test('tidyCase only rewrites ALL-CAPS text', () => {
  assert.equal(tidyCase('GREEK NONFAT YOGURT'), 'Greek Nonfat Yogurt');
  assert.equal(tidyCase('Bananas, raw'), 'Bananas, raw');
});

test('USDA search: nutrients, portions and filtering', () => {
  const foods = parseUsdaSearch(usdaSearch);
  assert.equal(foods.length, 2);
  const [banana, yogurt] = foods;

  assert.equal(banana.id, 'usda:173944');
  assert.deepEqual(banana.per100g, { kcal: 89, protein: 1.09, carbs: 22.8, fat: 0.33 });
  assert.deepEqual(banana.portions, [
    { unit: 'cup', amount: 1, grams: 225 },
    { unit: 'medium', amount: 1, grams: 118 },
  ]);

  assert.equal(yogurt.name, 'Greek Nonfat Yogurt');
  assert.equal(yogurt.brand, 'Fage');
  assert.equal(yogurt.per100g.carbs, null);
  assert.deepEqual(yogurt.portions, [
    { unit: 'serving', amount: 1, grams: 170 },
    { unit: 'cup', amount: 0.75, grams: 170 },
  ]);
  // 3/4 cup = 170 g → 1 cup ≈ 226.7 g
  assert.ok(Math.abs(toGrams(yogurt, 1, 'cup') - 226.6667) < 0.001);
});

test('USDA kcal prefers 1008, then Atwater specific, never kJ', () => {
  const atwater = parseUsdaFood({
    fdcId: 2,
    description: 'Foundation food',
    foodNutrients: [
      { nutrientId: 1062, unitName: 'kJ', value: 500 },
      { nutrientId: 2047, unitName: 'KCAL', value: 120 },
      { nutrientId: 2048, unitName: 'KCAL', value: 118 },
    ],
  });
  assert.equal(atwater.per100g.kcal, 118);
});

test('USDA detail record: nested nutrients and foodPortions variants', () => {
  const food = parseUsdaFood({
    fdcId: 3,
    description: 'Apples, raw',
    foodNutrients: [{ nutrient: { id: 1008, number: '208', unitName: 'kcal' }, amount: 52 }],
    foodPortions: [
      // Foundation style
      { amount: 1, gramWeight: 110, modifier: 'sliced', measureUnit: { name: 'cup' } },
      // SR Legacy style
      {
        amount: 1,
        gramWeight: 182,
        modifier: 'medium (3" dia)',
        measureUnit: { name: 'undetermined' },
      },
      // Survey style
      { gramWeight: 25, portionDescription: '1 slice', measureUnit: { name: 'undetermined' } },
    ],
  });
  assert.equal(food.per100g.kcal, 52);
  assert.deepEqual(
    food.portions.map((p) => [p.unit, p.grams]),
    [
      ['cup', 110],
      ['medium', 182],
      ['slice', 25],
    ],
  );
});

test('USDA ml-labelled branded foods assume 1 g/ml', () => {
  const [milk] = parseUsdaSearch({
    foods: [
      {
        fdcId: 4,
        description: 'OAT MILK',
        servingSize: 240,
        servingSizeUnit: 'MLT',
        householdServingFullText: '1 cup',
        foodNutrients: [{ nutrientId: 1008, unitName: 'KCAL', value: 50 }],
      },
    ],
  });
  assert.equal(milk.density, 1);
  assert.equal(toGrams(milk, 100, 'ml'), 100);
});

test('Open Food Facts search', () => {
  const foods = parseOffSearch({
    products: [
      {
        code: '5201054017505',
        product_name: 'Total 0% Greek Yoghurt',
        brands: 'Fage, Total',
        serving_size: '1 cup (227 g)',
        serving_quantity: '227',
        nutriments: {
          'energy-kcal_100g': 54,
          proteins_100g: 10.3,
          carbohydrates_100g: 3,
          fat_100g: 0,
        },
      },
      {
        code: '1',
        product_name: 'kJ only',
        nutriments: { energy_100g: 418.4 },
      },
      { code: '2', product_name: 'No energy', nutriments: {} },
      { code: '3', product_name: '', nutriments: { 'energy-kcal_100g': 5 } },
    ],
  });
  assert.equal(foods.length, 2);
  const [yog, kj] = foods;
  assert.equal(yog.id, 'off:5201054017505');
  assert.equal(yog.brand, 'Fage');
  assert.deepEqual(yog.per100g, { kcal: 54, protein: 10.3, carbs: 3, fat: 0 });
  assert.deepEqual(yog.portions, [
    { unit: 'serving', amount: 1, grams: 227 },
    { unit: 'cup', amount: 1, grams: 227 },
  ]);
  assert.ok(Math.abs(kj.per100g.kcal - 100) < 1e-9);
});

test('custom food with a weight converts to per 100 g', () => {
  const bar = makeCustomFood({
    name: 'Protein bar',
    servingAmount: '1',
    servingUnit: 'bar',
    servingGrams: '60',
    kcal: '240',
    protein: '20',
  });
  assert.equal(bar.per100g.kcal, 400);
  assert.equal(bar.per100g.carbs, null);
  assert.ok(!bar.noMass);
  assert.equal(toGrams(bar, 1, 'bar'), 60);
  assert.equal(nutrientsFor(bar, toGrams(bar, 1, 'bar')).kcal, 240);
});

test('custom food without a weight works per serving only', () => {
  const f = makeCustomFood({ name: 'Mom’s lasagna', servingUnit: 'slice', kcal: 450 });
  assert.equal(f.noMass, true);
  assert.equal(nutrientsFor(f, toGrams(f, 2, 'slice')).kcal, 900);
  assert.equal(toGrams(f, 100, 'g'), null);
});

test('custom food given in grams needs no separate weight', () => {
  const f = makeCustomFood({ name: 'Oats', servingAmount: 40, servingUnit: 'g', kcal: 150 });
  assert.equal(f.per100g.kcal, 375);
  assert.ok(!f.noMass);
});

test('displayName and nutrientsFor', () => {
  const f = {
    name: 'Yogurt',
    brand: 'Fage',
    per100g: { kcal: 50, protein: 10, carbs: null, fat: 0 },
  };
  assert.equal(displayName(f), 'Yogurt (Fage)');
  assert.deepEqual(nutrientsFor(f, 200), { kcal: 100, protein: 20, carbs: null, fat: 0 });
  assert.deepEqual(nutrientsFor(f, null), { kcal: null, protein: null, carbs: null, fat: null });
});
