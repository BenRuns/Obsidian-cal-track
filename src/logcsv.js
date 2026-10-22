'use strict';

// The food log: one CSV file, one row per food eaten. Daily notes don't hold
// any food data — they show the rows for their date (see the cal-track block
// in main.js). Columns are found by header name, so a hand-edited file with
// reordered or extra columns still reads.

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
const NUMERIC = new Set(['qty', 'kcal', 'protein', 'carbs', 'fat']);
const DECIMALS = { qty: 2, kcal: 0, protein: 1, carbs: 1, fat: 1 };

// RFC 4180: fields with commas, quotes or newlines are quoted, quotes doubled.
function parseCsv(text) {
  const rows = [];
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

function csvField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function round(v, decimals) {
  if (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) return null;
  const f = 10 ** decimals;
  return Math.round(Number(v) * f) / f;
}

// → [{ id, date, time, food, qty, unit, kcal, protein, carbs, fat }]
// Numbers are numbers (or null when blank).
function parseLog(text) {
  const [header, ...rows] = parseCsv(text || '');
  if (!header) return [];
  const idx = {};
  header.forEach((h, i) => {
    const key = h.trim().toLowerCase();
    if (COLUMNS.includes(key) && idx[key] === undefined) idx[key] = i;
  });
  return rows.map((cells, n) => {
    const entry = {};
    for (const k of COLUMNS) {
      const raw = idx[k] === undefined ? '' : (cells[idx[k]] ?? '').trim();
      entry[k] = NUMERIC.has(k) ? round(raw, 6) : raw;
    }
    // Rows added by hand may have no id. Their position stands in for one —
    // stable until the file changes, and saved as their id on the next write.
    if (!entry.id) entry.id = `row${n + 1}`;
    return entry;
  });
}

function entryLine(entry) {
  return COLUMNS.map((k) =>
    csvField(NUMERIC.has(k) ? round(entry[k], DECIMALS[k]) : entry[k]),
  ).join(',');
}

function serializeLog(entries) {
  return `${[COLUMNS.join(','), ...entries.map(entryLine)].join('\n')}\n`;
}

// Appends one line when the file has our columns, leaving the rest of the file
// untouched. A hand-made file with other columns or order is rewritten in ours.
function appendEntry(text, entry) {
  const body = (text || '').replace(/\s+$/, '');
  const [header] = parseCsv(body.split(/\r?\n/, 1)[0]);
  const ours = header && header.map((h) => h.trim().toLowerCase()).join(',') === COLUMNS.join(',');
  if (ours) return `${body}\n${entryLine(entry)}\n`;
  return serializeLog([...parseLog(body), entry]);
}

function updateEntry(text, id, changes) {
  return serializeLog(parseLog(text).map((e) => (e.id === id ? { ...e, ...changes, id } : e)));
}

function removeEntry(text, id) {
  return serializeLog(parseLog(text).filter((e) => e.id !== id));
}

function entriesFor(entries, date) {
  return entries
    .filter((e) => e.date === date)
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
}

// Sums of each macro; null when no entry has a value for it.
function totals(entries) {
  const out = {};
  for (const k of ['kcal', 'protein', 'carbs', 'fat']) {
    const vals = entries.map((e) => e[k]).filter((v) => v !== null);
    out[k] = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  }
  return out;
}

// Meals from the setting: "Breakfast, Lunch, Dinner, Snack" → ['Breakfast', ...]
function parseMeals(text) {
  const seen = new Set();
  return (text || '')
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m && !seen.has(m.toLowerCase()) && seen.add(m.toLowerCase()));
}

// A sensible pick for a food logged at this time ('HH:mm'), when the meal
// list has the usual names; '' otherwise.
const MEAL_HOURS = [
  ['breakfast', 4, 11],
  ['lunch', 11, 15],
  ['dinner', 17, 22],
  ['snack', 0, 24],
];

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
function groupByMeal(entries, meals) {
  const groups = new Map();
  const key = (m) => (m || '').toLowerCase();
  for (const m of meals) groups.set(key(m), { meal: m, entries: [] });
  for (const e of entries) {
    if (!e.meal) continue;
    if (!groups.has(key(e.meal))) groups.set(key(e.meal), { meal: e.meal, entries: [] });
    groups.get(key(e.meal)).entries.push(e);
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

module.exports = {
  COLUMNS,
  DECIMALS,
  parseCsv,
  parseLog,
  serializeLog,
  appendEntry,
  updateEntry,
  removeEntry,
  entriesFor,
  totals,
  parseMeals,
  mealForTime,
  groupByMeal,
  newId,
};
