import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { unzip } from '../lib/unzip';
import { colToIndex, indexToCol, readWorkbook } from '../lib/xlsx';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'week1.xlsx');

test('колонки переводятся в индексы в обе стороны', () => {
  assert.equal(colToIndex('A'), 1);
  assert.equal(colToIndex('Z'), 26);
  assert.equal(colToIndex('AA'), 27);
  assert.equal(indexToCol(1), 'A');
  assert.equal(indexToCol(26), 'Z');
  assert.equal(indexToCol(27), 'AA');
  for (let i = 1; i < 200; i++) assert.equal(colToIndex(indexToCol(i)), i);
});

test('unzip разбирает xlsx и находит обязательные части', { skip: !existsSync(fixture) }, () => {
  const entries = unzip(readFileSync(fixture));
  assert.ok(entries.has('xl/workbook.xml'));
  assert.ok(entries.has('xl/sharedStrings.xml'));
  assert.ok(entries.get('xl/workbook.xml')!.toString('utf8').includes('<sheets>'));
});

test('unzip отвергает не-ZIP', () => {
  assert.throws(() => unzip(Buffer.from('это не архив, а просто текст подлиннее двадцати двух байт')));
});

test('readWorkbook возвращает листы в порядке книги', { skip: !existsSync(fixture) }, () => {
  const sheets = readWorkbook(readFileSync(fixture));
  assert.equal(sheets.length, 6);
  assert.equal(sheets[0].name, '4к 9 кл, 3к 11 кл');
  assert.ok(sheets[0].cells.get('A1')?.includes('День недели'));
  assert.ok(sheets[0].merges.includes('A6:A10'));
});
