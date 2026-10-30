/**
 * Клавиатуры бота. Отдельным модулем, потому что нужны и обработчику нажатий,
 * и автоотправке — под закреплённым сообщением тоже должны быть кнопки.
 *
 * Единственная команда бота — /start. Всё остальное живёт в кнопках, поэтому
 * каждый экран обязан давать путь назад в меню.
 */
import type { Day } from './parse';
import { shortDay } from './format';
import { displayGroup } from './aliases';
import { dayExamKind, EXAM_MARK } from './exam';
import type { AccessStatus } from './db';
import type { InlineButton, InlineKeyboard } from './telegram';

/** Один экран: текст сообщения и кнопки под ним. */
export interface Screen {
  text: string;
  keyboard: InlineKeyboard;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Страница списка. Номер приводится в допустимые границы: список мог
 * сократиться (человека одобрили — он ушёл из «Ждут»), а номер в старой
 * кнопке — указывать за конец.
 */
export function pageOf<T>(
  items: T[],
  page: number,
  size: number,
): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const wanted = Number.isInteger(page) ? page : 0;
  const current = Math.min(Math.max(wanted, 0), pages - 1);
  return { items: items.slice(current * size, (current + 1) * size), page: current, pages };
}

const TO_MENU = { text: '↩︎ Меню', callback_data: 'm' };
const TO_ADMIN = { text: '↩︎ Сводка', callback_data: 'adm' };

/** Разделы экрана «Доступ»: буква — то, что влезает в `callback_data`. */
export type AccessSection = 'p' | 'a' | 'd';

export const ACCESS_SECTIONS: Record<
  AccessSection,
  { status: AccessStatus; title: string; emoji: string }
> = {
  p: { status: 'pending', title: 'Ждут решения', emoji: '⏳' },
  a: { status: 'approved', title: 'Одобрены', emoji: '✅' },
  d: { status: 'denied', title: 'Отказано', emoji: '⛔️' },
};

export function isAccessSection(value: string | undefined): value is AccessSection {
  return value === 'p' || value === 'a' || value === 'd';
}

/** Сколько человек на странице раздела: строка кнопок на каждого плюс навигация. */
export const ACCESS_PAGE_SIZE = 8;

/** Длинное имя на кнопке Telegram всё равно обрежет — делаем это сами и аккуратно. */
const BUTTON_LABEL_MAX = 28;

function buttonLabel(text: string): string {
  const chars = Array.from(text);
  return chars.length > BUTTON_LABEL_MAX ? `${chars.slice(0, BUTTON_LABEL_MAX - 1).join('')}…` : text;
}

/** Обзор доступа: три раздела вместо одной простыни на сотни людей. */
export function accessOverviewKeyboard(counts: Record<AccessStatus, number>): InlineKeyboard {
  return [
    [{ text: `⏳ Ждут решения (${counts.pending})`, callback_data: 'acc:p:0' }],
    [
      { text: `✅ Одобрены (${counts.approved})`, callback_data: 'acc:a:0' },
      { text: `⛔️ Отказано (${counts.denied})`, callback_data: 'acc:d:0' },
    ],
    [{ text: '🔄 Обновить', callback_data: 'admacc' }, TO_ADMIN],
  ];
}

/**
 * Страница раздела доступа: по строке кнопок на человека.
 *
 * Номер раздела и страницы едут в кнопке решения, чтобы после нажатия
 * вернуться на ту же страницу, а не листать список заново.
 */
export function accessSectionKeyboard(
  section: AccessSection,
  people: { id: number; label: string }[],
  page: number,
  pages: number,
): InlineKeyboard {
  const where = `${section}:${page}`;
  const rows: InlineKeyboard = people.map(({ id, label }) => {
    const name = buttonLabel(label);
    if (section === 'p') {
      return [
        { text: `✅ ${name}`, callback_data: `ok:${id}:${where}` },
        { text: '⛔️', callback_data: `no:${id}:${where}` },
      ];
    }
    if (section === 'a') return [{ text: `🚫 Отозвать: ${name}`, callback_data: `no:${id}:${where}` }];
    return [{ text: `✅ Разрешить: ${name}`, callback_data: `ok:${id}:${where}` }];
  });

  if (pages > 1) {
    const nav: InlineKeyboard[number] = [];
    if (page > 0) nav.push({ text: '◀︎', callback_data: `acc:${section}:${page - 1}` });
    nav.push({ text: `${page + 1} / ${pages}`, callback_data: `acc:${section}:${page}` });
    if (page + 1 < pages) nav.push({ text: '▶︎', callback_data: `acc:${section}:${page + 1}` });
    rows.push(nav);
  }

  rows.push([{ text: '↩︎ Доступ', callback_data: 'admacc' }, TO_ADMIN]);
  return rows;
}

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

