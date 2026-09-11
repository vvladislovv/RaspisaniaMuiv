import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGroupTable } from '../lib/muiv';

// Фрагмент `ttable`, снятый вживую с ajax.php (el=groupnames) для реальной группы
const TTABLE = `<h2>08.09.2026 (вторник)</h2><div class="tableScroll"><TABLE><TBODY><tr class="th-1"><td><b>Время занятия</b></td><td><b>Группа</b></td><td><b>Дисциплина</b></td><td><b>Аудитория</b></td><td><b>Вид занятия</b></td><td><b>Преподаватель</b></td></tr><tr><td>12:05-13:35</td><td style="white-space: nowrap;">к/о/к БАД-26-09</td><td>Математика</td><td>ауд.206 (колледж)</td><td>Семинары ИПЗ</td><td>Кириллаева Мария Александровна</td></tr><tr><td>13:45-15:15</td><td style="white-space: nowrap;">к/о/к БАД-26-09</td><td>Математика</td><td>ауд.206 (колледж)</td><td>Семинары ИПЗ</td><td>Кириллаева Мария Александровна</td></tr></TBODY></TABLE></div><h2>09.09.2026 (среда)</h2><div class="tableScroll"><TABLE><TBODY><tr class="th-1"><td><b>Время занятия</b></td><td><b>Группа</b></td><td><b>Дисциплина</b></td><td><b>Аудитория</b></td><td><b>Вид занятия</b></td><td><b>Преподаватель</b></td></tr><tr><td>12:05-13:35</td><td style="white-space: nowrap;">к/о/к БАД-26-09</td><td>Химия</td><td>503</td><td>Семинары ИПЗ</td><td>Зюзюкин Михаил Юрьевич</td></tr></TBODY></TABLE></div>`;

test('parseGroupTable разбирает дни и пары', () => {
  const days = parseGroupTable(TTABLE);

  assert.equal(days.length, 2);
  assert.equal(days[0].date, '2026-09-08');
  assert.equal(days[0].name, 'Вторник');
  assert.equal(days[0].lessons.length, 2);
  assert.equal(days[0].lessons[0].pair, 1);
  assert.equal(days[0].lessons[0].time, '12:05-13:35');
  assert.equal(days[0].lessons[0].subject, 'Математика · Семинары ИПЗ');
  assert.equal(days[0].lessons[0].teacher, 'Кириллаева Мария Александровна');
  assert.equal(days[0].lessons[0].room, 'ауд.206 (колледж)');

  assert.equal(days[1].date, '2026-09-09');
  assert.equal(days[1].name, 'Среда');
  assert.equal(days[1].lessons.length, 1);
  assert.equal(days[1].lessons[0].subject, 'Химия · Семинары ИПЗ');
});

test('parseGroupTable отдаёт пустой список для пустого ttable', () => {
  assert.deepEqual(parseGroupTable('<p>Выберите группу</p>'), []);
});

test('parseGroupTable сортирует дни по дате', () => {
  const days = parseGroupTable(TTABLE);
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  assert.deepEqual(days.map((d) => d.date), sorted.map((d) => d.date));
});
