'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toGrams, unitsFor, densityOf, normalizeUnit } = require('../src/units');

const banana = {
  per100g: { kcal: 89 },
  portions: [
    { unit: 'medium', amount: 1, grams: 118 },
    { unit: 'cup', amount: 1, grams: 150 },
  ],
};

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('normalizeUnit handles plurals, abbreviations and case', () => {
  assert.equal(normalizeUnit('Tablespoons'), 'tbsp');
  assert.equal(normalizeUnit('OZ.'), 'oz');
  assert.equal(normalizeUnit('GRM'), 'g');
  assert.equal(normalizeUnit('fluid ounce'), 'fl oz');
  assert.equal(normalizeUnit('cups'), 'cup');
});

test('mass units convert directly', () => {
  near(toGrams(banana, 2, 'oz'), 56.69904625);
  near(toGrams(banana, 1, 'lb'), 453.59237);
  assert.equal(toGrams(banana, 150, 'g'), 150);
});

test('named portions use their gram weight', () => {
  assert.equal(toGrams(banana, 2, 'medium'), 236);
  assert.equal(toGrams(banana, 0.5, 'cup'), 75);
});

test('portions with amount > 1 are scaled per unit', () => {
  const f = { portions: [{ unit: 'tbsp', amount: 2, grams: 32 }] };
  assert.equal(toGrams(f, 1, 'tbsp'), 16);
});

test('volume units derive density from a volume portion', () => {
  // 150 g per cup → tbsp is 1/16 cup
  near(densityOf(banana), 150 / 236.5882365);
  near(toGrams(banana, 1, 'tbsp'), 150 / 16);
});

test('volume units are impossible without a density', () => {
  const f = { portions: [{ unit: 'medium', amount: 1, grams: 50 }] };
  assert.equal(toGrams(f, 1, 'cup'), null);
  assert.ok(!unitsFor(f).includes('cup'));
});

test('unitsFor lists portions, then mass, then volume', () => {
  const units = unitsFor(banana);
  assert.deepEqual(units.slice(0, 3), ['medium', 'cup', 'g']);
  assert.ok(units.includes('oz'));
  assert.ok(units.includes('tbsp'));
  assert.equal(new Set(units).size, units.length);
});

test('noMass foods only offer their portions', () => {
  const f = { noMass: true, portions: [{ unit: 'bar', amount: 1, grams: 100 }] };
  assert.deepEqual(unitsFor(f), ['bar']);
  assert.equal(toGrams(f, 100, 'g'), null);
  assert.equal(toGrams(f, 2, 'bar'), 200);
});

test('invalid quantities give null', () => {
  assert.equal(toGrams(banana, -1, 'g'), null);
  assert.equal(toGrams(banana, 'abc', 'g'), null);
  assert.equal(toGrams(banana, 1, 'parsec'), null);
});
