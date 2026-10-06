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
