'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  splitRow,
  findTables,
  tableAt,
  readFoodRow,
  insertShift,
  deleteShift,
  insertFoodRow,
  updateFoodRow,
  deleteFoodRow,
  buildTable,
} = require('../src/table');

// Same positional semantics as Table Calc's engine: data rows numbered from 1,
// header excluded.
function apply(lines, edit) {
  return [...lines.slice(0, edit.from), ...edit.lines, ...lines.slice(edit.to + 1)];
}

const banana = {
  food: 'Banana',
  qty: 1,
  unit: 'medium',
  kcal: 105.02,
  protein: 1.286,
  carbs: 26.9,
  fat: 0.39,
};
const oats = { food: 'Oats', qty: 40, unit: 'g', kcal: 150, protein: 5, carbs: 27, fat: 2.5 };

test('splitRow keeps escaped pipes and empty cells', () => {
  assert.deepEqual(splitRow('| a | b \\| c |  |'), ['a', 'b \\| c', '']);
  assert.deepEqual(splitRow('a | b'), ['a', 'b']);
});

test('buildTable makes an empty Table Calc log', () => {
  assert.deepEqual(buildTable({ macros: true }), [
    '{{calc}}',
    '| Food | Qty | Unit | kcal | Protein | Carbs | Fat |',
    '| --- | ---: | --- | ---: | ---: | ---: | ---: |',
    '| **Total** |  |  | =SUM(D0:D0) | =SUM(E0:E0) | =SUM(F0:F0) | =SUM(G0:G0) |',
  ]);
});

test('findTables only matches food logs and maps columns by header', () => {
  const lines = [
    '| Item | Cost |',
    '| --- | --- |',
    '| x | 1 |',
    '',
    'some text',
    '{{calc}}',
    '| **Calories** | Food | Qty (g) |',
    '|---|---|---|',
    '| 100 | Apple | 120 |',
  ];
  const tables = findTables(lines);
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].cols, { kcal: 0, food: 1, qty: 2 });
  assert.equal(tables[0].start, 6);
  assert.equal(tables[0].end, 8);
  assert.equal(tables[0].hasMarker, true);
  assert.deepEqual(tableAt(lines, 5), tables[0]); // marker line counts
  assert.equal(tableAt(lines, 2), null);
});

test('adding foods grows the totals range', () => {
  let lines = buildTable({ macros: true });
  lines = apply(lines, insertFoodRow(lines, findTables(lines)[0], banana));
  assert.equal(lines[3], '| Banana | 1 | medium | 105 | 1.3 | 26.9 | 0.4 |');
  assert.equal(
    lines[4],
    '| **Total** |  |  | =SUM(D1:D1) | =SUM(E1:E1) | =SUM(F1:F1) | =SUM(G1:G1) |',
  );

  lines = apply(lines, insertFoodRow(lines, findTables(lines)[0], oats));
  assert.equal(lines[4], '| Oats | 40 | g | 150 | 5 | 27 | 2.5 |');
  assert.equal(
    lines[5],
    '| **Total** |  |  | =SUM(D1:D2) | =SUM(E1:E2) | =SUM(F1:F2) | =SUM(G1:G2) |',
  );
});

test('goal and remaining rows keep pointing at the right rows', () => {
  let lines = buildTable({ macros: false, goal: 2000 });
  assert.deepEqual(lines.slice(3), [
    '| **Total** |  |  | =SUM(D0:D0) |',
    '| **Goal** |  |  | 2000 |',
    '| **Remaining** |  |  | =D2-D1 |',
  ]);
  lines = apply(lines, insertFoodRow(lines, findTables(lines)[0], banana));
  lines = apply(lines, insertFoodRow(lines, findTables(lines)[0], oats));
  assert.deepEqual(lines.slice(3), [
    '| Banana | 1 | medium | 105 |',
    '| Oats | 40 | g | 150 |',
    '| **Total** |  |  | =SUM(D1:D2) |',
    '| **Goal** |  |  | 2000 |',
    '| **Remaining** |  |  | =D4-D3 |',
  ]);
});

test('inserting into a hand-written log without summary rows appends', () => {
  const lines = ['| Food | kcal |', '|---|---|', '| Egg | 70 |'];
  const out = apply(lines, insertFoodRow(lines, findTables(lines)[0], oats));
  assert.deepEqual(out, ['| Food | kcal |', '|---|---|', '| Egg | 70 |', '| Oats | 150 |']);
});

test('food names with pipes are escaped and read back', () => {
  let lines = ['| Food | kcal |', '|---|---|'];
  lines = apply(
    lines,
    insertFoodRow(lines, findTables(lines)[0], { food: 'Mac | cheese', kcal: 300 }),
  );
  assert.equal(lines[2], '| Mac \\| cheese | 300 |');
  assert.equal(readFoodRow(lines, findTables(lines)[0], 2).name, 'Mac | cheese');
});

test('readFoodRow skips header, separator and summary rows', () => {
  let lines = buildTable();
  lines = apply(lines, insertFoodRow(lines, findTables(lines)[0], banana));
  const t = findTables(lines)[0];
  assert.equal(readFoodRow(lines, t, 1), null);
  assert.equal(readFoodRow(lines, t, 2), null);
  assert.deepEqual(readFoodRow(lines, t, 3), {
    name: 'Banana',
    qty: '1',
    unit: 'medium',
    kcal: '105',
  });
  assert.equal(readFoodRow(lines, t, 4), null);
});

test('updateFoodRow rewrites values and preserves extra columns', () => {
  const lines = [
    '| Food | Qty | Unit | kcal | Notes |',
    '|---|---|---|---|---|',
    '| Oats | 40 | g | 150 | breakfast |',
  ];
  const t = findTables(lines)[0];
  const out = apply(lines, updateFoodRow(lines, t, 2, { ...oats, qty: 80, kcal: 300 }));
  assert.equal(out[2], '| Oats | 80 | g | 300 | breakfast |');
});

test('deleteFoodRow shrinks ranges and shifts later refs', () => {
  let lines = buildTable({ macros: false, goal: 2000 });
  for (const f of [banana, oats, banana])
    lines = apply(lines, insertFoodRow(lines, findTables(lines)[0], f));
  lines = apply(lines, deleteFoodRow(lines, findTables(lines)[0], 4)); // Oats = row 2
  assert.deepEqual(lines.slice(3), [
    '| Banana | 1 | medium | 105 |',
    '| Banana | 1 | medium | 105 |',
    '| **Total** |  |  | =SUM(D1:D2) |',
    '| **Goal** |  |  | 2000 |',
    '| **Remaining** |  |  | =D4-D3 |',
  ]);
  // Removing every food returns to the empty-sum form.
  lines = apply(lines, deleteFoodRow(lines, findTables(lines)[0], 3));
  lines = apply(lines, deleteFoodRow(lines, findTables(lines)[0], 3));
  assert.deepEqual(lines.slice(3), [
    '| **Total** |  |  | =SUM(D0:D0) |',
    '| **Goal** |  |  | 2000 |',
    '| **Remaining** |  |  | =D2-D1 |',
  ]);
});

test('reference shifting leaves function names alone', () => {
  assert.equal(insertShift('=ROUND(LOG10(D3), 2)+D1', 2), '=ROUND(LOG10(D4), 2)+D1');
  assert.equal(insertShift('=SUM(D1:D3)', 4), '=SUM(D1:D4)');
  assert.equal(insertShift('=SUM(D2:D3)', 1), '=SUM(D3:D4)');
  assert.equal(deleteShift('=SUM(D1:D3)*D5', 2), '=SUM(D1:D2)*D4');
});
