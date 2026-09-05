/**
 * Клавиатуры бота. Отдельным модулем, потому что нужны и обработчику нажатий,
 * и автоотправке — под закреплённым сообщением тоже должны быть кнопки.
 *
 * Единственная команда бота — /start. Всё остальное живёт в кнопках, поэтому
 * каждый экран обязан давать путь назад в меню.
 */
import type { Day } from './parse';
import { shortDay } from './format';
import type { InlineButton, InlineKeyboard } from './telegram';

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const TO_MENU = { text: '↩︎ Меню', callback_data: 'm' };

export interface MenuOptions {
  groups: string[];
  /** В личке предлагаем добавить бота в группу; в самой группе это не нужно. */
  isPrivate: boolean;
  /** Владельцу бота показываем вход в сводку. */
  isOwner: boolean;
  /** Имя бота для ссылки «добавить в группу». */
  username: string | null;
  /** Группа с темами, и человек сейчас не в той теме, куда идёт расписание. */
  offerTopic?: boolean;
}

/** Главное меню. Без выбранной группы показывать расписание нечего. */
export function menuKeyboard(opts: MenuOptions): InlineKeyboard {
  const rows: InlineKeyboard = [];

  if (opts.groups.length > 0) {
    rows.push([
      { text: '📅 Завтра', callback_data: 'day:1' },
      { text: '📅 Сегодня', callback_data: 'day:0' },
    ]);
    rows.push([{ text: '📖 Вся неделя', callback_data: 'week' }]);
    rows.push([
      {
        text: opts.groups.length > 1 ? '👥 Изменить группы' : '👥 Группы',
        callback_data: 'grp',
      },
    ]);
  } else {
    rows.push([{ text: '👥 Выбрать группу', callback_data: 'grp' }]);
  }

  // Тема выбирается тем, где нажали: список тем Bot API не отдаёт
  if (opts.offerTopic) {
    rows.push([{ text: '🧵 Слать в эту тему', callback_data: 'topic' }]);
  }

  // Ссылка открывает выбор группы прямо в Telegram — руками добавлять не нужно
  if (opts.isPrivate && opts.username) {
    rows.push([
      { text: '➕ Добавить в группу', url: `https://t.me/${opts.username}?startgroup=true` },
    ]);
  }

  rows.push([
    { text: '⚙️ Статус', callback_data: 'st' },
    { text: 'ℹ️ О боте', callback_data: 'about' },
  ]);

  // Писать баги и идеи можно только в личке: в группе у бота включён режим
  // приватности, обычных сообщений он там не видит. Поэтому из группы —
  // ссылкой в личку, а не кнопкой, которая ничего не смогла бы принять.
  rows.push([feedbackButton(opts.isPrivate, opts.username)]);

  if (opts.isOwner) rows.push([{ text: '🛠 Сводка', callback_data: 'adm' }]);

  return rows;
}

/**
 * Клавиатура листания расписания.
 *
 * Даты в `callback_data` вместо индексов: кнопка остаётся рабочей и после того,
 * как колледж выложит новый файл. Активный день помечен точками, день без пар —
 * точкой после названия.
 */
export interface GroupSwitch {
  groups: string[];
  activeIndex: number;
  /** Дата, к которой относится показанная неделя. */
  dateIso: string;
}

