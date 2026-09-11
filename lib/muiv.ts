/**
 * Доступ к расписанию колледжа на muiv.ru.
 *
 * Раньше сайт публиковал расписание файлами .xlsx с прямыми ссылками — этот
 * модуль их искал и решал JS-задачу Bitrix перед скачиванием. Осенью 2026
 * страница расписания стала виджетом «Курс → Форма обучения → Группа»,
 * который тянет расписание через POST на `ajax.php` и рисует HTML-таблицей;
 * файлов на странице больше нет. Сама загрузка теперь идёт через настоящий
 * браузер (см. `lib/browser.ts`) — WAF, вставший перед сайтом, не пускает
 * обычный fetch/curl даже с правильно решённой JS-задачей.
 */
import type { Page } from 'playwright-core';
import { postAjax } from './browser';
import type { Day, Lesson } from './parse';

export const SCHEDULE_URL = 'https://www.muiv.ru/studentu/spo/raspisanie/';
const ALLOWED_HOST = 'www.muiv.ru';

/** Фиксировано для страницы расписания колледжа СПО. */
const BRANCH = 'gv';
const FACULTY = 'Колледж (факультет СПО)';

/** Курсы, которые показывает сайт. */
export const COURSES = ['Курс 1', 'Курс 2', 'Курс 3', 'Курс 4'] as const;

function assertAllowed(url: string): void {
  const u = new URL(url, SCHEDULE_URL);
  if (u.protocol !== 'https:' || u.hostname !== ALLOWED_HOST) {
    throw new Error(`Недопустимый хост: ${u.href}`);
  }
}

/** Достаёт подписи из списка `<a data-type="item">Текст</a>`. */
function parseItems(html: string): string[] {
  const items: string[] = [];
  for (const m of html.matchAll(/<a[^>]*data-type="item"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (text) items.push(text);
  }
  return items;
}

/** Формы обучения для курса (`el=years`). Обычно одна — «Очная», но не хардкодим. */
export async function fetchStudyforms(page: Page, year: string): Promise<string[]> {
  assertAllowed(SCHEDULE_URL);
  const res = await postAjax(page, { el: 'years', branch: BRANCH, year, studyform: '', faculty: FACULTY, groupname: '' });
  return parseItems(res.studyform ?? '');
}

/** Список групп курса и формы обучения (`el=studyforms`). */
export async function fetchGroupNames(page: Page, year: string, studyform: string): Promise<string[]> {
  const res = await postAjax(page, { el: 'studyforms', branch: BRANCH, year, studyform, faculty: FACULTY, groupname: '' });
  return parseItems(res.groupName ?? '');
}

export interface GroupIdentity {
  group: string;
  year: string;
  studyform: string;
}

/** Расписание группы (`el=groupnames`) — скользящее окно от сегодняшней даты. */
export async function fetchGroupSchedule(page: Page, id: GroupIdentity): Promise<Day[]> {
  const res = await postAjax(page, {
    el: 'groupnames',
    branch: BRANCH,
    year: id.year,
    studyform: id.studyform,
    faculty: FACULTY,
    groupname: id.group,
  });
  return parseGroupTable(res.ttable ?? '');
}

/** Обходит весь каталог: курс × форма обучения → список групп с их (курс, форма). */
export async function fetchCatalog(page: Page): Promise<GroupIdentity[]> {
  const out: GroupIdentity[] = [];
  for (const year of COURSES) {
    const studyforms = await fetchStudyforms(page, year);
    for (const studyform of studyforms) {
      const groups = await fetchGroupNames(page, year, studyform);
      for (const group of groups) out.push({ group, year, studyform });
    }
  }
  return out;
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

// «08.09.2026 (вторник)»
const DAY_HEADING_RE = /<h2[^>]*>\s*(\d{2})\.(\d{2})\.(\d{4})\s*\(([^)]+)\)\s*<\/h2>/gi;

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toIso(d: number, m: number, y: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Разбирает одну `<TABLE>` пар дня в список занятий. */
function parseDayTable(tableHtml: string): Lesson[] {
  const rows = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  const lessons: Lesson[] = [];
  let pair = 0;

  for (const rowMatch of rows) {
    const cells = [...rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      stripTags(m[1]),
    );
    if (cells.length < 6) continue;
    // Первая строка — заголовок «Время занятия / Группа / ...»
    if (/^время/i.test(cells[0])) continue;

    const [time, , subject, room, kind, teacher] = cells;
    if (!time || !subject) continue;

    pair += 1;
    const parts = [subject, kind].filter(Boolean);
    lessons.push({
      pair,
      time: time.replace(/\s+/g, ''),
      subject: parts.join(' · '),
      teacher: teacher || null,
      room: room || null,
      raw: cells.join(' | '),
    });
  }

  return lessons;
}

/** Разбирает `ttable` — HTML со списком `<h2>дата</h2><table>...</table>` по дням. */
export function parseGroupTable(html: string): Day[] {
  const headings = [...html.matchAll(DAY_HEADING_RE)];
  const days: Day[] = [];

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const [, d, m, y, rawName] = h;
    const start = h.index! + h[0].length;
    const end = i + 1 < headings.length ? headings[i + 1].index! : html.length;
    const block = html.slice(start, end);

    const dayName =
      DAY_NAMES.find((n) => n.toLowerCase().startsWith(rawName.trim().toLowerCase())) ??
      rawName.trim();

    days.push({
      date: toIso(Number(d), Number(m), Number(y)),
      name: dayName,
      lessons: parseDayTable(block),
    });
  }

  return days.sort((a, b) => a.date.localeCompare(b.date));
}
