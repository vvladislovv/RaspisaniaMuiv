import { test } from 'node:test';
import assert from 'node:assert/strict';
import { examKind } from '../lib/exam';
import { formatDay, formatWeek } from '../lib/format';
import { scheduleKeyboard } from '../lib/keyboard';
import type { Day, Lesson } from '../lib/parse';

function lesson(subject: string, pair = 2): Lesson {
  return { pair, time: '10:00-11:30', subject, teacher: null, room: null, raw: subject };
}

function dayOf(...lessons: Lesson[]): Day {
  return { date: '2026-12-21', name: 'Понедельник', lessons };
}

test('examKind узнаёт экзамен в любом регистре и написании', () => {
  assert.equal(examKind(lesson('Экзамен · Математика')), 'exam');
  assert.equal(examKind(lesson('математика (ЭКЗАМЕН)')), 'exam');
  assert.equal(examKind(lesson('Квалификационный экзамен')), 'exam');
});

test('examKind узнаёт зачёт, в том числе с «е» вместо «ё» и дифференцированный', () => {
  assert.equal(examKind(lesson('Зачет · История')), 'credit');
  assert.equal(examKind(lesson('История (зачёт)')), 'credit');
  assert.equal(examKind(lesson('Дифференцированный зачет · Физика')), 'credit');
  assert.equal(examKind(lesson('Дифзачет Физика')), 'credit');
});

test('examKind не трогает обычные пары и консультации перед экзаменом', () => {
  assert.equal(examKind(lesson('Математика')), null);
  assert.equal(examKind(lesson('Консультация к экзамену · Математика')), null);
  assert.equal(examKind(lesson('Консультация перед зачётом')), null);
});

test('formatDay подписывает экзамен и зачёт на самой паре', () => {
  const text = formatDay(dayOf(lesson('Экзамен · Математика'), lesson('Зачет · История', 3)), {
    group: 'ФИН-25-11',
  });
  assert.match(text, /🔴 ЭКЗАМЕН/);
  assert.match(text, /🟡 ЗАЧЁТ/);
});

test('formatDay не подписывает обычную пару', () => {
  const text = formatDay(dayOf(lesson('Математика')), { group: 'ФИН-25-11' });
  assert.doesNotMatch(text, /ЭКЗАМЕН|ЗАЧЁТ/);
});

test('formatWeek выносит экзамен в заголовок дня — виден и в свёрнутой цитате', () => {
  const [text] = formatWeek([dayOf(lesson('Экзамен · Математика'))], { group: 'ФИН-25-11' });
  const title = text.split('\n').find((line) => line.includes('1 пара'));
  assert.ok(title, 'заголовок дня найден');
  assert.match(title, /🔴 ЭКЗАМЕН/);
});

test('кнопка дня с зачётом или экзаменом помечена кружком', () => {
  const days: Day[] = [
    dayOf(lesson('Экзамен · Математика')),
    { date: '2026-12-22', name: 'Вторник', lessons: [lesson('Зачет · История')] },
    { date: '2026-12-23', name: 'Среда', lessons: [lesson('Математика')] },
  ];
  const buttons = scheduleKeyboard(days, null, '2026-12-21', ['2026-12-21']).flat();
  const label = (date: string) => buttons.find((b) => b.callback_data === `d:${date}`)?.text;
  assert.equal(label('2026-12-21'), 'Пн 🔴');
  assert.equal(label('2026-12-22'), 'Вт 🟡');
  assert.equal(label('2026-12-23'), 'Ср');
});

test('если в день и зачёт, и экзамен — на кнопке экзамен', () => {
  const days: Day[] = [dayOf(lesson('Зачет · История'), lesson('Экзамен · Математика', 3))];
  const buttons = scheduleKeyboard(days, null, '2026-12-21', ['2026-12-21']).flat();
  assert.equal(buttons.find((b) => b.callback_data === 'd:2026-12-21')?.text, 'Пн 🔴');
});
