import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSchedule, parseLesson } from '../lib/parse';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'week1.xlsx');

test('parseLesson: предмет, преподаватель, аудитория', () => {
  const lesson = parseLesson(
    'Поддержка и тестирование программных модулей\nСоломин Максим Сергеевич\nауд. 531 ГК',
    4,
    '13:45-15:15',
  );
  assert.ok(lesson);
  assert.equal(lesson.subject, 'Поддержка и тестирование программных модулей');
  assert.equal(lesson.teacher, 'Соломин Максим Сергеевич');
  assert.equal(lesson.room, '531 ГК');
  assert.equal(lesson.pair, 4);
});

test('parseLesson: без преподавателя и аудитории', () => {
  const lesson = parseLesson('Производственная практика', 1, '8:20-09:50');
  assert.ok(lesson);
  assert.equal(lesson.subject, 'Производственная практика');
  assert.equal(lesson.teacher, null);
  assert.equal(lesson.room, null);
});

test('parseLesson: пустая ячейка не даёт пары', () => {
  assert.equal(parseLesson('   \n  ', 1, '8:20-09:50'), null);
});

test('parseLesson: мастер-класс с многострочным описанием', () => {
  const lesson = parseLesson(
    'Мастер-класс с работодателем\nООО «Русаудит»\nСмирнова Светлана\nЗаместитель руководителя\nауд. 117 ГК',
    3,
    '12:05-13:35',
  );
  assert.ok(lesson);
  assert.equal(lesson.room, '117 ГК');
  assert.match(lesson.subject, /Мастер-класс/);
});

test('parseSchedule: реальный файл расписания', { skip: !existsSync(fixture) }, () => {
  const workbook = parseSchedule(readFileSync(fixture));

  assert.equal(workbook.weekStart, '2026-08-31');
  assert.ok(workbook.groups.length > 50, `групп должно быть много, получили ${workbook.groups.length}`);

  // Обе группы из объединённого заголовка колонки должны попасть в результат
  const target = workbook.groups.find((g) => g.group === 'ИСП/П-24-11');
  const sibling = workbook.groups.find((g) => g.group === 'ИСП/П-23-09');
  assert.ok(target, 'ИСП/П-24-11 не найдена');
  assert.ok(sibling, 'ИСП/П-23-09 не найдена');

  // Дни идут по возрастанию даты, пары — по возрастанию номера
  const dates = target.days.map((d) => d.date);
  assert.deepEqual(dates, [...dates].sort());

  for (const day of target.days) {
    const pairs = day.lessons.map((l) => l.pair);
    assert.deepEqual(pairs, [...pairs].sort((a, b) => a - b));
    assert.equal(new Set(pairs).size, pairs.length, 'номера пар не должны дублироваться');
  }

  const tuesday = target.days.find((d) => d.date === '2026-09-01');
  assert.ok(tuesday);
  assert.equal(tuesday.name, 'Вторник');
  assert.equal(tuesday.lessons.length, 2);
  assert.equal(tuesday.lessons[0].pair, 4);
  assert.equal(tuesday.lessons[0].teacher, 'Соломин Максим Сергеевич');
  assert.equal(tuesday.lessons[0].room, '531 ГК');

  // Заголовки-служебные строки не должны попасть в предметы
  for (const group of workbook.groups) {
    for (const day of group.days) {
      for (const lesson of day.lessons) {
        assert.doesNotMatch(lesson.subject, /^(Понедельник|Вторник|Среда|Четверг|Пятница|Суббота)/);
        assert.doesNotMatch(lesson.subject, /^Специальность:/);
        assert.doesNotMatch(lesson.subject, /^\d+$/, `число вместо предмета: ${lesson.raw}`);
      }
    }
  }
});

test('имя файла берётся из адреса и не зависит от пути', async () => {
  const { fileNameOf } = await import('../lib/db');
  // МУИВ меняет хеш в пути при каждой перезаливке, имя остаётся прежним
  const a = 'https://www.muiv.ru/upload/iblock/72a/pojsgqq2/Raspisanie-kolledzh.xlsx';
  const b = 'https://www.muiv.ru/upload/iblock/629/2war0pls/Raspisanie-kolledzh.xlsx';
  assert.equal(fileNameOf(a), 'Raspisanie-kolledzh.xlsx');
  assert.equal(fileNameOf(a), fileNameOf(b));
  assert.equal(fileNameOf('/x/%D0%A0%D0%B0%D1%81.xlsx'), 'Рас.xlsx');
});
