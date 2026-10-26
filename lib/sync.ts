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
  markFileParsed,
  setPinnedMessage,
  setState,
  getState,
  clearState,
  touchFile,
  upsertFile,
  weekStarts,
  withReadCache,
  acquireLock,
  pruneOldRows,
  releaseLock,
  catalogEntries,
  groupFileName,
  groupFileStatus,
  listGroups,
  replaceGroupsCatalog,
  resolveGroups,
  renameChatGroups,
  type Chat,
} from './db';
import { log, logError } from './log';
import { renderDay } from './render';
import {
  TelegramError,
  editMessageText,
  pinChatMessage,
  sendMessage,
  unpinChatMessage,
  type InlineKeyboard,
  type SentMessage,
} from './telegram';
import { isSaturdayMsk, mskDateOffset, mskParts, mondayOf, weekAnchor } from './time';
import { env } from './env';
import {
  LAST_CHECK_KEY,
  SWEEP_ATTEMPTS_KEY,
  forEachUntil,
  planSweep,
  weekBounds,
  weekOfGroup,
  type CheckRecord,
  type SweepReport,
} from './sweep';

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
 * Записывает неделю одной группы в базу.
 *
 * Расписание приходит по AJAX и не имеет ни адреса, ни своего веса в байтах,
 * поэтому запись в `files` ключуется именем группы (см. `groupFileName`).
 * Неделя без единой пары не пишется вовсе — см. `weekOfGroup`.
 */
async function ingestGroup(
  groupName: string,
  rawDays: Day[],
): Promise<{ changed: boolean; empty: boolean }> {
  const name = groupFileName(groupName);
  const days = weekOfGroup(rawDays, weekAnchor());
  if (!days) return { changed: false, empty: true };

  // `files.url` уникален в схеме, а у всех групп один SCHEDULE_URL —
  // различаем адрес фрагментом с именем группы
  const url = `${SCHEDULE_URL}#group=${encodeURIComponent(groupName)}`;
  const existing = await getFileByName(name);
  const hash = sha256(JSON.stringify(days));

  if (existing && existing.sha256 === hash && existing.parsed_ok) {
    await touchFile(name);
    return { changed: false, empty: false };
  }

  const workbook: Workbook = {
    weekStart: days[0].date,
    groups: [{ group: groupName, sheet: '', days }],
  };

  // Ошибку базы здесь не глотаем: её поймает обход и сложит в общий отчёт.
  // Отдельный алерт на каждую группу при сбое Supabase — это десятки
  // одинаковых сообщений владельцу за один тик.
  //
  // «Разобран» ставим только после записи дней. Иначе сбой на вставке дней
  // оставлял бы файл с новым хешем и `parsed_ok`, и следующий тик счёл бы
  // группу загруженной, хотя дней у неё в базе уже нет.
  const row = await upsertFile({
    name,
    url,
    title: groupName,
    sha256: hash,
    size: JSON.stringify(days).length,
    siteUpdated: null,
    weekStart: workbook.weekStart,
    parsedOk: false,
    parseError: 'дни недели ещё записываются',
  });
  const inserted = await replaceSchedules(row.id, workbook);
  await markFileParsed(row.id);

  await log('file_changed', `Расписание «${groupName}» обновлено`, {
    details: { days: days.length, rows: inserted, weekStart: workbook.weekStart },
  });
  return { changed: true, empty: false };
}

const CATALOG_REFRESH_KEY = 'catalog_refreshed_date';

/**
 * Раз в сутки обходит весь каталог университета (курс × форма обучения) и
 * обновляет `groups_catalog` — список для кнопок выбора и очередь обхода.
 *
 * Сбой здесь не роняет тик: вчерашний каталог ничем не хуже, а расписание
 * групп скачать всё равно нужно. Курс, пришедший без единой группы, — сбой
 * сайта, а не расформирование всех групп разом: группы такого курса
 * оставляем как были, иначе сотни подписок разом стали бы «группы больше
 * нет». Остальные курсы обновляются как обычно.
 */
