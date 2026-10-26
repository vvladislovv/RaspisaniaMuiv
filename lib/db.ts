/** Доступ к Supabase. Только серверный ключ, только с сервера. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';
import type { Day, Lesson, Workbook } from './parse';
import { mondayOf } from './time';

let client: SupabaseClient | null = null;

/** Коды, при которых имеет смысл повторить: шлюз не ответил или попросил ждать. */
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504, 522, 524]);
const DB_ATTEMPTS = 3;

/**
 * Можно ли безопасно повторить запрос.
 *
 * Чтение, изменение и удаление идемпотентны. Обычная вставка — нет: если
 * первая попытка на самом деле прошла, а ответ потерялся, повтор добавил бы
 * вторую строку. Исключение — upsert (`on_conflict` в адресе): он идемпотентен
 * по своей природе.
 */
function isRetryable(url: string, method: string): boolean {
  if (method === 'GET' || method === 'HEAD') return true;
  if (method === 'PATCH' || method === 'DELETE') return true;
  if (method === 'POST') return url.includes('on_conflict=');
  return false;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch с повторами для Supabase.
 *
 * Разовый `Gateway Timeout` от базы ронял всю проверку расписания. Повтор
 * задаётся здесь, одним местом на все запросы, а не в каждом вызове.
 */
async function retryingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  const retryable = isRetryable(url, method);

  let lastError: unknown;

  for (let attempt = 1; attempt <= DB_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(input, init);

      if (!retryable || !TRANSIENT_STATUS.has(res.status) || attempt === DB_ATTEMPTS) {
        return res;
      }

      console.warn(`База ответила ${res.status}, попытка ${attempt} из ${DB_ATTEMPTS}`);
    } catch (error) {
      lastError = error;
      if (!retryable || attempt === DB_ATTEMPTS) throw error;
      console.warn(
        `База недоступна (попытка ${attempt} из ${DB_ATTEMPTS}):`,
        error instanceof Error ? error.message : String(error),
      );
    }

    await sleep(250 * 2 ** (attempt - 1));
  }

  throw lastError instanceof Error ? lastError : new Error('База недоступна');
}

export function db(): SupabaseClient {
  if (!client) {
    client = createClient(env.supabaseUrl, env.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: retryingFetch },
    });
  }
  return client;
}

/** Бросает понятную ошибку вместо молчаливого проглатывания. */
function check<T>(
  result: { data: T; error: { message: string; code?: string } | null },
  what: string,
): T {
  if (result.error) {
    const code = result.error.code ? ` [${result.error.code}]` : '';
    throw new Error(`БД (${what})${code}: ${result.error.message}`);
  }
  return result.data;
}

// ─── Чаты ────────────────────────────────────────────────────────────────────

/**
 * Кэш чтений на время одной операции.
 *
 * Расписание одно на всех: при рассылке пятьсот чатов спрашивают у базы одно
 * и то же — список групп, неделю группы, даты файла. Внутри `withReadCache`
 * каждый такой запрос выполняется один раз, остальные получают готовый ответ
 * из памяти. Кэш живёт только внутри вызова: между тиками файл мог поменяться,
 * и держать его дольше было бы враньём.
 */
/**
 * Кэш живёт в контексте вызова, а не в переменной модуля.
 *
 * Vercel может выполнять два вызова функции в одном процессе одновременно —
 * например, часовой тик задержался и наложился на следующий. С общей
 * переменной они перетирали бы кэш друг другу, а в худшем случае один
 * оставлял бы свой кэш висеть навсегда, и все дальнейшие запросы получали бы
 * устаревшее расписание. AsyncLocalStorage даёт каждому вызову своё хранилище.
 */
const cacheStore = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

export function withReadCache<T>(fn: () => Promise<T>): Promise<T> {
  return cacheStore.run(new Map(), fn);
}

/**
 * Вне `withReadCache` (то есть в вебхуке бота) каталог групп и список недель
 * держим в памяти процесса пару минут. Они нужны почти каждому нажатию, а
 * меняются раз в сутки и раз в час: без этого каждый клик тянул из базы весь
 * каталог, и при сотнях людей трафик бесплатного Supabase уходил на одно это.
 */
const SHARED_TTL_MS = 2 * 60 * 1000;
const SHARED_KEYS = new Set(['listGroups', 'weekStarts']);
const shared = new Map<string, { at: number; value: Promise<unknown> }>();

function sharedCached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = shared.get(key);
  if (hit && Date.now() - hit.at < SHARED_TTL_MS) return hit.value as Promise<T>;

  const fresh = load();
  shared.set(key, { at: Date.now(), value: fresh });
  fresh.catch(() => shared.delete(key));
  return fresh;
}

/** Забывает общий кэш — после того как каталог или недели поменялись. */
export function forgetSharedCache(): void {
  shared.clear();
}

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const store = cacheStore.getStore();
  if (!store) return SHARED_KEYS.has(key) ? sharedCached(key, load) : load();

  const hit = store.get(key) as Promise<T> | undefined;
  if (hit) return hit;

  const fresh = load();
  store.set(key, fresh);
  // Разовый сбой не должен утащить за собой всю рассылку: неудачную попытку
  // забываем, следующий желающий сходит в базу заново
  fresh.catch(() => store.delete(key));
  return fresh;
}

export interface Chat {
  chat_id: number;
  title: string | null;
  /** Выбранные группы чата: одна или две. */
  groups: string[];
  enabled: boolean;
  pinned_msg_id: number | null;
  /** Какой день показывает закреплённое сообщение. */
  pinned_date: string | null;
  /** Тема форума, в которую слать расписание. null — обычный чат или «Общее». */
  topic_id: number | null;
  /** Название темы, если Telegram его показал: в меню оно понятнее номера. */
  topic_name: string | null;
}

