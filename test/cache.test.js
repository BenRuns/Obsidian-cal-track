'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TTLCache } = require('../src/cache');

test('get/set round-trip', () => {
  const c = new TTLCache({ ttlMs: 1000, maxEntries: 10 });
  c.set('a', 1, 0);
  assert.equal(c.get('a', 500), 1);
});

test('entries expire after ttlMs', () => {
  const c = new TTLCache({ ttlMs: 1000, maxEntries: 10 });
  c.set('a', 1, 0);
  assert.equal(c.get('a', 1000), 1); // exactly at the edge still counts
  assert.equal(c.get('a', 1001), undefined); // and it's gone, not just stale
});

test('a miss returns undefined, not null or throwing', () => {
  const c = new TTLCache({ ttlMs: 1000, maxEntries: 10 });
  assert.equal(c.get('nope', 0), undefined);
});

test('setting the same key again refreshes its age', () => {
  const c = new TTLCache({ ttlMs: 1000, maxEntries: 10 });
  c.set('a', 1, 0);
  c.set('a', 2, 900);
  assert.equal(c.get('a', 1800), 2); // still alive at 1800 because it was reset at 900
});

test('evicts the least-recently-used entry once over maxEntries', () => {
  const c = new TTLCache({ ttlMs: 100000, maxEntries: 2 });
  c.set('a', 1, 0);
  c.set('b', 2, 1);
  c.set('c', 3, 2); // evicts 'a'
  assert.equal(c.get('a', 3), undefined);
  assert.equal(c.get('b', 3), 2);
  assert.equal(c.get('c', 3), 3);
});

test('a get touches the entry, protecting it from eviction', () => {
  const c = new TTLCache({ ttlMs: 100000, maxEntries: 2 });
  c.set('a', 1, 0);
  c.set('b', 2, 1);
  c.get('a', 2); // 'a' is now more recently used than 'b'
  c.set('c', 3, 3); // evicts 'b', not 'a'
  assert.equal(c.get('a', 4), 1);
  assert.equal(c.get('b', 4), undefined);
});

test('clear empties the cache', () => {
  const c = new TTLCache({ ttlMs: 1000, maxEntries: 10 });
  c.set('a', 1, 0);
  c.clear();
  assert.equal(c.get('a', 0), undefined);
});
