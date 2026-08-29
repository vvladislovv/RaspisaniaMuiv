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
  setPinnedMessage,
  setState,
  getState,
  touchFile,
  upsertFile,
  getWeek,
  weekStarts,
  type Chat,
  type FileRow,
} from './db';
import { log, logError } from './log';
import { formatDay, formatEmptyDay } from './format';
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
    await log('file_changed', `Файл «${file.title}» обновлён`, {
      details: {
        groups: workbook.groups.length,
        rows: inserted,
        weekStart: workbook.weekStart,
        siteUpdated: file.siteUpdated,
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
    if (!chat.group_name || !chat.pinned_msg_id || !chat.pinned_date) continue;
    // День уже прошёл — перерисовывать нечего
    if (chat.pinned_date < today) continue;

    try {
      const { days, file } = await getWeek(chat.group_name, chat.pinned_date);
      const day = days.find((d) => d.date === chat.pinned_date) ?? null;

      const opts = {
        group: chat.group_name,
        siteUpdated: file?.site_updated ?? null,
        heading: chat.pinned_date === today ? 'Расписание на сегодня' : 'Расписание на завтра',
      };
      const text = day
        ? formatDay(day, opts)
        : formatEmptyDay(chat.pinned_date, dayNameOf(chat.pinned_date), opts);

      const ok = await editMessageText(
        chat.chat_id,
        chat.pinned_msg_id,
        text,
        scheduleKeyboard(days, day ? chat.pinned_date : null, file?.week_start ?? null, weeks),
        { fallbackToSend: false },
      );

      if (ok) {
        updated++;
        await log('send', 'Закреплённое расписание обновлено', {
          chatId: chat.chat_id,
          details: { date: chat.pinned_date },
        });
      }
    } catch (error) {
      await logError(`Обновление закреплённого сообщения в чате ${chat.chat_id}`, error);
    }
  }

  return updated;
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
  dayName: string,
  weeks: string[],
): Promise<'sent' | 'failed' | 'disabled'> {
  if (!chat.group_name) return 'failed';

  try {
    // Берём неделю, содержащую завтрашний день: так подпись «файл обновлён»
    // относится к тому файлу, из которого взято расписание.
    const { days, file } = await getWeek(chat.group_name, dateIso);
    const day = days.find((d) => d.date === dateIso) ?? null;

    const opts = {
      group: chat.group_name,
      siteUpdated: file?.site_updated ?? null,
      heading: 'Расписание на завтра',
    };
    const text = day ? formatDay(day, opts) : formatEmptyDay(dateIso, dayName, opts);

    // Кнопки и под закреплённым сообщением: можно листать дни, не набирая команды
    const keyboard = scheduleKeyboard(days, day ? dateIso : null, file?.week_start ?? null, weeks);
    const message = await sendMessage(chat.chat_id, text, { silent: false, keyboard });

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
      details: { group: chat.group_name, lessons: day?.lessons.length ?? 0 },
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
  const dayName = dayNameOf(dateIso);
  const weeks = await weekStarts();
  const deadline = Date.now() + SEND_BUDGET_MS;

  const all = await activeChats();
  const queue = all.filter((chat) => chat.group_name && chat.pinned_date !== dateIso);

  const result: SendResult = { sent: 0, failed: 0, disabled: 0, pending: 0 };
  let next = 0;

  const worker = async () => {
    while (true) {
      if (Date.now() > deadline) return;
      const index = next++;
      if (index >= queue.length) return;

      const outcome = await sendToChat(queue[index], dateIso, dayName, weeks);
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
