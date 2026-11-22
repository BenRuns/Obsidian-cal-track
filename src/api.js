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

// A page of results, and whether the source has more after it.
/** @typedef {{ foods: Food[], more: boolean }} SearchPage */

const PAGE_SIZE = 15;

// Words of a brand or query, lowercased, for matching against a food's brand.
/** @param {string} s */
const wordsOf = (s) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}'&]+/u)
    .filter((w) => w.length > 1);

/**
 * @param {Food} food
 * @param {string[]} words
 */
const brandMatches = (food, words) => {
  const brand = food.brand.toLowerCase();
  return words.length > 0 && words.some((w) => brand.includes(w));
};

// USDA's field syntax: each brand word must be in the brand name.
// "Trader Joe's" → +brandName:trader +brandName:joe's
/** @param {string} brand */
function usdaBrandQuery(brand) {
  return wordsOf(brand)
    .map((w) => `+brandName:${w.replace(/[^\p{L}\p{N}']/gu, '')}`)
    .filter((w) => w !== '+brandName:')
    .join(' ');
}

// USDA ranks by relevance across all data types; generic foods (Foundation /
// SR Legacy / Survey) are moved ahead of branded ones so "banana" lists the
// fruit before banana-flavoured candy — unless the query names the brand
// ("chobani yogurt"), when those branded foods come first. Relevance order is
// kept within each group. With a brand, only Branded foods are searched.
/**
 * @param {HttpRequest} request
 * @param {string} query
 * @param {string} apiKey
 * @param {{ branded?: boolean, pageSize?: number, page?: number, brand?: string, retryDelays?: number[] }} [options]
 * @returns {Promise<SearchPage>}
 */
async function searchUsdaPage(
  request,
  query,
  apiKey,
  {
    branded = true,
    pageSize = PAGE_SIZE,
    page = 1,
    brand = '',
    retryDelays = USDA_RETRY_DELAYS_MS,
  } = {},
) {
  const brandQuery = usdaBrandQuery(brand);
  const types = brandQuery ? ['Branded'] : ['Foundation', 'SR Legacy', 'Survey (FNDDS)'];
  if (branded && !brandQuery) types.push('Branded');
  // A POST with a JSON body: USDA's server rejects a GET whose query string
  // has the encoded parentheses of "Survey (FNDDS)" (HTTP 400).
  const params = new URLSearchParams({ api_key: apiKey || 'DEMO_KEY' });
  /** @type {Record<string, unknown>} */
  const body = {
    query: [brandQuery, query.trim()].filter(Boolean).join(' '),
    pageSize,
    dataType: types,
  };
  if (page > 1) body.pageNumber = page;
  const json = /** @type {UsdaSearchJson} */ (
    await getJson(request, `${USDA_BASE}/foods/search?${params}`, undefined, {
      retryDelays,
      body,
    })
  );
  const foods = parseUsdaSearch(json);
  const words = wordsOf(query);
  /** @param {Food} f */
  const first = (f) => !f.brand || brandMatches(f, words);
  const more = Number(json?.totalPages) > (Number(json?.currentPage) || page);
  return { foods: [...foods.filter(first), ...foods.filter((f) => !first(f))], more };
}

/**
 * @param {HttpRequest} request
 * @param {string} query
 * @param {string} apiKey
 * @param {Parameters<typeof searchUsdaPage>[3]} [options]
 */
async function searchUsda(request, query, apiKey, options) {
  return (await searchUsdaPage(request, query, apiKey, options)).foods;
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
// A brand is a brands:"…" filter there; the classic search has no filter for
// it, so the brand joins the search terms.
/**
 * @param {HttpRequest} request
 * @param {string} query
 * @param {{ pageSize?: number, page?: number, brand?: string }} [options]
 * @returns {Promise<SearchPage>}
 */
async function searchOffPage(request, query, { pageSize = PAGE_SIZE, page = 1, brand = '' } = {}) {
  const headers = { 'User-Agent': USER_AGENT };
  const b = brand.trim().replace(/"/g, '');
  try {
    const params = new URLSearchParams({
      q: [query.trim(), b && `brands:"${b}"`].filter(Boolean).join(' '),
      page_size: String(pageSize),
      fields: OFF_FIELDS,
    });
    if (page > 1) params.set('page', String(page));
    const json = /** @type {{ hits?: OffProductJson[], page_count?: number } | null} */ (
      await getJson(request, `${OFF_SEARCH}/search?${params}`, headers)
    );
    return {
      foods: parseOffSearch({ products: json?.hits }),
      more: Number(json?.page_count) > page,
    };
  } catch (e) {
    if (errorCode(e) === 'rate_limited') throw e;
  }
  const params = new URLSearchParams({
    search_terms: [query.trim(), b].filter(Boolean).join(' '),
    search_simple: '1',
    action: 'process',
    json: '1',
    page_size: String(pageSize),
    fields: OFF_FIELDS,
  });
  if (page > 1) params.set('page', String(page));
  const json = /** @type {import('./types').OffSearchJson | null} */ (
    await getJson(request, `${OFF_BASE}/cgi/search.pl?${params}`, headers)
  );
  return {
    foods: parseOffSearch(json || {}),
    more: Number(json?.count) > page * pageSize,
  };
}

/**
 * @param {HttpRequest} request
 * @param {string} query
 * @param {Parameters<typeof searchOffPage>[2]} [options]
 */
async function searchOff(request, query, options) {
  return (await searchOffPage(request, query, options)).foods;
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
// other's results; errors are returned alongside. `more` lists the sources
// with another page, for a "More results" button (page + 1).
// A query that is just a barcode is looked up by barcode instead of as text.
/**
 * @param {HttpRequest} request
 * @param {string} query
 * @param {SearchSettings} settings
 * @param {{ page?: number, brand?: string }} [options]
 * @returns {Promise<SearchResult>}
 */
async function searchAll(request, query, settings, { page = 1, brand = '' } = {}) {
  const code = brand.trim() ? null : asBarcode(query);
  /** @param {Promise<Food[]>} p */
  const single = async (p) => ({ foods: await p, more: false });
  /** @type {[string, Promise<SearchPage>][]} */
  const jobs = [];
  if (settings.useUsda) {
    const job = code
      ? single(lookupUsdaBarcode(request, code, settings.usdaApiKey))
      : searchUsdaPage(request, query, settings.usdaApiKey, { page, brand });
    jobs.push(['USDA', job]);
  }
  if (settings.useOff) {
    jobs.push([
      'Open Food Facts',
      code
        ? single(lookupOffBarcode(request, code))
        : searchOffPage(request, query, { page, brand }),
    ]);
  }
  const settled = await Promise.allSettled(jobs.map(([, p]) => p));
  /** @type {Food[]} */
  const foods = [];
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const rateLimited = [];
  /** @type {string[]} */
  const more = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      foods.push(...r.value.foods);
      if (r.value.more) more.push(jobs[i][0]);
    } else {
      /** @type {unknown} */
      const reason = r.reason;
      errors.push(`${jobs[i][0]}: ${errorMessage(reason)}`);
      if (errorCode(reason) === 'rate_limited') rateLimited.push(jobs[i][0]);
    }
  });
  return { foods, errors, barcode: code, rateLimited, more };
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
  searchOffPage,
  searchUsda,
  searchUsdaPage,
  USER_AGENT,
  usdaBrandQuery,
};
