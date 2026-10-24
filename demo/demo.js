// Browser demo of Cal Track: the plugin's own units / food / CSV log modules,
// with a daily note and its log.csv standing in for Obsidian. The note shows
// its day's foods the way the plugin's cal-track block does.

import { toGrams, unitsFor, normalizeUnit } from '../src/units.js';
import { displayName, nutrientsFor, makeCustomFood } from '../src/food.js';
import { formatNumber } from '../src/table.js';
import * as L from '../src/logcsv.js';

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

const KEY = 'cal-track-demo-v2';
const DAY = '2026-10-06';
const MEALS = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
const GOAL = 2000;

function entry(food, qty, unit, meal, time) {
  const grams = toGrams(food, qty, unit);
  return { id: L.newId(), date: DAY, time, meal, food: displayName(food), qty, unit, ...nutrientsFor(food, grams) };
}

function exampleLog() {
  const add = (name, qty, unit, meal, time) => entry(SAMPLE.find((f) => f.name === name), qty, unit, meal, time);
  return L.serializeLog([
    add('Oats, rolled, dry', 0.5, 'cup', 'Breakfast', '07:40'),
    add('Milk, 2% fat', 1, 'cup', 'Breakfast', '07:40'),
    add('Bananas, raw', 1, 'medium', 'Breakfast', '07:45'),
    add('Coffee, brewed', 2, 'cup', 'Breakfast', '08:00'),
    add('Chicken breast, roasted', 1, 'half breast', 'Lunch', '12:30'),
    add('Rice, white, cooked', 1, 'cup', 'Lunch', '12:30'),
  ]);
}

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && typeof s.csv === 'string') return s;
  } catch (_) {}
  return null;
}

let state = load() || { csv: exampleLog(), custom: {}, recent: [], example: true };

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (_) {}
}

function setLog(csv) {
  state.csv = csv;
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
const fmt = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : formatNumber(v, d));
const grouped = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '–');


// ─── Daily note ──────────────────────────────────────────────────────────────

const NOTE = ['# Tuesday, October 6', '', 'Easy 5k before breakfast.', '', '```cal-track', '```'];
const KEYS = ['kcal', 'protein', 'carbs', 'fat'];
const DECIMALS = { kcal: 0, protein: 1, carbs: 1, fat: 1 };

function dayEntries() {
  return L.entriesFor(L.parseLog(state.csv), DAY);
}

function numCells(values) {
  return KEYS.map((k) => h('td', { class: 'num', text: values[k] === null || values[k] === undefined ? '' : fmt(values[k], DECIMALS[k]) }));
}

// The cal-track block: foods grouped by meal with subtotals, then the day's totals.
function renderLog() {
  const entries = dayEntries();
  const rows = [];
  const groups = entries.some((e) => e.meal) ? L.groupByMeal(entries, MEALS) : [{ meal: null, entries }];
  for (const g of groups) {
    if (g.meal !== null) {
      rows.push(h('tr', { class: 'meal' }, h('th', { colspan: '2', text: g.meal || 'No meal' }), numCells(L.totals(g.entries))));
    }
    for (const e of g.entries) {
      const open = () => openAdjust(e.id);
      rows.push(
        h(
          'tr',
          {
            class: 'food',
            tabindex: '0',
            title: 'Adjust this food',
            onclick: open,
            onkeydown: (ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                open();
              }
            },
          },
          h('td', { text: e.food }),
          h('td', { text: `${fmt(e.qty, 2)} ${e.unit}`.trim() }),
          numCells(e),
        ),
      );
    }
  }
  if (!entries.length) rows.push(h('tr', {}, h('td', { colspan: '6', class: 'muted', text: 'Nothing logged yet.' })));
  const sum = L.totals(entries);
  const foot = [
    h('tr', { class: 'summary' }, h('th', { colspan: '2', text: 'Total' }), numCells({ ...sum, kcal: sum.kcal ?? 0 })),
    h('tr', { class: 'summary' }, h('th', { colspan: '2', text: 'Goal' }), numCells({ kcal: GOAL })),
    h('tr', { class: 'summary' }, h('th', { colspan: '2', text: 'Remaining' }), numCells({ kcal: GOAL - (sum.kcal ?? 0) })),
  ];
  const head = h('tr', {}, ['Food', 'Qty', 'kcal', 'Protein', 'Carbs', 'Fat'].map((x, i) => h('th', { class: i > 1 ? 'num' : null, text: x })));
  return h(
    'div',
    { class: 'log' },
    h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, head), h('tbody', {}, rows), h('tfoot', {}, foot))),
    h('button', { type: 'button', class: 'ghost', text: '+ Add food', onclick: () => addFood() }),
  );
}

