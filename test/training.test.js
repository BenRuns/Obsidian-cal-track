import assert from 'node:assert/strict';
import test from 'node:test';
import { asGuidance, goalFor } from '../src/training.js';

const day = (fuel) => ({ date: '2027-03-01', phase: 'Peak', fuel, note: `${fuel} note` });

test('keeps the daily goal in Base weeks', () => {
  assert.deepEqual(goalFor(2200, 2700, day('deficit-ok')), { goal: 2200, maintain: false });
});

test('switches to maintenance on maintain, carb-load and race days', () => {
  for (const fuel of ['maintain', 'carb-load', 'race'])
    assert.deepEqual(goalFor(2200, 2700, day(fuel)), { goal: 2700, maintain: true });
});

test('never lowers the goal below the daily goal', () => {
  assert.equal(goalFor(3000, 2700, day('maintain')).goal, 3000);
});

test('without maintenance calories or a plan, keeps the daily goal', () => {
  assert.deepEqual(goalFor(2200, 0, day('maintain')), { goal: 2200, maintain: false });
  assert.deepEqual(goalFor(2200, 2700, null), { goal: 2200, maintain: false });
});

test('maintenance alone gives a goal on training days', () => {
  assert.equal(goalFor(0, 2700, day('maintain')).goal, 2700);
  assert.equal(goalFor(0, 2700, day('deficit-ok')).goal, 0);
});

test('reads guidance defensively', () => {
  assert.deepEqual(asGuidance(day('carb-load')), day('carb-load'));
  assert.equal(asGuidance(null), null);
  assert.equal(asGuidance('maintain'), null);
  assert.equal(asGuidance({ fuel: 'feast' }), null);
  assert.deepEqual(asGuidance({ fuel: 'race' }), { date: '', phase: '', fuel: 'race', note: '' });
});
