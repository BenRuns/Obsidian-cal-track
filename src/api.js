import { parseOffSearch, parseUsdaFood, parseUsdaSearch } from './food.js';

/** @typedef {import('./types').Food} Food */
/** @typedef {import('./types').HttpError} HttpError */
/** @typedef {import('./types').HttpRequest} HttpRequest */
/** @typedef {import('./types').OffProductJson} OffProductJson */
/** @typedef {import('./types').SearchResult} SearchResult */
/** @typedef {import('./types').SearchSettings} SearchSettings */
/** @typedef {import('./types').UsdaFoodJson} UsdaFoodJson */
/** @typedef {import('./types').UsdaSearchJson} UsdaSearchJson */

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

import manifest from '../manifest.json' with { type: 'json' };

// Read through `unknown`: some TypeScript setups (Obsidian's review among
// them) don't type JSON imports.
/** @param {unknown} m */
const versionOf = (m) =>
  typeof m === 'object' && m !== null && 'version' in m && typeof m.version === 'string'
    ? m.version
    : '';
const version = versionOf(manifest);

// Open Food Facts asks every app to identify itself as
// "AppName/Version (ContactEmail)", so they can reach the maintainer
// instead of blocking the app's traffic.
const USER_AGENT = `ObsidianCalTrack/${version} (5211586+BenRuns@users.noreply.github.com; https://github.com/BenRuns/Obsidian-cal-track)`;

/**
 * @param {string} message
 * @param {string} code
 */
