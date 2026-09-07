import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAlertOnStreak } from '../lib/sync';

test('первый промах сайта не будит владельца, второй будит', () => {
  // Один медленный ответ чужого сервера — не поломка: через час повторим
  assert.equal(shouldAlertOnStreak(1), false);
  // Файл недоступен больше часа — это уже похоже на аварию
  assert.equal(shouldAlertOnStreak(2), true);
  // Дальше молчим, чтобы многодневная авария не стала потоком сообщений
  for (const streak of [3, 4, 5, 11, 13, 23]) {
    assert.equal(shouldAlertOnStreak(streak), false, `серия ${streak}`);
  }
  // Напоминание раз в двенадцать часов
  assert.equal(shouldAlertOnStreak(12), true);
  assert.equal(shouldAlertOnStreak(24), true);
});