function renderPreview() {
  const out = [];
  for (const line of NOTE) {
    if (line.startsWith('```cal-track')) out.push(renderLog());
    else if (line.startsWith('```') || !line.trim()) continue;
    else if (line.startsWith('# ')) out.push(h('h2', { text: line.slice(2) }));
    else out.push(h('p', { text: line }));
  }
  $('preview').replaceChildren(...out);
}

function renderSummary() {
  const sum = L.totals(dayEntries());
  const kcal = sum.kcal ?? 0;
  const pct = Math.min(kcal / GOAL, 1);
  const over = kcal > GOAL;
  const macro = (label, key) =>
    h('div', { class: 'macro' }, h('span', { class: 'label', text: label }), h('span', { class: 'val', text: `${fmt(sum[key] ?? 0, 1)} g` }));
  $('summary').replaceChildren(
    h('div', { class: 'kcal' }, h('span', { class: 'big', text: grouped(kcal) }), h('span', { class: 'unit', text: ` / ${grouped(GOAL)} kcal` })),
    h(
      'div',
      { class: `bar${over ? ' over' : ''}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(GOAL), 'aria-valuenow': String(Math.round(kcal)) },
      h('div', { class: 'fill', style: `width:${(pct * 100).toFixed(1)}%` }),
    ),
    h('p', { class: 'left', text: over ? `${grouped(kcal - GOAL)} kcal over goal` : `${grouped(GOAL - kcal)} kcal left` }),
    h('div', { class: 'macros' }, macro('Protein', 'protein'), macro('Carbs', 'carbs'), macro('Fat', 'fat')),
  );
}

function render() {
  renderPreview();
  renderSummary();
  $('note-source').textContent = NOTE.join('\n');
  const csv = $('csv');
  if (document.activeElement !== csv) csv.value = state.csv;
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
    h('p', { class: 'hint', text: 'In Obsidian, Enter searches USDA FoodData Central and Open Food Facts. This demo searches a built-in sample list as you type.' }),
    list,
  );
}

function openPortion(food, { qty, unit, meal = '', submitText = 'Add', onSubmit, onRemove, onChange }) {
  const units = unitsFor(food);
  const startUnit = units.includes(normalizeUnit(unit)) ? normalizeUnit(unit) : units[0];
  const startQty = qty ?? (startUnit === 'g' ? 100 : 1);
  const qtyIn = h('input', { id: 'portion-qty', type: 'number', min: '0', step: 'any', inputmode: 'decimal', value: String(startQty) });
  const unitIn = h('select', { id: 'portion-unit' }, units.map((u) => h('option', { value: u, text: u })));
  unitIn.value = startUnit;
  const mealIn = h(
    'select',
    { id: 'portion-meal' },
    h('option', { value: '', text: 'No meal' }),
    MEALS.map((m) => h('option', { value: m, text: m })),
  );
  mealIn.value = meal;
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
    onSubmit(food, q, unitIn.value, mealIn.value);
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
    h(
      'div',
      { class: 'portion-row' },
      h('label', { class: 'sr', for: 'portion-qty', text: 'Quantity' }),
      qtyIn,
      h('label', { class: 'sr', for: 'portion-unit', text: 'Unit' }),
      unitIn,
      h('label', { class: 'sr', for: 'portion-meal', text: 'Meal' }),
      mealIn,
    ),
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

const now = () => new Date().toTimeString().slice(0, 5);

function addFood() {
  openSearch({
    onPick: (food) =>
      openPortion(food, {
        meal: L.mealForTime(MEALS, now()),
        onSubmit: (f, qty, unit, meal) => setLog(L.appendEntry(state.csv, entry(f, qty, unit, meal, now()))),
      }),
  });
}

function openAdjust(id) {
  const e = L.parseLog(state.csv).find((x) => x.id === id);
  if (!e) return;
  const replace = (f, qty, unit, meal) => {
    const { id: _, date, time, ...values } = entry(f, qty, unit, meal, e.time);
    setLog(L.updateEntry(state.csv, id, values));
  };
  const remove = () => setLog(L.removeEntry(state.csv, id));
  const opts = { qty: e.qty ?? undefined, unit: e.unit, meal: e.meal, submitText: 'Update', onSubmit: replace, onRemove: remove };
  const search = () => openSearch({ query: e.food, onPick: (f) => openPortion(f, opts) });
  const food = findFood(e.food);
  if (!food) return search();
  openPortion(food, { ...opts, onChange: search });
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

function setView(view) {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.view === view));
  $('preview').hidden = view !== 'preview';
  $('source-wrap').hidden = view !== 'source';
  $('csv-wrap').hidden = view !== 'csv';
}

function boot() {
  $('add').addEventListener('click', addFood);
  $('reset').addEventListener('click', () => {
    state = { csv: exampleLog(), custom: {}, recent: [], example: true };
    save();
    render();
  });
  $('csv').addEventListener('input', (e) => setLog(e.target.value));
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
