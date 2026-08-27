/**
 * Разбор xlsx с расписанием колледжа МУИВ в структуру по группам и дням.
 *
 * Формат листа (проверено на файлах осеннего семестра 2026/27):
 *   строка 1  — заголовки: «День недели», «Время», «Пара», далее по колонке на группу.
 *               В одной ячейке может быть несколько групп, разделённых переводом строки.
 *   строки 2–4 — специальность, коды КБ, количество студентов (не используются).
 *   далее      — блоки по 5 строк на день: Пн…Сб. Название дня с датой лежит в
 *               объединённой ячейке колонки «День недели».
 *   Правая половина листа — дубликат для печати; колонки после второго
 *               «День недели» игнорируются.
 */
import { readWorkbook, resolveMerges, colToIndex, indexToCol, type Sheet } from './xlsx';

export interface Lesson {
  pair: number;
  time: string;
  subject: string;
  teacher: string | null;
  room: string | null;
  /** Исходный текст ячейки — на случай нестандартного содержимого. */
  raw: string;
}

export interface Day {
  /** ISO-дата, `2026-09-01`. */
  date: string;
  /** «Вторник». */
  name: string;
  lessons: Lesson[];
}

export interface GroupSchedule {
  group: string;
  /** Лист, на котором нашли группу, — используется как «курс» в кнопках. */
  sheet: string;
  days: Day[];
}

export interface Workbook {
  /** ISO-дата понедельника недели. */
  weekStart: string | null;
  groups: GroupSchedule[];
}

const DAY_NAMES = [
  'Понедельник',
  'Вторник',
  'Среда',
  'Четверг',
  'Пятница',
  'Суббота',
  'Воскресенье',
];

const DAY_RE = new RegExp(`^\\s*(${DAY_NAMES.join('|')})\\s*[,.]?\\s*(\\d{2})\\.(\\d{2})\\.(\\d{4})`, 'i');

const HEADER_DAY = 'день недели';
const HEADER_TIME = 'время';
const HEADER_PAIR = 'пара';

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

interface Layout {
  headerRow: number;
  dayCol: number;
  timeCol: number;
  pairCol: number;
  /** Колонка → список групп в этой колонке. */
  groupCols: Map<number, string[]>;
}

/** Находит строку заголовков и колонки групп. */
function detectLayout(sheet: Sheet): Layout | null {
  for (let row = 1; row <= Math.min(sheet.maxRow, 12); row++) {
    const byCol = new Map<number, string>();
    for (let c = 1; c <= 80; c++) {
      const v = sheet.cells.get(indexToCol(c) + row);
      if (v) byCol.set(c, v);
    }

    const dayCols = [...byCol].filter(([, v]) => norm(v) === HEADER_DAY).map(([c]) => c);
    const timeCol = [...byCol].find(([, v]) => norm(v) === HEADER_TIME)?.[0];
    const pairCol = [...byCol].find(([, v]) => norm(v) === HEADER_PAIR)?.[0];

    if (dayCols.length === 0 || timeCol === undefined || pairCol === undefined) continue;

    // Колонки групп — между «Пара» и началом дубликата для печати
    const dayCol = dayCols[0];
    const limit = dayCols.find((c) => c > pairCol) ?? 81;

    const groupCols = new Map<number, string[]>();
    for (let c = pairCol + 1; c < limit; c++) {
      const header = byCol.get(c);
      if (!header) continue;
      const names = header
        .split(/\r?\n/)
        .map((s) => s.replace(/\s+/g, ' ').trim())
        .filter((s) => s.length >= 3 && !/^специальность/i.test(s));
      if (names.length > 0) groupCols.set(c, names);
    }

    if (groupCols.size === 0) continue;
    return { headerRow: row, dayCol, timeCol, pairCol, groupCols };
  }
  return null;
}

const FIO_RE = /^[А-ЯЁ][а-яё-]+\s+[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)?$/;

