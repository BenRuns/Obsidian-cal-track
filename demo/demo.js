'use strict';

// Browser demo of Cal Track: the plugin's own units / food / table modules and
// Table Calc's formula engine, with a markdown "note" standing in for Obsidian.

const { toGrams, unitsFor, normalizeUnit } = require('../src/units');
const { displayName, nutrientsFor, makeCustomFood } = require('../src/food');
const T = require('../src/table');
const { evalFormula, formatResult } = require('./vendor/table-calc-engine');

// Approximate USDA SR Legacy values, per 100 g.
const S = (name, kcal, protein, carbs, fat, portions) => ({
  id: `sample:${name.toLowerCase()}`,
  source: 'sample',
  name,
  brand: '',
  per100g: { kcal, protein, carbs, fat },
  portions: portions.map(([unit, grams, amount = 1]) => ({ unit, amount, grams })),
});
const SAMPLE = [
  S('Bananas, raw', 89, 1.09, 22.8, 0.33, [['medium', 118], ['cup', 150]]),
  S('Apples, raw, with skin', 52, 0.26, 13.8, 0.17, [['medium', 182], ['cup', 110]]),
  S('Egg, whole, cooked', 155, 12.6, 1.12, 10.6, [['large', 50]]),
  S('Oats, rolled, dry', 379, 13.2, 67.7, 6.52, [['cup', 81]]),
  S('Milk, 2% fat', 50, 3.36, 4.8, 1.9, [['cup', 244]]),
  S('Greek yogurt, plain, nonfat', 59, 10.2, 3.6, 0.39, [['container', 170], ['cup', 245]]),
  S('Chicken breast, roasted', 165, 31, 0, 3.57, [['half breast', 86]]),
  S('Salmon, Atlantic, cooked', 206, 22.1, 0, 12.4, [['fillet', 154]]),
  S('Rice, white, cooked', 130, 2.69, 28.2, 0.28, [['cup', 158]]),
  S('Pasta, cooked', 158, 5.8, 30.9, 0.93, [['cup', 140]]),
  S('Bread, whole wheat', 254, 12.3, 43.1, 3.55, [['slice', 32]]),
  S('Peanut butter, smooth', 588, 25.1, 20, 50.4, [['tbsp', 16]]),
  S('Olive oil', 884, 0, 0, 100, [['tbsp', 13.5]]),
  S('Avocado, raw', 160, 2, 8.53, 14.7, [['fruit', 201], ['cup', 146]]),
  S('Broccoli, raw', 34, 2.82, 6.64, 0.37, [['cup', 91]]),
  S('Cheddar cheese', 403, 22.9, 3.37, 33.3, [['slice', 28], ['cup', 113]]),
  S('Almonds', 579, 21.2, 21.6, 49.9, [['almond', 1.2], ['cup', 143]]),
  S('Coffee, brewed', 1, 0.12, 0, 0.02, [['cup', 237]]),
];

// ─── State ───────────────────────────────────────────────────────────────────

const KEY = 'cal-track-demo-v1';

function rowValues(food, qty, unit) {
  const grams = toGrams(food, qty, unit);
  return { food: displayName(food), qty, unit, ...nutrientsFor(food, grams) };
}

function exampleNote() {
  let table = T.buildTable({ macros: true, goal: 2000 });
  const add = (name, qty, unit) => {
    const food = SAMPLE.find((f) => f.name === name);
    const t = T.findTables(table)[0];
    const e = T.insertFoodRow(table, t, rowValues(food, qty, unit));
    table = [...table.slice(0, e.from), ...e.lines, ...table.slice(e.to + 1)];
  };
  add('Oats, rolled, dry', 0.5, 'cup');
  add('Milk, 2% fat', 1, 'cup');
  add('Bananas, raw', 1, 'medium');
  add('Coffee, brewed', 2, 'cup');
  return ['# Tuesday, October 6', '', 'Easy 5k before breakfast.', '', '## Food', '', ...table, ''].join('\n');
}

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && typeof s.note === 'string') return s;
  } catch (_) {}
  return null;
}

