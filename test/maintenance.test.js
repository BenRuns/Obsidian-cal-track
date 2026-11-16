import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateMaintenance, MIN_DAYS } from '../src/maintenance.js';

const days = (n, kcal, active) => Array.from({ length: n }, () => ({ kcal, active }));

test('is average intake less average active calories', () => {
  assert.deepEqual(estimateMaintenance(days(20, 2600, 500)), {
    maintenance: 2100,
    days: 20,
    intake: 2600,
    active: 500,
    adjust: 0,
  });
});

test('needs enough logged days', () => {
  assert.equal(estimateMaintenance(days(MIN_DAYS - 1, 2600, 500)), null);
  assert.notEqual(estimateMaintenance(days(MIN_DAYS, 2600, 500)), null);
});

test('weight lost raises the estimate, weight gained lowers it', () => {
  // 1 kg over 28 days ≈ 7700 / 28 = 275 kcal a day.
  assert.equal(estimateMaintenance(days(20, 2600, 500), { weightChange: -1 }).maintenance, 2380);
  assert.equal(estimateMaintenance(days(20, 2600, 500), { weightChange: 1 }).maintenance, 1830);
  // 2 lb over 28 days = 7000 / 28 = 250 kcal a day.
  assert.equal(
    estimateMaintenance(days(20, 2600, 500), { weightChange: -2, unit: 'lb' }).adjust,
    250,
  );
});

test('averages uneven days and rounds to 10 kcal', () => {
  const mixed = [...days(10, 2400, 0), ...days(10, 2800, 700)];
  const e = estimateMaintenance(mixed);
  assert.equal(e.intake, 2600);
  assert.equal(e.active, 350);
  assert.equal(e.maintenance, 2250);
});

test('ignores a weight change that is not a number', () => {
  assert.equal(estimateMaintenance(days(20, 2600, 500), { weightChange: Number.NaN }).adjust, 0);
});
