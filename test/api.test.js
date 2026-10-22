'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchUsda, searchAll } = require('../src/api');

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

const usdaOk = {
  status: 200,
  json: {
    foods: [{ fdcId: 9, description: 'Egg', foodNutrients: [{ nutrientId: 1008, value: 143 }] }],
  },
};

test('USDA search uses DEMO_KEY by default and the given key otherwise', async () => {
  const { request, calls } = stub({ 'https://api.nal.usda.gov': usdaOk });
  const foods = await searchUsda(request, 'egg', '');
  assert.equal(foods[0].name, 'Egg');
  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get('api_key'), 'DEMO_KEY');
  assert.equal(url.searchParams.get('query'), 'egg');
  assert.match(url.searchParams.get('dataType'), /^Foundation,SR Legacy/);

  await searchUsda(request, 'egg', 'abc123');
  assert.equal(new URL(calls[1]).searchParams.get('api_key'), 'abc123');
});

test('searchAll merges sources and reports a failing one', async () => {
  const { request } = stub({
    'https://api.nal.usda.gov': usdaOk,
    'https://world.openfoodfacts.org': { status: 429, json: null },
  });
  const { foods, errors } = await searchAll(request, 'egg', { useUsda: true, useOff: true });
  assert.equal(foods.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^Open Food Facts: Rate limited/);
});

test('searchAll skips disabled sources', async () => {
  const { request, calls } = stub({ 'https://api.nal.usda.gov': usdaOk });
  await searchAll(request, 'egg', { useUsda: true, useOff: false });
  assert.equal(calls.length, 1);
});

const { asBarcode, sameBarcode } = require('../src/api');

const offProduct = {
  status: 1,
  product: {
    product_name: 'Cheerios',
    brands: 'General Mills',
    serving_quantity: 28,
    nutriments: { 'energy-kcal_100g': 357, proteins_100g: 12.5 },
  },
};

test('asBarcode accepts 8–14 digits with spaces or dashes', () => {
  assert.equal(asBarcode('016000275287'), '016000275287');
  assert.equal(asBarcode('0 16000 27528 7'), '016000275287');
  assert.equal(asBarcode('5449-0000-0099-6'), '5449000000996');
  assert.equal(asBarcode('1234567'), null);
  assert.equal(asBarcode('banana'), null);
  assert.equal(asBarcode('2 eggs'), null);
});

test('sameBarcode ignores leading zeros (UPC-A / EAN-13 / GTIN-14)', () => {
  assert.ok(sameBarcode('016000275287', '0016000275287'));
  assert.ok(sameBarcode('00016000275287', '16000275287'));
  assert.ok(!sameBarcode('016000275287', '016000275288'));
  assert.ok(!sameBarcode('', '0'));
});

test('barcode query hits the OFF product endpoint and filters USDA by gtinUpc', async () => {
  const { request, calls } = stub({
    'https://world.openfoodfacts.org/api/v2/product/016000275287.json': {
      status: 404,
      json: { status: 0 },
    },
    'https://world.openfoodfacts.org/api/v2/product/0016000275287.json': {
      status: 200,
      json: offProduct,
    },
    'https://api.nal.usda.gov': {
      status: 200,
      json: {
        foods: [
          {
            fdcId: 1,
            description: 'CHEERIOS',
            brandOwner: 'General Mills',
            gtinUpc: '016000275287',
            foodNutrients: [{ nutrientId: 1008, value: 357 }],
          },
          // Text match on the number, but a different barcode → dropped.
          {
            fdcId: 2,
            description: 'OTHER',
            gtinUpc: '999',
            foodNutrients: [{ nutrientId: 1008, value: 1 }],
          },
        ],
      },
    },
  });
  const { foods, errors, barcode } = await searchAll(request, '0 16000 27528 7', {
    useUsda: true,
    useOff: true,
  });
  assert.deepEqual(errors, []);
  assert.equal(barcode, '016000275287');
  assert.deepEqual(
    foods.map((f) => f.id),
    ['usda:1', 'off:0016000275287'],
  );
  assert.equal(foods[1].brand, 'General Mills');
  const usdaUrl = new URL(calls.find((c) => c.includes('nal.usda.gov')));
  assert.equal(usdaUrl.searchParams.get('dataType'), 'Branded');
  assert.ok(!calls.some((c) => c.includes('search.pl')), 'no text search for a barcode');
});

test('unknown barcode returns no foods and no error', async () => {
  const { request } = stub({
    'https://world.openfoodfacts.org/api/v2/product/': { status: 404, json: { status: 0 } },
    'https://api.nal.usda.gov': { status: 200, json: { foods: [] } },
  });
  const { foods, errors } = await searchAll(request, '12345678', { useUsda: true, useOff: true });
  assert.deepEqual(foods, []);
  assert.deepEqual(errors, []);
});