/** Сколько групп разрешено выбрать одному чату. */
export const MAX_GROUPS = 2;

export async function getChat(chatId: number): Promise<Chat | null> {
  const res = await db().from('chats').select('*').eq('chat_id', chatId).maybeSingle();
  return check(res, 'getChat') as Chat | null;
}

export async function upsertChat(
  chatId: number,
  title: string | null,
  addedBy?: number,
): Promise<void> {
  const row: Record<string, unknown> = {
    chat_id: chatId,
    title,
    updated_at: new Date().toISOString(),
  };
  // Кто подключил чат — по нему потом видно, чьё это хозяйство
  if (addedBy !== undefined) row.added_by = addedBy;

  const res = await db().from('chats').upsert(row, { onConflict: 'chat_id' }).select('chat_id');
  check(res, 'upsertChat');
}

export type ToggleResult = 'added' | 'removed' | 'limit';

/**
 * Добавляет или убирает группу чата. Групп может быть до двух: в файле МУИВ
 * две группы часто делят одну колонку, и расписание нужно обеим сразу.
 */
export async function toggleChatGroup(chatId: number, group: string): Promise<ToggleResult> {
  const chat = await getChat(chatId);
  const current = chat?.groups ?? [];

  let next: string[];
  let outcome: ToggleResult;

  if (current.includes(group)) {
    next = current.filter((g) => g !== group);
    outcome = 'removed';
  } else if (current.length >= MAX_GROUPS) {
    return 'limit';
  } else {
    next = [...current, group];
    outcome = 'added';
  }

  const res = await db()
    .from('chats')
    .update({
      groups: next,
      // group_name оставлен для совместимости со старыми записями
      group_name: next[0] ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('chat_id', chatId)
    .select('chat_id');
  check(res, 'toggleChatGroup');

  return outcome;
}

export async function setChatEnabled(chatId: number, enabled: boolean): Promise<void> {
  const res = await db()
    .from('chats')
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq('chat_id', chatId)
    .select('chat_id');
  check(res, 'setChatEnabled');
}

/**
 * Запоминает тему форума для расписания.
 *
 * Список тем Bot API не отдаёт, поэтому тема задаётся тем, что человек
 * нажимает кнопку внутри неё: куда нажал — туда и слать.
 */
export async function setChatTopic(
  chatId: number,
  topicId: number | null,
  topicName: string | null = null,
): Promise<void> {
  const res = await db()
    .from('chats')
    .update({ topic_id: topicId, topic_name: topicName, updated_at: new Date().toISOString() })
    .eq('chat_id', chatId)
    .select('chat_id');
  check(res, 'setChatTopic');
}

export async function setPinnedMessage(
  chatId: number,
  messageId: number | null,
  dateIso: string | null = null,
): Promise<void> {
  const res = await db()
    .from('chats')
    .update({ pinned_msg_id: messageId, pinned_date: dateIso })
    .eq('chat_id', chatId)
    .select('chat_id');
  check(res, 'setPinnedMessage');
}

/**
 * Сколько строк Supabase отдаёт за один запрос. Больше — молча обрезает,
 * поэтому длинные списки читаем страницами.
 */
const PAGE_ROWS = 1000;

/**
 * Чаты, готовые к автоотправке: включены и хотя бы с одной группой.
 * Страницами по порядку: без этого на тысяче с лишним чатов часть молча
 * выпадала бы из рассылки, и каждый раз разная.
 */
export async function activeChats(): Promise<Chat[]> {
  const pages: Chat[][] = [];
  for (let from = 0; ; from += PAGE_ROWS) {
    const res = await db()
      .from('chats')
      .select('*')
      .eq('enabled', true)
      .order('chat_id', { ascending: true })
      .range(from, from + PAGE_ROWS - 1);
    const page = (check(res, 'activeChats') ?? []) as Chat[];
    pages.push(page);
    if (page.length < PAGE_ROWS) break;
  }
  return pages.flat().filter((chat) => (chat.groups ?? []).length > 0);
}

export async function allChats(): Promise<Chat[]> {
  const res = await db().from('chats').select('*').order('created_at', { ascending: true });
  return (check(res, 'allChats') ?? []) as Chat[];
}

// ─── Файлы и расписание ──────────────────────────────────────────────────────

export interface FileRow {
  id: number;
  /** Имя файла — устойчивый ключ: путь меняется при каждой перезаливке. */
  name: string;
  url: string;
  title: string;
  sha256: string;
  size: number;
  site_updated: string | null;
  week_start: string | null;
  parsed_ok: boolean;
  parse_error: string | null;
  first_seen: string;
  last_seen: string;
  changed_at: string;
}

/** Имя файла из адреса: `/upload/iblock/629/xxx/Raspisanie.xlsx` → `Raspisanie.xlsx`. */
export function fileNameOf(url: string): string {
  const last = url.split('?')[0].split('/').pop() ?? url;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export async function getFileByName(name: string): Promise<FileRow | null> {
  const res = await db().from('files').select('*').eq('name', name).maybeSingle();
  return check(res, 'getFileByName') as FileRow | null;
}

/**
 * Отмечает, что файл всё ещё лежит на сайте.
 *
 * Это косметика: колонка `last_seen` ни на что не влияет. Поэтому ошибка тут
 * не должна ронять проверку расписания — именно так разовый Gateway Timeout
 * от базы обрушил весь тик и прислал владельцу алерт.
 */
export async function touchFile(name: string): Promise<void> {
  const res = await db()
    .from('files')
    .update({ last_seen: new Date().toISOString() })
    .eq('name', name)
    .select('id');

  if (res.error) {
    console.warn(`Не удалось отметить файл «${name}»:`, res.error.message);
  }
}

export interface FileUpsert {
  name: string;
  url: string;
  title: string;
  sha256: string;
  size: number;
  siteUpdated: string | null;
  weekStart: string | null;
  parsedOk: boolean;
  parseError: string | null;
}

export async function upsertFile(input: FileUpsert): Promise<FileRow> {
  const now = new Date().toISOString();
  const res = await db()
    .from('files')
    .upsert(
      {
        name: input.name,
        url: input.url,
        title: input.title,
        sha256: input.sha256,
        size: input.size,
        site_updated: input.siteUpdated,
        week_start: input.weekStart,
        parsed_ok: input.parsedOk,
        parse_error: input.parseError,
        last_seen: now,
        changed_at: now,
      },
      // Ключ — имя файла: адрес меняется при каждой перезаливке
      { onConflict: 'name' },
    )
    .select('*')
    .single();
  return check(res, 'upsertFile') as FileRow;
}

/**
 * Помечает файл разобранным. Отдельным шагом после записи дней: если запись
 * упала посередине, файл остаётся `parsed_ok = false`, и следующий тик
 * перекачает группу, а не сочтёт её загруженной по совпавшему хешу.
 */
export async function markFileParsed(fileId: number): Promise<void> {
  const res = await db()
    .from('files')
    .update({ parsed_ok: true, parse_error: null })
    .eq('id', fileId)
    .select('id');
  check(res, 'markFileParsed');
  // Неделя появилась или сменилась — список недель в памяти устарел
  forgetSharedCache();
}

/** Перезаписывает расписание для файла целиком. */
export async function replaceSchedules(fileId: number, workbook: Workbook): Promise<number> {
  const del = await db().from('schedules').delete().eq('file_id', fileId).select('id');
  check(del, 'replaceSchedules.delete');

  const rows = workbook.groups.flatMap((g) =>
    g.days.map((d) => ({
      file_id: fileId,
      group_name: g.group,
      sheet_name: g.sheet,
      day_date: d.date,
      day_name: d.name,
      lessons: d.lessons,
    })),
  );

  for (let i = 0; i < rows.length; i += 500) {
    const res = await db().from('schedules').insert(rows.slice(i, i + 500)).select('id');
    check(res, 'replaceSchedules.insert');
  }

  return rows.length;
}

/** Самый свежий успешно распарсенный файл. */
export async function latestFile(): Promise<FileRow | null> {
  return cached('latestFile', loadLatestFile);
}

async function loadLatestFile(): Promise<FileRow | null> {
  const res = await db()
    .from('files')
    .select('*')
    .eq('parsed_ok', true)
    .order('week_start', { ascending: false, nullsFirst: false })
    .order('changed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return check(res, 'latestFile') as FileRow | null;
}

export async function recentFiles(limit = 20): Promise<FileRow[]> {
  const res = await db()
    .from('files')
    .select('*')
    .order('changed_at', { ascending: false })
    .limit(limit);
  return (check(res, 'recentFiles') ?? []) as FileRow[];
}

/**
 * Список групп с указанием курса — для кнопок выбора.
 *
 * Берётся из `groups_catalog`, а не из уже подключённых групп в `schedules`:
 * по часовому тику расписание тянется только для групп, на которые уже
 * подписан хотя бы один чат, а каталог всех групп университета обновляется
 * отдельно и реже (см. `upsertGroupsCatalog`).
 */
export async function listGroups(): Promise<{ group: string; sheet: string | null }[]> {
  return cached('listGroups', loadGroups);
}

async function loadGroups(): Promise<{ group: string; sheet: string | null }[]> {
  const res = await db()
    .from('groups_catalog')
    .select('group_name, year')
    .order('group_name', { ascending: true });

  const rows = (check(res, 'listGroups') ?? []) as { group_name: string; year: string }[];
  return rows
    .map((r) => ({ group: r.group_name, sheet: r.year }))
    .sort((a, b) => a.group.localeCompare(b.group, 'ru'));
}

export interface CatalogEntry {
  group: string;
  year: string;
  studyform: string;
}

/**
 * Перезаписывает каталог групп целиком — обновляется раз в сутки.
 * Группы курсов из `keepYears` не удаляются, даже если их нет в обходе:
 * пустой курс в ответе сайта — это сбой, а не выпуск всех групп разом.
 */
export async function replaceGroupsCatalog(
  entries: CatalogEntry[],
  keepYears: string[] = [],
): Promise<void> {
  const now = new Date().toISOString();
  const rows = entries.map((e) => ({
    group_name: e.group,
    year: e.year,
    studyform: e.studyform,
    updated_at: now,
  }));

  for (let i = 0; i < rows.length; i += 500) {
    const res = await db()
      .from('groups_catalog')
      .upsert(rows.slice(i, i + 500), { onConflict: 'group_name' })
      .select('group_name');
    check(res, 'replaceGroupsCatalog.upsert');
  }

  // Группы, которых в новом обходе не оказалось (расформированы/переименованы),
  // не должны продолжать висеть в списке выбора
  const seen = new Set(entries.map((e) => e.group));
  const existing = await db().from('groups_catalog').select('group_name, year');
  const stale = (
    (check(existing, 'replaceGroupsCatalog.list') ?? []) as { group_name: string; year: string }[]
  )
    .filter((r) => !seen.has(r.group_name) && !keepYears.includes(r.year))
    .map((r) => r.group_name);

  if (stale.length > 0) {
    const del = await db().from('groups_catalog').delete().in('group_name', stale).select('group_name');
    check(del, 'replaceGroupsCatalog.delete');
  }
  forgetSharedCache();
}

/** Весь каталог с курсом и формой обучения — для обхода всех групп. */
export async function catalogEntries(): Promise<CatalogEntry[]> {
  const res = await db()
    .from('groups_catalog')
    .select('group_name, year, studyform')
    .order('group_name', { ascending: true });
  const rows = (check(res, 'catalogEntries') ?? []) as {
    group_name: string;
    year: string;
    studyform: string;
  }[];
  return rows.map((r) => ({ group: r.group_name, year: r.year, studyform: r.studyform }));
}

/** Курс и форма обучения группы — нужны, чтобы запросить её расписание. */
export async function catalogEntry(groupName: string): Promise<CatalogEntry | null> {
  const res = await db()
    .from('groups_catalog')
    .select('group_name, year, studyform')
    .eq('group_name', groupName)
    .maybeSingle();
  const row = check(res, 'catalogEntry') as { group_name: string; year: string; studyform: string } | null;
  return row ? { group: row.group_name, year: row.year, studyform: row.studyform } : null;
}

/**
 * Расписание группы на конкретный день.
 *
 * Ищем по дате во всех файлах, а не в «самом свежем»: когда колледж выкладывает
 * следующую неделю, файл текущей никуда не девается, и расписание на завтра
 * должно браться именно из него. Если день есть в нескольких файлах —
 * побеждает тот, который заметили позже.
 */
export async function getDay(groupName: string, dateIso: string): Promise<Day | null> {
  const res = await db()
    .from('schedules')
    .select('day_date, day_name, lessons, file_id')
    .eq('group_name', groupName)
    .eq('day_date', dateIso)
    .order('file_id', { ascending: false })
    .limit(1)
    .maybeSingle();

  const row = check(res, 'getDay') as
    | { day_date: string; day_name: string; lessons: Lesson[] }
    | null;
  if (!row) return null;
  return { date: row.day_date, name: row.day_name, lessons: row.lessons };
}

/**
 * Неделя группы: та, в которой ближайший учебный день начиная с `fromIso`.
 * В воскресенье это уже следующая неделя, в середине недели — текущая.
 */
export async function getWeek(
  groupName: string,
  fromIso: string,
): Promise<{ days: Day[]; file: FileRow | null }> {
  return cached(`week:${groupName}:${fromIso}`, () => loadWeek(groupName, fromIso));
}

async function loadWeek(
  groupName: string,
  fromIso: string,
): Promise<{ days: Day[]; file: FileRow | null }> {
  const upcoming = await db()
    .from('schedules')
    .select('file_id')
    .eq('group_name', groupName)
    .gte('day_date', fromIso)
    .order('day_date', { ascending: true })
    .limit(1)
    .maybeSingle();

  const picked = check(upcoming, 'getWeek.pick') as { file_id: number } | null;

  // Впереди учебных дней нет — показываем последнюю известную неделю этой же
  // группы. Раньше здесь брался самый свежий файл вообще, но у каждой группы
  // теперь свой файл: группа, чьё расписание ещё не скачано, получала чужой
  // файл, не находила в нём своих дней и показывала «Пар нет» при живых парах.
  const fileId = picked?.file_id ?? (await lastFileOfGroup(groupName));
  if (fileId === null) return { days: [], file: null };

  const [rowsRes, fileRes] = await Promise.all([
    db()
      .from('schedules')
      .select('day_date, day_name, lessons')
      .eq('file_id', fileId)
      .eq('group_name', groupName)
      .order('day_date', { ascending: true }),
    db().from('files').select('*').eq('id', fileId).maybeSingle(),
  ]);

  const rows = (check(rowsRes, 'getWeek.rows') ?? []) as {
    day_date: string;
    day_name: string;
    lessons: Lesson[];
  }[];

  return {
    days: rows.map((r) => ({ date: r.day_date, name: r.day_name, lessons: r.lessons })),
    file: check(fileRes, 'getWeek.file') as FileRow | null,
  };
}

/** Файл с самым поздним днём группы; null — расписания группы в базе нет. */
async function lastFileOfGroup(groupName: string): Promise<number | null> {
  const res = await db()
    .from('schedules')
    .select('file_id')
    .eq('group_name', groupName)
    .order('day_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = check(res, 'getWeek.last') as { file_id: number } | null;
  return row?.file_id ?? null;
}

/**
 * Имя записи о расписании группы в `files`. Адреса и веса у AJAX-ответа нет,
 * поэтому ключом служит имя группы — запись у группы одна, и правится она
 * же, а не плодится новая на каждое изменение.
 */
export function groupFileName(groupName: string): string {
  return `ajax:${groupName}`;
}

/** Что лежит в базе по группе: когда последний раз скачана и какая неделя. */
export interface GroupFileStatus {
  fetchedAt: string;
  weekStart: string | null;
}

/**
 * Состояние всех групп разом — одним запросом, а не по запросу на группу:
 * по нему строится очередь обхода и сводка «сколько загружено».
 */
export async function groupFileStatus(): Promise<Map<string, GroupFileStatus>> {
  const res = await db()
    .from('files')
    .select('name, week_start, last_seen')
    .eq('parsed_ok', true)
    .like('name', groupFileName('*'));

  const rows = (check(res, 'groupFileStatus') ?? []) as {
    name: string;
    week_start: string | null;
    last_seen: string;
  }[];

  const prefix = groupFileName('');
  return new Map(
    rows
      .filter((r) => r.name.startsWith(prefix))
      .map((r) => [r.name.slice(prefix.length), { fetchedAt: r.last_seen, weekStart: r.week_start }]),
  );
}

// ─── Состояние ───────────────────────────────────────────────────────────────

export async function getState<T>(key: string): Promise<T | null> {
  const res = await db().from('app_state').select('value').eq('key', key).maybeSingle();
  const row = check(res, 'getState') as { value: T } | null;
  return row ? row.value : null;
}

export async function setState(key: string, value: unknown): Promise<void> {
  const res = await db()
    .from('app_state')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    .select('key');
  check(res, 'setState');
}

/**
 * Забирает значение и удаляет его одним запросом. Из двух одновременных
 * вызовов значение достанется только одному: второй получит null. Так
 * одно ожидание текста не превращается в два принятых сообщения, если
 * человек отправил два подряд и Telegram доставил их параллельно.
 */
export async function takeState<T>(key: string): Promise<T | null> {
  const res = await db().from('app_state').delete().eq('key', key).select('value');
  const rows = (check(res, 'takeState') ?? []) as { value: T }[];
  return rows[0]?.value ?? null;
}

/** Забывает значение: `value` в таблице not null, «пустого» состояния нет. */
export async function clearState(key: string): Promise<void> {
  const res = await db().from('app_state').delete().eq('key', key).select('key');
  check(res, 'clearState');
}

/**
 * Замок на одну операцию за раз — поверх `app_state`.
 *
 * Тик дёргают два крона (pg_cron и GitHub Actions), и иногда в одну минуту.
 * Два тика разом — это два Chromium в одном процессе (ровно так бот уже
 * падал с `ERR_INSUFFICIENT_RESOURCES`) и две рассылки, которые шлют одному
 * чату дважды. Вставка по первичному ключу атомарна: второй получает отказ.
 * Замок, который не сняли (функцию убил лимит), протухает через `ttlMs`.
 */
export async function acquireLock(key: string, ttlMs: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - ttlMs).toISOString();
  const stale = await db()
    .from('app_state')
    .delete()
    .eq('key', key)
    .lt('updated_at', cutoff)
    .select('key');
  check(stale, 'acquireLock.stale');

  const now = new Date().toISOString();
  const res = await db().from('app_state').insert({ key, value: now, updated_at: now }).select('key');
  // Ключ уже занят — замок держит другой тик
  if (res.error?.code === '23505') return false;
  check(res, 'acquireLock');
  return true;
}

export async function releaseLock(key: string): Promise<void> {
  await clearState(key);
}

// ─── Rate limit ──────────────────────────────────────────────────────────────

/**
 * Счётчики команд и нажатий раздельные: иначе десяток нажатий одного
 * участника группы съедал лимит команд, и /start в этой группе молча не
 * работал до конца минуты. Ключ счётчика — (чат, начало окна); чтобы не
 * менять схему, окно нажатий сдвинуто на секунду внутри той же минуты.
 */
const BUCKET_OFFSET_MS = { command: 0, button: 1000 } as const;

/** Возвращает true, если запрос разрешён. Окно — минута. */
export async function allowRequest(
  chatId: number,
  limit = 10,
  bucket: keyof typeof BUCKET_OFFSET_MS = 'command',
): Promise<boolean> {
  const windowStart = new Date(
    Math.floor(Date.now() / 60_000) * 60_000 + BUCKET_OFFSET_MS[bucket],
  ).toISOString();

  const inc = await db().rpc('increment_rate_limit', {
    p_chat_id: chatId,
    p_window: windowStart,
  });

  if (inc.error) {
    // Функции нет или БД недоступна — не блокируем пользователя, но пишем в консоль
    console.error('rate limit недоступен:', inc.error.message);
    return true;
  }

  return Number(inc.data) <= limit;
}

/**
 * Чистит старые логи и счётчики частоты (функция `prune_old_rows` из
 * schema.sql). Без этого обе таблицы растут без конца, а бесплатная база
 * упирается в 500 МБ и переходит в режим только для чтения.
 */
export async function pruneOldRows(): Promise<void> {
  const res = await db().rpc('prune_old_rows');
  if (res.error) throw new Error(`БД (prune_old_rows): ${res.error.message}`);
}

// ─── Логи ────────────────────────────────────────────────────────────────────

export interface LogRow {
  id: number;
  ts: string;
  kind: string;
  chat_id: number | null;
  message: string;
  details: unknown;
  duration_ms: number | null;
}

export async function writeLog(row: {
  kind: string;
  message: string;
  chatId?: number | null;
  details?: unknown;
  durationMs?: number | null;
}): Promise<void> {
  const res = await db().from('logs').insert({
    kind: row.kind,
    message: row.message.slice(0, 2000),
    chat_id: row.chatId ?? null,
    details: row.details ?? null,
    duration_ms: row.durationMs ?? null,
  }).select('id');
  if (res.error) console.error('Не удалось записать лог:', res.error.message);
}

export async function recentLogs(limit = 50): Promise<LogRow[]> {
  const res = await db().from('logs').select('*').order('ts', { ascending: false }).limit(limit);
  return (check(res, 'recentLogs') ?? []) as LogRow[];
}

/** Логи за последние `hours` часов — для ленты часов на статус-странице. */
export async function logsSince(hours: number): Promise<LogRow[]> {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const res = await db()
    .from('logs')
    .select('*')
    .gte('ts', since)
    .order('ts', { ascending: true });
  return (check(res, 'logsSince') ?? []) as LogRow[];
}

/** Даты начала недель, для которых есть разобранное расписание. */
export async function weekStarts(): Promise<string[]> {
  return cached('weekStarts', loadWeekStarts);
}

async function loadWeekStarts(): Promise<string[]> {
  const res = await db()
    .from('files')
    .select('week_start')
    .eq('parsed_ok', true)
    .not('week_start', 'is', null)
    .order('week_start', { ascending: true });

  const rows = (check(res, 'weekStarts') ?? []) as { week_start: string }[];

  // Одна запись на настоящую неделю: если в базе остались два файла одной
  // недели, навигация не должна показывать её дважды
  const byMonday = new Map<string, string>();
  for (const row of rows) {
    const monday = mondayOf(row.week_start);
    const known = byMonday.get(monday);
    if (!known || row.week_start > known) byMonday.set(monday, row.week_start);
  }

  return [...byMonday.values()].sort();
}

/**
 * Переносит настройки чата на новый идентификатор.
 *
 * Обычная группа при превращении в супергруппу меняет chat_id, и без переноса
 * бот потерял бы и выбранную группу, и право слать в этот чат.
 */
export async function migrateChat(oldId: number, newId: number): Promise<boolean> {
  const previous = await getChat(oldId);
  if (!previous) return false;

  const res = await db()
    .from('chats')
    .upsert(
      {
        chat_id: newId,
        title: previous.title,
        groups: previous.groups,
        group_name: previous.groups?.[0] ?? null,
        enabled: previous.enabled,
        // id закреплённого сообщения при переезде не переносится
        pinned_msg_id: null,
        pinned_date: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'chat_id' },
    )
    .select('chat_id');
  check(res, 'migrateChat.insert');

  const del = await db().from('chats').delete().eq('chat_id', oldId).select('chat_id');
  check(del, 'migrateChat.delete');

  return true;
}

// ─── Баги и предложения ──────────────────────────────────────────────────────

export type FeedbackKind = 'bug' | 'idea';

export interface FeedbackRow {
  id: number;
  chat_id: number;
  user_id: number;
  username: string | null;
  first_name: string | null;
  kind: FeedbackKind;
  text: string;
  created_at: string;
}

export async function addFeedback(entry: {
  chatId: number;
  userId: number;
  username: string | null;
  firstName: string | null;
  kind: FeedbackKind;
  text: string;
}): Promise<FeedbackRow> {
  const res = await db()
    .from('feedback')
    .insert({
      chat_id: entry.chatId,
      user_id: entry.userId,
      username: entry.username,
      first_name: entry.firstName,
      kind: entry.kind,
      text: entry.text,
    })
    .select('*')
    .single();
  return check(res, 'addFeedback') as FeedbackRow;
}

/**
 * Сколько сообщений пришло с момента `sinceIso` — от одного человека или,
 * без `userId`, от всех сразу.
 *
 * Писать может кто угодно, поэтому нужен потолок: иначе одному скучающему
 * хватит минуты, чтобы завалить владельца уведомлениями.
 */
export async function feedbackSince(sinceIso: string, userId?: number): Promise<number> {
  let query = db().from('feedback').select('id').gte('created_at', sinceIso);
  if (userId !== undefined) query = query.eq('user_id', userId);
  const res = await query;
  return ((check(res, 'feedbackSince') ?? []) as { id: number }[]).length;
}

/** Сводка для владельца: сколько багов и идей пришло за сутки. */
export async function feedbackStats(hours = 24): Promise<{ bugs: number; ideas: number }> {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const res = await db().from('feedback').select('kind').gte('created_at', since);
  const rows = (check(res, 'feedbackStats') ?? []) as { kind: string }[];
  return {
    bugs: rows.filter((r) => r.kind === 'bug').length,
    ideas: rows.filter((r) => r.kind === 'idea').length,
  };
}

export interface ChatStats {
  total: number;
  enabled: number;
  withGroup: number;
  topGroups: { group: string; chats: number }[];
}

/** Сводка по подключённым чатам — для админского экрана. */
export async function chatStats(): Promise<ChatStats> {
  const res = await db().from('chats').select('groups, enabled');
  const rows = (check(res, 'chatStats') ?? []) as { groups: string[] | null; enabled: boolean }[];

  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const group of row.groups ?? []) {
      counts.set(group, (counts.get(group) ?? 0) + 1);
    }
  }

  return {
    total: rows.length,
    enabled: rows.filter((r) => r.enabled).length,
    withGroup: rows.filter((r) => (r.groups ?? []).length > 0).length,
    topGroups: [...counts]
      .map(([group, chats]) => ({ group, chats }))
      .sort((a, b) => b.chats - a.chats || a.group.localeCompare(b.group, 'ru'))
      .slice(0, 8),
  };
}

/**
 * Все группы, на которые сейчас подписан хотя бы один чат, с полным
 * списком чатов у каждой — для экрана «Все группы» в сводке владельца
 * (chatStats.topGroups обрезан до 8, этот список — без обрезки).
 */
export async function groupsInUse(): Promise<
  { group: string; chats: { chat_id: number; title: string | null }[] }[]
> {
  const res = await db().from('chats').select('chat_id, title, groups, enabled').eq('enabled', true);
  const rows = (check(res, 'groupsInUse') ?? []) as {
    chat_id: number;
    title: string | null;
    groups: string[] | null;
  }[];

  const byGroup = new Map<string, { chat_id: number; title: string | null }[]>();
  for (const row of rows) {
    for (const group of row.groups ?? []) {
      const list = byGroup.get(group) ?? [];
      list.push({ chat_id: row.chat_id, title: row.title });
      byGroup.set(group, list);
    }
  }

  return [...byGroup]
    .map(([group, chats]) => ({ group, chats }))
    .sort((a, b) => b.chats.length - a.chats.length || a.group.localeCompare(b.group, 'ru'));
}

/** Сколько ошибок записано за последние сутки. */
export async function errorCount(hours = 24): Promise<number> {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const res = await db()
    .from('logs')
    .select('id')
    .eq('kind', 'error')
    .gte('ts', since);
  return ((check(res, 'errorCount') ?? []) as unknown[]).length;
}

/**
 * Приведение названия группы к сравнимому виду.
 *
 * Колледж меняет написание между файлами: «ИСП/П-24-11» превращается в
 * «ИСП/п 24-11», а с переходом сайта на AJAX-виджет — в «к/о/к ИСП/п 24-11».
 * Регистр, пробелы, дефисы и префикс формы обучения значения не имеют, а вот
 * точка с цифрой — имеет: «23-09.1» и «23-09.2» это разные группы.
 */
export function normalizeGroup(name: string): string {
  return name
    .toLowerCase()
    .replace(/^\s*к\/о\/к\s*/i, '')
    .replace(/[\s-]+/g, '');
}

export interface GroupResolution {
  /** Что сохранено в чате → как называется в актуальном файле. */
  actual: Map<string, string>;
  /** Группы, которых в актуальном файле не нашлось. */
  missing: string[];
  /** Названия, которые изменились и требуют обновления в базе. */
  renamed: { from: string; to: string }[];
  /** Сколько групп сейчас в каталоге: ноль значит, что каталог сам не загрузился. */
  catalogSize: number;
}

/**
 * Сопоставляет сохранённые группы чата с актуальным файлом.
 * Переименование подхватывается само; исчезнувшую группу надо выбрать заново.
 */
export async function resolveGroups(stored: string[]): Promise<GroupResolution> {
  const available = await listGroups();
  const byNormalized = new Map<string, string>();
  for (const item of available) {
    const key = normalizeGroup(item.group);
    if (!byNormalized.has(key)) byNormalized.set(key, item.group);
  }
  const exact = new Set(available.map((g) => g.group));

  const resolution: GroupResolution = {
    actual: new Map(),
    missing: [],
    renamed: [],
    catalogSize: available.length,
  };

  for (const name of stored) {
    if (exact.has(name)) {
      resolution.actual.set(name, name);
      continue;
    }
    const match = byNormalized.get(normalizeGroup(name));
    if (match) {
      resolution.actual.set(name, match);
      resolution.renamed.push({ from: name, to: match });
    } else {
      resolution.missing.push(name);
    }
  }

  return resolution;
}

/** Сохраняет новые названия групп после переименования в файле. */
export async function renameChatGroups(
  chatId: number,
  renamed: { from: string; to: string }[],
): Promise<void> {
  if (renamed.length === 0) return;

  const chat = await getChat(chatId);
  if (!chat) return;

  const map = new Map(renamed.map((r) => [r.from, r.to]));
  const next = (chat.groups ?? []).map((g) => map.get(g) ?? g);

  const res = await db()
    .from('chats')
    .update({ groups: next, group_name: next[0] ?? null, updated_at: new Date().toISOString() })
    .eq('chat_id', chatId)
    .select('chat_id');
  check(res, 'renameChatGroups');
}

/**
 * Актуальные названия групп чата: подхватывает переименования в файле и
 * сообщает, какие группы исчезли — их надо выбрать заново.
 */
export async function currentGroups(
  chatId: number,
  stored: string[],
): Promise<{ groups: string[]; missing: string[] }> {
  const resolution = await resolveGroups(stored);

  if (resolution.renamed.length > 0) {
    await renameChatGroups(chatId, resolution.renamed);
  }

  return {
    groups: stored.map((name) => resolution.actual.get(name)).filter((g): g is string => !!g),
    missing: resolution.missing,
  };
}

/** Все учебные даты недели по файлу — чтобы клавиатура показывала всю неделю. */
export async function weekDates(fileId: number): Promise<string[]> {
  return cached(`weekDates:${fileId}`, () => loadWeekDates(fileId));
}

async function loadWeekDates(fileId: number): Promise<string[]> {
  const res = await db().from('schedules').select('day_date').eq('file_id', fileId);
  const rows = (check(res, 'weekDates') ?? []) as { day_date: string }[];
  return [...new Set(rows.map((r) => r.day_date))].sort();
}

// ─── Доступ по заявкам ───────────────────────────────────────────────────────

export type AccessStatus = 'pending' | 'approved' | 'denied';

export interface AccessRow {
  user_id: number;
  username: string | null;
  first_name: string | null;
  status: AccessStatus;
  requested_at: string;
  decided_at: string | null;
}

export async function getAccess(userId: number): Promise<AccessRow | null> {
  const res = await db().from('access').select('*').eq('user_id', userId).maybeSingle();
  return check(res, 'getAccess') as AccessRow | null;
}

/**
 * Заводит заявку, если её ещё не было. Возвращает актуальное состояние:
 * повторное обращение не создаёт вторую заявку и не сбрасывает отказ.
 */
export async function requestAccess(
  userId: number,
  username: string | null,
  firstName: string | null,
): Promise<{ status: AccessStatus; isNew: boolean }> {
  const existing = await getAccess(userId);
  if (existing) return { status: existing.status, isNew: false };

  const res = await db()
    .from('access')
    .insert({ user_id: userId, username, first_name: firstName, status: 'pending' })
    .select('user_id');

  // Два быстрых /start подряд могут вставляться одновременно. Проигравшая
  // вставка упирается в первичный ключ — это не ошибка, а признак того,
  // что заявка уже есть, и владельца второй раз дёргать не нужно.
  if (res.error) {
    const already = await getAccess(userId);
    if (already) return { status: already.status, isNew: false };
    check(res, 'requestAccess');
  }

  return { status: 'pending', isNew: true };
}

export async function decideAccess(userId: number, status: AccessStatus): Promise<void> {
  const res = await db()
    .from('access')
    .upsert(
      { user_id: userId, status, decided_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    )
    .select('user_id');
  check(res, 'decideAccess');
}

/** Есть ли у человека право подключать чаты и пользоваться расписанием. */
export async function isApproved(userId: number): Promise<boolean> {
  if (userId === env.adminTelegramId) return true;
  const row = await getAccess(userId);
  return row?.status === 'approved';
}

export async function pendingRequests(limit = 20): Promise<AccessRow[]> {
  const res = await db()
    .from('access')
    .select('*')
    .eq('status', 'pending')
    .order('requested_at', { ascending: true })
    .limit(limit);
  return (check(res, 'pendingRequests') ?? []) as AccessRow[];
}

export async function accessCounts(): Promise<Record<AccessStatus, number>> {
  const res = await db().from('access').select('status');
  const rows = (check(res, 'accessCounts') ?? []) as { status: AccessStatus }[];
  return {
    pending: rows.filter((r) => r.status === 'pending').length,
    approved: rows.filter((r) => r.status === 'approved').length,
    denied: rows.filter((r) => r.status === 'denied').length,
  };
}

/**
 * Список заявок по статусу — для разделов экрана «Доступ».
 *
 * Ждущие — от самой старой: кто раньше пришёл, того раньше и решают.
 * Решённые — от самого свежего решения: обычно ищут того, кого только что
 * одобрили или отклонили. Страницы режутся в памяти: людей сотни, а не
 * миллионы, и один запрос проще пары «счётчик + страница».
 */
export async function accessList(status: AccessStatus, limit = 1000): Promise<AccessRow[]> {
  let query = db().from('access').select('*').eq('status', status);
  query =
    status === 'pending'
      ? query.order('requested_at', { ascending: true })
      : query
          .order('decided_at', { ascending: false, nullsFirst: false })
          .order('requested_at', { ascending: false });
  const res = await query.limit(limit);
  return (check(res, 'accessList') ?? []) as AccessRow[];
}

/**
 * Сколько новых заявок пришло с момента `sinceIso`. Нужно для потолка
 * уведомлений владельцу: волна заявок от ботов не должна превращаться
 * в сотни сообщений ему в личку.
 */
export async function accessRequestsSince(sinceIso: string): Promise<number> {
  const res = await db().from('access').select('user_id').gte('requested_at', sinceIso);
  return ((check(res, 'accessRequestsSince') ?? []) as unknown[]).length;
}

/** Полный сброс подключённых чатов и заявок: начинаем с чистого листа. */
export async function resetChatsAndAccess(): Promise<{ chats: number; access: number }> {
  const chats = await db().from('chats').delete().neq('chat_id', 0).select('chat_id');
  check(chats, 'reset.chats');

  const access = await db().from('access').delete().neq('user_id', 0).select('user_id');
  check(access, 'reset.access');

  const limits = await db().from('rate_limit').delete().gte('count', 0).select('chat_id');
  check(limits, 'reset.rate_limit');

  return {
    chats: ((chats.data ?? []) as unknown[]).length,
    access: ((access.data ?? []) as unknown[]).length,
  };
}

/**
 * Файл, из которого берётся расписание на указанную дату.
 *
 * На сайте одновременно лежат текущая и следующая недели, поэтому «самый
 * свежий файл» и «файл, по которому мы отвечаем сегодня» — разные вещи.
 * В статусе нужен именно второй, иначе строка про файл вводит в заблуждение.
 */
export async function fileForDate(dateIso: string): Promise<FileRow | null> {
  return cached(`fileForDate:${dateIso}`, () => loadFileForDate(dateIso));
}

async function loadFileForDate(dateIso: string): Promise<FileRow | null> {
  const res = await db()
    .from('files')
    .select('*')
    .eq('parsed_ok', true)
    .lte('week_start', dateIso)
    .order('week_start', { ascending: false })
    .limit(1)
    .maybeSingle();

  const current = check(res, 'fileForDate') as FileRow | null;
  if (current) return current;

  // Дата раньше всех известных недель — показываем ближайшую будущую
  const upcoming = await db()
    .from('files')
    .select('*')
    .eq('parsed_ok', true)
    .gt('week_start', dateIso)
    .order('week_start', { ascending: true })
    .limit(1)
    .maybeSingle();

  return check(upcoming, 'fileForDate.upcoming') as FileRow | null;
}

/**
 * Дни группы внутри конкретного файла-недели.
 *
 * Отличается от `getWeek` тем, что неделя задана явно, а не выводится из
 * «ближайшего учебного дня». У двух групп дни недели разные, и вывод по
 * ближайшему дню приводил к тому, что при переключении групп менялась ещё
 * и неделя.
 */
export async function getWeekOfFile(groupName: string, fileId: number): Promise<Day[]> {
  const res = await db()
    .from('schedules')
    .select('day_date, day_name, lessons')
    .eq('file_id', fileId)
    .eq('group_name', groupName)
    .order('day_date', { ascending: true });

  const rows = (check(res, 'getWeekOfFile') ?? []) as {
    day_date: string;
    day_name: string;
    lessons: Lesson[];
  }[];

  return rows.map((r) => ({ date: r.day_date, name: r.day_name, lessons: r.lessons }));
}

/**
 * Убирает записи о файлах, описывающих ту же неделю, что и `keepId`.
 *
 * Колледж перезаливает файл недели под новым именем («31-5 августа-сентября»
 * стало «1-5 сентября»), и в базе оказывались две записи на одну неделю:
 * навигация показывала лишнюю неделю, а «Пред. неделя» вела на устаревшие
 * данные. Неделя опознаётся по своему понедельнику.
 */
export async function dropSupersededWeeks(keepId: number, weekStart: string): Promise<number> {
  const monday = mondayOf(weekStart);

  const res = await db().from('files').select('id, week_start');
  const rows = (check(res, 'dropSupersededWeeks.list') ?? []) as {
    id: number;
    week_start: string | null;
  }[];

  const doomed = rows
    .filter((r) => r.id !== keepId && r.week_start && mondayOf(r.week_start) === monday)
    .map((r) => r.id);

  if (doomed.length === 0) return 0;

  const del = await db().from('files').delete().in('id', doomed).select('id');
  check(del, 'dropSupersededWeeks.delete');

  return doomed.length;
}
