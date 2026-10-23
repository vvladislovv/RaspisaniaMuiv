/**
 * Экран расписания на один день — общий для кнопок бота, рассылки и
 * перерисовки закрепа. Раньше у бота и у рассылки была своя копия, и правка
 * в одной из них легко не доезжала до другой.
 */
import { currentGroups, getWeek, weekDates } from './db';
import { formatDayFor, type GroupDay } from './format';
import { scheduleKeyboard } from './keyboard';
import type { Day } from './parse';
import { weekCovers } from './sweep';
import type { InlineKeyboard } from './telegram';
import { dayNameOf } from './time';

/**
 * Дни недели для клавиатуры: берём все даты недели из файла, а не только те,
 * где у группы есть пары. Иначе у группы с двумя учебными днями клавиатура
 * состояла бы из двух кнопок, и в пустой день нельзя было бы заглянуть.
 */
async function keyboardDays(
  perGroup: { days: Day[]; file: { id: number } | null }[],
): Promise<Day[]> {
  const withLessons = new Map<string, Day>();
  for (const { days } of perGroup) {
    for (const day of days) {
      const known = withLessons.get(day.date);
      if (!known || known.lessons.length === 0) withLessons.set(day.date, day);
    }
  }

  const file = perGroup.find((w) => w.file)?.file ?? null;
  const dates = file ? await weekDates(file.id) : [...withLessons.keys()];

  return dates.sort().map(
    (date) => withLessons.get(date) ?? { date, name: dayNameOf(date), lessons: [] },
  );
}

export interface RenderedDay {
  text: string;
  keyboard: InlineKeyboard;
  /**
   * Группы, чьей недели с этой датой в базе нет: им нельзя писать «Пар нет»,
   * и рассылка по ним ждёт, пока расписание скачается.
   */
  unready: string[];
}

/**
 * День сразу по всем выбранным группам: в один день пары обеих групп
 * читаются рядом, и переключать ничего не нужно.
 */
export async function renderDay(
  chatId: number,
  stored: string[],
  dateIso: string,
  weeks: string[],
  heading?: string,
): Promise<RenderedDay> {
  const { groups, missing } = await currentGroups(chatId, stored);
  const perGroup = await Promise.all(groups.map((group) => getWeek(group, dateIso)));

  const blocks: GroupDay[] = groups.map((group, index) => ({
    group,
    day: perGroup[index].days.find((d) => d.date === dateIso) ?? null,
    noData: !weekCovers(perGroup[index].file, dateIso),
  }));

  const file = perGroup.find((w) => w.file)?.file ?? null;

  // Для клавиатуры дни объединяем: точка «пар нет» гаснет, если пары есть
  // хотя бы у одной группы
  const merged = await keyboardDays(perGroup);
  const hasDay = blocks.some((b) => b.day);

  return {
    text: formatDayFor(dateIso, dayNameOf(dateIso), blocks, {
      siteUpdated: file?.site_updated ?? null,
      heading,
      missing,
    }),
    keyboard: scheduleKeyboard(
      merged,
      hasDay ? dateIso : null,
      file?.week_start ?? null,
      weeks,
      undefined,
      missing,
    ),
    unready: blocks.filter((b) => b.noData).map((b) => b.group),
  };
}