test('Open Food Facts requests identify the app, its version and a contact email', async () => {
  const { USER_AGENT } = require('../src/api');
  const { version } = require('../manifest.json');
  const seen = [];
  const request = async ({ url, headers }) => {
    if (url.includes('openfoodfacts.org')) seen.push(headers?.['User-Agent']);
    // Search-a-licious down, so both search endpoints are used; then a barcode.
    if (url.startsWith('https://search.openfoodfacts.org')) return { status: 503, json: null };
    return { status: 200, json: { products: [], status: 0 } };
  };
  await searchAll(request, 'egg', { useUsda: false, useOff: true });
  await searchAll(request, '3017624010701', { useUsda: false, useOff: true });
  assert.deepEqual(seen, [USER_AGENT, USER_AGENT, USER_AGENT]);
  assert.match(
    USER_AGENT,
    new RegExp(
      `^ObsidianCalTrack/${version.replace(/\./g, '\\.')} \\(5211586\\+BenRuns@users\\.noreply\\.github\\.com; `,
    ),
  );
});

const offHit = {
  code: '5000108236832',
  product_name: 'Oats so simple',
  brands: ['Quaker', ' Quaker Oats'],
  nutriments: {
    'energy-kcal_100g': 379,
    proteins_100g: 8.9,
    carbohydrates_100g: 68,
    fat_100g: 6.4,
  },
};

test('Open Food Facts text search uses Search-a-licious', async () => {
  const { request, calls } = stub({
    'https://search.openfoodfacts.org/search': { status: 200, json: { hits: [offHit] } },
  });
  const { foods, errors } = await searchAll(request, 'oats', { useUsda: false, useOff: true });
  assert.deepEqual(errors, []);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get('q'), 'oats');
  assert.match(url.searchParams.get('fields'), /nutriments/);
  assert.equal(foods[0].name, 'Oats so simple');
  assert.equal(foods[0].brand, 'Quaker');
  assert.equal(foods[0].per100g.kcal, 379);
});

test('Open Food Facts falls back to the classic search when Search-a-licious is down', async () => {
  const { request, calls } = stub({
    'https://search.openfoodfacts.org': { status: 503, json: null },
    'https://world.openfoodfacts.org/cgi/search.pl': {
      status: 200,
      json: { products: [{ ...offHit, brands: 'Quaker, Quaker Oats' }] },
    },
  });
  const { foods, errors } = await searchAll(request, 'oats', { useUsda: false, useOff: true });
  assert.deepEqual(errors, []);
  assert.equal(calls.length, 2);
  assert.equal(foods[0].brand, 'Quaker');
});

test('a 503 from both says the service is busy, not a bare HTTP error', async () => {
  const { request } = stub({
    'https://search.openfoodfacts.org': { status: 503, json: null },
    'https://world.openfoodfacts.org': { status: 503, json: null },
  });
  const { foods, errors } = await searchAll(request, 'oats', { useUsda: false, useOff: true });
  assert.deepEqual(foods, []);
  assert.match(errors[0], /^Open Food Facts: Busy right now \(HTTP 503\)/);
});

test('rate limited by Search-a-licious: no second request to the classic search', async () => {
  const { request, calls } = stub({
    'https://search.openfoodfacts.org': { status: 429, json: null },
  });
  const { errors } = await searchAll(request, 'oats', { useUsda: false, useOff: true });
  assert.equal(calls.length, 1);
  assert.match(errors[0], /Rate limited/);
});

const { getUsdaFood, backoffDelays } = require('../src/api');

test('backoff delays double each retry', () => {
  assert.deepEqual(backoffDelays(3, 500), [500, 1000, 2000]);
});

// Stub that answers a sequence of responses in order; an Error is thrown.
function sequence(responses) {
  const calls = [];
  const request = async ({ url }) => {
    calls.push(url);
    const res = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (res instanceof Error) throw res;
    return res;
  };
  return { request, calls };
}

const noWait = { retryDelays: [0, 0, 0] };

test('USDA search retries a transient server error and returns the result', async () => {
  const { request, calls } = sequence([{ status: 502, json: null }, usdaOk]);
  const foods = await searchUsda(request, 'egg', '', noWait);
  assert.equal(calls.length, 2);
  assert.equal(foods[0].name, 'Egg');
});

test('USDA search retries a dropped connection', async () => {
  const { request, calls } = sequence([new Error('net::ERR_CONNECTION_RESET'), usdaOk]);
  const foods = await searchUsda(request, 'egg', '', noWait);
  assert.equal(calls.length, 2);
  assert.equal(foods[0].name, 'Egg');
});

test('USDA search gives up after the retries run out', async () => {
  const { request, calls } = sequence([{ status: 500, json: null }]);
  await assert.rejects(searchUsda(request, 'egg', '', noWait), /Lookup failed \(HTTP 500\)/);
  assert.equal(calls.length, 4);
});

test('USDA rate limits and bad keys are not retried', async () => {
  for (const status of [429, 403]) {
    const { request, calls } = sequence([{ status, json: null }, usdaOk]);
    await assert.rejects(searchUsda(request, 'egg', '', noWait));
    assert.equal(calls.length, 1);
  }
});

test('USDA full-record fetch retries too', async () => {
  const food = { fdcId: 9, description: 'Egg', foodNutrients: [{ nutrientId: 1008, value: 143 }] };
  const { request, calls } = sequence([
    { status: 504, json: null },
    { status: 200, json: food },
  ]);
  const full = await getUsdaFood(request, '9', '', noWait);
  assert.equal(calls.length, 2);
  assert.equal(full.name, 'Egg');
});
