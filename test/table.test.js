'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  splitRow,
  joinRow,
  escapeCell,
  unescapeCell,
  findTables,
  formatNumber,
} = require('../src/table');

test('splitRow keeps escaped pipes and empty cells', () => {
  assert.deepEqual(splitRow('| a | b \\| c |  |'), ['a', 'b \\| c', '']);
  assert.deepEqual(splitRow('a | b'), ['a', 'b']);
});

test('findTables only matches food tables and maps columns by header', () => {
  const lines = [
    '| Item | Cost |',
    '| --- | --- |',
    '| x | 1 |',
    '',
    'some text',
    '| **Calories** | Food | Per (serving) | Notes |',
    '|---|---|---|---|',
    '| 100 | Apple | 1 apple = 182 g | crisp |',
  ];
  const tables = findTables(lines);
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].cols, { kcal: 0, food: 1, per: 2 });
  assert.equal(tables[0].start, 5);
  assert.equal(tables[0].end, 7);
  assert.equal(tables[0].width, 4);
});

test('food names with pipes are escaped and read back', () => {
  const row = joinRow([escapeCell('Mac | cheese'), '300']);
  assert.equal(row, '| Mac \\| cheese | 300 |');
  assert.equal(unescapeCell(splitRow(row)[0]), 'Mac | cheese');
  assert.equal(escapeCell('two\nlines'), 'two lines');
});

test('formatNumber rounds and blanks missing values', () => {
  assert.equal(formatNumber(105.02, 0), '105');
  assert.equal(formatNumber(1.286, 1), '1.3');
  assert.equal(formatNumber(null, 1), '');
  assert.equal(formatNumber(Number.NaN, 1), '');
});