async function maybeRefreshCatalog(session: BrowserSession, site: SiteAccess): Promise<void> {
  const today = mskDateOffset(0);
  if ((await getState<string>(CATALOG_REFRESH_KEY)) === today) return;

  try {
    const catalog = await site.fetchCatalog(session.page);
    const known = await listGroups();
    const lostCourses = [...new Set(known.map((g) => g.sheet))].filter(
      (year): year is string => !!year && !catalog.some((e) => e.year === year),
    );

    await replaceGroupsCatalog(catalog, lostCourses);
    await setState(CATALOG_REFRESH_KEY, today);
    await log('check', `Каталог групп обновлён: ${catalog.length}`, {
      details: { groups: catalog.length, keptCourses: lostCourses },
    });
    if (lostCourses.length > 0) {
      await log('skip', `Сайт не отдал ни одной группы: ${lostCourses.join(', ')} — оставляю прежние`, {
        details: { courses: lostCourses },
      });
    }
  } catch (error) {
    await log('skip', 'Каталог групп не обновлён, остаётся прежний', {
      details: { reason: error instanceof Error ? error.message : String(error) },
    });
  }
}

/**
 * Какие из пропавших подписанных групп считать сбоем для владельца.
 *
 * Если каталог загружен, а одной группы в нём нет, её убрал колледж: человек
 * видит в боте «выбери заново», и будить владельца раз в двенадцать часов
 * незачем. Пустой каталог — другое дело: это сбой обхода сайта, и пропадает
 * сразу всё.
 */
export function missingGroupsToAlert(missing: string[], catalogSize: number): string[] {
  return catalogSize > 0 ? [] : missing;
}

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

/** Ещё один сбой подряд. Возвращает длину серии. */
async function bumpFailStreak(title: string): Promise<number> {
  const key = failKey(title);
  const streak = ((await getState<number>(key)) ?? 0) + 1;
  await setState(key, streak);
  return streak;
}

