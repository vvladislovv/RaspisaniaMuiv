/** Форматирование расписания в сообщения Telegram (MarkdownV2). */
import type { Day, Lesson } from './parse';

const MDV2_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/** Экранирует текст для MarkdownV2 — иначе символы из Excel ломают сообщение. */
export function esc(s: string): string {
  return s.replace(MDV2_SPECIAL, (c) => '\\' + c);
}

const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

const SHORT_DAYS: Record<string, string> = {
  Понедельник: 'Пн',
  Вторник: 'Вт',
  Среда: 'Ср',
  Четверг: 'Чт',
  Пятница: 'Пт',
  Суббота: 'Сб',
  Воскресенье: 'Вс',
};

/** `2026-09-01` → `1 сентября`. */
export function humanDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS_GEN[m - 1]}`;
}

/** «Понедельник» → «Пн». */
export function shortDay(dayName: string): string {
  return SHORT_DAYS[dayName] ?? dayName.slice(0, 2);
}

/** «Соломин Максим Сергеевич» → «Соломин М. С.» */
export function shortName(fio: string): string {
  const parts = fio.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return fio;
  const initials = parts.slice(1).map((p) => p[0].toUpperCase() + '.').join(' ');
  return `${parts[0]} ${initials}`;
}

/** Приводит «8:20-09:50» к «8:20–09:50». */
function prettyTime(time: string): string {
  return time.replace(/\s*-\s*/, '–');
}

/** «2 пары», «5 пар» — правильная форма после числа. */
export function pairsWord(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'пар';
  if (mod10 === 1) return 'пара';
  if (mod10 >= 2 && mod10 <= 4) return 'пары';
  return 'пар';
}

/** Строки одной пары внутри цитаты. */
function lessonLines(lesson: Lesson): string[] {
  const meta: string[] = [];
  if (lesson.teacher) meta.push(esc(shortName(lesson.teacher)));
  if (lesson.room) meta.push(esc(`ауд. ${lesson.room}`));

  const lines = [
    `*${lesson.pair}\\.* *${esc(prettyTime(lesson.time))}*`,
    esc(lesson.subject),
  ];
  if (meta.length > 0) lines.push(`_${meta.join(' · ')}_`);
  return lines;
}

/**
 * Собирает цитату MarkdownV2. Каждая строка начинается с `>`.
 * `expandable` делает цитату раскрывающейся: в списке дней видно только
 * начало, остальное открывается тапом.
 */
export function quote(lines: string[], expandable = false): string {
  const body = lines.map((line) => '>' + line);
  if (!expandable) return body.join('\n');
  // Пустая жирная разметка перед `>` отделяет цитату от предыдущей,
  // а `||` в конце помечает её как раскрывающуюся.
  return '**' + body.join('\n') + '||';
}

/**
 * Подпись эмодзи в MarkdownV2.
 *
 * Кастомный эмодзи задаётся как `![глиф](tg://emoji?id=...)`. Глиф в скобках —
 * запасной: его показывают там, где кастомный отобразить нельзя (уведомления,
 * пересылка не-Premium пользователем).
 */
export function emojiTag(glyph: string, customId: string | null): string {
  if (!customId) return glyph;
  return `![${esc(glyph)}](tg://emoji?id=${customId})`;
}

export interface DayMessageOptions {
  group: string;
  /** «Дата обновления» файла на сайте — показываем, чтобы было видно свежесть. */
  siteUpdated?: string | null;
  /** Подпись сверху, например «Расписание на завтра». */
  heading?: string;
}

/** Расписание одной группы на один день: `null`, если пар нет в файле. */
export interface GroupDay {
  group: string;
  day: Day | null;
}

/** Пары одной группы в виде цитаты. */
function dayQuote(day: Day | null): string {
  if (!day || day.lessons.length === 0) return quote([`_${esc('Пар нет')}_`]);

  const lines: string[] = [];
  day.lessons.forEach((lesson, index) => {
    if (index > 0) lines.push('');
    lines.push(...lessonLines(lesson));
  });
  return quote(lines);
}

/**
 * Сообщение на один день сразу по нескольким группам.
 *
 * Группы в файле МУИВ часто делят одну колонку, поэтому людям нужно расписание
 * двух групп рядом. Название группы стоит над каждой цитатой — при двух блоках
 * не спутаешь, что чьё.
 */
export function formatDayFor(
  dateIso: string,
  dayName: string,
  blocks: GroupDay[],
  opts: {
    siteUpdated?: string | null;
    heading?: string;
    /** Группы, которых больше нет в файле: молчать об этом нельзя. */
    missing?: string[];
  } = {},
): string {
  const parts: string[] = [];

  if (opts.heading) parts.push(`_${esc(opts.heading)}_`);
  parts.push(`📅 *${esc(dayName)}, ${esc(humanDate(dateIso))}*`);

  for (const block of blocks) {
    parts.push('');
    parts.push(`👥 *${esc(block.group)}*`);
    parts.push(dayQuote(block.day));
  }

  if (blocks.length === 0 && (opts.missing?.length ?? 0) === 0) {
    parts.push('');
    parts.push(quote([`_${esc('Группа не выбрана')}_`]));
  }

  // Колледж иногда переименовывает группы или делит их на подгруппы.
  // Молча показывать «пар нет» в таком случае — худшее из возможного.
  for (const name of opts.missing ?? []) {
    parts.push('');
    parts.push(
      `⚠️ ${esc(`Группы «${name}» больше нет в расписании — выбери её заново.`)}`,
    );
  }

  if (opts.siteUpdated) {
    parts.push('');
    parts.push(`_${esc(`Файл обновлён: ${opts.siteUpdated}`)}_`);
  }

  return parts.join('\n');
}

/** Сообщение с расписанием на один день. */
export function formatDay(day: Day, opts: DayMessageOptions): string {
  const parts: string[] = [];

  if (opts.heading) parts.push(`_${esc(opts.heading)}_`);
  parts.push(`📅 *${esc(day.name)}, ${esc(humanDate(day.date))}*`);
  parts.push(`👥 *${esc(opts.group)}*`);
  parts.push('');

  if (day.lessons.length === 0) {
    parts.push(quote(['_Пар нет_']));
  } else {
    const lines: string[] = [];
    day.lessons.forEach((lesson, index) => {
      if (index > 0) lines.push('');
      lines.push(...lessonLines(lesson));
    });
    parts.push(quote(lines));
  }

  if (opts.siteUpdated) {
    parts.push('');
    parts.push(`_Файл обновлён: ${esc(opts.siteUpdated)}_`);
  }

  return parts.join('\n');
}

/** Сообщение «на этот день пар нет / нет данных». */
export function formatEmptyDay(
  dateIso: string,
  dayName: string,
  opts: DayMessageOptions,
): string {
  return formatDay({ date: dateIso, name: dayName, lessons: [] }, opts);
}

const TELEGRAM_LIMIT = 4096;

/**
 * Сообщение со всей неделей: каждый день — раскрывающаяся цитата, поэтому
 * сообщение читается как список дней, а подробности открываются тапом.
 * Режет на части, если не влезает в лимит.
 */
export function formatWeek(days: Day[], opts: DayMessageOptions): string[] {
  const header = [
    `*${esc(opts.heading ?? 'Расписание на неделю')}*`,
    `👥 *${esc(opts.group)}*`,
    '',
  ];

  const blocks = days.map((day) => {
    const title =
      `*${esc(day.name)}, ${esc(humanDate(day.date))}* — ` +
      `${day.lessons.length} ${esc(pairsWord(day.lessons.length))}`;

    if (day.lessons.length === 0) return quote([title, '_Пар нет_'], true);

    const lines = [title];
    day.lessons.forEach((lesson, index) => {
      if (index > 0) lines.push('');
      lines.push(...lessonLines(lesson));
    });
    return quote(lines, true);
  });

  if (blocks.length === 0) blocks.push(quote(['_Нет данных за эту неделю_']));

  const footer = opts.siteUpdated ? ['', `_Файл обновлён: ${esc(opts.siteUpdated)}_`] : [];

  const chunks: string[] = [];
  let current = [...header];

  for (const block of blocks) {
    const candidate = [...current, block].join('\n');
    if (candidate.length > TELEGRAM_LIMIT - 200 && current.length > header.length) {
      chunks.push(current.join('\n').trimEnd());
      current = [...header, block];
    } else {
      current.push(block);
    }
  }

  current.push(...footer);
  chunks.push(current.join('\n').trimEnd());
  return chunks;
}
