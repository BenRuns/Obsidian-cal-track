'use strict';

const { parseUsdaSearch, parseUsdaFood, parseOffSearch } = require('./food');

// ─── Food database lookups ────────────────────────────────────────────────────
//
// `request` is Obsidian's requestUrl (it bypasses CORS and works on mobile);
// tests pass a stub. It resolves to { status, json }.

const USDA_BASE = 'https://api.nal.usda.gov/fdc/v1';
const OFF_BASE = 'https://world.openfoodfacts.org';
// Open Food Facts' newer search service. The classic /cgi/search.pl is often
// overloaded (HTTP 503) and ignores `fields`, sending whole product records.
const OFF_SEARCH = 'https://search.openfoodfacts.org';
const OFF_FIELDS = 'code,product_name,brands,nutriments,serving_size,serving_quantity';
const { version } = require('../manifest.json');

// Open Food Facts asks every app to identify itself as
// "AppName/Version (ContactEmail)", so they can reach the maintainer
// instead of blocking the app's traffic.
const USER_AGENT = `ObsidianCalTrack/${version} (5211586+BenRuns@users.noreply.github.com; https://github.com/BenRuns/Obsidian-cal-track)`;

function httpError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// USDA's FoodData Central fails intermittently (HTTP 500/502/504 or a dropped
// connection) and the same request usually succeeds a moment later. Failures
// like these are retried with exponential backoff (0.5 s, 1 s, 2 s) before
// giving up. Rate limits and bad keys are never retried: another try would
// fail the same way and spend more of the shared DEMO_KEY quota.
const USDA_RETRIES = 3;
const USDA_RETRY_BASE_MS = 500;
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);

function backoffDelays(retries, baseMs) {
  return Array.from({ length: retries }, (_, i) => baseMs * 2 ** i);
}

const USDA_RETRY_DELAYS_MS = backoffDelays(USDA_RETRIES, USDA_RETRY_BASE_MS);

// Up to 50% random jitter, so clients that failed together don't all retry
// at the same instant.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms * (1 + Math.random() * 0.5)));

async function getJson(request, url, headers, { notFoundOk = false, retryDelays = [] } = {}) {
  let res;
  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < retryDelays.length;
    try {
      res = await request({ url, method: 'GET', headers, throw: false });
    } catch (e) {
      // requestUrl rejects on network errors even with throw: false.
      if (!canRetry) throw e;
      await sleep(retryDelays[attempt]);
      continue;
    }
    if (!canRetry || !TRANSIENT_STATUSES.has(res.status)) break;
    await sleep(retryDelays[attempt]);
  }
  if (notFoundOk && res.status === 404) return null;
  if (res.status === 429) {
    throw httpError(
      'Rate limited — try again shortly, or add your own USDA API key in settings.',
      'rate_limited',
    );
  }
  if (res.status === 403)
    throw httpError('USDA rejected the API key — check it in settings.', 'forbidden');
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    throw httpError(`Busy right now (HTTP ${res.status}) — try again in a minute.`, 'unavailable');
  }
  if (res.status < 200 || res.status >= 300) {
    throw httpError(`Lookup failed (HTTP ${res.status})`, 'http_error');
  }
  return res.json;
}

// USDA ranks by relevance across all data types; generic foods (Foundation /
// SR Legacy / Survey) are moved ahead of branded ones so "banana" lists the
// fruit before banana-flavoured candy. Relevance order is kept within each.
async function searchUsda(
  request,
  query,
  apiKey,
  { branded = true, pageSize = 15, retryDelays = USDA_RETRY_DELAYS_MS } = {},
) {
  const types = ['Foundation', 'SR Legacy', 'Survey (FNDDS)'];
  if (branded) types.push('Branded');
  const params = new URLSearchParams({
    api_key: apiKey || 'DEMO_KEY',
    query,
    pageSize: String(pageSize),
    dataType: types.join(','),
  });
  const json = await getJson(request, `${USDA_BASE}/foods/search?${params}`, undefined, {
    retryDelays,
  });
  const foods = parseUsdaSearch(json);
  return [...foods.filter((f) => !f.brand), ...foods.filter((f) => f.brand)];
}

// Full record — has foodPortions, which search results sometimes lack.
async function getUsdaFood(request, fdcId, apiKey, { retryDelays = USDA_RETRY_DELAYS_MS } = {}) {
  const params = new URLSearchParams({ api_key: apiKey || 'DEMO_KEY' });
  const json = await getJson(request, `${USDA_BASE}/food/${fdcId}?${params}`, undefined, {
    retryDelays,
  });
  return parseUsdaFood(json);
}

