/**
 * Главная логика: проверка сайта, обновление БД, автоотправка.
 * Вызывается из /api/tick раз в час.
 */
import { createHash } from 'node:crypto';
import { withBrowserSession, type BrowserSession } from './browser';
import { SCHEDULE_URL, fetchCatalog, fetchGroupSchedule } from './muiv';
import type { Day, Workbook } from './parse';
import {
  activeChats,
  setChatEnabled,
  setChatTopic,
  getFileByName,
  latestFile,
  replaceSchedules,
  setPinnedMessage,
  setState,
  getState,
  clearState,
  touchFile,
  upsertFile,
  getWeek,
  weekStarts,
  currentGroups,
  weekDates,
  withReadCache,
  catalogEntry,
  replaceGroupsCatalog,
  type Chat,
  type FileRow,
} from './db';
import { log, logError } from './log';
import { formatDayFor, type GroupDay } from './format';
import {
  TelegramError,
  editMessageText,
  pinChatMessage,
  sendMessage,
  unpinChatMessage,
  type InlineKeyboard,
  type SentMessage,
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

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Разбор дней для одной группы — то, что раньше было «файлом» на сайте
 * (`.xlsx`), теперь получено по AJAX и не имеет ни адреса, ни своего веса в
 * байтах. Имя всё равно нужно стабильное: по нему ищется существующая
 * запись, а адрес и размер в новой модели чисто описательные.
 */
async function ingestGroup(
  groupName: string,
  days: Day[],
): Promise<{ changed: boolean; row: FileRow | null; error?: string }> {
  const name = `ajax:${groupName}`;
  const existing = await getFileByName(name);
  const hash = sha256(JSON.stringify(days));

  if (existing && existing.sha256 === hash && existing.parsed_ok) {
    await touchFile(name);
    return { changed: false, row: existing };
  }

  const weekStart = days[0]?.date ?? null;
  const workbook: Workbook = { weekStart, groups: [{ group: groupName, sheet: '', days }] };

  try {
    if (days.length === 0) throw new Error('Нет ни одного дня в расписании группы');

    const row = await upsertFile({
      name,
      url: SCHEDULE_URL,
      title: groupName,
      sha256: hash,
      size: JSON.stringify(days).length,
      siteUpdated: null,
      weekStart: workbook.weekStart,
      parsedOk: true,
      parseError: null,
    });
    const inserted = await replaceSchedules(row.id, workbook);

    // Дублей недели тут не бывает: имя файла — стабильный ключ группы
    // (`ajax:<group>`), upsertFile обновляет тот же ряд, а не создаёт новый.
    // dropSupersededWeeks здесь не нужен и опасен: он чистит весь `files` без
    // привязки к группе, а теперь на каждую группу свой ряд с той же неделей.
    await log('file_changed', `Расписание «${groupName}» обновлено`, {
      details: { days: days.length, rows: inserted, weekStart: workbook.weekStart },
    });
    return { changed: true, row };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await upsertFile({
      name,
      url: SCHEDULE_URL,
      title: groupName,
      sha256: hash,
      size: JSON.stringify(days).length,
      siteUpdated: null,
      weekStart: null,
      parsedOk: false,
      parseError: message,
    });
    await logError(`Разбор расписания «${groupName}»`, error);
    return { changed: false, row: null, error: message };
  }
}

const CATALOG_REFRESH_KEY = 'catalog_refreshed_date';

/**
 * Раз в сутки обходит весь каталог университета (курс × форма обучения) и
 * обновляет `groups_catalog` — список для кнопок выбора группы в /start.
 * Часовой тик каталог не трогает: он тянет расписание только уже подписанных
 * групп, а полный обход дороже и нужен реже.
 */
async function maybeRefreshCatalog(session: BrowserSession): Promise<void> {
  const today = mskDateOffset(0);
  const lastRefresh = await getState<string>(CATALOG_REFRESH_KEY);
  if (lastRefresh === today) return;

  const catalog = await fetchCatalog(session.page);
  await replaceGroupsCatalog(catalog);
  await setState(CATALOG_REFRESH_KEY, today);
  await log('check', `Каталог групп обновлён: ${catalog.length}`, {
    details: { groups: catalog.length },
  });
}

/** Проверяет сайт и обновляет БД. Возвращает список изменившихся файлов. */
/**
 * Будить ли владельца на N-м подряд сбое одного файла.
 *
 * Чужой сервер иногда отвечает медленно, и следующая проверка через час
 * обычно проходит — расписание в базе от одного промаха не устаревает.
 * Поэтому первый промах молчит, со второго (файл недоступен больше часа)
 * приходит алерт, а дальше напоминание раз в двенадцать часов, чтобы
 * многодневная авария сайта не превратилась в поток сообщений.
 */
export function shouldAlertOnStreak(streak: number): boolean {
  return streak === 2 || (streak > 2 && streak % 12 === 0);
}

const failKey = (title: string): string => `siteFail:${title}`.slice(0, 200);

/** Записывает сбой скачивания и решает, беспокоить ли владельца. */
export async function noteFileFailure(title: string, error: unknown): Promise<void> {
  const key = failKey(title);
  const streak = ((await getState<number>(key)) ?? 0) + 1;
  await setState(key, streak);

  if (shouldAlertOnStreak(streak)) {
    await logError(`Скачивание файла «${title}»`, error, { streak });
    return;
  }

  await log('skip', `Файл «${title}» не скачался, попробуем через час`, {
    details: { streak, reason: error instanceof Error ? error.message : String(error) },
  });
}

/** Файл снова читается — серия сбоев кончилась. */
export async function noteFileOk(title: string): Promise<void> {
  if ((await getState<number>(failKey(title))) !== null) await clearState(failKey(title));
}

/**
 * Проверяет сайт и обновляет БД.
 *
 * Тянет расписание только для групп, на которые сейчас подписан хотя бы один
 * включённый чат — не весь каталог университета: один прогон поднимает
 * настоящий Chromium, и укладываться нужно в 60-секундный лимит функции.
 * Каталог всех групп (для кнопок выбора) обновляется отдельно, раз в сутки —
 * см. `maybeRefreshCatalog`.
 */
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

  const chats = await activeChats();
  const groupNames = [...new Set(chats.flatMap((c) => c.groups ?? []))];

  // Браузер поднимается в любом случае, даже без подписанных групп: раз в
  // сутки нужно обновить каталог для кнопок выбора группы (иначе на пустой
  // базе /start никогда не покажет ни одной группы)
  let scheduleByGroup: Map<string, Day[] | Error>;
  try {
    scheduleByGroup = await withBrowserSession(SCHEDULE_URL, async (session) => {
      await maybeRefreshCatalog(session);

      const out = new Map<string, Day[] | Error>();
      for (const groupName of groupNames) {
        try {
          const entry = await catalogEntry(groupName);
          if (!entry) {
            out.set(groupName, new Error('Группы нет в каталоге сайта — возможно, переименована'));
            continue;
          }
          out.set(groupName, await fetchGroupSchedule(session.page, entry));
        } catch (error) {
          out.set(groupName, error instanceof Error ? error : new Error(String(error)));
        }
      }
      return out;
    });
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    await record();
    await log('check', 'Проверка сайта не удалась', {
      durationMs: Date.now() - started,
      details: { errors: result.errors },
    });
    throw error;
  }

  result.filesOnSite = groupNames.length;

  for (const groupName of groupNames) {
    const outcome = scheduleByGroup.get(groupName);
    try {
      if (outcome instanceof Error) throw outcome;
      const ingested = await ingestGroup(groupName, outcome ?? []);
      if (ingested.changed) result.changed.push(groupName);
      if (ingested.error) result.errors.push(`${groupName}: ${ingested.error}`);
      await noteFileOk(groupName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${groupName}: ${message}`);
      await noteFileFailure(groupName, error);
    }
  }

  await record();

  await log('check', `Проверка сайта: групп ${result.filesOnSite}, изменилось ${result.changed.length}`, {
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
  return withReadCache(runRefreshPinned);
}

async function runRefreshPinned(): Promise<number> {
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

/**
 * Отправка с оглядкой на тему форума.
 *
 * Тему могли удалить или закрыть уже после того, как её выбрали. Ронять из-за
 * этого рассылку нельзя: слать нечем — значит слать в «Общее», а настройку
 * забыть, чтобы в следующий раз не биться в ту же стену.
 */
async function sendToTopic(
  chat: Chat,
  text: string,
  keyboard: InlineKeyboard,
): Promise<SentMessage> {
  try {
    return await sendMessage(chat.chat_id, text, {
      silent: false,
      keyboard,
      threadId: chat.topic_id,
    });
  } catch (error) {
    if (!(chat.topic_id && error instanceof TelegramError && error.topicIsGone)) throw error;

    await setChatTopic(chat.chat_id, null);
    await log('skip', `Тема ${chat.topic_id} в чате ${chat.chat_id} недоступна`, {
      chatId: chat.chat_id,
      details: { reason: error.description },
    });
    return sendMessage(chat.chat_id, text, { silent: false, keyboard });
  }
}

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
    const message = await sendToTopic(chat, rendered.text, rendered.keyboard);

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
  // Расписание одно на всех: внутри кэша список групп и недели читаются
  // из базы один раз, а не по разу на каждый чат
  return withReadCache(runSendTomorrow);
}

async function runSendTomorrow(): Promise<SendResult> {
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
