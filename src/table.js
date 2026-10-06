'use strict';

// ─── Markdown food-log tables ─────────────────────────────────────────────────
//
// A food log is an ordinary Table Calc table: a {{calc}} line, a header row, a
// separator, food rows, then summary rows (Total / Goal / Remaining) whose
// cells are Table Calc formulas like =SUM(D1:D3).
//
// Table Calc references are positional (row N of the table's data rows, header
// excluded) and never auto-shift. So whenever this plugin inserts or removes a
// row it rewrites every formula in the table the way a spreadsheet would —
// otherwise =SUM(D1:D3) would silently stop covering the new food.

const CALC_MARKER = '{{calc}}';
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SUMMARY_NAMES = new Set(['total', 'totals', 'goal', 'target', 'remaining', 'left']);

const COLUMN_ALIASES = {
  food: ['food', 'item', 'name'],
  qty: ['qty', 'quantity', 'amount', 'amt'],
  unit: ['unit', 'units'],
  kcal: ['kcal', 'calories', 'cal', 'cals', 'energy'],
  protein: ['protein', 'prot'],
  carbs: ['carbs', 'carb', 'carbohydrates', 'carbohydrate'],
  fat: ['fat', 'fats'],
  // My-foods file columns (see foodfile.js).
  per: ['per', 'serving', 'per serving', 'basis'],
  portions: ['portions', 'measures'],
};

const COLUMN_TITLES = {
  food: 'Food',
  qty: 'Qty',
  unit: 'Unit',
  kcal: 'kcal',
  protein: 'Protein',
  carbs: 'Carbs',
  fat: 'Fat',
};

// ─── Row parsing ──────────────────────────────────────────────────────────────

function isTableLine(line) {
  return line.trim().startsWith('|');
}

// Splits "| a | b \| c |" into ['a', 'b \| c'], keeping escapes intact.
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '\\|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += s[i];
    }
  }
  cells.push(cur.trim());
  return cells;
}

function joinRow(cells) {
  return `| ${cells.join(' | ')} |`;
}

function escapeCell(text) {
  return String(text ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|');
}

function unescapeCell(text) {
  return String(text ?? '').replace(/\\\|/g, '|');
}

function stripMd(s) {
  return String(s)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .trim();
}

function isSeparatorRow(line) {
  const cells = splitRow(line).filter(Boolean);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function columnKey(header) {
  const h = stripMd(header)
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .trim();
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (aliases.includes(h)) return key;
  }
  return null;
}

// ─── Finding tables ───────────────────────────────────────────────────────────

// Returns every food-log table in the note: one whose header has a Food
// column and a calories column.
//   { start, end, hasMarker, cols: { food: 0, qty: 1, ... }, width }
// start = header line, end = last table line (inclusive).
function findTables(lines) {
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    if (!isTableLine(lines[i]) || i + 1 >= lines.length || !isSeparatorRow(lines[i + 1])) {
      i++;
      continue;
    }
    const start = i;
    let end = i + 1;
    while (end + 1 < lines.length && isTableLine(lines[end + 1])) end++;

    const headers = splitRow(lines[start]);
    const cols = {};
    headers.forEach((h, idx) => {
      const key = columnKey(h);
      if (key && cols[key] === undefined) cols[key] = idx;
    });
    if (cols.food !== undefined && cols.kcal !== undefined) {
      let m = start - 1;
      while (m >= 0 && lines[m].trim() === '') m--;
      tables.push({
        start,
        end,
        hasMarker: m >= 0 && lines[m].trim() === CALC_MARKER,
        cols,
        width: headers.length,
      });
    }
    i = end + 1;
  }
  return tables;
}

function tableAt(lines, lineNo) {
  return findTables(lines).find((t) => lineNo >= t.start - 1 && lineNo <= t.end) || null;
}

// First data line of a table, and 1-based Table Calc row number of a line.
function firstDataLine(table) {
  return table.start + 2;
}

function rowNumber(table, lineIdx) {
  return lineIdx - firstDataLine(table) + 1;
}

function isSummaryRow(line, table) {
  const first = splitRow(line)[table.cols.food] ?? '';
  return SUMMARY_NAMES.has(stripMd(first).toLowerCase().replace(/:$/, ''));
}

// Food rows only: not header, separator or summary rows.
function foodRowLines(lines, table) {
  const out = [];
  for (let i = firstDataLine(table); i <= table.end; i++) {
    if (!isSummaryRow(lines[i], table)) out.push(i);
  }
  return out;
}

function readFoodRow(lines, table, lineIdx) {
  if (lineIdx < firstDataLine(table) || lineIdx > table.end) return null;
  if (isSummaryRow(lines[lineIdx], table)) return null;
  const cells = splitRow(lines[lineIdx]);
  const get = (k) => (table.cols[k] === undefined ? '' : (cells[table.cols[k]] ?? ''));
  return {
    name: unescapeCell(get('food')),
    qty: get('qty'),
    unit: get('unit'),
    kcal: get('kcal'),
  };
}

// ─── Reference shifting ───────────────────────────────────────────────────────