// Search-a-licious first; the classic search only if it fails for a reason
// other than rate limiting (being rate limited, a second request won't help).
async function searchOff(request, query, { pageSize = 15 } = {}) {
  const headers = { 'User-Agent': USER_AGENT };
  try {
    const params = new URLSearchParams({
      q: query,
      page_size: String(pageSize),
      fields: OFF_FIELDS,
    });
    const json = await getJson(request, `${OFF_SEARCH}/search?${params}`, headers);
    return parseOffSearch({ products: json?.hits });
  } catch (e) {
    if (e?.code === 'rate_limited') throw e;
  }
  const params = new URLSearchParams({
    search_terms: query,
    search_simple: '1',
    action: 'process',
    json: '1',
    page_size: String(pageSize),
    fields: OFF_FIELDS,
  });
  const json = await getJson(request, `${OFF_BASE}/cgi/search.pl?${params}`, headers);
  return parseOffSearch(json);
}

// ─── Barcodes ─────────────────────────────────────────────────────────────────

// UPC-A (12), EAN-8/13, GTIN-14. Spaces and dashes from a label are allowed.
function asBarcode(query) {
  const digits = String(query || '').replace(/[\s-]/g, '');
  return /^\d{8,14}$/.test(digits) ? digits : null;
}

// The same product can be written as UPC-A (12 digits), EAN-13 with a
// leading 0, or GTIN-14 with leading zeros. Compare without them.
function sameBarcode(a, b) {
  const strip = (s) => String(s || '').replace(/^0+/, '');
  return strip(a) !== '' && strip(a) === strip(b);
}

async function lookupOffBarcode(request, code) {
  // Open Food Facts keys products by EAN-13; a 12-digit UPC-A is the same
  // number with a leading 0, so try that form if the typed one misses.
  const tries = code.length === 12 ? [code, `0${code}`] : [code];
  for (const c of tries) {
    const json = await getJson(
      request,
      `${OFF_BASE}/api/v2/product/${c}.json?fields=${OFF_FIELDS}`,
      { 'User-Agent': USER_AGENT },
      { notFoundOk: true },
    );
    if (json?.status === 1 && json.product) {
      return parseOffSearch({ products: [{ code: c, ...json.product }] });
    }
  }
  return [];
}

// USDA's Branded foods carry gtinUpc; a search for the number finds them,
// then only exact barcode matches are kept.
async function lookupUsdaBarcode(
  request,
  code,
  apiKey,
  { retryDelays = USDA_RETRY_DELAYS_MS } = {},
) {
  const params = new URLSearchParams({
    api_key: apiKey || 'DEMO_KEY',
    query: code,
    pageSize: '10',
    dataType: 'Branded',
  });
  const json = await getJson(request, `${USDA_BASE}/foods/search?${params}`, undefined, {
    retryDelays,
  });
  const hits = (json?.foods || []).filter((f) => sameBarcode(f.gtinUpc, code));
  return parseUsdaSearch({ foods: hits });
}

// Runs the enabled sources in parallel. One failing source doesn't hide the
// other's results; errors are returned alongside.
// A query that is just a barcode is looked up by barcode instead of as text.
async function searchAll(request, query, settings) {
  const code = asBarcode(query);
  const jobs = [];
  if (settings.useUsda) {
    const job = code
      ? lookupUsdaBarcode(request, code, settings.usdaApiKey)
      : searchUsda(request, query, settings.usdaApiKey);
    jobs.push(['USDA', job]);
  }
  if (settings.useOff) {
    jobs.push([
      'Open Food Facts',
      code ? lookupOffBarcode(request, code) : searchOff(request, query),
    ]);
  }
  const settled = await Promise.allSettled(jobs.map(([, p]) => p));
  const foods = [];
  const errors = [];
  const rateLimited = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') foods.push(...r.value);
    else {
      errors.push(`${jobs[i][0]}: ${r.reason?.message || r.reason}`);
      if (r.reason?.code === 'rate_limited') rateLimited.push(jobs[i][0]);
    }
  });
  return { foods, errors, barcode: code, rateLimited };
}

module.exports = {
  backoffDelays,
  USER_AGENT,
  searchUsda,
  getUsdaFood,
  searchOff,
  searchAll,
  asBarcode,
  sameBarcode,
  lookupOffBarcode,
  lookupUsdaBarcode,
};
