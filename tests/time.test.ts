import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayNameOf, isSaturdayMsk, mskDateOffset, mskParts, mskToday } from '../lib/time';

test('mskParts сдвигает UTC на +3', () => {
  // 2026-09-01T22:30:00Z — это уже 2 сентября 01:30 по Москве
  const p = mskParts(new Date('2026-09-01T22:30:00Z'));
  assert.equal(p.day, 2);
  assert.equal(p.hour, 1);
  assert.equal(p.minute, 30);
});

test('mskToday учитывает переход суток по МСК', () => {
  assert.equal(mskToday(new Date('2026-09-01T21:00:00Z')), '2026-09-02');
  assert.equal(mskToday(new Date('2026-09-01T20:59:00Z')), '2026-09-01');
});

test('mskDateOffset даёт завтрашнюю дату по МСК', () => {
  assert.equal(mskDateOffset(1, new Date('2026-08-31T13:00:00Z')), '2026-09-01');
  assert.equal(mskDateOffset(0, new Date('2026-08-31T13:00:00Z')), '2026-08-31');
});

test('dayNameOf называет день недели', () => {
  assert.equal(dayNameOf('2026-08-31'), 'Понедельник');
  assert.equal(dayNameOf('2026-09-05'), 'Суббота');
});

test('isSaturdayMsk определяет субботу по московскому времени', () => {
  // 2026-09-05 — суббота; 13:00 UTC = 16:00 МСК
  assert.equal(isSaturdayMsk(new Date('2026-09-05T13:00:00Z')), true);
  assert.equal(isSaturdayMsk(new Date('2026-09-04T13:00:00Z')), false);
  // пятница 22:00 UTC = суббота 01:00 МСК
  assert.equal(isSaturdayMsk(new Date('2026-09-04T22:00:00Z')), true);
});

test('mondayOf опознаёт неделю по её понедельнику', async () => {
  const { mondayOf } = await import('../lib/time');

  // Колледж перезалил файл, и начало недели сместилось с 31.08 на 01.09 —
  // понедельник обязан совпасть
  assert.equal(mondayOf('2026-08-31'), '2026-08-31');
  assert.equal(mondayOf('2026-09-01'), '2026-08-31');
  assert.equal(mondayOf('2026-09-05'), '2026-08-31');
  // Воскресенье относится к своей неделе, а не к следующей
  assert.equal(mondayOf('2026-09-06'), '2026-08-31');
  assert.equal(mondayOf('2026-09-07'), '2026-09-07');
  assert.equal(mondayOf('2026-09-12'), '2026-09-07');
});

test('mskDayStart — полночь по Москве, а не по UTC', async () => {
  const { mskDayStart } = await import('../lib/time');

  // 23 октября 13:00 МСК — сутки начались в 21:00 UTC накануне
  assert.equal(mskDayStart(new Date('2026-10-23T10:00:00Z')), '2026-10-22T21:00:00.000Z');
  // 23 октября 23:30 по UTC — это уже 24-е по Москве
  assert.equal(mskDayStart(new Date('2026-10-23T21:30:00Z')), '2026-10-23T21:00:00.000Z');
  // Минута до полуночи по Москве — ещё 23-е
  assert.equal(mskDayStart(new Date('2026-10-23T20:59:00Z')), '2026-10-22T21:00:00.000Z');
});

test('isIsoDate пропускает только настоящие даты', async () => {
  const { isIsoDate } = await import('../lib/time');

  assert.equal(isIsoDate('2026-10-24'), true);
  assert.equal(isIsoDate('2028-02-29'), true);
  for (const bad of ['2026-13-01', '2026-02-30', '2027-02-29', '2026-1-1', 'abc', '', '2026-10-24x']) {
    assert.equal(isIsoDate(bad), false, bad);
  }
});

test('weekAnchor переводит на следующую неделю только в воскресенье', async () => {
  const { weekAnchor } = await import('../lib/time');

  // Будни и суббота: неделя та же, что и сегодня. В субботу пары ещё идут,
  // и колледж иногда правит файл текущей недели прямо в этот день
  assert.equal(weekAnchor(new Date('2026-09-04T13:00:00Z')), '2026-09-04');
  assert.equal(weekAnchor(new Date('2026-09-05T13:00:00Z')), '2026-09-05');
  // Воскресенье: показываем уже следующую неделю
  assert.equal(weekAnchor(new Date('2026-09-06T13:00:00Z')), '2026-09-07');
  // Суббота 22:00 UTC — это уже воскресенье по МСК
  assert.equal(weekAnchor(new Date('2026-09-05T22:00:00Z')), '2026-09-07');
  // Понедельник снова обычный день
  assert.equal(weekAnchor(new Date('2026-09-07T13:00:00Z')), '2026-09-07');
});
