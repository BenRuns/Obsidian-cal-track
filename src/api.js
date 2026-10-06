'use strict';

const { parseUsdaSearch, parseUsdaFood, parseOffSearch } = require('./food');

// ─── Food database lookups ────────────────────────────────────────────────────
//
// `request` is Obsidian's requestUrl (it bypasses CORS and works on mobile);
// tests pass a stub. It resolves to { status, json }.

const USDA_BASE = 'https://api.nal.usda.gov/fdc/v1';
const OFF_BASE = 'https://world.openfoodfacts.org';
const USER_AGENT = 'ObsidianCalTrack/0.1 (https://github.com/BenRuns/Obsidian-cal-track)';

async function getJson(request, url, headers) {
  const res = await request({ url, method: 'GET', headers, throw: false });
  if (res.status === 429)
    throw new Error('Rate limited — try again shortly, or add your own USDA API key in settings.');
  if (res.status === 403) throw new Error('USDA rejected the API key — check it in settings.');
  if (res.status < 200 || res.status >= 300) throw new Error(`Lookup failed (HTTP ${res.status})`);
  return res.json;
}

// USDA ranks by relevance across all data types; generic foods (Foundation /
// SR Legacy / Survey) are moved ahead of branded ones so "banana" lists the
// fruit before banana-flavoured candy. Relevance order is kept within each.
async function searchUsda(request, query, apiKey, { branded = true, pageSize = 15 } = {}) {
  const types = ['Foundation', 'SR Legacy', 'Survey (FNDDS)'];
  if (branded) types.push('Branded');
  const params = new URLSearchParams({
    api_key: apiKey || 'DEMO_KEY',
    query,
    pageSize: String(pageSize),
    dataType: types.join(','),
  });
  const json = await getJson(request, `${USDA_BASE}/foods/search?${params}`);
  const foods = parseUsdaSearch(json);
  return [...foods.filter((f) => !f.brand), ...foods.filter((f) => f.brand)];
}

// Full record — has foodPortions, which search results sometimes lack.
async function getUsdaFood(request, fdcId, apiKey) {
  const params = new URLSearchParams({ api_key: apiKey || 'DEMO_KEY' });
  const json = await getJson(request, `${USDA_BASE}/food/${fdcId}?${params}`);
  return parseUsdaFood(json);
}

async function searchOff(request, query, { pageSize = 15 } = {}) {
  const params = new URLSearchParams({
    search_terms: query,
    search_simple: '1',
    action: 'process',
    json: '1',
    page_size: String(pageSize),
    fields: 'code,product_name,brands,nutriments,serving_size,serving_quantity',
  });
  const json = await getJson(request, `${OFF_BASE}/cgi/search.pl?${params}`, {
    'User-Agent': USER_AGENT,
  });
  return parseOffSearch(json);
}

// Runs the enabled sources in parallel. One failing source doesn't hide the
// other's results; errors are returned alongside.
async function searchAll(request, query, settings) {
  const jobs = [];
  if (settings.useUsda) jobs.push(['USDA', searchUsda(request, query, settings.usdaApiKey)]);
  if (settings.useOff) jobs.push(['Open Food Facts', searchOff(request, query)]);
  const settled = await Promise.allSettled(jobs.map(([, p]) => p));
  const foods = [];
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') foods.push(...r.value);
    else errors.push(`${jobs[i][0]}: ${r.reason?.message || r.reason}`);
  });
  return { foods, errors };
}

module.exports = { searchUsda, getUsdaFood, searchOff, searchAll };
