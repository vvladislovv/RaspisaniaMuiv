/**
 * Главная логика: проверка сайта, обновление БД, автоотправка.
 * Вызывается из /api/tick раз в час.
 */
import { createHash } from 'node:crypto';
import { fetchSite, type SiteFile } from './muiv';
import { parseSchedule } from './parse';
import {
  activeChats,
  setChatEnabled,
  fileNameOf,
  getFileByName,
  latestFile,
  replaceSchedules,
  dropSupersededWeeks,
  setPinnedMessage,
  setState,
  getState,
  touchFile,
  upsertFile,
  getWeek,
  weekStarts,
  currentGroups,
  weekDates,
  type Chat,
  type FileRow,
} from './db';
import { log, logError } from './log';
import { formatDayFor, type GroupDay } from './format';
import type { Day } from './parse';
import {
  TelegramError,
  editMessageText,
  pinChatMessage,
  sendMessage,
  unpinChatMessage,
} from './telegram';
import { scheduleKeyboard } from './keyboard';
import { dayNameOf, isSaturdayMsk, mskDateOffset, mskParts } from './time';
import { env } from './env';

const LAST_CHECK_KEY = 'last_check';
const LAST_SEND_KEY = 'last_send_date';

export interface CheckResult {
  filesOnSite: number;
  changed: string[];
  errors: string[];
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Скачивает и разбирает один файл, пишет результат в БД. */
async function ingest(
  file: SiteFile,
  download: (f: SiteFile) => Promise<Buffer>,
): Promise<{ changed: boolean; row: FileRow | null; error?: string }> {
  const name = fileNameOf(file.url);
  const existing = await getFileByName(name);
  const buf = await download(file);
  const hash = sha256(buf);

  if (existing && existing.sha256 === hash && existing.parsed_ok) {
    await touchFile(name);
    return { changed: false, row: existing };
  }

  try {
    const workbook = parseSchedule(buf);
    const row = await upsertFile({
      name,
      url: file.url,
      title: file.title,
      sha256: hash,
      size: buf.byteLength,
      siteUpdated: file.siteUpdated,
      weekStart: workbook.weekStart,
      parsedOk: true,
      parseError: null,
    });
    const inserted = await replaceSchedules(row.id, workbook);

    // Тот же файл мог уже лежать в базе под прежним именем — убираем дубль,
    // иначе навигация покажет одну неделю дважды
    const superseded = workbook.weekStart
      ? await dropSupersededWeeks(row.id, workbook.weekStart)
      : 0;
    await log('file_changed', `Файл «${file.title}» обновлён`, {
      details: {
        groups: workbook.groups.length,
        rows: inserted,
        weekStart: workbook.weekStart,
        siteUpdated: file.siteUpdated,
        superseded,
      },
    });
    return { changed: true, row };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await upsertFile({
      name,
      url: file.url,
      title: file.title,
      sha256: hash,
      size: buf.byteLength,
      siteUpdated: file.siteUpdated,
      weekStart: null,
      parsedOk: false,
      parseError: message,
    });
    await logError(`Разбор файла «${file.title}»`, error);
    return { changed: false, row: null, error: message };
  }
}

/** Проверяет сайт и обновляет БД. Возвращает список изменившихся файлов. */
export async function checkSite(): Promise<CheckResult> {
  const started = Date.now();
  const result: CheckResult = { filesOnSite: 0, changed: [], errors: [] };

  // Отметку о проверке пишем в любом случае — даже если сайт не ответил.
  // Иначе на статус-странице выглядело бы, будто крон умер, хотя недоступен сайт.
  const record = async () => {
    await setState(LAST_CHECK_KEY, {
      at: new Date().toISOString(),
      filesOnSite: result.filesOnSite,
      changed: result.changed,
      errors: result.errors,
      durationMs: Date.now() - started,
    });
  };

  let site: Awaited<ReturnType<typeof fetchSite>>;
  try {
    site = await fetchSite();
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    await record();
    await log('check', 'Проверка сайта не удалась', {
      durationMs: Date.now() - started,
      details: { errors: result.errors },
    });
    throw error;
  }

  result.filesOnSite = site.files.length;

  if (site.files.length === 0) {
    result.errors.push('На странице нет файлов расписания');
    await logError('Проверка сайта', new Error('На странице нет ни одного .xls/.xlsx'));
  }

  for (const file of site.files) {
    try {
      const outcome = await ingest(file, site.download);
      if (outcome.changed) result.changed.push(file.title);
      if (outcome.error) result.errors.push(`${file.title}: ${outcome.error}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${file.title}: ${message}`);
      await logError(`Скачивание файла «${file.title}»`, error);
    }
  }

  await record();

  await log('check', `Проверка сайта: файлов ${result.filesOnSite}, изменилось ${result.changed.length}`, {
    durationMs: Date.now() - started,
    details: { changed: result.changed, errors: result.errors },
  });

  return result;
}

/**
 * Перерисовывает закреплённое расписание, когда колледж поменял файл.
 *
 * Раньше здесь уходило отдельное сообщение «расписание обновилось» — в группе
 * это спам, да ещё и со ссылками на команды, которых больше нет. Теперь просто
 * правим уже закреплённое сообщение: там всегда актуальные пары, а новых
 * сообщений в чате не появляется. Если править нечего или не вышло — молчим.
 */
export async function refreshPinned(): Promise<number> {
  const chats = await activeChats();
  const today = mskDateOffset(0);
  const weeks = await weekStarts();
  let updated = 0;

  for (const chat of chats) {
    const date = chat.pinned_date;
    if ((chat.groups ?? []).length === 0 || !chat.pinned_msg_id || !date) continue;
    // День уже прошёл — перерисовывать нечего
    if (date < today) continue;

    try {
      const rendered = await renderDay(chat.chat_id, chat.groups, date, weeks, date === today);

      const ok = await editMessageText(
        chat.chat_id,
        chat.pinned_msg_id,
        rendered.text,
        rendered.keyboard,
        { fallbackToSend: false },
      );

      if (ok) {
        updated++;
        await log('send', 'Закреплённое расписание обновлено', {
          chatId: chat.chat_id,
          details: { date },
        });
      }
    } catch (error) {
      await logError(`Обновление закреплённого сообщения в чате ${chat.chat_id}`, error);
    }
  }

  return updated;
}

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
    (date) =>
      withLessons.get(date) ?? { date, name: dayNameOf(date), lessons: [] },
  );
}

