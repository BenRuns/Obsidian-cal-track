'use strict';

// ─── Small in-memory TTL cache ────────────────────────────────────────────────
//
// Used to avoid re-querying the food databases for a search or lookup the
// user already made recently (reopening "adjust" on the same food, retyping
// after a backspace, searching for the same thing twice). Not persisted —
// cleared on reload, which is fine since it only ever saves network calls,
// never real data.

class TTLCache {
  constructor({ ttlMs, maxEntries }) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.map = new Map(); // key -> { value, at }
  }

  get(key, now = Date.now()) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (now - entry.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // Touch it so eviction below is least-recently-used, not least-recently-set.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, now = Date.now()) {
    this.map.delete(key);
    this.map.set(key, { value, at: now });
    while (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value);
    }
  }

  clear() {
    this.map.clear();
  }
}

module.exports = { TTLCache };
