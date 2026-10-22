'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('../src/logcsv');

const banana = {
  id: 'a1',
  date: '2026-10-15',
  time: '08:05',
  meal: 'Breakfast',
  food: 'Bananas, raw',
  qty: 1,
  unit: 'medium',
  kcal: 105.02,
  protein: 1.286,
  carbs: 26.94,
  fat: 0.39,
};

test('parseCsv handles quotes, commas, newlines and CRLF', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n"two\nlines",\n\n'), [
    ['a', 'b'],
    ['x, y', 'say "hi"'],
    ['two\nlines', ''],
  ]);
});

test('appendEntry starts a file with a header and rounds numbers', () => {
  const text = appendEntry('', banana);
  assert.equal(
    text,
    'id,date,time,meal,food,qty,unit,kcal,protein,carbs,fat\n' +
      'a1,2026-10-15,08:05,Breakfast,"Bananas, raw",1,medium,105,1.3,26.9,0.4\n',
  );
  assert.deepEqual(parseLog(text)[0], {
    ...banana,
    kcal: 105,
    protein: 1.3,
    carbs: 26.9,
    fat: 0.4,
  });
});

test('appendEntry adds one line and leaves the rest alone', () => {
  const start =
    'id,date,time,meal,food,qty,unit,kcal,protein,carbs,fat\nz,2026-10-14,,,Toast,2,slice,160,,,\n';
  const text = appendEntry(start, banana);
  assert.ok(text.startsWith(start));
  assert.equal(parseLog(text).length, 2);
});

test('a hand-made file with other columns is read by header name and rewritten on append', () => {
  const start = 'Date,Food,kcal,Notes\n2026-10-15,Oats,150,breakfast\n';
  const [oats] = parseLog(start);
  assert.equal(oats.food, 'Oats');
  assert.equal(oats.kcal, 150);
  assert.equal(oats.protein, null);
  assert.equal(oats.id, 'row1');
  const text = appendEntry(start, banana);
  assert.ok(text.startsWith('id,date,time,meal,food,'));
  assert.deepEqual(
    parseLog(text).map((e) => [e.id, e.food]),
    [
      ['row1', 'Oats'],
      ['a1', 'Bananas, raw'],
    ],
  );
});

test('updateEntry and removeEntry act on one row by id', () => {
  const two = serializeLog([banana, { ...banana, id: 'b2', food: 'Apple', kcal: 95 }]);
  const updated = parseLog(updateEntry(two, 'a1', { qty: 2, kcal: 210 }));
  assert.deepEqual(
    updated.map((e) => [e.id, e.qty, e.kcal]),
    [
      ['a1', 2, 210],
      ['b2', 1, 95],
    ],
  );
  assert.deepEqual(
    parseLog(removeEntry(two, 'a1')).map((e) => e.id),
    ['b2'],
  );
});

test('entriesFor picks one day in time order; totals skip blanks', () => {
  const entries = [
    { ...banana, id: '1', time: '12:00', kcal: 100, protein: 2 },
    { ...banana, id: '2', date: '2026-10-14', kcal: 999 },
    { ...banana, id: '3', time: '07:30', kcal: 50, protein: null },
  ];
  const day = entriesFor(entries, '2026-10-15');
  assert.deepEqual(
    day.map((e) => e.id),
    ['3', '1'],
  );
  const sum = totals(day);
  assert.equal(sum.kcal, 150);
  assert.equal(sum.protein, 2);
  assert.deepEqual(totals([]), { kcal: null, protein: null, carbs: null, fat: null });
});

test('newId is short and differs between calls', () => {
  assert.match(
    newId(1760000000000, () => 0.5),
    /^[0-9a-z]+$/,
  );
  assert.notEqual(newId(), newId());
});

test('a log from before meals is moved to the new columns on the next write', () => {
  const old =
    'id,date,time,food,qty,unit,kcal,protein,carbs,fat\nz,2026-10-14,09:00,Toast,2,slice,160,,,\n';
  const [toast] = parseLog(old);
  assert.equal(toast.meal, '');
  const text = appendEntry(old, banana);
  assert.deepEqual(
    parseLog(text).map((e) => [e.id, e.meal, e.food, e.kcal]),
    [
      ['z', '', 'Toast', 160],
      ['a1', 'Breakfast', 'Bananas, raw', 105],
    ],
  );
});

test('parseMeals splits the setting and drops blanks and repeats', () => {
  assert.deepEqual(parseMeals(' Breakfast, Lunch,,dinner , lunch '), [
    'Breakfast',
    'Lunch',
    'dinner',
  ]);
  assert.deepEqual(parseMeals(''), []);
});

test('mealForTime guesses from the usual meal names only', () => {
  const meals = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
  assert.equal(mealForTime(meals, '07:30'), 'Breakfast');
  assert.equal(mealForTime(meals, '12:15'), 'Lunch');
  assert.equal(mealForTime(meals, '15:45'), 'Snack');
  assert.equal(mealForTime(meals, '18:00'), 'Dinner');
  assert.equal(mealForTime(meals, '23:10'), 'Snack');
  assert.equal(mealForTime(['Lunch', 'Dinner'], '15:45'), '');
  assert.equal(mealForTime(['Pre-workout', 'Post-workout'], '07:30'), '');
});

test('groupByMeal orders by the setting, then other meals, then no meal', () => {
  const e = (id, meal) => ({ ...banana, id, meal });
  const groups = groupByMeal(
    [
      e('1', 'Dinner'),
      e('2', ''),
      e('3', 'breakfast'),
      e('4', 'Second breakfast'),
      e('5', 'Dinner'),
    ],
    ['Breakfast', 'Lunch', 'Dinner'],
  );
  assert.deepEqual(
    groups.map((g) => [g.meal, g.entries.map((x) => x.id)]),
    [
      ['Breakfast', ['3']],
      ['Dinner', ['1', '5']],
      ['Second breakfast', ['4']],
      ['', ['2']],
    ],
  );
});