/** Записывает сбой скачивания и решает, беспокоить ли владельца. */
export async function noteFileFailure(title: string, error: unknown): Promise<void> {
  const streak = await bumpFailStreak(title);

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
 * Чем ходить на сайт. По умолчанию — настоящий браузер; проверки подставляют
 * свою заглушку, чтобы гонять обход, не трогая сайт колледжа.
 */
export interface SiteAccess {
  openSession: typeof withBrowserSession;
  fetchCatalog: typeof fetchCatalog;
  fetchGroupSchedule: typeof fetchGroupSchedule;
}

const REAL_SITE: SiteAccess = {
  openSession: withBrowserSession,
  fetchCatalog,
  fetchGroupSchedule,
};

/**
 * Сколько групп качаем одновременно. Два запроса разом — обычное поведение
 * страницы в браузере; больше не берём, чтобы не злить защиту сайта.
 */
const FETCH_CONCURRENCY = 2;

/**
 * Сколько времени отдаём обходу сайта, если его вызвали без дедлайна.
 * Начатый запрос может идти ещё до 10 секунд (таймаут ajax.php) — это
 * учтено в общем окне тика.
 */
const SWEEP_BUDGET_MS = 32_000;

/**
 * Проверяет сайт и обновляет БД.
 *
 * Держит в базе текущую неделю каждой группы каталога, а не только
 * подписанных: выбранная группа сразу показывает расписание, и бот не
 * поднимает браузер на каждое нажатие (это и роняло его под нагрузкой —
 * `ERR_INSUFFICIENT_RESOURCES`). Очерёдность — в `planSweep`.
 *
 * Каждая группа пишется в базу сразу после скачивания: если время кончится,
 * сделанное не пропадёт, а следующий тик продолжит с того же места.
 */
export async function checkSite(
  deadline: number = Date.now() + SWEEP_BUDGET_MS,
  site: SiteAccess = REAL_SITE,
): Promise<CheckResult> {
  const started = Date.now();
  const result: CheckResult = { filesOnSite: 0, changed: [], errors: [] };
  const report: SweepReport = {
    monday: weekBounds(weekAnchor()).monday,
    planned: 0,
    fetched: 0,
    empty: [],
    failed: [],
  };

  // Когда какую группу пробовали: по этому очередь вращается, а не упирается
  // в одни и те же пустые группы (см. SweepCandidate.attemptedAt)
  const previousAttempts = (await getState<Record<string, string>>(SWEEP_ATTEMPTS_KEY)) ?? {};
  const attempts = new Map<string, string>();
  let catalogNames: Set<string> | null = null;

  // Отметку о проверке пишем в любом случае — даже если сайт не ответил.
  // Иначе на статус-странице выглядело бы, будто крон умер, хотя недоступен сайт.
  const record = async () => {
    if (attempts.size > 0) {
      const merged = Object.fromEntries(
        [...Object.entries(previousAttempts), ...attempts].filter(
          ([group]) => !catalogNames || catalogNames.has(group),
        ),
      );
      await setState(SWEEP_ATTEMPTS_KEY, merged);
    }
    const value: CheckRecord = {
      at: new Date().toISOString(),
      filesOnSite: result.filesOnSite,
      changed: result.changed,
      errors: result.errors,
      durationMs: Date.now() - started,
      sweep: report,
    };
    await setState(LAST_CHECK_KEY, value);
  };

  const chats = await activeChats();
  const stored = [...new Set(chats.flatMap((c) => c.groups ?? []))];

  // Имя в подписке чата и имя в каталоге сайта совпадают не всегда: колледж
  // меняет написание («РЕК 25-09.1» → «к/о/к РЕК 25-09.1»), а точное
  // совпадение строк тут не годится — нужна та же нормализация, что и при
  // показе расписания.
  const resolution = await resolveGroups(stored);
  for (const chat of chats) {
    if ((chat.groups ?? []).some((g) => resolution.renamed.some((r) => r.from === g))) {
      await renameChatGroups(chat.chat_id, resolution.renamed);
    }
  }
  const subscribed = new Set(resolution.actual.values());

  // Сбои подписанных групп копим и шлём владельцу одним сообщением: при
  // аварии сайта иначе пришло бы по алерту на каждую группу
  const alertDue: { group: string; reason: string }[] = [];
  const noteSubscribedFailure = async (group: string, reason: string) => {
    result.errors.push(`${group}: ${reason}`);
    if (shouldAlertOnStreak(await bumpFailStreak(group))) alertDue.push({ group, reason });
  };

  for (const name of missingGroupsToAlert(resolution.missing, resolution.catalogSize)) {
    await noteSubscribedFailure(name, 'Группы нет в каталоге сайта — возможно, переименована');
  }

  try {
    await site.openSession(SCHEDULE_URL, async (session) => {
      await maybeRefreshCatalog(session, site);

      const [catalog, files] = await Promise.all([catalogEntries(), groupFileStatus()]);
      const byName = new Map(catalog.map((entry) => [entry.group, entry]));
      catalogNames = new Set(byName.keys());
      const plan = planSweep(
        catalog.map((entry) => {
          const file = files.get(entry.group);
          return {
            group: entry.group,
            subscribed: subscribed.has(entry.group),
            fetchedAt: file?.fetchedAt ?? null,
            attemptedAt: previousAttempts[entry.group] ?? null,
            storedMonday: file?.weekStart ? mondayOf(file.weekStart) : null,
          };
        }),
        report.monday,
        Date.now(),
      );
      report.planned = plan.length;

      await forEachUntil(plan, FETCH_CONCURRENCY, deadline, async (group) => {
        const entry = byName.get(group);
        if (!entry) return;
        attempts.set(group, new Date().toISOString());
        try {
          const ingested = await ingestGroup(group, await site.fetchGroupSchedule(session.page, entry));
          report.fetched++;
          if (ingested.changed) result.changed.push(group);
          if (ingested.empty) report.empty.push(group);
          if (subscribed.has(group)) await noteFileOk(group);
        } catch (error) {
          const reason = (error instanceof Error ? error.message : String(error)).slice(0, 300);
          report.failed.push({ group, reason });
          if (subscribed.has(group)) await noteSubscribedFailure(group, reason);
        }
      });
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

  result.filesOnSite = report.fetched;

  if (alertDue.length > 0) {
    await logError(
      'Скачивание расписания',
      new Error(
        `не скачались ${alertDue.length} групп больше часа подряд: ` +
          alertDue.map((a) => `${a.group} (${a.reason})`).join('; '),
      ),
    );
  }

  await record();

  await log(
    'check',
    `Проверка сайта: скачано ${report.fetched} из ${report.planned}, изменилось ${result.changed.length}`,
    {
      durationMs: Date.now() - started,
      details: {
        changed: result.changed,
        empty: report.empty,
        failed: report.failed,
        errors: result.errors,
      },
    },
  );

  return result;
}

/** Группы, чьи закрепы прошлый тик не успел перерисовать. */
const PINNED_STALE_KEY = 'pinned_stale_groups';

/** Сколько закрепов правим одновременно: Telegram терпит ~30 сообщений в секунду. */
const REFRESH_CONCURRENCY = 4;

/** Сколько времени отдаём перерисовке, если её вызвали без дедлайна. */
const REFRESH_BUDGET_MS = 40_000;

/**
 * Перерисовывает закреплённое расписание, когда колледж поменял файл.
 *
 * Раньше здесь уходило отдельное сообщение «расписание обновилось» — в группе
 * это спам, да ещё и со ссылками на команды, которых больше нет. Теперь просто
 * правим уже закреплённое сообщение: там всегда актуальные пары, а новых
 * сообщений в чате не появляется. Если править нечего или не вышло — молчим.
 *
 * С `groups` правятся только чаты этих групп: при двухстах чатах перерисовка
 * всех подряд из-за одной изменившейся группы съедала бы весь тик. Чаты, до
 * которых не дошли руки, запоминаются и идут первыми на следующем тике —
 * иначе их закреп так и остался бы старым.
 */
export async function refreshPinned(
  groups?: string[],
  deadline: number = Date.now() + REFRESH_BUDGET_MS,
): Promise<number> {
  return withReadCache(() => runRefreshPinned(groups, deadline));
}

async function runRefreshPinned(groups: string[] | undefined, deadline: number): Promise<number> {
  const leftover = groups ? ((await getState<string[]>(PINNED_STALE_KEY)) ?? []) : [];
  const wanted = groups ? new Set([...groups, ...leftover]) : null;
  if (wanted && wanted.size === 0) return 0;

  const today = mskDateOffset(0);
  const chats = (await activeChats()).filter(
    (chat) =>
      (chat.groups ?? []).length > 0 &&
      chat.pinned_msg_id &&
      // День уже прошёл — перерисовывать нечего
      chat.pinned_date &&
      chat.pinned_date >= today &&
      (!wanted || chat.groups.some((g) => wanted.has(g))),
  );
  const weeks = await weekStarts();
  const touched = new Set<number>();
  let updated = 0;

  await forEachUntil(chats, REFRESH_CONCURRENCY, deadline, async (chat) => {
    touched.add(chat.chat_id);
    const date = chat.pinned_date!;
    try {
      const rendered = await renderDay(
        chat.chat_id,
        chat.groups,
        date,
        weeks,
        date === today ? 'Расписание на сегодня' : 'Расписание на завтра',
      );

      const ok = await editMessageText(
        chat.chat_id,
        chat.pinned_msg_id!,
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
      // Чат — в подробностях, а не в заголовке: иначе алерты по разным
      // чатам не схлопываются, и сбой Telegram давал бы сотню сообщений
      await logError('Обновление закреплённого сообщения', error, { chatId: chat.chat_id });
    }
  });

  if (wanted) {
    const stale = [
      ...new Set(
        chats
          .filter((chat) => !touched.has(chat.chat_id))
          .flatMap((chat) => chat.groups.filter((g) => wanted.has(g))),
      ),
    ];
    if (stale.length > 0) {
      await setState(PINNED_STALE_KEY, stale);
      await log('skip', `Не успели перерисовать закрепы: ${stale.length} групп ждут следующего тика`, {
        details: { groups: stale },
      });
    } else if (leftover.length > 0) {
      await clearState(PINNED_STALE_KEY);
    }
  }

  return updated;
}

/** Сколько чатов обслуживаем одновременно. Telegram допускает ~30 сообщений в секунду. */
const SEND_CONCURRENCY = 8;

/**
 * Сколько времени отводим рассылке, если её вызвали без дедлайна. Лимит
 * функции — 60 секунд; останавливаемся заранее, чтобы успеть записать
 * состояние и вернуть ответ.
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

type SendOutcome = 'sent' | 'failed' | 'disabled' | 'waiting';

/**
 * Отправляет расписание одному чату.
 *
 * Если расписание какой-то из групп чата на эту дату ещё не скачано и
 * `allowUnready` не задан, ничего не шлёт и отвечает `waiting`: такой чат
 * остаётся в очереди и уйдёт на следующем тике, когда данные появятся.
 */
async function sendToChat(
  chat: Chat,
  dateIso: string,
  weeks: string[],
  allowUnready: boolean,
): Promise<{ outcome: SendOutcome; unready: string[] }> {
  const groups = chat.groups ?? [];
  if (groups.length === 0) return { outcome: 'failed', unready: [] };

  try {
    const rendered = await renderDay(chat.chat_id, groups, dateIso, weeks, 'Расписание на завтра');
    if (rendered.unready.length > 0 && !allowUnready) {
      return { outcome: 'waiting', unready: rendered.unready };
    }

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
      details: { groups, unready: rendered.unready },
    });
    return { outcome: 'sent', unready: rendered.unready };
  } catch (error) {
    // Бота выгнали или заблокировали — выключаем чат, иначе он будет
    // впустую отъедать время рассылки каждый день
    if (error instanceof TelegramError && error.chatIsGone) {
      await setChatEnabled(chat.chat_id, false);
      await log('skip', `Чат ${chat.chat_id} недоступен, выключен`, {
        chatId: chat.chat_id,
        details: { reason: error.description },
      });
      return { outcome: 'disabled', unready: [] };
    }

    await logError('Отправка расписания', error, { chatId: chat.chat_id });
    return { outcome: 'failed', unready: [] };
  }
}

export interface SendResult {
  sent: number;
  failed: number;
  disabled: number;
  /** Чаты, ждущие расписания своих групп: уйдут на следующем тике. */
  waiting: number;
  /** Чаты, до которых не дошли из-за нехватки времени или ждущие данных. */
  pending: number;
}

/**
 * Рассылает расписание на завтра.
 *
 * Чаты обслуживаются пачками: последовательный цикл при полусотне чатов
 * упирался в лимит функции, и остаток молча оставался без расписания.
 * Если время всё же кончается, работа прерывается штатно — уже отправленные
 * чаты помечены датой, и следующий тик продолжит с места обрыва.
 *
 * `allowUnready: false` придерживает чаты, чьё расписание на завтра ещё не
 * скачано: лучше прислать на час позже, чем разослать «Пар нет» при парах.
 */
export async function sendTomorrow(
  deadline: number = Date.now() + SEND_BUDGET_MS,
  allowUnready = true,
): Promise<SendResult> {
  // Расписание одно на всех: внутри кэша список групп и недели читаются
  // из базы один раз, а не по разу на каждый чат
  return withReadCache(() => runSendTomorrow(deadline, allowUnready));
}

async function runSendTomorrow(deadline: number, allowUnready: boolean): Promise<SendResult> {
  const dateIso = mskDateOffset(1);
  const weeks = await weekStarts();

  const all = await activeChats();
  const queue = all.filter(
    (chat) => (chat.groups ?? []).length > 0 && chat.pinned_date !== dateIso,
  );

  const result: SendResult = { sent: 0, failed: 0, disabled: 0, waiting: 0, pending: 0 };
  const waitingFor = new Set<string>();
  const sentWithout = new Set<string>();

  await forEachUntil(queue, SEND_CONCURRENCY, deadline, async (chat) => {
    const { outcome, unready } = await sendToChat(chat, dateIso, weeks, allowUnready);
    if (outcome === 'sent') result.sent++;
    else if (outcome === 'disabled') result.disabled++;
    else if (outcome === 'waiting') result.waiting++;
    else result.failed++;

    for (const group of unready) (outcome === 'waiting' ? waitingFor : sentWithout).add(group);
  });

  result.pending = Math.max(0, queue.length - result.sent - result.failed - result.disabled);

  if (result.waiting > 0) {
    await log('skip', `Ждём расписание на ${dateIso}: ${result.waiting} чатов`, {
      details: { groups: [...waitingFor] },
    });
  }

  const outOfTime = result.pending - result.waiting;
  if (outOfTime > 0) {
    await log('skip', `Не хватило времени: ${outOfTime} чатов ждут следующего тика`, {
      details: { queue: queue.length, ...result },
    });
  }

  // Ждать дальше было нельзя, и часть чатов получила «ещё не загружено».
  // Владелец должен узнать об этом сам, а не от студентов утром
  if (sentWithout.size > 0) {
    await logError(
      'Рассылка без расписания',
      new Error(`на ${dateIso} не загрузилось: ${[...sentWithout].join(', ')}`),
    );
  }

  return result;
}

export interface TickResult {
  check: CheckResult | null;
  /** Другой тик ещё идёт — этот ничего не делал. */
  locked?: boolean;
  autoSend: 'sent' | 'skipped-saturday' | 'skipped-hour' | 'skipped-already' | 'skipped-parse-error' | null;
  sent?: number;
  failed?: number;
  disabled?: number;
  waiting?: number;
  pending?: number;
}

/**
 * Время тика. Лимит функции — 60 секунд, и всё расписано так, чтобы
 * закончить раньше: обход сайта, перерисовка закрепов и рассылка делят
 * одно окно, а не берут каждый по своему. Раньше обход и рассылка
 * укладывались по отдельности, а вместе выходили за лимит.
 */
const TICK_BUDGET_MS = 45_000;

/**
 * В час рассылки сайту достаётся меньше: группы на завтра уже скачаны
 * прошлыми тиками, а отправка при сотнях чатов занимает заметное время.
 */
const SWEEP_BUDGET_SEND_MS = 15_000;

/** Перерисовке закрепов — после обхода, но не дольше этого. */
const REFRESH_AFTER_SWEEP_MS = 10_000;

/**
 * Сколько часов после часа рассылки ждём расписание на завтра. Дальше
 * рассылаем что есть: позднее сообщение никому не поможет.
 */
const SEND_WAIT_HOURS = 4;

/** Почему рассылки на этом тике нет; null — пора рассылать. */
async function sendSkipReason(now: Date): Promise<TickResult['autoSend']> {
  if (isSaturdayMsk(now)) return 'skipped-saturday';
  // «Не раньше», а не «ровно в»: если тик в нужный час пропал (крон опоздал,
  // Vercel был недоступен), рассылка уйдёт на следующем тике, а не потеряется.
  if (mskParts(now).hour < env.sendHourMsk) return 'skipped-hour';
  if ((await getState<string>(LAST_SEND_KEY)) === mskDateOffset(0, now)) return 'skipped-already';
  return null;
}

const PRUNE_KEY = 'pruned_date';

/** Раз в сутки чистит старые логи и счётчики частоты. Сбой — не повод ронять тик. */
async function maybePrune(): Promise<void> {
  const today = mskDateOffset(0);
  try {
    if ((await getState<string>(PRUNE_KEY)) === today) return;
    await pruneOldRows();
    await setState(PRUNE_KEY, today);
  } catch (error) {
    await log('skip', 'Чистка старых строк не удалась, попробую на следующем тике', {
      details: { reason: error instanceof Error ? error.message : String(error) },
    });
  }
}

/** Замок тика и сколько он живёт, если его не сняли: чуть дольше лимита функции. */
const TICK_LOCK_KEY = 'tick_lock';
const TICK_LOCK_TTL_MS = 75_000;

/** Один часовой тик: проверить сайт, при необходимости разослать. */
export async function tick(force = false): Promise<TickResult> {
  if (!(await acquireLock(TICK_LOCK_KEY, TICK_LOCK_TTL_MS))) {
    await log('skip', 'Предыдущий тик ещё идёт — этот пропускаю');
    return { check: null, autoSend: null, locked: true };
  }

  try {
    return await runTick(force);
  } finally {
    // Не сняли — не страшно: замок протухнет сам через TICK_LOCK_TTL_MS
    await releaseLock(TICK_LOCK_KEY).catch((error) =>
      console.warn('Замок тика не снят:', error instanceof Error ? error.message : String(error)),
    );
  }
}

async function runTick(force: boolean): Promise<TickResult> {
  const started = Date.now();
  const now = new Date(started);
  const out: TickResult = { check: null, autoSend: null };

  // Про рассылку решаем до обхода сайта: от этого зависит, сколько времени
  // можно отдать сайту, а сколько оставить на отправку
  const skip = force ? null : await sendSkipReason(now);
  const sweepUntil = started + (skip ? SWEEP_BUDGET_MS : SWEEP_BUDGET_SEND_MS);
  const tickUntil = started + TICK_BUDGET_MS;

  try {
    out.check = await checkSite(sweepUntil);
    // Проверка сайта прошла — если до этого была серия сбоев, она кончилась
    await noteFileOk('Проверка сайта');
  } catch (error) {
    // Та же терпимость к разовым сбоям, что и для отдельной группы: шлюз
    // Supabase или сайт МУИВ иногда отвечают с запинкой, и следующий тик
    // через час обычно проходит — будить владельца на первом же промахе
    // не нужно (см. shouldAlertOnStreak).
    await noteFileFailure('Проверка сайта', error);
    out.check = {
      filesOnSite: 0,
      changed: [],
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  // Отдельно от проверки: сбой перерисовки не должен выдавать себя за сбой
  // сайта и стирать отчёт о том, что скачалось
  try {
    await refreshPinned(out.check.changed, Math.min(tickUntil, sweepUntil + REFRESH_AFTER_SWEEP_MS));
  } catch (error) {
    await logError('Перерисовка закреплённых сообщений', error);
  }

  await maybePrune();

  if (skip) {
    out.autoSend = skip;
    if (skip === 'skipped-saturday') await log('skip', 'Суббота — автоотправку не делаем');
    return out;
  }

  const file = await latestFile();
  if (!file) {
    out.autoSend = 'skipped-parse-error';
    await logError('Автоотправка', new Error('Нет ни одного успешно разобранного файла'));
    return out;
  }

  const allowUnready =
    force || mskParts(now).hour >= Math.min(23, env.sendHourMsk + SEND_WAIT_HOURS);
  const outcome = await sendTomorrow(tickUntil, allowUnready);
  out.autoSend = 'sent';
  out.sent = outcome.sent;
  out.failed = outcome.failed;
  out.disabled = outcome.disabled;
  out.waiting = outcome.waiting;
  out.pending = outcome.pending;

  // День помечаем отправленным, только когда очередь разошлась полностью,
  // иначе остаток чатов никогда не получит расписание
  if (outcome.pending === 0) await setState(LAST_SEND_KEY, mskDateOffset(0, now));

  return out;
}

export { LAST_CHECK_KEY, LAST_SEND_KEY };
