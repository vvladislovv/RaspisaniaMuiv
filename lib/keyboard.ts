/**
 * Клавиатура листания расписания. Отдельным модулем, потому что нужна и боту
 * (ответы на команды), и автоотправке — под закреплённым сообщением тоже
 * должны быть кнопки.
 */
import type { Day } from './parse';
import { shortDay } from './format';
import type { InlineKeyboard } from './telegram';

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Даты в `callback_data` вместо индексов: кнопка остаётся рабочей и после того,
 * как колледж выложит новый файл. Активный день помечен точками, день без пар —
 * точкой после названия.
 */
export function scheduleKeyboard(
  days: Day[],
  active: string | null,
  weekStart: string | null,
  allWeeks: string[],
): InlineKeyboard {
  const rows: InlineKeyboard = chunk(
    days.map((day) => {
      const label = shortDay(day.name) + (day.lessons.length === 0 ? ' ·' : '');
      return {
        text: active === day.date ? `· ${label} ·` : label,
        callback_data: `d:${day.date}`,
      };
    }),
    3,
  );

  const anchor = days[0]?.date ?? weekStart;

  if (anchor) {
    rows.push([
      active === null
        ? { text: '📅 По дням', callback_data: `d:${anchor}` }
        : { text: '📖 Вся неделя', callback_data: `w:${anchor}` },
    ]);
  }

  // Переходы между неделями — только если другая неделя реально есть в базе
  const week = weekStart ?? days[0]?.date ?? null;
  if (week && allWeeks.length > 1) {
    const index = allWeeks.indexOf(week);
    const nav: InlineKeyboard[number] = [];
    if (index > 0) {
      nav.push({ text: '◀︎ Пред. неделя', callback_data: `w:${allWeeks[index - 1]}` });
    }
    if (index !== -1 && index + 1 < allWeeks.length) {
      nav.push({ text: 'След. неделя ▶︎', callback_data: `w:${allWeeks[index + 1]}` });
    }
    if (nav.length > 0) rows.push(nav);
  }

  return rows;
}