/**
 * Текст и кнопки расписания на день сразу по всем группам чата.
 * Общий код для рассылки и для перерисовки закреплённого сообщения.
 */
async function renderDay(
  chatId: number,
  stored: string[],
  dateIso: string,
  weeks: string[],
  isToday = false,
): Promise<{ text: string; keyboard: ReturnType<typeof scheduleKeyboard> }> {
  const { groups, missing } = await currentGroups(chatId, stored);
  const perGroup = await Promise.all(groups.map((group) => getWeek(group, dateIso)));

  const blocks: GroupDay[] = groups.map((group, index) => ({
    group,
    day: perGroup[index].days.find((d) => d.date === dateIso) ?? null,
  }));

  const file = perGroup.find((w) => w.file)?.file ?? null;

  const merged = await keyboardDays(perGroup);
  const hasDay = blocks.some((b) => b.day);

  return {
    text: formatDayFor(dateIso, dayNameOf(dateIso), blocks, {
      siteUpdated: file?.site_updated ?? null,
      heading: isToday ? 'Расписание на сегодня' : 'Расписание на завтра',
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
  };
}

/** Сколько чатов обслуживаем одновременно. Telegram допускает ~30 сообщений в секунду. */
const SEND_CONCURRENCY = 8;

/**
 * Сколько времени отводим рассылке. Лимит функции — 60 секунд; останавливаемся
 * заранее, чтобы успеть записать состояние и вернуть ответ.
 */
const SEND_BUDGET_MS = 45_000;

/** Отправляет расписание одному чату. Возвращает, удалось ли. */
async function sendToChat(
  chat: Chat,
  dateIso: string,
  weeks: string[],
): Promise<'sent' | 'failed' | 'disabled'> {
  const groups = chat.groups ?? [];
  if (groups.length === 0) return 'failed';

  try {
    const rendered = await renderDay(chat.chat_id, groups, dateIso, weeks);

    // Кнопки и под закреплённым сообщением: можно листать дни, не набирая команды
    const message = await sendMessage(chat.chat_id, rendered.text, {
      silent: false,
      keyboard: rendered.keyboard,
    });

    // Дату помечаем сразу после отправки, до закрепления: она означает
    // «за этот день уже отправлено», и по ней рассылка продолжается с места
    // обрыва, а не начинает всё заново.
    await setPinnedMessage(chat.chat_id, message.message_id, dateIso);

    if (chat.pinned_msg_id) {
      try {
        await unpinChatMessage(chat.chat_id, chat.pinned_msg_id);
      } catch {
        // старое сообщение могли удалить вручную — это не ошибка
      }
    }

    try {
      await pinChatMessage(chat.chat_id, message.message_id);
    } catch (error) {
      // без прав на закрепление сообщение всё равно отправлено
      await log('skip', `Не удалось закрепить сообщение в чате ${chat.chat_id}`, {
        chatId: chat.chat_id,
        details: { reason: error instanceof Error ? error.message : String(error) },
      });
    }

    await log('send', `Расписание на ${dateIso} отправлено`, {
      chatId: chat.chat_id,
      details: { groups },
    });
    return 'sent';
  } catch (error) {
    // Бота выгнали или заблокировали — выключаем чат, иначе он будет
    // впустую отъедать время рассылки каждый день
    if (error instanceof TelegramError && error.chatIsGone) {
      await setChatEnabled(chat.chat_id, false);
      await log('skip', `Чат ${chat.chat_id} недоступен, выключен`, {
        chatId: chat.chat_id,
        details: { reason: error.description },
      });
      return 'disabled';
    }

    await logError(`Отправка расписания в чат ${chat.chat_id}`, error);
    return 'failed';
  }
}

export interface SendResult {
  sent: number;
  failed: number;
  disabled: number;
  /** Чаты, до которых не дошли из-за нехватки времени. */
  pending: number;
}

/**
 * Рассылает расписание на завтра.
 *
 * Чаты обслуживаются пачками: последовательный цикл при полусотне чатов
 * упирался в лимит функции, и остаток молча оставался без расписания.
 * Если время всё же кончается, работа прерывается штатно — уже отправленные
 * чаты помечены датой, и следующий тик продолжит с места обрыва.
 */
export async function sendTomorrow(): Promise<SendResult> {
  const dateIso = mskDateOffset(1);
  const weeks = await weekStarts();
  const deadline = Date.now() + SEND_BUDGET_MS;

  const all = await activeChats();
  const queue = all.filter(
    (chat) => (chat.groups ?? []).length > 0 && chat.pinned_date !== dateIso,
  );

  const result: SendResult = { sent: 0, failed: 0, disabled: 0, pending: 0 };
  let next = 0;

  const worker = async () => {
    while (true) {
      if (Date.now() > deadline) return;
      const index = next++;
      if (index >= queue.length) return;

      const outcome = await sendToChat(queue[index], dateIso, weeks);
      if (outcome === 'sent') result.sent++;
      else if (outcome === 'disabled') result.disabled++;
      else result.failed++;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(SEND_CONCURRENCY, queue.length) }, () => worker()),
  );

  result.pending = Math.max(0, queue.length - result.sent - result.failed - result.disabled);

  if (result.pending > 0) {
    await log('skip', `Не хватило времени: ${result.pending} чатов ждут следующего тика`, {
      details: { queue: queue.length, ...result },
    });
  }

  return result;
}

export interface TickResult {
  check: CheckResult | null;
  autoSend: 'sent' | 'skipped-saturday' | 'skipped-hour' | 'skipped-already' | 'skipped-parse-error' | null;
  sent?: number;
  failed?: number;
  disabled?: number;
  pending?: number;
}

/** Один часовой тик: проверить сайт, при необходимости разослать. */
export async function tick(force = false): Promise<TickResult> {
  const out: TickResult = { check: null, autoSend: null };

  try {
    out.check = await checkSite();
    if (out.check.changed.length > 0) await refreshPinned();
  } catch (error) {
    await logError('Проверка сайта', error);
    out.check = {
      filesOnSite: 0,
      changed: [],
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  const now = new Date();
  const { hour } = mskParts(now);
  const today = mskDateOffset(0, now);

  if (!force) {
    if (isSaturdayMsk(now)) {
      out.autoSend = 'skipped-saturday';
      await log('skip', 'Суббота — автоотправку не делаем');
      return out;
    }
    // «Не раньше», а не «ровно в»: если тик в нужный час пропал (крон опоздал,
    // Vercel был недоступен), рассылка уйдёт на следующем тике, а не потеряется.
    if (hour < env.sendHourMsk) {
      out.autoSend = 'skipped-hour';
      return out;
    }
    const lastSend = await getState<string>(LAST_SEND_KEY);
    if (lastSend === today) {
      out.autoSend = 'skipped-already';
      return out;
    }
  }

  const file = await latestFile();
  if (!file) {
    out.autoSend = 'skipped-parse-error';
    await logError('Автоотправка', new Error('Нет ни одного успешно разобранного файла'));
    return out;
  }

  const outcome = await sendTomorrow();
  out.autoSend = 'sent';
  out.sent = outcome.sent;
  out.failed = outcome.failed;
  out.disabled = outcome.disabled;
  out.pending = outcome.pending;

  // День помечаем отправленным, только когда очередь разошлась полностью,
  // иначе остаток чатов никогда не получит расписание
  if (outcome.pending === 0) await setState(LAST_SEND_KEY, today);

  return out;
}

export { LAST_CHECK_KEY, LAST_SEND_KEY };
