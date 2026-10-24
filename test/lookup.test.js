import assert from 'node:assert/strict';
import test from 'node:test';
import { TTLCache } from '../src/cache.js';
import { cachedSearch, RATE_LIMIT_COOLDOWN_MS } from '../src/lookup.js';

const usdaOk = {
  status: 200,
  json: {
    foods: [{ fdcId: 1, description: 'Egg', foodNutrients: [{ nutrientId: 1008, value: 143 }] }],
  },
};
const offOk = {
  status: 200,
  json: {
    products: [
      {
        code: '2',
        product_name: 'Egg carton',
        nutriments: { 'energy-kcal_100g': 150 },
      },
    ],
  },
};

function stub(routes) {
  const calls = [];
  const request = async ({ url }) => {
    calls.push(url);
    for (const [prefix, res] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return typeof res === 'function' ? res(url) : res;
    }
    return { status: 404, json: null };
  };
  return { request, calls };
}

function setup(routes) {
  const { request, calls } = stub(routes);
  const cache = new TTLCache({ ttlMs: 10 * 60 * 1000, maxEntries: 50 });
  const cooldowns = {};
  const settings = { useUsda: true, useOff: true, usdaApiKey: '' };
  return { request, calls, cache, cooldowns, settings };
}

test('a second identical search is served from cache, with no new network call', async () => {
  const { request, calls, cache, cooldowns, settings } = setup({
    'https://api.nal.usda.gov': usdaOk,
    'https://world.openfoodfacts.org': offOk,
  });
  const a = await cachedSearch({ request, cache, cooldowns, settings, query: 'egg', now: 0 });
  assert.equal(a.foods.length, 2);
  const callsAfterFirst = calls.length;
  const b = await cachedSearch({
    request,
    cache,
    cooldowns,
    settings,
    query: '  Egg  ',
    now: 1000,
  });
  assert.equal(calls.length, callsAfterFirst); // no new calls — trimmed/cased the same
  assert.deepEqual(b, a);
});

test('a different query, or different settings, is not a cache hit', async () => {
  const { request, calls, cache, cooldowns, settings } = setup({
    'https://api.nal.usda.gov': usdaOk,
    'https://world.openfoodfacts.org': offOk,
  });
  await cachedSearch({ request, cache, cooldowns, settings, query: 'egg', now: 0 });
  const afterFirst = calls.length;
  await cachedSearch({ request, cache, cooldowns, settings, query: 'eggs', now: 1 });
  assert.ok(calls.length > afterFirst, 'different query should re-fetch');
  const afterSecond = calls.length;
  await cachedSearch({
    request,
    cache,
    cooldowns,
    settings: { ...settings, usdaApiKey: 'mykey' },
    query: 'egg',
    now: 2,
  });
  assert.ok(
    calls.length > afterSecond,
    'different API key should re-fetch, not reuse a DEMO_KEY result',
  );
});

test('a 429 from one source starts a cooldown that skips it on the next query', async () => {
  const { request, calls, cache, cooldowns, settings } = setup({
    'https://api.nal.usda.gov': usdaOk,
    'https://world.openfoodfacts.org': { status: 429, json: null },
  });
  const a = await cachedSearch({ request, cache, cooldowns, settings, query: 'egg', now: 0 });
  assert.equal(a.foods.length, 1); // USDA still came through
  assert.match(a.errors[0], /^Open Food Facts: Rate limited/); // the real getJson() message
  assert.equal(cooldowns['Open Food Facts'], RATE_LIMIT_COOLDOWN_MS);

  const before = calls.length;
  const b = await cachedSearch({ request, cache, cooldowns, settings, query: 'oats', now: 1000 });
  assert.ok(
    !calls.slice(before).some((u) => u.includes('openfoodfacts')),
    'OFF should be skipped while cooling down',
  );
  assert.ok(
    calls.slice(before).some((u) => u.includes('nal.usda.gov')),
    'USDA should still be queried',
  );
  assert.match(b.errors[0], /^Open Food Facts: rate limited, retrying in \d+ min\./);
});

test('the cooldown message for USDA mentions getting a personal key', async () => {
  const { request, cache, cooldowns, settings } = setup({
    'https://api.nal.usda.gov': { status: 429, json: null },
    'https://world.openfoodfacts.org': offOk,
  });
  const a = await cachedSearch({ request, cache, cooldowns, settings, query: 'egg', now: 0 });
  assert.match(a.errors[0], /^USDA: Rate limited/); // the real getJson() message
  const b = await cachedSearch({ request, cache, cooldowns, settings, query: 'oats', now: 1 });
  assert.match(b.errors[0], /own free API key/);
});

test('cooldown expires and the source is tried again', async () => {
  const { request, calls, cache, cooldowns, settings } = setup({
    'https://api.nal.usda.gov': usdaOk,
    'https://world.openfoodfacts.org': { status: 429, json: null },
  });
  await cachedSearch({ request, cache, cooldowns, settings, query: 'egg', now: 0 });
  const before = calls.length;
  await cachedSearch({
    request,
    cache,
    cooldowns,
    settings,
    query: 'oats',
    now: RATE_LIMIT_COOLDOWN_MS + 1,
  });
  assert.ok(
    calls.slice(before).some((u) => u.includes('openfoodfacts')),
    'should retry OFF once cooldown passes',
  );
});

test('both sources cooled down skips the network entirely', async () => {
  const { request, calls, cache, cooldowns, settings } = setup({
    'https://api.nal.usda.gov': { status: 429, json: null },
    'https://world.openfoodfacts.org': { status: 429, json: null },
  });
  await cachedSearch({ request, cache, cooldowns, settings, query: 'egg', now: 0 });
  const before = calls.length;
  const b = await cachedSearch({ request, cache, cooldowns, settings, query: 'oats', now: 1 });
  assert.equal(calls.length, before, 'no network call when every enabled source is cooling down');
  assert.equal(b.errors.length, 2);
  assert.deepEqual(b.foods, []);
});

test('a non-rate-limit error is not cached — it is retried next time', async () => {
  let n = 0;
  const { cache, cooldowns } = setup({});
  const flaky = async () => {
    n++;
    return n === 1 ? { status: 400, json: null } : usdaOk;
  };
  const a = await cachedSearch({
    request: flaky,
    cache,
    cooldowns,
    settings: { useUsda: true, useOff: false, usdaApiKey: '' },
    query: 'egg',
    now: 0,
  });
  assert.equal(a.foods.length, 0);
  const b = await cachedSearch({
    request: flaky,
    cache,
    cooldowns,
    settings: { useUsda: true, useOff: false, usdaApiKey: '' },
    query: 'egg',
    now: 1,
  });
  assert.equal(b.foods.length, 1, 'retried instead of serving the cached failure');
});
