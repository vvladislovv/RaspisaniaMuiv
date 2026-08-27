/**
 * Главная логика: проверка сайта, обновление БД, автоотправка.
 * Вызывается из /api/tick раз в час.
 */
import { createHash } from 'node:crypto';
import { fetchSite, type SiteFile } from './muiv';
import { parseSchedule } from './parse';
import {
  activeChats,
  getFileByUrl,
  latestFile,
  replaceSchedules,
  setPinnedMessage,
  setState,
  getState,
  touchFile,
  upsertFile,
  getDay,
  type FileRow,
} from './db';
import { log, logError } from './log';
import { formatDay, formatEmptyDay, esc } from './format';
import { pinChatMessage, sendMessage, unpinChatMessage } from './telegram';
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
  const existing = await getFileByUrl(file.url);
  const buf = await download(file);
  const hash = sha256(buf);

  if (existing && existing.sha256 === hash && existing.parsed_ok) {
    await touchFile(file.url);
    return { changed: false, row: existing };
  }

  try {
    const workbook = parseSchedule(buf);
    const row = await upsertFile({
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

  const site = await fetchSite();
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

  await setState(LAST_CHECK_KEY, {
    at: new Date().toISOString(),
    filesOnSite: result.filesOnSite,
    changed: result.changed,
    errors: result.errors,
    durationMs: Date.now() - started,
  });

  await log('check', `Проверка сайта: файлов ${result.filesOnSite}, изменилось ${result.changed.length}`, {
    durationMs: Date.now() - started,
    details: { changed: result.changed, errors: result.errors },
  });

  return result;
}

/** Рассылает уведомление об обновлении расписания. */
async function notifyUpdate(titles: string[]): Promise<void> {
  const chats = await activeChats();
  const list = titles.map((t) => `• ${esc(t)}`).join('\n');

  for (const chat of chats) {
    try {
      await sendMessage(
        chat.chat_id,
        `⚠️ *Расписание обновилось*\n\n${list}\n\nАктуальное на завтра — /tomorrow, вся неделя — /week`,
        { silent: true },
      );
      await log('send', 'Уведомление об обновлении', { chatId: chat.chat_id });
    } catch (error) {
      await logError(`Уведомление об обновлении в чат ${chat.chat_id}`, error);
    }
  }
}

/** Отправляет расписание на завтра во все активные чаты и закрепляет сообщение. */
export async function sendTomorrow(): Promise<{ sent: number; failed: number }> {
  const chats = await activeChats();
  const file = await latestFile();
  const dateIso = mskDateOffset(1);
  const dayName = dayNameOf(dateIso);

  let sent = 0;
  let failed = 0;

  for (const chat of chats) {
    if (!chat.group_name) continue;

    try {
      const day = await getDay(chat.group_name, dateIso);

      const text = day
        ? formatDay(day, {
            group: chat.group_name,
            siteUpdated: file?.site_updated ?? null,
            heading: 'Расписание на завтра',
          })
        : formatEmptyDay(dateIso, dayName, {
            group: chat.group_name,
            siteUpdated: file?.site_updated ?? null,
            heading: 'Расписание на завтра',
          });

      const message = await sendMessage(chat.chat_id, text, { silent: false });

      if (chat.pinned_msg_id) {
        try {
          await unpinChatMessage(chat.chat_id, chat.pinned_msg_id);
        } catch {
          // старое сообщение могли удалить вручную — это не ошибка
        }
      }

      try {
        await pinChatMessage(chat.chat_id, message.message_id);
        await setPinnedMessage(chat.chat_id, message.message_id);
      } catch (error) {
        // без прав на закрепление сообщение всё равно отправлено
        await log('skip', `Не удалось закрепить сообщение в чате ${chat.chat_id}`, {
          chatId: chat.chat_id,
          details: { reason: error instanceof Error ? error.message : String(error) },
        });
      }

      sent++;
      await log('send', `Расписание на ${dateIso} отправлено`, {
        chatId: chat.chat_id,
        details: { group: chat.group_name, lessons: day?.lessons.length ?? 0 },
      });
    } catch (error) {
      failed++;
      await logError(`Отправка расписания в чат ${chat.chat_id}`, error);
    }
  }

  return { sent, failed };
}

export interface TickResult {
  check: CheckResult | null;
  autoSend: 'sent' | 'skipped-saturday' | 'skipped-hour' | 'skipped-already' | 'skipped-parse-error' | null;
  sent?: number;
  failed?: number;
}

/** Один часовой тик: проверить сайт, при необходимости разослать. */
export async function tick(force = false): Promise<TickResult> {
  const out: TickResult = { check: null, autoSend: null };

  try {
    out.check = await checkSite();
    if (out.check.changed.length > 0) await notifyUpdate(out.check.changed);
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
    if (hour !== env.sendHourMsk) {
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

  const { sent, failed } = await sendTomorrow();
  out.autoSend = 'sent';
  out.sent = sent;
  out.failed = failed;
  await setState(LAST_SEND_KEY, today);

  return out;
}

export { LAST_CHECK_KEY, LAST_SEND_KEY };
