import test from 'node:test';
import assert from 'node:assert/strict';
import { formKeyboard, formsOf, groupKeyboard, shortGroupLabel } from '../lib/keyboard';

const flat = (kb: { text: string; callback_data?: string }[][]) => kb.flat();

function entry(group: string, index: number, form: string) {
  return { group, index, form };
}

test('formsOf: очная, заочная, очно-заочная — в привычном порядке, незнакомая форма в конце', () => {
  const groups = [
    entry('a', 0, 'Заочная'),
    entry('b', 1, 'Очно-заочная'),
    entry('c', 2, 'Очная'),
    entry('d', 3, 'Заочная'),
    entry('e', 4, 'Экстернат'),
  ];
  assert.deepEqual(formsOf(groups), ['Очная', 'Заочная', 'Очно-заочная', 'Экстернат']);
});

test('shortGroupLabel срезает код формы обучения — форма уже выбрана', () => {
  assert.equal(shortGroupLabel('к/о/к ФИН 25-11'), 'ФИН 25-11');
  assert.equal(shortGroupLabel('к/з/д ТД 25-11'), 'ТД 25-11');
  assert.equal(shortGroupLabel('к/оз/д ИСП/р 25-11'), 'ИСП/р 25-11');
  assert.equal(shortGroupLabel('к/о/к ИРПТИИ-26-09'), 'ИРПТИИ-26-09');
});

test('shortGroupLabel не трогает имена без кода формы, в том числе с привычным именем', () => {
  assert.equal(shortGroupLabel('КБо 21-24'), 'ФИН-24-09 (КБо 21-24)');
  assert.equal(shortGroupLabel('КБо 999-24'), 'КБо 999-24');
});

test('экран форм: кнопка на форму со счётчиком, назад к курсам', () => {
  const kb = flat(
    formKeyboard(2, [
      { form: 'Очная', count: 31 },
      { form: 'Заочная', count: 10 },
    ]),
  );
  const och = kb.find((b) => b.text.includes('Очная'));
  assert.ok(och?.text.includes('31'), 'видно, сколько групп');
  assert.equal(och?.callback_data, 'p:2:0:0');
  assert.equal(kb.find((b) => b.text.includes('Заочная'))?.callback_data, 'p:2:0:1');
  assert.ok(kb.some((b) => b.callback_data === 'grp'), 'есть путь к курсам');
  assert.ok(kb.some((b) => b.callback_data === 'm'), 'и в меню');
});

const shortGroups = Array.from({ length: 30 }, (_, i) =>
  entry(`к/о/к ФИН 25-${String(i).padStart(2, '0')}`, i, 'Очная'),
);

test('короткие имена: по две в ряд, без кода формы', () => {
  const rows = groupKeyboard(shortGroups, 2, 0, [], 0, true);
  const first = rows[0];
  assert.equal(first.length, 2);
  assert.equal(first[0].text, 'ФИН 25-00');
  assert.equal(first[0].callback_data, 'g:0');
});

test('длинные имена: по одному в ряд, чтобы Telegram их не обрезал', () => {
  const long = [
    entry('КБо 111п-23', 0, 'Очная'),
    entry('КБо 112п-23', 1, 'Очная'),
    entry('КБо 111р-23', 2, 'Очная'),
  ];
  const rows = groupKeyboard(long, 3, 0, [], 0, true);
  assert.equal(rows[0].length, 1);
  assert.ok(rows[0][0].text.includes('КБо 111п-23'), 'имя показано целиком');
});

test('листание помнит курс и форму; страниц за краем нет', () => {
  const first = flat(groupKeyboard(shortGroups, 2, 0, [], 1, true));
  assert.ok(first.some((b) => b.text === '▶︎' && b.callback_data === 'p:2:1:1'));
  assert.ok(!first.some((b) => b.text === '◀︎'));

  const beyond = flat(groupKeyboard(shortGroups, 2, 99, [], 1, true));
  assert.ok(!beyond.some((b) => b.text === '▶︎'), 'вперёд листать некуда');
  assert.ok(beyond.some((b) => b.text === '◀︎' && b.callback_data?.startsWith('p:2:')));
  assert.ok(!beyond.some((b) => b.callback_data?.includes(':-')));
});

test('кнопка «назад» ведёт к формам, если форм несколько, иначе к курсам', () => {
  const withForms = flat(groupKeyboard(shortGroups, 2, 0, [], 0, true));
  assert.ok(withForms.some((b) => b.text.includes('Формы') && b.callback_data === 's:2'));

  const single = flat(groupKeyboard(shortGroups, 2, 0, [], null, false));
  assert.ok(single.some((b) => b.text.includes('Курсы') && b.callback_data === 'grp'));
  // без формы в нажатии листание остаётся совместимым со старыми кнопками
  assert.ok(single.some((b) => b.text === '▶︎' && b.callback_data === 'p:2:1'));
});

test('выбранная группа помечена галочкой и есть «Готово»', () => {
  const rows = flat(groupKeyboard(shortGroups, 2, 0, ['к/о/к ФИН 25-00'], 0, true));
  assert.equal(rows.find((b) => b.callback_data === 'g:0')?.text, '✓ ФИН 25-00');
  assert.ok(rows.some((b) => b.text.includes('Готово (1)')));
});

test('все кнопки укладываются в лимит callback_data Telegram (64 байта)', () => {
  const rows = [
    ...flat(groupKeyboard(shortGroups, 12, 99, [], 2, true)),
    ...flat(formKeyboard(12, [{ form: 'Очная', count: 1 }])),
  ];
  for (const b of rows) assert.ok(Buffer.byteLength(b.callback_data ?? '') <= 64, b.callback_data);
});
