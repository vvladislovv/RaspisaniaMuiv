import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayGroup } from '../lib/aliases';

test('displayGroup возвращает старое имя и настоящее с сайта в скобках', () => {
  assert.equal(displayGroup('КБо 111п-23'), 'ИСП/П-23-09.1 (КБо 111п-23)');
  assert.equal(displayGroup('КБо 112п-23'), 'ИСП/П-23-09.2 (КБо 112п-23)');
  assert.equal(displayGroup('КБсп 111п-24'), 'ИСП/П-24-11 (КБсп 111п-24)');
});

test('displayGroup не трогает группы без алиаса', () => {
  assert.equal(displayGroup('к/о/к БАД 25-09'), 'к/о/к БАД 25-09');
  assert.equal(displayGroup('Неизвестная группа'), 'Неизвестная группа');
});
