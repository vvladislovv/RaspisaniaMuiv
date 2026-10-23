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

test('лимит багов и предложений: 1 в день без доступа, 3 с доступом', async () => {
  const { FEEDBACK_PER_DAY, feedbackLimit } = await import('../lib/bot');
  assert.equal(FEEDBACK_PER_DAY.other, 1);
  assert.equal(FEEDBACK_PER_DAY.approved, 3);
  assert.equal(feedbackLimit(false), 1);
  assert.equal(feedbackLimit(true), 3);
});
