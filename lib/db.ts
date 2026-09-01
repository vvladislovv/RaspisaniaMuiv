/** Доступ к Supabase. Только серверный ключ, только с сервера. */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';
import type { Day, Lesson, Workbook } from './parse';

let cached: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!cached) {
    cached = createClient(env.supabaseUrl, env.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}

/** Бросает понятную ошибку вместо молчаливого проглатывания. */
function check<T>(result: { data: T; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`БД (${what}): ${result.error.message}`);
  return result.data;
}

// ─── Чаты ────────────────────────────────────────────────────────────────────

export interface Chat {
  chat_id: number;
  title: string | null;
  /** Выбранные группы чата: одна или две. */
  groups: string[];
  enabled: boolean;
  pinned_msg_id: number | null;
  /** Какой день показывает закреплённое сообщение. */
  pinned_date: string | null;
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

/** Чаты, готовые к автоотправке: включены и хотя бы с одной группой. */
export async function activeChats(): Promise<Chat[]> {
  const res = await db().from('chats').select('*').eq('enabled', true);
  const rows = (check(res, 'activeChats') ?? []) as Chat[];
  return rows.filter((chat) => (chat.groups ?? []).length > 0);
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

export async function touchFile(name: string): Promise<void> {
  const res = await db()
    .from('files')
    .update({ last_seen: new Date().toISOString() })
    .eq('name', name)
    .select('id');
  check(res, 'touchFile');
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

/** Список групп с указанием листа — для кнопок выбора. */
export async function listGroups(): Promise<{ group: string; sheet: string | null }[]> {
  const file = await latestFile();
  if (!file) return [];

  const res = await db()
    .from('schedules')
    .select('group_name, sheet_name')
    .eq('file_id', file.id);

  const rows = (check(res, 'listGroups') ?? []) as { group_name: string; sheet_name: string | null }[];
  const seen = new Map<string, string | null>();
  for (const r of rows) if (!seen.has(r.group_name)) seen.set(r.group_name, r.sheet_name);

  return [...seen]
    .map(([group, sheet]) => ({ group, sheet }))
    .sort((a, b) => a.group.localeCompare(b.group, 'ru'));
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
  const upcoming = await db()
    .from('schedules')
    .select('file_id')
    .eq('group_name', groupName)
    .gte('day_date', fromIso)
    .order('day_date', { ascending: true })
    .limit(1)
    .maybeSingle();

  const picked = check(upcoming, 'getWeek.pick') as { file_id: number } | null;

  // Впереди учебных дней нет — показываем последнюю известную неделю
  const fileId = picked?.file_id ?? (await latestFile())?.id;
  if (fileId === undefined) return { days: [], file: null };

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

// ─── Rate limit ──────────────────────────────────────────────────────────────

/** Возвращает true, если запрос разрешён. Окно — минута. */
export async function allowRequest(chatId: number, limit = 10): Promise<boolean> {
  const windowStart = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();

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
  const res = await db()
    .from('files')
    .select('week_start')
    .eq('parsed_ok', true)
    .not('week_start', 'is', null)
    .order('week_start', { ascending: true });

  const rows = (check(res, 'weekStarts') ?? []) as { week_start: string }[];
  return [...new Set(rows.map((r) => r.week_start))];
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
 * «ИСП/п 24-11». Регистр, пробелы и дефисы значения не имеют, а вот точка
 * с цифрой — имеет: «23-09.1» и «23-09.2» это разные группы.
 */
export function normalizeGroup(name: string): string {
  return name.toLowerCase().replace(/[\s-]+/g, '');
}

export interface GroupResolution {
  /** Что сохранено в чате → как называется в актуальном файле. */
  actual: Map<string, string>;
  /** Группы, которых в актуальном файле не нашлось. */
  missing: string[];
  /** Названия, которые изменились и требуют обновления в базе. */
  renamed: { from: string; to: string }[];
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

  const resolution: GroupResolution = { actual: new Map(), missing: [], renamed: [] };

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
