/**
 * Работа с московским временем без внешних зависимостей.
 * Vercel запускает функции в UTC, а вся логика расписания — по МСК (UTC+3).
 */

export const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

const DAY_NAMES = [
  'Воскресенье', 'Понедельник', 'Вторник', 'Среда',
  'Четверг', 'Пятница', 'Суббота',
];

/** Компоненты текущего момента в МСК. */
export function mskParts(now: Date = new Date()) {
  const shifted = new Date(now.getTime() + MSK_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    /** 0 — воскресенье, 6 — суббота. */
    weekday: shifted.getUTCDay(),
  };
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Сегодняшняя дата по МСК в формате `2026-09-01`. */
export function mskToday(now: Date = new Date()): string {
  const p = mskParts(now);
  return iso(p.year, p.month, p.day);
}

/** Дата через `offset` дней от сегодняшней по МСК. */
export function mskDateOffset(offset: number, now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + MSK_OFFSET_MS + offset * 86_400_000);
  return iso(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** Название дня недели для ISO-даты. */
export function dayNameOf(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return DAY_NAMES[dt.getUTCDay()];
}

/** Суббота ли сегодня по МСК — по субботам автоотправку не делаем. */
export function isSaturdayMsk(now: Date = new Date()): boolean {
  return mskParts(now).weekday === 6;
}

/** Человекочитаемое время МСК для логов и статуса. */
export function mskStamp(date: Date): string {
  const p = mskParts(date);
  return (
    `${String(p.day).padStart(2, '0')}.${String(p.month).padStart(2, '0')}.${p.year} ` +
    `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} МСК`
  );
}

/**
 * Понедельник недели, в которую попадает дата.
 *
 * Устойчивый признак недели. Колледж перезаливает файл то под другим путём,
 * то под другим именем, и «начало недели» в новом файле может оказаться
 * вторником (31.08 против 01.09) — но понедельник у них один и тот же.
 */
export function mondayOf(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // getUTCDay(): 0 — воскресенье, поэтому его отматываем на шесть дней назад
  const shift = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - shift);
  return dt.toISOString().slice(0, 10);
}
