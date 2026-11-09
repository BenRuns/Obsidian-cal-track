import assert from 'node:assert/strict';
import test from 'node:test';
import { calorieEstimate, exerciseFor } from '../src/exercise.js';

// start_date → its UTC date, standing in for the local date in these tests.
const dayOf = (value) => {
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const run = {
  path: 'Activities/2026-10-23/1 Morning Run.md',
  frontmatter: {
    name: 'Morning Run',
    start_date: '2026-10-23T14:00:00.000Z',
    calories: 700,
    estimated_calories: 612,
    active_calories: 540,
  },
};

test('adds up the day’s activities with estimates', () => {
  const ride = {
    path: 'Activities/2026-10-23/2 Evening Ride.md',
    frontmatter: {
      name: 'Evening Ride',
      start_date: '2026-10-23T23:00:00.000Z',
      estimated_calories: 900,
      active_calories: 800,
    },
  };
  const exercise = exerciseFor([ride, run], '2026-10-23', dayOf);

  assert.equal(exercise.kcal, 1512);
  assert.equal(exercise.active, 1340);
  assert.deepEqual(
    exercise.activities.map((a) => a.name),
    ['Morning Run', 'Evening Ride'],
  );
});

test('only counts activities on that day', () => {
  assert.equal(exerciseFor([run], '2026-10-24', dayOf).activities.length, 0);
});

test('leaves out activities without an estimate', () => {
  const garminOnly = {
    path: 'Activities/3 Walk.md',
    frontmatter: { start_date: '2026-10-23T10:00:00.000Z', calories: 300 },
  };
  const noActive = {
    path: 'Activities/4 Swim.md',
    frontmatter: { start_date: '2026-10-23T10:00:00.000Z', estimated_calories: 400 },
  };
  const exercise = exerciseFor([garminOnly, noActive, { path: 'Note.md' }], '2026-10-23', dayOf);

  assert.deepEqual(exercise, { kcal: 0, active: 0, activities: [] });
});

test('names activities by their file when they have no name', () => {
  const { activities } = exerciseFor(
    [{ path: run.path, frontmatter: { ...run.frontmatter, name: '' } }],
    '2026-10-23',
    dayOf,
  );
  assert.equal(activities[0].name, '1 Morning Run');
});

test('reads numbers written as text, and rejects anything else', () => {
  assert.deepEqual(calorieEstimate({ estimated_calories: '612', active_calories: '540' }), {
    kcal: 612,
    active: 540,
  });
  assert.equal(calorieEstimate({ estimated_calories: 'lots', active_calories: 540 }), null);
  assert.equal(calorieEstimate({ estimated_calories: -5, active_calories: 0 }), null);
  assert.equal(calorieEstimate({ estimated_calories: '', active_calories: 0 }), null);
  assert.equal(calorieEstimate(null), null);
});
