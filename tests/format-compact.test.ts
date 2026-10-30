import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDay, formatWeek } from '../lib/format';
import type { Day, Lesson } from '../lib/parse';

function lesson(pair: number, time: string, subject: string, extra: Partial<Lesson> = {}): Lesson {
  return {
    pair,
    time,
    subject,
    teacher: 'Давтян Анна Юрьевна',
    room: '536 ГК',
    raw: `${time} | ${subject}`,
    ...extra,
  };
}

// Четверг со скриншота: пары 1–2 и 3–5 повторяются подряд
const thursday: Day = {
  date: '2026-10-29',
  name: 'Четверг',
  lessons: [
    lesson(1, '08:20-09:50', 'Налоговый контроль и администрирование · Семинары ИПЗ'),
    lesson(2, '10:00-11:30', 'Налоговый контроль и администрирование · Семинары ИПЗ'),
    lesson(3, '12:05-13:35', 'Налоги и налогообложение · Семинары ИПЗ'),
    lesson(4, '13:45-15:15', 'Налоги и налогообложение · Семинары ИПЗ'),
    lesson(5, '15:25-16:55', 'Налоги и налогообложение · Семинары ИПЗ'),
  ],
};

const bodyOf = (text: string) => text.split('\n');

test('подряд идущие одинаковые пары склеиваются в одну запись с общим временем', () => {
  const text = formatDay(thursday, { group: 'ФИН 25-11' });
  assert.match(text, /\*1–2\\\.\* \*08:20–11:30\*/);
  assert.match(text, /\*3–5\\\.\* \*12:05–16:55\*/);
  // Название каждой склеенной записи — один раз, а не по числу пар
  assert.equal(text.match(/Налоги и налогообложение/g)?.length, 1);
  assert.equal(text.match(/Налоговый контроль/g)?.length, 1);
});

test('разные пары и пары не подряд не склеиваются', () => {
  const day: Day = {
    date: '2026-10-29',
    name: 'Четверг',
    lessons: [
      lesson(1, '08:20-09:50', 'Математика'),
      lesson(2, '10:00-11:30', 'Физика'),
      lesson(4, '13:45-15:15', 'Математика'),
      lesson(5, '15:25-16:55', 'Математика', { room: '101 ГК' }),
    ],
  };
  const text = formatDay(day, { group: 'ФИН 25-11' });
  for (const pair of ['1', '2', '4', '5']) {
    assert.match(text, new RegExp(`\\*${pair}\\\\\\.\\* \\*`), `пара ${pair} отдельной записью`);
  }
  assert.doesNotMatch(text, /–\d\\\./);
});

test('«Семинары ИПЗ» убирается, «Вебинар» остаётся', () => {
  const day: Day = {
    date: '2026-10-26',
    name: 'Понедельник',
    lessons: [
      lesson(1, '10:00-11:30', 'Налоги · Вебинар'),
      lesson(2, '12:05-13:35', 'Бухучёт · Семинары ИПЗ'),
      lesson(3, '13:45-15:15', 'Право'),
    ],
  };
  const text = formatDay(day, { group: 'ФИН 25-11' });
  assert.doesNotMatch(text, /ИПЗ/);
  assert.match(text, /Налоги · Вебинар/);
  assert.match(text, /Бухучёт/);
  assert.match(text, /Право/);
});

test('внутри записи нет пустых строк — пустая строка только между записями', () => {
  const text = formatDay(thursday, { group: 'ФИН 25-11' });
  const quoted = bodyOf(text).filter((line) => line.startsWith('>'));
  // 2 записи по 3 строки + 1 пустая строка между ними
  assert.equal(quoted.length, 7);
});

test('неделя: заголовок дня стоит вне цитаты, дни разделены пустой строкой', () => {
  const week: Day[] = [
    thursday,
    {
      date: '2026-10-30',
      name: 'Пятница',
      lessons: [lesson(1, '13:45-15:15', 'Учёт'), lesson(2, '15:25-16:55', 'Учёт')],
    },
  ];
  const [text] = formatWeek(week, { group: 'ФИН 25-11' });
  const lines = bodyOf(text);

  const titleAt = (needle: string) => lines.findIndex((l) => l.includes(needle));
  const thu = titleAt('Четверг');
  const fri = titleAt('Пятница');

  assert.ok(!lines[thu].startsWith('>'), 'заголовок четверга вне цитаты');
  assert.ok(!lines[fri].startsWith('>'), 'заголовок пятницы вне цитаты');
  assert.equal(lines[fri - 1], '', 'между днями пустая строка');
  // Раскрывающиеся цитаты склеивались в одну — теперь их нет
  assert.doesNotMatch(text, /\|\|/);
});

test('неделя: день с одной склеенной записью занимает пять строк, а не тринадцать', () => {
  const [text] = formatWeek([thursday], { group: 'ФИН 25-11' });
  assert.ok(bodyOf(text).length <= 11, `строк: ${bodyOf(text).length}`);
});

test('день без пар в неделе остаётся «Пар нет»', () => {
  const [text] = formatWeek([{ date: '2026-10-31', name: 'Суббота', lessons: [] }], {
    group: 'ФИН 25-11',
  });
  assert.match(text, /Пар нет/);
  assert.match(text, /0 пар/);
});

test('экзамен на склеенной записи подписан один раз', () => {
  const day: Day = {
    date: '2026-12-22',
    name: 'Вторник',
    lessons: [
      lesson(1, '10:00-11:30', 'Математика · Экзамен'),
      lesson(2, '12:05-13:35', 'Математика · Экзамен'),
    ],
  };
  const text = formatDay(day, { group: 'ФИН 25-11' });
  assert.equal(text.match(/🔴 ЭКЗАМЕН/g)?.length, 1);
  assert.match(text, /\*1–2\\\.\*/);
});

test('склейка не портит исходные данные дня', () => {
  const before = JSON.stringify(thursday);
  formatDay(thursday, { group: 'ФИН 25-11' });
  formatWeek([thursday], { group: 'ФИН 25-11' });
  assert.equal(JSON.stringify(thursday), before);
});

test('«Вебинар» не повторяется, если им уже подписана аудитория', () => {
  const day: Day = {
    date: '2026-10-26',
    name: 'Понедельник',
    lessons: [
      lesson(1, '10:00-11:30', 'Налоги · Вебинар', { room: 'Д' }),
      lesson(2, '12:05-13:35', 'Право · Вебинар', { room: '536 ГК' }),
    ],
  };
  const text = formatDay(day, { group: 'ФИН 25-11' });
  // у первой пары «Вебинар» один раз — в строке преподавателя и аудитории
  assert.equal(text.match(/Вебинар/g)?.length, 2);
  assert.match(text, /Право · Вебинар/, 'если аудитория настоящая — тип остаётся');
});
