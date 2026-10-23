import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCESS_PAGE_SIZE,
  accessOverviewKeyboard,
  accessSectionKeyboard,
  groupKeyboard,
  isAccessSection,
  pageOf,
  scheduleKeyboard,
} from '../lib/keyboard';

const flat = (kb: { text: string; callback_data?: string }[][]) => kb.flat();

test('pageOf режет список и держит номер страницы в границах', () => {
  const items = Array.from({ length: 20 }, (_, i) => i);

  assert.deepEqual(pageOf(items, 0, 8), { items: [0, 1, 2, 3, 4, 5, 6, 7], page: 0, pages: 3 });
  assert.deepEqual(pageOf(items, 2, 8).items, [16, 17, 18, 19]);
  // Страницу за концом приводим к последней: список мог сократиться
  assert.equal(pageOf(items, 99, 8).page, 2);
  assert.equal(pageOf(items, -3, 8).page, 0);
  assert.equal(pageOf(items, Number.NaN, 8).page, 0);
  // Пустой список — одна пустая страница, а не ноль страниц
  assert.deepEqual(pageOf([], 0, 8), { items: [], page: 0, pages: 1 });
});

test('isAccessSection пропускает только известные разделы', () => {
  for (const ok of ['p', 'a', 'd']) assert.equal(isAccessSection(ok), true);
  for (const bad of ['', 'x', 'pp', undefined]) assert.equal(isAccessSection(bad), false);
});

test('обзор доступа — три раздела со счётчиками, без списка людей', () => {
  const kb = flat(accessOverviewKeyboard({ pending: 37, approved: 120, denied: 5 }));
  assert.ok(kb.some((b) => b.text.includes('Ждут решения (37)') && b.callback_data === 'acc:p:0'));
  assert.ok(kb.some((b) => b.text.includes('Одобрены (120)') && b.callback_data === 'acc:a:0'));
  assert.ok(kb.some((b) => b.text.includes('Отказано (5)') && b.callback_data === 'acc:d:0'));
  assert.ok(kb.length <= 6);
});

test('страница раздела: кнопки решения помнят раздел и страницу', () => {
  const people = [
    { id: 101, label: 'Иван (@ivan)' },
    { id: 102, label: 'Мария' },
  ];

  const pending = flat(accessSectionKeyboard('p', people, 1, 3));
  assert.ok(pending.some((b) => b.callback_data === 'ok:101:p:1'));
  assert.ok(pending.some((b) => b.callback_data === 'no:101:p:1'));
  // Листание в обе стороны и номер страницы
  assert.ok(pending.some((b) => b.callback_data === 'acc:p:0'));
  assert.ok(pending.some((b) => b.callback_data === 'acc:p:2'));
  assert.ok(pending.some((b) => b.text === '2 / 3'));

  const approved = flat(accessSectionKeyboard('a', people, 0, 1));
  assert.ok(approved.some((b) => b.text.startsWith('🚫 Отозвать') && b.callback_data === 'no:102:a:0'));
  // Одна страница — без листания
  assert.ok(!approved.some((b) => b.callback_data?.startsWith('acc:a:')));

  const denied = flat(accessSectionKeyboard('d', people, 0, 1));
  assert.ok(denied.some((b) => b.text.startsWith('✅ Разрешить') && b.callback_data === 'ok:101:d:0'));

  // Путь назад есть всегда
  for (const kb of [pending, approved, denied]) {
    assert.ok(kb.some((b) => b.callback_data === 'admacc'));
    assert.ok(kb.some((b) => b.callback_data === 'adm'));
  }
});

test('страница раздела влезает в лимиты Telegram на длинных именах и больших id', () => {
  const people = Array.from({ length: ACCESS_PAGE_SIZE }, (_, i) => ({
    id: 9_007_199_254_740 + i,
    label: '🦊 Очень-очень длинное имя человека из Telegram (@very_long_username_here)',
  }));
  const kb = flat(accessSectionKeyboard('p', people, 999, 1000));

  assert.ok(kb.length <= 100, `кнопок ${kb.length}`);
  for (const b of kb) {
    assert.ok(Buffer.byteLength(b.callback_data ?? '') <= 64, b.callback_data);
    assert.ok(Array.from(b.text).length <= 32, b.text);
  }
});

test('у группы без недели в базе переключатель групп не пропадает', () => {
  const kb = flat(
    scheduleKeyboard([], null, null, [], {
      groups: ['КБо 21-24', 'КБо 111п-23'],
      activeIndex: 0,
      dateIso: '2026-10-19',
    }),
  );
  assert.equal(kb.filter((b) => b.callback_data?.startsWith('wg:')).length, 2);
  assert.ok(kb.some((b) => b.callback_data === 'm'));
});

test('groupKeyboard не уходит за границы страниц на подделанном номере', () => {
  const groups = Array.from({ length: 30 }, (_, i) => ({ group: `Группа ${i}`, index: i }));

  const negative = flat(groupKeyboard(groups, 0, -5));
  assert.ok(negative.some((b) => b.callback_data === 'g:0'), 'показана первая страница');
  assert.ok(!negative.some((b) => b.callback_data?.includes(':-')), 'и нет кнопок на «минус» страницы');

  const beyond = flat(groupKeyboard(groups, 0, 99));
  assert.ok(beyond.some((b) => b.callback_data === 'g:29'), 'показана последняя страница');
  assert.ok(!beyond.some((b) => b.text === '▶︎'), 'и вперёд листать некуда');
});