/** Разбирает ячейку пары: предмет / преподаватель / аудитория. */
export function parseLesson(raw: string, pair: number, time: string): Lesson | null {
  const lines = raw
    .split(/\r?\n/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  let room: string | null = null;
  const roomIdx = lines.findIndex((l) => /^ауд\.?\s/i.test(l));
  if (roomIdx !== -1) {
    room = lines[roomIdx].replace(/^ауд\.?\s*/i, '').trim();
    lines.splice(roomIdx, 1);
  }

  let teacher: string | null = null;
  for (let i = lines.length - 1; i >= 1; i--) {
    if (FIO_RE.test(lines[i])) {
      teacher = lines[i];
      lines.splice(i, 1);
      break;
    }
  }

  const subject = lines.join(' · ').trim();
  if (!subject) return null;

  return { pair, time, subject, teacher, room, raw };
}

function toIso(d: number, m: number, y: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseSheet(sheet: Sheet, seenDates: Set<string>): GroupSchedule[] {
  resolveMerges(sheet);

  const layout = detectLayout(sheet);
  if (!layout) return [];

  const { headerRow, dayCol, timeCol, pairCol, groupCols } = layout;

  // группа → дата → пары
  const acc = new Map<string, Map<string, { name: string; lessons: Lesson[] }>>();
  for (const names of groupCols.values()) {
    for (const n of names) if (!acc.has(n)) acc.set(n, new Map());
  }

  for (let row = headerRow + 1; row <= sheet.maxRow; row++) {
    const dayCell = sheet.cells.get(indexToCol(dayCol) + row);
    if (!dayCell) continue;

    const m = DAY_RE.exec(dayCell);
    if (!m) continue;

    const dayName = DAY_NAMES.find((n) => n.toLowerCase() === m[1].toLowerCase()) ?? m[1];
    const date = toIso(Number(m[2]), Number(m[3]), Number(m[4]));

    seenDates.add(date);

    const time = sheet.cells.get(indexToCol(timeCol) + row) ?? '';
    const pairRaw = sheet.cells.get(indexToCol(pairCol) + row) ?? '';
    const pair = Number.parseInt(pairRaw, 10);
    if (!Number.isFinite(pair)) continue;

    for (const [col, names] of groupCols) {
      const cell = sheet.cells.get(indexToCol(col) + row);
      if (!cell) continue;

      const lesson = parseLesson(cell, pair, time.replace(/\s+/g, ''));
      if (!lesson) continue;

      for (const name of names) {
        const byDate = acc.get(name)!;
        const day = byDate.get(date) ?? { name: dayName, lessons: [] };
        // одна и та же пара может продублироваться из объединённых ячеек
        if (!day.lessons.some((l) => l.pair === lesson.pair)) day.lessons.push(lesson);
        byDate.set(date, day);
      }
    }
  }

  const out: GroupSchedule[] = [];
  for (const [group, byDate] of acc) {
    const days: Day[] = [...byDate]
      .map(([date, d]) => ({
        date,
        name: d.name,
        lessons: d.lessons.sort((a, b) => a.pair - b.pair),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    if (days.length > 0) out.push({ group, sheet: sheet.name, days });
  }
  return out;
}

/** Разбирает весь файл. Бросает, если не нашлось ни одной группы. */
export function parseSchedule(buf: Buffer): Workbook {
  const sheets = readWorkbook(buf);
  const groups: GroupSchedule[] = [];
  const seenDates = new Set<string>();

  for (const sheet of sheets) {
    for (const g of parseSheet(sheet, seenDates)) {
      const existing = groups.find((x) => x.group === g.group);
      if (existing) {
        // группа встречается на нескольких листах — объединяем дни
        for (const day of g.days) {
          if (!existing.days.some((d) => d.date === day.date)) existing.days.push(day);
        }
        existing.days.sort((a, b) => a.date.localeCompare(b.date));
      } else {
        groups.push(g);
      }
    }
  }

  if (groups.length === 0) {
    throw new Error('Не найдено ни одной группы — формат файла изменился');
  }

  const weekStart = [...seenDates].sort()[0] ?? null;

  groups.sort((a, b) => a.group.localeCompare(b.group, 'ru'));
  return { weekStart, groups };
}
