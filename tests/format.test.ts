import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, formatDay, formatWeek, humanDate, shortName } from '../lib/format';
import type { Day } from '../lib/parse';

test('esc экранирует все специальные символы MarkdownV2', () => {
  assert.equal(esc('a_b*c[d]e(f)'), 'a\\_b\\*c\\[d\\]e\\(f\\)');
  assert.equal(esc('ИСП/П-24-11'), 'ИСП/П\\-24\\-11');
  assert.equal(esc('ауд. 531 ГК'), 'ауд\\. 531 ГК');
});

test('humanDate переводит ISO в русскую дату', () => {
  assert.equal(humanDate('2026-09-01'), '1 сентября');
  assert.equal(humanDate('2026-12-31'), '31 декабря');
});

test('shortName сокращает ФИО до инициалов', () => {
  assert.equal(shortName('Соломин Максим Сергеевич'), 'Соломин М. С.');
  assert.equal(shortName('Тофан Алина'), 'Тофан А.');
  assert.equal(shortName('Иванов'), 'Иванов');
});

const day: Day = {
  date: '2026-09-01',
  name: 'Вторник',
  lessons: [
    {
      pair: 4,
      time: '13:45-15:15',
      subject: 'Поддержка и тестирование программных модулей',
      teacher: 'Соломин Максим Сергеевич',
      room: '531 ГК',
      raw: '',
    },
  ],
};

test('formatDay собирает сообщение и экранирует опасные символы', () => {
  const text = formatDay(day, { group: 'ИСП/П-24-11', siteUpdated: '25.08.2026' });
  assert.match(text, /Вторник/);
  assert.match(text, /ИСП\/П\\-24\\-11/);
  assert.match(text, /Соломин М\\\. С\\\./);

  // Ни один спецсимвол MarkdownV2 не должен остаться неэкранированным.
  // Снимаем разметку, которую ставим сами: экранирование, жирный, курсив
  // и `>` в начале строк цитаты.
  const bare = text
    .replace(/\\./g, '')
    .split('\n')
    .map((line) => line.replace(/^>/, ''))
    .join('\n')
    .replace(/\*/g, '')
    .replace(/_/g, '');
  assert.doesNotMatch(bare, /[[\]()~`>#+=|{}]/);
});

test('formatDay кладёт пары в цитату', () => {
  const text = formatDay(day, { group: 'ИСП/П-24-11' });
  const quoted = text.split('\n').filter((line) => line.startsWith('>'));
  assert.ok(quoted.length >= 3, 'пары должны быть строками цитаты');
  assert.match(quoted.join('\n'), /\*4\\\.\* \*13:45–15:15\*/);
});

test('formatWeek делает дни раскрывающимися цитатами', () => {
  const chunks = formatWeek([day], { group: 'ИСП/П-24-11' });
  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /\*\*>/, 'должна быть раскрывающаяся цитата');
  assert.match(chunks[0], /\|\|$/, 'цитата должна закрываться меткой раскрытия');
  assert.match(chunks[0], /1 пара/);
});

test('formatDay без пар пишет «Пар нет»', () => {
  const text = formatDay({ date: '2026-09-06', name: 'Воскресенье', lessons: [] }, { group: 'ИСП/П-24-11' });
  assert.match(text, /Пар нет/);
});

test('formatWeek режет длинную неделю на части в лимит Telegram', () => {
  const fat: Day = {
    ...day,
    lessons: Array.from({ length: 5 }, (_, i) => ({
      ...day.lessons[0],
      pair: i + 1,
      subject: 'Очень длинное название предмета '.repeat(12),
    })),
  };
  const chunks = formatWeek(Array.from({ length: 6 }, () => fat), { group: 'ИСП/П-24-11' });
  assert.ok(chunks.length > 1, 'должно разрезаться на несколько сообщений');
  for (const chunk of chunks) assert.ok(chunk.length <= 4096, `часть длиной ${chunk.length}`);
});

test('describeUser не повторяет одно и то же имя дважды', async () => {
  const { describeUser } = await import('../lib/bot');

  // Точное совпадение и совпадение с точностью до регистра и подчёркиваний
  assert.equal(describeUser({ first_name: 'Devil_clown03', username: 'Devil_clown03' }), '@Devil_clown03');
  assert.equal(describeUser({ first_name: 'devil clown03', username: 'Devil_clown03' }), '@Devil_clown03');

  // Настоящий случай: в имени лишняя буква
  assert.equal(
    describeUser({ first_name: 'Deviil_clown03', username: 'Devil_clown03' }),
    '@Devil_clown03',
  );

  // Короткие и явно разные имена склеивать нельзя
  assert.equal(describeUser({ first_name: 'Анна', username: 'anna1' }), 'Анна (@anna1)');
  assert.equal(
    describeUser({ first_name: 'Александр', username: 'vladislav' }),
    'Александр (@vladislav)',
  );
  assert.equal(describeUser({ first_name: 'Владислав', username: 'dislov' }), 'Владислав (@dislov)');
  assert.equal(describeUser({ first_name: 'Владислав' }), 'Владислав');
  assert.equal(describeUser({ username: 'dislov' }), '@dislov');
  assert.equal(describeUser({ id: 42 }), 'ID 42');
});

test('emojiTag собирает кастомный эмодзи и запасной глиф', async () => {
  const { emojiTag } = await import('../lib/format');

  // Без id — обычный эмодзи как есть
  assert.equal(emojiTag('🦅', null), '🦅');

  // С id — разметка MarkdownV2, глиф внутри как запасной
  assert.equal(
    emojiTag('🦅', '5368324170671202286'),
    '![🦅](tg://emoji?id=5368324170671202286)',
  );

  // Глиф со спецсимволом должен быть экранирован
  assert.equal(emojiTag('!', '123'), '![\\!](tg://emoji?id=123)');
});