/** Переключатель групп в режиме недели: активная отмечена точками. */
function groupSwitchRow(groupSwitch: GroupSwitch): InlineKeyboard[number] {
  return groupSwitch.groups.map((group, index) => ({
    text: index === groupSwitch.activeIndex ? `· ${displayGroup(group)} ·` : displayGroup(group),
    callback_data: `wg:${index}:${groupSwitch.dateIso}`,
  }));
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
  // Показывать нечего: у этой группы ещё нет недели в базе. Переключатель
  // групп всё равно нужен — у второй группы расписание может уже быть
  if (days.length === 0) {
    const rows: InlineKeyboard = [];
    if (groupSwitch && groupSwitch.groups.length > 1) rows.push(groupSwitchRow(groupSwitch));
    if (missingGroups.length > 0) {
      rows.push([{ text: '👥 Выбрать группу', callback_data: 'grp' }]);
    }
    rows.push([TO_MENU]);
    return rows;
  }

  const rows: InlineKeyboard = chunk(
    days.map((day) => {
      const kind = dayExamKind(day);
      const label =
        shortDay(day.name) +
        (day.lessons.length === 0 ? ' ·' : '') +
        (kind ? ` ${EXAM_MARK[kind].dot}` : '');
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
  if (groupSwitch && groupSwitch.groups.length > 1) rows.push(groupSwitchRow(groupSwitch));

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

/** Группа каталога с формой обучения и номером для `callback_data`. */
export interface PickerGroup {
  group: string;
  index: number;
  form: string;
}

/** Порядок форм обучения на экране; незнакомая форма (если появится) идёт в конце. */
const FORM_ORDER = ['Очная', 'Заочная', 'Очно-заочная'];

/** Формы, которые есть в списке групп курса, в привычном порядке. */
export function formsOf(groups: { form: string }[]): string[] {
  const rank = (form: string) => {
    const i = FORM_ORDER.indexOf(form);
    return i === -1 ? FORM_ORDER.length : i;
  };
  return [...new Set(groups.map((g) => g.form))].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b, 'ru'),
  );
}

/** Код формы обучения в начале имени: «к/о/к », «к/з/д », «к/оз/д ». */
const FORM_CODE = /^к\/[а-яё/]+\s+/i;

/**
 * Имя группы для кнопки. Код формы срезаем: форма уже выбрана на прошлом
 * экране, а на узкой кнопке он съедал место и имена были не отличить.
 */
export function shortGroupLabel(group: string): string {
  return displayGroup(group).replace(FORM_CODE, '');
}

/** Дольше этого имя в две колонки на телефоне обрежется. */
const PAIR_LABEL_MAX = 14;
const PAIRS_PER_PAGE = 24;
const SINGLES_PER_PAGE = 12;

/** Выбор формы обучения: кнопка на форму со счётчиком групп. */
export function formKeyboard(
  sheetIndex: number,
  forms: { form: string; count: number }[],
): InlineKeyboard {
  const rows: InlineKeyboard = forms.map(({ form, count }, formIndex) => [
    { text: `${form} · ${count}`, callback_data: `p:${sheetIndex}:0:${formIndex}` },
  ]);
  rows.push([{ text: '↩︎ Курсы', callback_data: 'grp' }]);
  rows.push([TO_MENU]);
  return rows;
}

/**
 * Список групп курса (и формы) с постраничной прокруткой.
 *
 * `formIndex` — номер формы в `formsOf`; `null` — формы не выбирали (одна
 * форма на курсе или старая кнопка), тогда он не едет в `callback_data`.
 * `backToForms` — вести «назад» к выбору формы, а не к курсам.
 */
export function groupKeyboard(
  groups: PickerGroup[] | { group: string; index: number }[],
  sheetIndex: number,
  page: number,
  selected: string[] = [],
  formIndex: number | null = null,
  backToForms = false,
): InlineKeyboard {
  const labelOf = (g: { group: string }) => shortGroupLabel(g.group);
  const paired = groups.every((g) => Array.from(labelOf(g)).length <= PAIR_LABEL_MAX);
  const perRow = paired ? 2 : 1;
  const pages = chunk(groups, paired ? PAIRS_PER_PAGE : SINGLES_PER_PAGE);
  // Страница приходит из нажатия, а его можно подделать: «-5» или «99»
  // не должны давать пустой список со стрелками в никуда
  const shown = Math.min(Math.max(page, 0), Math.max(pages.length - 1, 0));
  const current = pages[shown] ?? [];

  // Галочка показывает выбранные группы: нажатие снимает выбор, поэтому
  // человек видит, что выбрал, не выходя из списка
  const rows: InlineKeyboard = chunk(
    current.map((g) => ({
      text: selected.includes(g.group) ? `✓ ${labelOf(g)}` : labelOf(g),
      callback_data: `g:${g.index}`,
    })),
    perRow,
  );

  const at = (target: number) =>
    `p:${sheetIndex}:${target}` + (formIndex === null ? '' : `:${formIndex}`);

  const nav: InlineKeyboard[number] = [];
  if (shown > 0) nav.push({ text: '◀︎', callback_data: at(shown - 1) });
  nav.push(
    backToForms
      ? { text: '↩︎ Формы', callback_data: `s:${sheetIndex}` }
      : { text: '↩︎ Курсы', callback_data: 'grp' },
  );
  if (shown + 1 < pages.length) nav.push({ text: '▶︎', callback_data: at(shown + 1) });
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