// Matches A1 or A1:B9 that isn't the tail of a function name (LOG10).
const REF_RE = /(?<![A-Z0-9_])([A-Z])(\d+)(?::([A-Z])(\d+))?(?![\d(])/gi;

function shiftFormula(formula, mapRange) {
  return formula.replace(REF_RE, (_whole, c1, r1, c2, r2) => {
    if (c2 === undefined) {
      const [n] = mapRange(Number(r1), null);
      return `${c1}${n}`;
    }
    const [a, b] = mapRange(Number(r1), Number(r2));
    return `${c1}${a}:${c2}${b}`;
  });
}

// A row is inserted so it becomes row p. Refs at/after p move down; a range
// ending just above p grows to include it (that's how =SUM(D1:D3) picks up a
// food appended as row 4). An empty table's =SUM(D0:D0) grows to D1:D1.
function insertShift(formula, p) {
  return shiftFormula(formula, (r1, r2) => {
    if (r2 === null) return [r1 >= p ? r1 + 1 : r1];
    let a = r1 >= p ? r1 + 1 : r1;
    let b = r2 >= p ? r2 + 1 : r2;
    if (r2 === p - 1 && r1 <= r2) {
      b = p;
      if (a < 1) a = 1;
    }
    return [a, b];
  });
}

// Row p is removed. Refs after p move up; ranges shrink. A range that loses
// its only row becomes X0:X0 (sums to 0) rather than pointing at a summary row.
function deleteShift(formula, p) {
  return shiftFormula(formula, (r1, r2) => {
    if (r2 === null) return [r1 > p ? r1 - 1 : r1];
    const a = r1 > p ? r1 - 1 : r1;
    const b = r2 >= p ? r2 - 1 : r2;
    return b < a ? [0, 0] : [a, b];
  });
}

function shiftTableFormulas(rows, shiftFn) {
  return rows.map((line) => {
    if (!line.includes('=')) return line;
    const cells = splitRow(line);
    let changed = false;
    const next = cells.map((c) => {
      if (!c.startsWith('=')) return c;
      const s = shiftFn(c);
      if (s !== c) changed = true;
      return s;
    });
    return changed ? joinRow(next) : line;
  });
}

// ─── Editing ──────────────────────────────────────────────────────────────────

function formatNumber(v, decimals) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  const f = 10 ** decimals;
  return String(Math.round(v * f) / f);
}

// Builds the cells for a food row in this table's column layout.
// values: { food, qty, unit, kcal, protein, carbs, fat } (numbers unformatted)
function buildRowCells(table, values, existing) {
  const cells = existing ? splitRow(existing) : [];
  while (cells.length < table.width) cells.push('');
  const set = (k, text) => {
    if (table.cols[k] !== undefined) cells[table.cols[k]] = text;
  };
  set('food', escapeCell(values.food));
  set('qty', formatNumber(values.qty, 2));
  set('unit', escapeCell(values.unit));
  set('kcal', formatNumber(values.kcal, 0));
  set('protein', formatNumber(values.protein, 1));
  set('carbs', formatNumber(values.carbs, 1));
  set('fat', formatNumber(values.fat, 1));
  return cells.slice(0, Math.max(table.width, cells.length));
}

// Each edit returns { from, to, lines }: replace source lines from..to
// (inclusive) with `lines`. Keeping edits to the table block lets the plugin
// apply them as one editor change (one undo step, cursor elsewhere untouched).

function insertFoodRow(lines, table, values) {
  const block = lines.slice(table.start, table.end + 1);
  const dataStart = 2;
  // Insert above the first summary row, or at the bottom if there is none.
  let at = block.length;
  for (let i = dataStart; i < block.length; i++) {
    if (isSummaryRow(block[i], table)) {
      at = i;
      break;
    }
  }
  const p = at - dataStart + 1;
  const shifted = shiftTableFormulas(block, (f) => insertShift(f, p));
  shifted.splice(at, 0, joinRow(buildRowCells(table, values)));
  return { from: table.start, to: table.end, lines: shifted, insertedLine: table.start + at };
}

function updateFoodRow(lines, table, lineIdx, values) {
  const cells = buildRowCells(table, values, lines[lineIdx]);
  return { from: lineIdx, to: lineIdx, lines: [joinRow(cells)] };
}

function deleteFoodRow(lines, table, lineIdx) {
  const block = lines.slice(table.start, table.end + 1);
  const at = lineIdx - table.start;
  const p = rowNumber(table, lineIdx);
  block.splice(at, 1);
  return {
    from: table.start,
    to: table.end,
    lines: shiftTableFormulas(block, (f) => deleteShift(f, p)),
  };
}

// A new, empty food log. Summary formulas start as X0:X0 (sum of nothing)
// and grow as foods are added.
function buildTable({ macros = true, goal = 0 } = {}) {
  const keys = ['food', 'qty', 'unit', 'kcal'];
  if (macros) keys.push('protein', 'carbs', 'fat');
  const header = joinRow(keys.map((k) => COLUMN_TITLES[k]));
  const sep = joinRow(keys.map((k) => (k === 'food' || k === 'unit' ? '---' : '---:')));
  const sumCols = keys.map((k, i) => (['food', 'qty', 'unit'].includes(k) ? null : LETTERS[i]));
  const kcalLetter = LETTERS[keys.indexOf('kcal')];

  const rows = [];
  rows.push(
    joinRow(
      keys.map((k, i) =>
        k === 'food' ? '**Total**' : sumCols[i] ? `=SUM(${sumCols[i]}0:${sumCols[i]}0)` : '',
      ),
    ),
  );
  if (goal > 0) {
    rows.push(
      joinRow(keys.map((k) => (k === 'food' ? '**Goal**' : k === 'kcal' ? String(goal) : ''))),
    );
    rows.push(
      joinRow(
        keys.map((k) =>
          k === 'food' ? '**Remaining**' : k === 'kcal' ? `=${kcalLetter}2-${kcalLetter}1` : '',
        ),
      ),
    );
  }
  return [CALC_MARKER, header, sep, ...rows];
}

module.exports = {
  CALC_MARKER,
  splitRow,
  joinRow,
  escapeCell,
  unescapeCell,
  findTables,
  tableAt,
  foodRowLines,
  readFoodRow,
  isSummaryRow,
  insertShift,
  deleteShift,
  formatNumber,
  insertFoodRow,
  updateFoodRow,
  deleteFoodRow,
  buildTable,
};
