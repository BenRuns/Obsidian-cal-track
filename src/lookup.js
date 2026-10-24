import { asBarcode, searchAll } from './api.js';

// ─── Cached, backoff-aware search ─────────────────────────────────────────────
//
// Wraps searchAll with:
//   - a short TTL cache, so reopening "adjust" on a food, retyping after a
//     backspace, or searching the same thing twice doesn't re-hit the network
//   - a per-source cooldown after a 429, so continuing to type (or search
//     again a minute later) doesn't keep hammering an already-rate-limited
//     source — it's skipped until the cooldown passes, with a status message
//     explaining why and how long
//
// `cooldowns` is a plain object `{ [sourceLabel]: untilTimestampMs }`, owned
// by the caller and mutated in place so it persists across calls on the same
// plugin instance (and can be reset to `{}` to retry immediately).

const SOURCES = ['USDA', 'Open Food Facts'];

// The USDA DEMO_KEY quota (~30 requests/hour) is shared across every
// anonymous user of this plugin worldwide, not just this vault, so it can
// already be exhausted before you've made a single request yourself. A
// personal key (free, 1000/hour) isn't shared, so it's the real fix; this
// cooldown just stops the plugin from making the shared problem worse.
const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;

function cacheKey(settings, query) {
  return [
    query.trim().toLowerCase(),
    settings.useUsda ? `usda:${settings.usdaApiKey || 'demo'}` : '',
    settings.useOff ? 'off' : '',
  ].join('|');
}

function minutesLeft(ms) {
  return Math.max(1, Math.ceil(ms / 60000));
}

function cooldownMessage(source, cooldowns, now) {
  const mins = minutesLeft(cooldowns[source] - now);
  const hint =
    source === 'USDA' ? ' Add your own free API key in settings to stop sharing this limit.' : '';
  return `${source}: rate limited, retrying in ${mins} min.${hint}`;
}

async function cachedSearch({ request, cache, cooldowns, settings, query, now = Date.now() }) {
  const key = cacheKey(settings, query);
  const hit = cache.get(key, now);
  if (hit) return hit;

  const cooledDown = (source) => (cooldowns[source] || 0) > now;
  const effective = {
    ...settings,
    useUsda: settings.useUsda && !cooledDown('USDA'),
    useOff: settings.useOff && !cooledDown('Open Food Facts'),
  };
  const waiting = SOURCES.filter(
    (s) => cooledDown(s) && settings[s === 'USDA' ? 'useUsda' : 'useOff'],
  ).map((s) => cooldownMessage(s, cooldowns, now));

  if (!effective.useUsda && !effective.useOff) {
    return { foods: [], errors: waiting, barcode: asBarcode(query), rateLimited: [] };
  }

  const result = await searchAll(request, query, effective);
  for (const source of result.rateLimited) cooldowns[source] = now + RATE_LIMIT_COOLDOWN_MS;
  const merged = { ...result, errors: [...waiting, ...result.errors] };

  // Cache a clean result (including "no matches") but not one that hit a
  // real error — a transient network hiccup shouldn't be remembered as if
  // it were the true answer. The rate-limit cooldown above is what prevents
  // hammering a failing source; it's tracked separately from this cache.
  if (!result.errors.length) cache.set(key, merged, now);
  return merged;
}

export { cachedSearch, cacheKey, RATE_LIMIT_COOLDOWN_MS };
