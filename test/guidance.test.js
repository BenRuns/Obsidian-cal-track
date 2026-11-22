import assert from 'node:assert/strict';
import test from 'node:test';
import { asGuidance, goalFor, guidanceFor } from '../src/guidance.js';

// guidance.js uses window timers, as Obsidian's popout windows need.
globalThis.window ??= globalThis;

const noDeficit = { noDeficit: true, notes: ['Eat to maintain'] };
const deficitOk = { noDeficit: false, notes: ['A mild deficit is OK'] };

test('keeps the daily goal when no provider asks for no deficit', () => {
  assert.deepEqual(goalFor(2200, 2700, deficitOk), { goal: 2200, maintain: false });
});

test('switches to maintenance on a no-deficit day', () => {
  assert.deepEqual(goalFor(2200, 2700, noDeficit), { goal: 2700, maintain: true });
});

test('never lowers the goal below the daily goal', () => {
  assert.equal(goalFor(3000, 2700, noDeficit).goal, 3000);
});

test('without maintenance calories or guidance, keeps the daily goal', () => {
  assert.deepEqual(goalFor(2200, 0, noDeficit), { goal: 2200, maintain: false });
  assert.deepEqual(goalFor(2200, 2700, null), { goal: 2200, maintain: false });
});

test('maintenance alone gives a goal on no-deficit days', () => {
  assert.equal(goalFor(0, 2700, noDeficit).goal, 2700);
  assert.equal(goalFor(0, 2700, deficitOk).goal, 0);
});

test('reads guidance defensively', () => {
  assert.deepEqual(asGuidance({ noDeficit: true, note: ' Peak week ' }), {
    noDeficit: true,
    note: 'Peak week',
  });
  assert.deepEqual(asGuidance({ note: 'Base week' }), { noDeficit: false, note: 'Base week' });
  assert.equal(asGuidance({ noDeficit: 'yes' }), null);
  assert.equal(asGuidance({}), null);
  assert.equal(asGuidance(null), null);
  assert.equal(asGuidance('maintain'), null);
});

test('combines providers, skipping ones that fail', async () => {
  const g = await guidanceFor(
    [
      () => ({ note: 'Base week' }),
      async () => ({ noDeficit: true, note: 'Rest day' }),
      () => {
        throw new Error('boom');
      },
      async () => 42,
      () => null,
    ],
    '2027-03-01',
  );
  assert.deepEqual(g, { noDeficit: true, notes: ['Base week', 'Rest day'] });
});

test('passes the date and skips a provider that never answers', async () => {
  const seen = [];
  const g = await guidanceFor(
    [
      (date) => {
        seen.push(date);
        return { note: date };
      },
      () => new Promise(() => {}),
    ],
    '2027-03-01',
    20,
  );
  assert.deepEqual(seen, ['2027-03-01']);
  assert.deepEqual(g, { noDeficit: false, notes: ['2027-03-01'] });
});

test('no providers means no guidance', async () => {
  assert.deepEqual(await guidanceFor([], '2027-03-01'), { noDeficit: false, notes: [] });
});
