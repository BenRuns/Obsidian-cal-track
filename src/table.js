// ─── Markdown tables ──────────────────────────────────────────────────────────
//
// Reading and writing the pipe tables in My foods (see foodfile.js): splitting
// rows, escaping pipes, and finding a food table's columns by header name.

const COLUMN_ALIASES = {
  food: ['food', 'item', 'name'],
  kcal: ['kcal', 'calories', 'cal', 'cals', 'energy'],
  protein: ['protein', 'prot'],
  carbs: ['carbs', 'carb', 'carbohydrates', 'carbohydrate'],
  fat: ['fat', 'fats'],
  per: ['per', 'serving', 'per serving', 'basis'],
  portions: ['portions', 'measures'],
  ingredients: ['ingredients', 'contains'],
};

// ─── Rows ─────────────────────────────────────────────────────────────────────

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

// Returns every food table in the text: one whose header has a Food column
// and a calories column.
//   { start, end, cols: { food: 0, kcal: 2, ... }, width }
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
      tables.push({ start, end, cols, width: headers.length });
    }
    i = end + 1;
  }
  return tables;
}

// ─── Numbers ──────────────────────────────────────────────────────────────────

function formatNumber(v, decimals) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  const f = 10 ** decimals;
  return String(Math.round(v * f) / f);
}

export { escapeCell, findTables, formatNumber, joinRow, splitRow, unescapeCell };