let state = load() || { note: exampleNote(), custom: {}, recent: [], example: true };

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (_) {}
}

function setNote(note) {
  state.note = note;
  state.example = false;
  save();
  render();
}

function allFoods() {
  return [...Object.values(state.custom), ...SAMPLE];
}

function findFood(name) {
  const key = name.toLowerCase();
  return allFoods().find((f) => displayName(f).toLowerCase() === key);
}

function remember(food) {
  const key = displayName(food).toLowerCase();
  if (food.source === 'custom') state.custom[key] = food;
  state.recent = [key, ...state.recent.filter((k) => k !== key)].slice(0, 8);
  save();
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : T.formatNumber(v, d));
const grouped = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '–');

// Renders **bold** and escaped pipes in a cell, safely.
function cellContent(raw) {
  const text = T.unescapeCell(raw);
  const m = text.match(/^\*\*(.+)\*\*$/);
  return m ? h('strong', { text: m[1] }) : document.createTextNode(text);
}

// ─── Note preview ────────────────────────────────────────────────────────────

function evaluateTable(lines, t) {
  const dataLines = [];
  for (let i = t.start + 2; i <= t.end; i++) dataLines.push(i);
  const grid = dataLines.map((i) => T.splitRow(lines[i]));
  const values = grid.map((row) =>
    row.map((c) => (c.startsWith('=') ? { formula: c, result: evalFormula(c, grid) } : null)),
  );
  return { dataLines, grid, values };
}

function renderTable(lines, t) {
  const headers = T.splitRow(lines[t.start]);
  const { dataLines, grid, values } = evaluateTable(lines, t);
  const letters = h('tr', { class: 'refs' }, h('th', {}), headers.map((_, i) => h('th', { text: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i] })));
  const head = h('tr', {}, h('th', { class: 'rownum' }), headers.map((x) => h('th', {}, cellContent(x))));
  const body = dataLines.map((lineIdx, r) => {
    const summary = T.isSummaryRow(lines[lineIdx], t);
    const tr = h(
      'tr',
      {
        class: summary ? 'summary' : 'food',
        tabindex: summary ? null : '0',
        title: summary ? null : 'Adjust this food',
        onclick: summary ? null : () => openAdjust(lineIdx),
        onkeydown: summary
          ? null
          : (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openAdjust(lineIdx);
              }
            },
      },
      h('td', { class: 'rownum', text: String(r + 1) }),
      headers.map((_, c) => {
        const raw = grid[r][c] ?? '';
        const v = values[r][c];
        if (!v) return h('td', { class: /^[\d.,-]+$/.test(raw) ? 'num' : null }, cellContent(raw));
        const err = typeof v.result === 'string' && v.result.startsWith('#');
        return h('td', { class: err ? 'num err' : 'num calc', title: v.formula }, formatResult(v.result));
      }),
    );
    return tr;
  });
  return h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, letters, head), h('tbody', {}, body)));
}

function renderPreview() {
  const lines = state.note.split('\n');
  const tables = T.findTables(lines);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const t = tables.find((x) => x.start === i);
    if (t) {
      out.push(renderTable(lines, t));
      i = t.end + 1;
      continue;
    }
    const line = lines[i].trim();
    if (line === T.CALC_MARKER || line === '') {
      // hidden, like Table Calc does
    } else if (line.startsWith('## ')) out.push(h('h3', { text: line.slice(3) }));
    else if (line.startsWith('# ')) out.push(h('h2', { text: line.slice(2) }));
    else out.push(h('p', { text: line }));
    i++;
  }
  $('preview').replaceChildren(...out);
}

