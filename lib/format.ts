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

/** `2026-09-01` → `1 сентября`. */
export function humanDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS_GEN[m - 1]}`;
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

function lessonLines(lesson: Lesson): string {
  const head = `*${lesson.pair}\\.* ${esc(prettyTime(lesson.time))}`;
  const subject = esc(lesson.subject);

  const meta: string[] = [];
  if (lesson.teacher) meta.push(esc(shortName(lesson.teacher)));
  if (lesson.room) meta.push(esc(`ауд. ${lesson.room}`));

  const tail = meta.length > 0 ? `\n    _${meta.join(' · ')}_` : '';
  return `${head}\n    ${subject}${tail}`;
}

export interface DayMessageOptions {
  group: string;
  /** «Дата обновления» файла на сайте — показываем, чтобы было видно свежесть. */
  siteUpdated?: string | null;
  /** Подпись сверху, например «Расписание на завтра». */
  heading?: string;
}

/** Сообщение с расписанием на один день. */
export function formatDay(day: Day, opts: DayMessageOptions): string {
  const parts: string[] = [];

  if (opts.heading) parts.push(`*${esc(opts.heading)}*`);
  parts.push(`📅 *${esc(day.name)}, ${esc(humanDate(day.date))}*`);
  parts.push(`👥 ${esc(opts.group)}`);
  parts.push('');

  if (day.lessons.length === 0) {
    parts.push('_Пар нет_');
  } else {
    parts.push(day.lessons.map(lessonLines).join('\n\n'));
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

/** Сообщение со всей неделей. Режет на части, если не влезает в лимит. */
export function formatWeek(days: Day[], opts: DayMessageOptions): string[] {
  const header = [`*${esc(opts.heading ?? 'Расписание на неделю')}*`, `👥 ${esc(opts.group)}`, ''];

  const blocks = days.map((day) => {
    const lines = [`📅 *${esc(day.name)}, ${esc(humanDate(day.date))}*`];
    lines.push(
      day.lessons.length === 0 ? '_Пар нет_' : day.lessons.map(lessonLines).join('\n\n'),
    );
    return lines.join('\n');
  });

  if (blocks.length === 0) blocks.push('_Нет данных за эту неделю_');

  const footer = opts.siteUpdated ? ['', `_Файл обновлён: ${esc(opts.siteUpdated)}_`] : [];

  const chunks: string[] = [];
  let current = [...header];

  for (const block of blocks) {
    const candidate = [...current, block, ''].join('\n');
    if (candidate.length > TELEGRAM_LIMIT - 200 && current.length > header.length) {
      chunks.push(current.join('\n').trimEnd());
      current = [...header, block, ''];
    } else {
      current.push(block, '');
    }
  }

  current.push(...footer);
  chunks.push(current.join('\n').trimEnd());
  return chunks;
}