function httpError(message, code) {
  /** @type {HttpError} */
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

// The reason an httpError gave, and the message, for any thrown value.
/** @param {unknown} e */
function errorCode(e) {
  return typeof e === 'object' && e !== null && 'code' in e ? e.code : undefined;
}

/** @param {unknown} e */
function errorMessage(e) {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : 'unknown error';
}

/**
 * @param {number} retries
 * @param {number} baseMs
 */
function backoffDelays(retries, baseMs) {
  return Array.from({ length: retries }, (_, i) => baseMs * 2 ** i);
}

const USDA_RETRY_DELAYS_MS = backoffDelays(USDA_RETRIES, USDA_RETRY_BASE_MS);

// Up to 50% random jitter, so clients that failed together don't all retry
// at the same instant. A zero wait (tests) skips the timer altogether.
/** @param {number} ms */
const pause = (ms) =>
  ms > 0
    ? new Promise((resolve) => window.setTimeout(resolve, ms * (1 + Math.random() * 0.5)))
    : Promise.resolve();

// body: sent as a JSON POST instead of a GET.
/**
 * @param {HttpRequest} request
 * @param {string} url
 * @param {Record<string, string> | undefined} headers
 * @param {{ notFoundOk?: boolean, retryDelays?: number[], body?: unknown }} [options]
 * @returns {Promise<unknown>}
 */
async function getJson(request, url, headers, { notFoundOk = false, retryDelays = [], body } = {}) {
  const req = body
    ? { url, method: 'POST', contentType: 'application/json', body: JSON.stringify(body) }
    : { url, method: 'GET' };
  /** @type {Awaited<ReturnType<HttpRequest>>} */
  let res;
  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < retryDelays.length;
    try {
      res = await request({ ...req, headers, throw: false });
    } catch (e) {
      // requestUrl rejects on network errors even with throw: false.
      if (!canRetry) throw e;
      await pause(retryDelays[attempt]);
      continue;
    }
    if (!canRetry || !TRANSIENT_STATUSES.has(res.status)) break;
    await pause(retryDelays[attempt]);
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
/**
 * @param {HttpRequest} request
 * @param {string} query
 * @param {string} apiKey
 * @param {{ branded?: boolean, pageSize?: number, retryDelays?: number[] }} [options]
 */
async function searchUsda(
  request,
  query,
  apiKey,
  { branded = true, pageSize = 15, retryDelays = USDA_RETRY_DELAYS_MS } = {},
) {
  const types = ['Foundation', 'SR Legacy', 'Survey (FNDDS)'];
  if (branded) types.push('Branded');
  // A POST with a JSON body: USDA's server rejects a GET whose query string
  // has the encoded parentheses of "Survey (FNDDS)" (HTTP 400).
  const params = new URLSearchParams({ api_key: apiKey || 'DEMO_KEY' });
  const json = /** @type {UsdaSearchJson} */ (
    await getJson(request, `${USDA_BASE}/foods/search?${params}`, undefined, {
      retryDelays,
      body: { query, pageSize, dataType: types },
    })
  );
  const foods = parseUsdaSearch(json);
  return [...foods.filter((f) => !f.brand), ...foods.filter((f) => f.brand)];
}

// Full record — has foodPortions, which search results sometimes lack.
/**
 * @param {HttpRequest} request
 * @param {string} fdcId
 * @param {string} apiKey
 * @param {{ retryDelays?: number[] }} [options]
 */
async function getUsdaFood(request, fdcId, apiKey, { retryDelays = USDA_RETRY_DELAYS_MS } = {}) {
  const params = new URLSearchParams({ api_key: apiKey || 'DEMO_KEY' });
  const json = /** @type {UsdaFoodJson} */ (
    await getJson(request, `${USDA_BASE}/food/${fdcId}?${params}`, undefined, { retryDelays })
  );
  return parseUsdaFood(json);
}

// Search-a-licious first; the classic search only if it fails for a reason
// other than rate limiting (being rate limited, a second request won't help).
/**
 * @param {HttpRequest} request
 * @param {string} query
 * @param {{ pageSize?: number }} [options]
 */
async function searchOff(request, query, { pageSize = 15 } = {}) {
  const headers = { 'User-Agent': USER_AGENT };
  try {
    const params = new URLSearchParams({
      q: query,
      page_size: String(pageSize),
      fields: OFF_FIELDS,
    });
    const json = /** @type {{ hits?: OffProductJson[] } | null} */ (
      await getJson(request, `${OFF_SEARCH}/search?${params}`, headers)
    );
    return parseOffSearch({ products: json?.hits });
  } catch (e) {
    if (errorCode(e) === 'rate_limited') throw e;
  }
  const params = new URLSearchParams({
    search_terms: query,
    search_simple: '1',
    action: 'process',
    json: '1',
    page_size: String(pageSize),
    fields: OFF_FIELDS,
  });
  const json = /** @type {import('./types').OffSearchJson} */ (
    await getJson(request, `${OFF_BASE}/cgi/search.pl?${params}`, headers)
  );
  return parseOffSearch(json);
}

// ─── Barcodes ─────────────────────────────────────────────────────────────────

// UPC-A (12), EAN-8/13, GTIN-14. Spaces and dashes from a label are allowed.
/** @param {string | null | undefined} query */
function asBarcode(query) {
  const digits = String(query || '').replace(/[\s-]/g, '');
  return /^\d{8,14}$/.test(digits) ? digits : null;
}

// The same product can be written as UPC-A (12 digits), EAN-13 with a
// leading 0, or GTIN-14 with leading zeros. Compare without them.
/**
 * @param {string | undefined} a
 * @param {string | undefined} b
 */
function sameBarcode(a, b) {
  /** @param {string | undefined} s */
  const strip = (s) => String(s || '').replace(/^0+/, '');
  return strip(a) !== '' && strip(a) === strip(b);
}

/**
 * @param {HttpRequest} request
 * @param {string} code
 */
async function lookupOffBarcode(request, code) {
  // Open Food Facts keys products by EAN-13; a 12-digit UPC-A is the same
  // number with a leading 0, so try that form if the typed one misses.
  const tries = code.length === 12 ? [code, `0${code}`] : [code];
  for (const c of tries) {
    const json = /** @type {{ status?: number, product?: OffProductJson } | null} */ (
      await getJson(
        request,
        `${OFF_BASE}/api/v2/product/${c}.json?fields=${OFF_FIELDS}`,
        { 'User-Agent': USER_AGENT },
        { notFoundOk: true },
      )
    );
    if (json?.status === 1 && json.product) {
      return parseOffSearch({ products: [{ code: c, ...json.product }] });
    }
  }
  return [];
}

// USDA's Branded foods carry gtinUpc; a search for the number finds them,
// then only exact barcode matches are kept.
/**
 * @param {HttpRequest} request
 * @param {string} code
 * @param {string} apiKey
 * @param {{ retryDelays?: number[] }} [options]
 */
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
  const json = /** @type {UsdaSearchJson | null} */ (
    await getJson(request, `${USDA_BASE}/foods/search?${params}`, undefined, { retryDelays })
  );
  const hits = (json?.foods || []).filter((f) => sameBarcode(f.gtinUpc, code));
  return parseUsdaSearch({ foods: hits });
}

// Runs the enabled sources in parallel. One failing source doesn't hide the
// other's results; errors are returned alongside.
// A query that is just a barcode is looked up by barcode instead of as text.
/**
 * @param {HttpRequest} request
 * @param {string} query
 * @param {SearchSettings} settings
 * @returns {Promise<SearchResult>}
 */
async function searchAll(request, query, settings) {
  const code = asBarcode(query);
  /** @type {[string, Promise<Food[]>][]} */
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
  /** @type {Food[]} */
  const foods = [];
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const rateLimited = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') foods.push(...r.value);
    else {
      /** @type {unknown} */
      const reason = r.reason;
      errors.push(`${jobs[i][0]}: ${errorMessage(reason)}`);
      if (errorCode(reason) === 'rate_limited') rateLimited.push(jobs[i][0]);
    }
  });
  return { foods, errors, barcode: code, rateLimited };
}

export {
  asBarcode,
  backoffDelays,
  errorCode,
  errorMessage,
  getUsdaFood,
  lookupOffBarcode,
  lookupUsdaBarcode,
  sameBarcode,
  searchAll,
  searchOff,
  searchUsda,
  USER_AGENT,
};
