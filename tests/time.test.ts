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
