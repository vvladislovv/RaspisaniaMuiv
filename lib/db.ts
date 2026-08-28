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
  group_name: string | null;
  enabled: boolean;
  pinned_msg_id: number | null;
}

export async function getChat(chatId: number): Promise<Chat | null> {
  const res = await db().from('chats').select('*').eq('chat_id', chatId).maybeSingle();
  return check(res, 'getChat') as Chat | null;
}

export async function upsertChat(chatId: number, title: string | null): Promise<void> {
  const res = await db()
    .from('chats')
    .upsert({ chat_id: chatId, title, updated_at: new Date().toISOString() }, { onConflict: 'chat_id' })
    .select('chat_id');
  check(res, 'upsertChat');
}

export async function setChatGroup(chatId: number, groupName: string): Promise<void> {
  const res = await db()
    .from('chats')
    .update({ group_name: groupName, updated_at: new Date().toISOString() })
    .eq('chat_id', chatId)
    .select('chat_id');
  check(res, 'setChatGroup');
}

export async function setChatEnabled(chatId: number, enabled: boolean): Promise<void> {
  const res = await db()
    .from('chats')
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq('chat_id', chatId)
    .select('chat_id');
  check(res, 'setChatEnabled');
}

export async function setPinnedMessage(chatId: number, messageId: number | null): Promise<void> {
  const res = await db()
    .from('chats')
    .update({ pinned_msg_id: messageId })
    .eq('chat_id', chatId)
    .select('chat_id');
  check(res, 'setPinnedMessage');
}

/** Чаты, готовые к автоотправке: включены и с выбранной группой. */
export async function activeChats(): Promise<Chat[]> {
  const res = await db()
    .from('chats')
    .select('*')
    .eq('enabled', true)
    .not('group_name', 'is', null);
  return (check(res, 'activeChats') ?? []) as Chat[];
}

export async function allChats(): Promise<Chat[]> {
  const res = await db().from('chats').select('*').order('created_at', { ascending: true });
  return (check(res, 'allChats') ?? []) as Chat[];
}

// ─── Файлы и расписание ──────────────────────────────────────────────────────

export interface FileRow {
  id: number;
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

export async function getFileByUrl(url: string): Promise<FileRow | null> {
  const res = await db().from('files').select('*').eq('url', url).maybeSingle();
  return check(res, 'getFileByUrl') as FileRow | null;
}

export async function touchFile(url: string): Promise<void> {
  const res = await db()
    .from('files')
    .update({ last_seen: new Date().toISOString() })
    .eq('url', url)
    .select('id');
  check(res, 'touchFile');
}

export interface FileUpsert {
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
      { onConflict: 'url' },
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
        group_name: previous.group_name,
        enabled: previous.enabled,
        // id закреплённого сообщения при переезде не переносится
        pinned_msg_id: null,
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