function renderSummary() {
  const lines = state.note.split('\n');
  const t = T.findTables(lines)[0];
  const el = $('summary');
  if (!t) {
    el.replaceChildren(h('p', { class: 'muted', text: 'No food log in this note yet. Add a food to start one.' }));
    return;
  }
  const { dataLines, grid, values } = evaluateTable(lines, t);
  const rowOf = (name) => dataLines.findIndex((li) => T.splitRow(lines[li])[t.cols.food]?.replace(/\*/g, '').toLowerCase() === name);
  const num = (r, key) => {
    if (r < 0 || t.cols[key] === undefined) return null;
    const v = values[r][t.cols[key]];
    const n = v ? v.result : parseFloat(grid[r][t.cols[key]]);
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  };
  const total = rowOf('total');
  const kcal = num(total, 'kcal') ?? 0;
  const goal = num(rowOf('goal'), 'kcal');
  const pct = goal ? Math.min(kcal / goal, 1) : 0;
  const over = goal && kcal > goal;
  const macro = (label, key) =>
    t.cols[key] === undefined ? null : h('div', { class: 'macro' }, h('span', { class: 'label', text: label }), h('span', { class: 'val', text: `${fmt(num(total, key), 1)} g` }));
  el.replaceChildren(
    h(
      'div',
      { class: 'kcal' },
      h('span', { class: 'big', text: grouped(kcal) }),
      h('span', { class: 'unit', text: goal ? ` / ${grouped(goal)} kcal` : ' kcal' }),
    ),
    goal
      ? h(
          'div',
          { class: `bar${over ? ' over' : ''}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(goal), 'aria-valuenow': String(Math.round(kcal)) },
          h('div', { class: 'fill', style: `width:${(pct * 100).toFixed(1)}%` }),
        )
      : null,
    goal ? h('p', { class: 'left', text: over ? `${grouped(kcal - goal)} kcal over goal` : `${grouped(goal - kcal)} kcal left` }) : null,
    h('div', { class: 'macros' }, macro('Protein', 'protein'), macro('Carbs', 'carbs'), macro('Fat', 'fat')),
  );
}

function render() {
  renderPreview();
  renderSummary();
  const src = $('source');
  if (document.activeElement !== src) src.value = state.note;
  $('example-flag').hidden = !state.example;
}

// ─── Sheet (search / portion / custom) ───────────────────────────────────────

const sheet = () => $('sheet');

function openSheet(title, ...content) {
  $('sheet-title').textContent = title;
  $('sheet-body').replaceChildren(...content);
  sheet().hidden = false;
  document.body.classList.add('locked');
  const first = $('sheet-body').querySelector('input, select, button');
  if (first) setTimeout(() => first.focus(), 0);
}

function closeSheet() {
  sheet().hidden = true;
  document.body.classList.remove('locked');
}

function foodItem(food, onPick) {
  const badge = food.source === 'custom' ? 'Mine' : 'Sample';
  const per = food.noMass ? `${fmt(food.per100g.kcal)} kcal / serving` : `${fmt(food.per100g.kcal)} kcal / 100 g`;
  return h(
    'button',
    { class: 'item', type: 'button', onclick: () => onPick(food) },
    h('span', { class: 'item-name', text: displayName(food) }),
    h('span', { class: 'item-meta' }, h('span', { text: per }), h('span', { class: 'badge', text: badge })),
  );
}

function openSearch({ query = '', onPick }) {
  const list = h('div', { class: 'results' });
  const input = h('input', { id: 'food-search', type: 'search', placeholder: 'Search: banana, oats, salmon…', value: query, autocomplete: 'off' });
  const pick = (food) => {
    remember(food);
    onPick(food);
  };
  const update = () => {
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const match = (f) => words.every((w) => displayName(f).toLowerCase().includes(w));
    const recent = words.length ? [] : state.recent.map(findFood).filter(Boolean);
    const rest = allFoods().filter((f) => match(f) && !recent.includes(f));
    const kids = [];
    if (recent.length) kids.push(h('div', { class: 'section', text: 'Recent' }), recent.map((f) => foodItem(f, pick)));
    if (rest.length) kids.push(h('div', { class: 'section', text: words.length ? 'Matches' : 'All foods' }), rest.map((f) => foodItem(f, pick)));
    if (!recent.length && !rest.length)
      kids.push(h('p', { class: 'muted pad', text: `No sample food matches “${input.value.trim()}”. Add it as a custom food.` }));
    list.replaceChildren(...kids.flat());
  };
  input.addEventListener('input', update);
  update();
  openSheet(
    'Look up food',
    h(
      'div',
      { class: 'search-row' },
      input,
      h('button', { type: 'button', class: 'ghost', onclick: () => openCustom({ name: input.value, onSave: pick }), text: '+ Custom' }),
    ),
    h('p', { class: 'hint', text: 'In Obsidian this searches USDA FoodData Central and Open Food Facts. This demo searches a built-in sample list.' }),
    list,
  );
}

function openPortion(food, { qty, unit, submitText = 'Add to log', onSubmit, onRemove, onChange }) {
  const units = unitsFor(food);
  const startUnit = units.includes(normalizeUnit(unit)) ? normalizeUnit(unit) : units[0];
  const startQty = qty ?? (startUnit === 'g' ? 100 : 1);
  const qtyIn = h('input', { id: 'portion-qty', type: 'number', min: '0', step: 'any', inputmode: 'decimal', value: String(startQty) });
  const unitIn = h('select', { id: 'portion-unit' }, units.map((u) => h('option', { value: u, text: u })));
  unitIn.value = startUnit;
  const kcal = h('span', { class: 'big' });
  const grams = h('span', { class: 'grams' });
  const macros = h('div', { class: 'macros' });
  const submit = h('button', { type: 'button', class: 'primary', text: submitText });
  const compute = () => {
    const q = Number(qtyIn.value);
    const g = toGrams(food, q, unitIn.value);
    return { q, g, n: nutrientsFor(food, g), ok: g !== null && q > 0 };
  };
  const update = () => {
    const { g, n, ok } = compute();
    kcal.textContent = ok ? `${fmt(n.kcal)} kcal` : 'Enter a quantity';
    grams.textContent = ok && !food.noMass ? `≈ ${fmt(g)} g` : '';
    macros.replaceChildren(
      ...[
        ['Protein', n.protein],
        ['Carbs', n.carbs],
        ['Fat', n.fat],
      ].map(([l, v]) => h('div', { class: 'macro' }, h('span', { class: 'label', text: l }), h('span', { class: 'val', text: ok ? `${fmt(v, 1)} g` : '–' }))),
    );
    submit.disabled = !ok;
  };
  const go = () => {
    const { q, ok } = compute();
    if (!ok) return;
    closeSheet();
    onSubmit(food, q, unitIn.value);
  };
  qtyIn.addEventListener('input', update);
  qtyIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
  });
  unitIn.addEventListener('change', update);
  submit.addEventListener('click', go);
  update();
  openSheet(
    displayName(food),
    h('div', { class: 'portion-row' }, h('label', { class: 'sr', for: 'portion-qty', text: 'Quantity' }), qtyIn, h('label', { class: 'sr', for: 'portion-unit', text: 'Unit' }), unitIn),
    h('div', { class: 'preview' }, h('div', { class: 'kcal' }, kcal, grams), macros),
    h('p', { class: 'hint', text: `Units: ${units.join(', ')}` }),
    h(
      'div',
      { class: 'actions' },
      onRemove ? h('button', { type: 'button', class: 'danger', text: 'Remove', onclick: () => (closeSheet(), onRemove()) }) : null,
      onChange ? h('button', { type: 'button', class: 'ghost', text: 'Different food…', onclick: onChange }) : null,
      h('span', { class: 'spacer' }),
      submit,
    ),
  );
  setTimeout(() => qtyIn.select(), 0);
}

function openCustom({ name = '', onSave }) {
  const field = (id, label, attrs = {}) =>
    h('label', { class: 'field', for: id }, h('span', { text: label }), h('input', { id, ...attrs }));
  const numAttrs = { type: 'number', step: 'any', min: '0', inputmode: 'decimal' };
  const err = h('p', { class: 'error', hidden: true });
  const form = h(
    'form',
    { class: 'custom', novalidate: true },
    h('p', { class: 'hint', text: 'Copy the numbers from a nutrition label.' }),
    field('c-name', 'Name', { value: name, placeholder: 'Protein bar' }),
    h('div', { class: 'grid2' }, field('c-amt', 'Serving amount', { ...numAttrs, value: '1' }), field('c-unit', 'Serving unit', { value: 'serving', placeholder: 'bar, g, cup' })),
    field('c-grams', 'Serving weight in grams (optional)', numAttrs),
    h('div', { class: 'grid2' }, field('c-kcal', 'Calories', numAttrs), field('c-p', 'Protein (g)', numAttrs), field('c-c', 'Carbs (g)', numAttrs), field('c-f', 'Fat (g)', numAttrs)),
    err,
    h('div', { class: 'actions' }, h('span', { class: 'spacer' }), h('button', { type: 'submit', class: 'primary', text: 'Save food' })),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = (id) => $(id).value;
    if (!v('c-name').trim() || v('c-kcal') === '') {
      err.textContent = 'Add a name and calories to save this food.';
      err.hidden = false;
      return;
    }
    onSave(
      makeCustomFood({
        name: v('c-name'),
        servingAmount: v('c-amt'),
        servingUnit: v('c-unit'),
        servingGrams: v('c-grams'),
        kcal: v('c-kcal'),
        protein: v('c-p'),
        carbs: v('c-c'),
        fat: v('c-f'),
      }),
    );
  });
  openSheet('Custom food', form);
}

// ─── Actions (mirror the plugin's commands) ──────────────────────────────────

function applyEdit(lines, e) {
  setNote([...lines.slice(0, e.from), ...e.lines, ...lines.slice(e.to + 1)].join('\n'));
}

function addFood() {
  openSearch({
    onPick: (food) =>
      openPortion(food, {
        onSubmit: (f, qty, unit) => {
          const lines = state.note.split('\n');
          const t = T.findTables(lines)[0];
          const values = rowValues(f, qty, unit);
          if (t) {
            applyEdit(lines, T.insertFoodRow(lines, t, values));
          } else {
            const block = T.buildTable({ macros: true, goal: 2000 });
            const e = T.insertFoodRow(block, T.findTables(block)[0], values);
            const body = state.note.replace(/\s*$/, '');
            setNote(`${body}\n\n${[...block.slice(0, e.from), ...e.lines].join('\n')}\n`);
          }
        },
      }),
  });
}

function openAdjust(lineIdx) {
  const lines = state.note.split('\n');
  const t = T.tableAt(lines, lineIdx);
  const row = t && T.readFoodRow(lines, t, lineIdx);
  if (!row) return;
  const replace = (f, qty, unit) => {
    const now = state.note.split('\n');
    const tt = T.tableAt(now, lineIdx);
    if (tt && T.readFoodRow(now, tt, lineIdx)) applyEdit(now, T.updateFoodRow(now, tt, lineIdx, rowValues(f, qty, unit)));
  };
  const remove = () => {
    const now = state.note.split('\n');
    const tt = T.tableAt(now, lineIdx);
    if (tt) applyEdit(now, T.deleteFoodRow(now, tt, lineIdx));
  };
  const search = () =>
    openSearch({
      query: row.name,
      onPick: (f) => openPortion(f, { qty: Number(row.qty) || undefined, unit: row.unit, submitText: 'Update', onSubmit: replace, onRemove: remove }),
    });
  const food = findFood(row.name);
  if (!food) return search();
  openPortion(food, { qty: Number(row.qty) || undefined, unit: row.unit, submitText: 'Update', onSubmit: replace, onRemove: remove, onChange: search });
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

function setView(view) {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.view === view));
  $('preview').hidden = view !== 'preview';
  $('source-wrap').hidden = view !== 'source';
}

function boot() {
  $('add').addEventListener('click', addFood);
  $('reset').addEventListener('click', () => {
    state = { note: exampleNote(), custom: {}, recent: [], example: true };
    save();
    render();
  });
  $('source').addEventListener('input', (e) => setNote(e.target.value));
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => setView(b.dataset.view));
  $('sheet-close').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', (e) => {
    if (e.target.id === 'sheet') closeSheet();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sheet().hidden) closeSheet();
  });
  setView('preview');
  render();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