export function scheduleKeyboard(
  days: Day[],
  active: string | null,
  weekStart: string | null,
  allWeeks: string[],
  groupSwitch?: GroupSwitch,
  /** Группы, которых нет в файле: нужна кнопка, чтобы выбрать заново. */
  missingGroups: string[] = [],
): InlineKeyboard {
  // Показывать нечего: ни дней, ни рабочих групп
  if (days.length === 0) {
    const rows: InlineKeyboard = [];
    if (missingGroups.length > 0) {
      rows.push([{ text: '👥 Выбрать группу', callback_data: 'grp' }]);
    }
    rows.push([TO_MENU]);
    return rows;
  }

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

  // В режиме недели показываем расписание одной группы: две недели рядом
  // не читаются. Поэтому даём переключатель, если групп выбрано больше одной.
  if (groupSwitch && groupSwitch.groups.length > 1) {
    rows.push(
      groupSwitch.groups.map((group, index) => ({
        text: index === groupSwitch.activeIndex ? `· ${group} ·` : group,
        callback_data: `wg:${index}:${groupSwitch.dateIso}`,
      })),
    );
  }

  // Одна группа потерялась, а другая работает: расписание показываем и дни
  // листать даём, но кнопку «выбрать заново» ставим тут же, а не в меню
  if (missingGroups.length > 0) {
    rows.push([{ text: '👥 Выбрать группу', callback_data: 'grp' }]);
  }

  rows.push([TO_MENU]);
  return rows;
}

/**
 * Кнопка «Баг или идея».
 *
 * В личке это обычная кнопка. Из группы — ссылка `?start=fb`, которая
 * открывает личку сразу на выборе тега; без имени бота ссылку не собрать,
 * поэтому там остаётся кнопка с объяснением.
 */
export function feedbackButton(isPrivate: boolean, username: string | null): InlineButton {
  const text = '🐞 Баг или идея';
  if (isPrivate || !username) return { text, callback_data: 'fb' };
  return { text, url: `https://t.me/${username}?start=fb` };
}

/** Выбор тега сообщения: без тега владельцу непонятно, что чинить первым. */
export function feedbackKindKeyboard(): InlineKeyboard {
  return [
    [
      { text: '🐞 Баг', callback_data: 'fb:bug' },
      { text: '💡 Предложение', callback_data: 'fb:idea' },
    ],
    [TO_MENU],
  ];
}

/** Экран ожидания текста: единственный выход — передумать. */
export function feedbackCancelKeyboard(): InlineKeyboard {
  return [[{ text: '✖️ Отмена', callback_data: 'fb' }], [TO_MENU]];
}

/** Выбор курса (листа файла). */
export function sheetKeyboard(sheets: string[]): InlineKeyboard {
  const rows: InlineKeyboard = sheets.map((sheet, i) => [
    { text: sheet, callback_data: `s:${i}` },
  ]);
  rows.push([TO_MENU]);
  return rows;
}

const GROUPS_PER_PAGE = 24;

/** Список групп курса с постраничной прокруткой. */
export function groupKeyboard(
  groups: { group: string; index: number }[],
  sheetIndex: number,
  page: number,
  selected: string[] = [],
): InlineKeyboard {
  const pages = chunk(groups, GROUPS_PER_PAGE);
  const current = pages[page] ?? [];

  // Галочка показывает выбранные группы: нажатие снимает выбор, поэтому
  // человек видит, что выбрал, не выходя из списка
  const rows: InlineKeyboard = chunk(
    current.map((g) => ({
      text: selected.includes(g.group) ? `✓ ${g.group}` : g.group,
      callback_data: `g:${g.index}`,
    })),
    3,
  );

  const nav: InlineKeyboard[number] = [];
  if (page > 0) nav.push({ text: '◀︎', callback_data: `p:${sheetIndex}:${page - 1}` });
  nav.push({ text: '↩︎ Курсы', callback_data: 'grp' });
  if (page + 1 < pages.length) {
    nav.push({ text: '▶︎', callback_data: `p:${sheetIndex}:${page + 1}` });
  }
  rows.push(nav);
  rows.push([
    selected.length > 0
      ? { text: `✔︎ Готово (${selected.length})`, callback_data: 'm' }
      : TO_MENU,
  ]);

  return rows;
}

/** Экран статуса: переключатель автоотправки и путь назад. */
export function statusKeyboard(enabled: boolean): InlineKeyboard {
  return [
    [
      enabled
        ? { text: '🔕 Выключить автоотправку', callback_data: 'off' }
        : { text: '🔔 Включить автоотправку', callback_data: 'on' },
    ],
    [TO_MENU],
  ];
}
