'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCombo, ingredientsText, parseIngredients } = require('../src/combo');
const { parseFoodFile, upsertFood, removeFood } = require('../src/foodfile');
const { toGrams } = require('../src/units');
const { nutrientsFor } = require('../src/food');

const oats = {
  name: 'Oats',
  qty: 40,
  unit: 'g',
  grams: 40,
  nutrients: { kcal: 150, protein: 5, carbs: 27, fat: 2.5 },
};
const banana = {
  name: 'Bananas, raw',
  qty: 1,
  unit: 'medium',
  grams: 118,
  nutrients: { kcal: 105, protein: 1.3, carbs: 27, fat: 0.4 },
};
const milk = {
  name: 'Milk (Fage)',
  qty: 1,
  unit: 'cup',
  grams: 244,
  nutrients: { kcal: 122, protein: 8, carbs: 12, fat: null },
};

test('makeCombo sums the ingredients into one serving', () => {
  const food = makeCombo({ name: 'Breakfast bowl', items: [oats, banana, milk] });
  assert.equal(food.name, 'Breakfast bowl');
  assert.deepEqual(food.per, { amount: 1, unit: 'serving', grams: 402 });
  const one = nutrientsFor(food, toGrams(food, 1, 'serving'));
  assert.equal(Math.round(one.kcal), 377);
  assert.equal(Math.round(one.protein * 10) / 10, 14.3);
  // A missing value counts as 0 rather than blanking the whole total.
  assert.equal(Math.round(one.fat * 10) / 10, 2.9);
  assert.deepEqual(food.ingredients, [
    { name: 'Oats', qty: 40, unit: 'g' },
    { name: 'Bananas, raw', qty: 1, unit: 'medium' },
    { name: 'Milk (Fage)', qty: 1, unit: 'cup' },
  ]);
  // Weighed, so grams work too.
  assert.ok(food.portions.length >= 1 && !food.noMass);
  assert.equal(toGrams(food, 100, 'g'), 100);
});

test('makeCombo divides by servings and adds a batch unit', () => {
  const food = makeCombo({ name: 'Chili', items: [oats, banana], servings: 4 });
  const serving = nutrientsFor(food, toGrams(food, 1, 'serving'));
  const batch = nutrientsFor(food, toGrams(food, 1, 'batch'));
  assert.equal(Math.round(serving.kcal), 64);
  assert.equal(Math.round(batch.kcal), 255);
  assert.equal(food.servings, 4);
});

test('makeCombo without weights is logged by the serving only', () => {
  const lasagna = {
    name: 'Lasagna',
    qty: 1,
    unit: 'slice',
    grams: null,
    nutrients: { kcal: 450, protein: null, carbs: null, fat: null },
  };
  const food = makeCombo({ name: 'Dinner', items: [lasagna, banana] });
  assert.equal(food.noMass, true);
  assert.equal(Math.round(nutrientsFor(food, toGrams(food, 1, 'serving')).kcal), 555);
  assert.equal(makeCombo({ name: 'x', items: [] }), null);
  assert.equal(makeCombo({ name: 'x', items: [{ ...lasagna, nutrients: { kcal: null } }] }), null);
});

test('ingredients round-trip through text, names with parentheses and commas included', () => {
  const list = [
    { name: 'Total 0% Greek Yoghurt (Fage)', qty: 1.5, unit: 'cup' },
    { name: 'Bananas, raw', qty: 1, unit: 'medium' },
  ];
  const text = ingredientsText(list);
  assert.equal(text, 'Total 0% Greek Yoghurt (Fage) (1.5 cup); Bananas, raw (1 medium)');
  assert.deepEqual(parseIngredients(text), list);
  assert.deepEqual(parseIngredients(''), []);
});

test('a combo saves to My foods and reads back with its ingredients and servings', () => {
  const old =
    '| Food | Per | kcal | Protein | Carbs | Fat | Portions |\n| --- | --- | ---: | ---: | ---: | ---: | --- |\n| Protein bar | 1 bar = 60 g | 240 | 20 | 25 | 8 | |\n';
  const combo = makeCombo({ name: 'Chili', items: [oats, banana], servings: 4 });
  const text = upsertFood(old, combo);
  // The older table gains an Ingredients column; the existing row keeps its cells.
  assert.match(text, /\| Portions \| Ingredients \|/);
  const foods = parseFoodFile(text);
  assert.equal(foods.length, 2);
  assert.equal(foods[0].name, 'Protein bar');
  assert.equal(foods[0].ingredients, undefined);
  const chili = foods[1];
  assert.deepEqual(chili.ingredients, combo.ingredients);
  assert.equal(chili.servings, 4);
  assert.equal(Math.round(nutrientsFor(chili, toGrams(chili, 1, 'batch')).kcal), 255);
});

test('removeFood drops the named row only', () => {
  const text = upsertFood(
    upsertFood('', makeCombo({ name: 'A', items: [oats] })),
    makeCombo({ name: 'B', items: [banana] }),
  );
  const left = parseFoodFile(removeFood(text, 'a'));
  assert.deepEqual(
    left.map((f) => f.name),
    ['B'],
  );
});
