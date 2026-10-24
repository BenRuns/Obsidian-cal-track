// The food log: one CSV file, one row per food eaten. Daily notes don't hold
// any food data — they show the rows for their date (see the cal-track block
// in main.js). Columns are found by header name, so a hand-edited file with
// reordered or extra columns still reads.

/** @typedef {import('./types').LogEntry} LogEntry */
/** @typedef {keyof LogEntry} Column */
/** @typedef {'qty' | 'kcal' | 'protein' | 'carbs' | 'fat'} NumericColumn */
/** @typedef {{ meal: string, entries: LogEntry[] }} MealGroup */

/** @type {Column[]} */
const COLUMNS = [
  'id',
  'date',
  'time',
  'meal',
  'food',
  'qty',
  'unit',
  'kcal',
  'protein',
  'carbs',
  'fat',
];
/** @type {Set<Column>} */
const NUMERIC = new Set(['qty', 'kcal', 'protein', 'carbs', 'fat']);
/** @type {Record<NumericColumn, number>} */
const DECIMALS = { qty: 2, kcal: 0, protein: 1, carbs: 1, fat: 1 };

// RFC 4180: fields with commas, quotes or newlines are quoted, quotes doubled.
/** @param {string} text */
function parseCsv(text) {
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/** @param {string | number | null | undefined} v */
function csvField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * @param {unknown} v
 * @param {number} decimals
 */
function round(v, decimals) {
  if (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) return null;
  const f = 10 ** decimals;
  return Math.round(Number(v) * f) / f;
}

// → [{ id, date, time, food, qty, unit, kcal, protein, carbs, fat }]
// Numbers are numbers (or null when blank).
/**
 * @param {string | null | undefined} text
 * @returns {LogEntry[]}
 */
function parseLog(text) {
  const [header, ...rows] = parseCsv(text || '');
  if (!header) return [];
  /** @type {Partial<Record<Column, number>>} */
  const idx = {};
  header.forEach((h, i) => {
    const key = /** @type {Column} */ (h.trim().toLowerCase());
    if (COLUMNS.includes(key) && idx[key] === undefined) idx[key] = i;
  });
  return rows.map((cells, n) => {
    /** @type {Record<string, string | number | null>} */
    const entry = {};
    for (const k of COLUMNS) {
      const at = idx[k];
      const raw = at === undefined ? '' : (cells[at] ?? '').trim();
      entry[k] = NUMERIC.has(k) ? round(raw, 6) : raw;
    }
    // Rows added by hand may have no id. Their position stands in for one —
    // stable until the file changes, and saved as their id on the next write.
    if (!entry.id) entry.id = `row${n + 1}`;
    return /** @type {LogEntry} */ (/** @type {unknown} */ (entry));
  });
}

/** @param {LogEntry} entry */
function entryLine(entry) {
  return COLUMNS.map((k) =>
    csvField(
      NUMERIC.has(k) ? round(entry[k], DECIMALS[/** @type {NumericColumn} */ (k)]) : entry[k],
    ),
  ).join(',');
}

/** @param {LogEntry[]} entries */
function serializeLog(entries) {
  return `${[COLUMNS.join(','), ...entries.map(entryLine)].join('\n')}\n`;
}

// Appends one line when the file has our columns, leaving the rest of the file
// untouched. A hand-made file with other columns or order is rewritten in ours.
/**
 * @param {string} text
 * @param {LogEntry} entry
 */
function appendEntry(text, entry) {
  const body = (text || '').replace(/\s+$/, '');
  const [header] = parseCsv(body.split(/\r?\n/, 1)[0]);
  const ours = header && header.map((h) => h.trim().toLowerCase()).join(',') === COLUMNS.join(',');
  if (ours) return `${body}\n${entryLine(entry)}\n`;
  return serializeLog([...parseLog(body), entry]);
}

/**
 * @param {string} text
 * @param {string} id
 * @param {Partial<LogEntry>} changes
 */
function updateEntry(text, id, changes) {
  return serializeLog(parseLog(text).map((e) => (e.id === id ? { ...e, ...changes, id } : e)));
}

/**
 * @param {string} text
 * @param {string} id
 */
function removeEntry(text, id) {
  return serializeLog(parseLog(text).filter((e) => e.id !== id));
}

/**
 * @param {LogEntry[]} entries
 * @param {string} date
 */
function entriesFor(entries, date) {
  return entries
    .filter((e) => e.date === date)
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
}

// Sums of each macro; null when no entry has a value for it.
/**
 * @param {LogEntry[]} entries
 * @returns {import('./types').Nutrients}
 */
function totals(entries) {
  /** @type {import('./types').Nutrients} */
  const out = { kcal: null, protein: null, carbs: null, fat: null };
  for (const k of /** @type {const} */ (['kcal', 'protein', 'carbs', 'fat'])) {
    for (const e of entries) {
      const v = e[k];
      if (v !== null) out[k] = (out[k] ?? 0) + v;
    }
  }
  return out;
}

// Meals from the setting: "Breakfast, Lunch, Dinner, Snack" → ['Breakfast', ...]
/** @param {string | null | undefined} text */
function parseMeals(text) {
  const seen = new Set();
  return (text || '')
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m && !seen.has(m.toLowerCase()) && seen.add(m.toLowerCase()));
}

// A sensible pick for a food logged at this time ('HH:mm'), when the meal
// list has the usual names; '' otherwise.
/** @type {[string, number, number][]} */
const MEAL_HOURS = [
  ['breakfast', 4, 11],
  ['lunch', 11, 15],
  ['dinner', 17, 22],
  ['snack', 0, 24],
];

/**
 * @param {string[]} meals
 * @param {string} time
 */
function mealForTime(meals, time) {
  const hour = Number.parseInt(time, 10);
  for (const [name, from, to] of MEAL_HOURS) {
    const meal = meals.find((m) => m.toLowerCase() === name);
    if (meal && hour >= from && hour < to) return meal;
  }
  return '';
}

// Entries grouped for display: meals in the setting's order, then any other
// meals as they come, then foods with no meal. → [{ meal, entries }]
/**
 * @param {LogEntry[]} entries
 * @param {string[]} meals
 * @returns {MealGroup[]}
 */
function groupByMeal(entries, meals) {
  /** @type {Map<string, MealGroup>} */
  const groups = new Map();
  /** @param {string} m */
  const key = (m) => (m || '').toLowerCase();
  for (const m of meals) groups.set(key(m), { meal: m, entries: [] });
  for (const e of entries) {
    if (!e.meal) continue;
    let group = groups.get(key(e.meal));
    if (!group) {
      group = { meal: e.meal, entries: [] };
      groups.set(key(e.meal), group);
    }
    group.entries.push(e);
  }
  const out = [...groups.values()].filter((g) => g.entries.length);
  const none = entries.filter((e) => !e.meal);
  if (none.length) out.push({ meal: '', entries: none });
  return out;
}

function newId(now = Date.now(), rand = Math.random) {
  return `${now.toString(36)}${Math.floor(rand() * 36 ** 4)
    .toString(36)
    .padStart(4, '0')}`;
}

export {
  appendEntry,
  COLUMNS,
  DECIMALS,
  entriesFor,
  groupByMeal,
  mealForTime,
  newId,
  parseCsv,
  parseLog,
  parseMeals,
  removeEntry,
  serializeLog,
  totals,
  updateEntry,
};
