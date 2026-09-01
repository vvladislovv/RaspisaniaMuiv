/**
 * Обработка апдейтов Telegram.
 *
 * У бота одна команда — /start. Всё остальное делается кнопками, и каждое
 * нажатие правит то же сообщение, а не присылает новое: чат не засоряется.
 */
import {
  allowRequest,
  getChat,
  getWeek,
  latestFile,
  listGroups,
  chatStats,
  errorCount,
  migrateChat,
  setChatEnabled,
  toggleChatGroup,
  currentGroups,
  weekDates,
  fileForDate,
  requestAccess,
  decideAccess,
  isApproved,
  getAccess,
  pendingRequests,
  accessCounts,
  MAX_GROUPS,
  upsertChat,
  getState,
  weekStarts,
  type Chat,
} from './db';
import { log, logError } from './log';
import {
  answerCallbackQuery,
  botUsername,
  leaveChat,
  editMessageText,
  isChatAdmin,
  sendMessage,
  type InlineKeyboard,
} from './telegram';
import { esc, formatDayFor, formatWeek, humanDate, type GroupDay } from './format';
import { groupKeyboard, menuKeyboard, scheduleKeyboard, sheetKeyboard, statusKeyboard } from './keyboard';
import { dayNameOf, mskDateOffset, mskStamp, mskToday } from './time';
import type { Day } from './parse';
import { env } from './env';
import { LAST_CHECK_KEY } from './sync';

// ─── Типы апдейтов (только используемые поля) ────────────────────────────────

interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
}

interface TgChat {
  id: number;
  type: string;
  title?: string;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  /** Группа превратилась в супергруппу: чат переехал на новый идентификатор. */
  migrate_to_chat_id?: number;
}

interface TgCallbackQuery {
  id: string;
  from: TgUser;
  data?: string;
  message?: TgMessage;
}

interface TgChatMemberUpdate {
  chat: TgChat;
  from: TgUser;
  new_chat_member: { status: string };
}

export interface TgUpdate {
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
  /** Бота добавили в чат или удалили из него. */
  my_chat_member?: TgChatMemberUpdate;
}

/** Один экран: текст сообщения и кнопки под ним. */
interface Screen {
  text: string;
  keyboard: InlineKeyboard;
}

// ─── Экраны ──────────────────────────────────────────────────────────────────

interface Context {
  isPrivate: boolean;
  isOwner: boolean;
  username: string | null;
}

function menuScreen(chat: Chat | null, ctx: Context): Screen {
  const lines = ['*Расписание колледжа МУИВ*', ''];

  const groups = chat?.groups ?? [];

  if (groups.length > 0) {
    lines.push(
      `👥 ${groups.length > 1 ? 'Группы' : 'Группа'}: ` +
        groups.map((g) => `*${esc(g)}*`).join(', '),
    );
    lines.push('');
    lines.push(esc('Проверяю сайт каждый час и обновляю закреплённое расписание.'));
    lines.push(
      chat?.enabled
        ? esc('Каждый день в 16:00 присылаю расписание на завтра и закрепляю его, кроме субботы.')
        : `_${esc('Автоотправка выключена. Включить — в разделе «Статус».')}_`,
    );
  } else {
    lines.push(esc('Группа ещё не выбрана. Нажми «Выбрать группу» — дальше всё кнопками.'));
    lines.push(esc(`Можно выбрать до ${MAX_GROUPS} групп — расписание придёт по обеим.`));
  }

  if (ctx.isPrivate) {
    lines.push('');
    lines.push(`*${esc('Как добавить в группу')}*`);
    lines.push(esc('1. Нажми «Добавить в группу» и выбери чат.'));
    lines.push(esc('2. Сделай меня администратором.'));
    lines.push(esc('3. Из прав нужно одно — «Закрепление сообщений».'));
    lines.push(esc('Меню появится в группе само, писать команды не нужно.'));
  }

  return {
    text: lines.join('\n'),
    keyboard: menuKeyboard({
      groups,
      isPrivate: ctx.isPrivate,
      isOwner: ctx.isOwner,
      username: ctx.username,
    }),
  };
}

/**
 * Экран для человека без доступа.
 *
 * Бот открыт на вход, но пользоваться им можно только после одобрения:
 * иначе кто угодно добавил бы бота куда угодно и трогал чужие настройки.
 */
function accessScreen(status: 'pending' | 'denied'): Screen {
  const lines = ['*Расписание колледжа МУИВ*', ''];

  if (status === 'pending') {
    lines.push(esc('Заявка на доступ отправлена. Дождись одобрения — я напишу сюда сам.'));
  } else {
    lines.push(esc('Доступ не открыт.'));
  }

  return { text: lines.join('\n'), keyboard: [] };
}

/**
 * Как назвать человека в заявке.
 *
 * Имя в Telegram часто совпадает с юзернеймом («Deviil_clown03» и
 * «@Devil_clown03»), и печатать оба — значит показывать одно и то же дважды.
 * Поэтому сравниваем без учёта регистра и подчёркиваний.
 */
/** Расстояние редактирования: сколько правок отделяет одну строку от другой. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0 || b.length === 0) return Math.max(a.length, b.length);

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }

  return previous[b.length];
}

/**
 * Имя и юзернейм — про одного и того же человека?
 *
 * Люди ставят имя почти как юзернейм и делают опечатки: «Deviil_clown03» при
 * «@Devil_clown03». Точное сравнение такое не поймает, поэтому допускаем
 * пару правок — но только на достаточно длинных строках, чтобы не склеить
 * действительно разные короткие имена.
 */
function looksLikeSameHandle(name: string, handle: string): boolean {
  const plain = (value: string) => value.toLowerCase().replace(/[_\s.\-]/g, '');
  const a = plain(name);
  const b = plain(handle);

  if (a === b) return true;
  if (Math.min(a.length, b.length) < 6) return false;
  if (Math.abs(a.length - b.length) > 2) return false;

  return editDistance(a, b) <= 2;
}

export function describeUser(user: {
  username?: string | null;
  first_name?: string | null;
  id?: number;
}): string {
  const name = user.first_name?.trim() || null;
  const handle = user.username?.trim() || null;

  if (handle && (!name || looksLikeSameHandle(name, handle))) return `@${handle}`;
  if (name && handle) return `${name} (@${handle})`;
  if (name) return name;
  return user.id ? `ID ${user.id}` : 'без имени';
}

/** Уведомление владельцу о новой заявке. */
function requestScreen(user: TgUser): Screen {
  return {
    text: [
      '*Новая заявка*',
      '',
      esc(describeUser(user)),
      `\`${user.id}\``,
      '',
      esc('Разрешить — сможет добавлять бота в группы и выбирать группу.'),
    ].join('\n'),
    keyboard: [
      [
        { text: '✅ Разрешить', callback_data: `ok:${user.id}` },
        { text: '⛔️ Отказать', callback_data: `no:${user.id}` },
      ],
    ],
  };
}

/** Сводка для владельца бота: сколько чатов, какие группы, есть ли ошибки. */
async function adminScreen(): Promise<Screen> {
  const [stats, errors, check, file, access, pending] = await Promise.all([
    chatStats(),
    errorCount(24),
    getState<{ at: string; filesOnSite: number; errors: string[] }>(LAST_CHECK_KEY),
    fileForDate(mskToday()),
    accessCounts(),
    pendingRequests(8),
  ]);

  const lines = ['*Сводка*', ''];
  lines.push(`Чатов: *${stats.total}*, включено ${stats.enabled}, с группой ${stats.withGroup}`);
  lines.push(`Ошибок за сутки: ${errors === 0 ? '*0*' : `*${errors}*`}`);
  lines.push(
    `Доступ: одобрено ${access.approved}, ждут *${access.pending}*, отказано ${access.denied}`,
  );

  if (check) {
    lines.push(`Проверка сайта: ${esc(mskStamp(new Date(check.at)))}`);
    if (check.errors.length > 0) lines.push(`⚠️ ${esc(check.errors.join('; ').slice(0, 200))}`);
  }
  if (file) lines.push(`Текущая неделя: ${esc(file.title)}`);

  if (pending.length > 0) {
    lines.push('');
    lines.push(`*${esc('Ждут решения')}*`);
    for (const row of pending) {
      lines.push(`${esc(describeUser({ ...row, id: row.user_id }))} · \`${row.user_id}\``);
    }
  }

  if (stats.topGroups.length > 0) {
    lines.push('');
    lines.push(`*${esc('Группы')}*`);
    for (const row of stats.topGroups) {
      lines.push(`${esc(row.group)} — ${row.chats}`);
    }
  }

  const rows: InlineKeyboard = [];

  // Заявки решаются прямо из сводки: отдельного экрана для этого не нужно
  for (const row of pending) {
    rows.push([
      {
        text: `✅ ${describeUser({ ...row, id: row.user_id })}`,
        callback_data: `ok:${row.user_id}`,
      },
      { text: '⛔️', callback_data: `no:${row.user_id}` },
    ]);
  }

  rows.push([{ text: '🔄 Обновить', callback_data: 'adm' }]);
  rows.push([{ text: '↩︎ Меню', callback_data: 'm' }]);

  return { text: lines.join('\n'), keyboard: rows };
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
 * Экран одного дня сразу по всем выбранным группам: в один день пары обеих
 * групп читаются рядом, и переключать ничего не нужно.
 */
export async function dayScreen(
  chatId: number,
  stored: string[],
  dateIso: string,
  heading?: string,
): Promise<Screen> {
  const weeks = await weekStarts();
  const { groups, missing } = await currentGroups(chatId, stored);
  const perGroup = await Promise.all(groups.map((group) => getWeek(group, dateIso)));

  const blocks: GroupDay[] = groups.map((group, index) => ({
    group,
    day: perGroup[index].days.find((d) => d.date === dateIso) ?? null,
  }));

  const file = perGroup.find((w) => w.file)?.file ?? null;

  // Для клавиатуры дни объединяем: точка «пар нет» гаснет, если пары есть
  // хотя бы у одной группы
  const merged = await keyboardDays(perGroup);
  const hasDay = blocks.some((b) => b.day);

  return {
    text: formatDayFor(dateIso, dayNameOf(dateIso), blocks, {
      siteUpdated: file?.site_updated ?? null,
      heading,
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

/**
 * Экран недели. Неделя может не влезть в одно сообщение, поэтому текст
 * возвращается частями: первая идёт в правку, остальные — отдельными сообщениями.
 */
export async function weekScreen(
  chatId: number,
  stored: string[],
  fromIso: string,
  groupIndex = 0,
): Promise<{ chunks: string[]; keyboard: InlineKeyboard }> {
  const { groups } = await currentGroups(chatId, stored);
  const active = Math.min(Math.max(groupIndex, 0), Math.max(groups.length - 1, 0));
  const group = groups[active] ?? '';

  const [{ days, file }, weeks] = await Promise.all([getWeek(group, fromIso), weekStarts()]);

  const chunks = formatWeek(days, {
    group,
    siteUpdated: file?.site_updated ?? null,
    heading: file?.week_start ? `Неделя с ${humanDate(file.week_start)}` : 'Расписание на неделю',
  });

  const anchor = days[0]?.date ?? fromIso;

  return {
    chunks,
    keyboard: scheduleKeyboard(days, null, file?.week_start ?? null, weeks, {
      groups,
      activeIndex: active,
      dateIso: anchor,
    }),
  };
}

async function statusScreen(chat: Chat | null): Promise<Screen> {
  const today = mskToday();
  const [file, newest, check] = await Promise.all([
    // Файл, по которому отвечаем сегодня, а не самый поздний на сайте:
    // на странице лежат две недели сразу, и путать их нельзя
    fileForDate(today),
    latestFile(),
    getState<{ at: string; filesOnSite: number; changed: string[]; errors: string[] }>(
      LAST_CHECK_KEY,
    ),
  ]);

  const lines = ['*Статус*', ''];
  const groups = chat?.groups ?? [];
  lines.push(
    `👥 ${groups.length > 1 ? 'Группы' : 'Группа'}: ` +
      (groups.length > 0 ? groups.map((g) => `*${esc(g)}*`).join(', ') : '_не выбрана_'),
  );
  lines.push(`🔔 Автоотправка: ${chat?.enabled ? 'включена' : 'выключена'}`);
  lines.push('');

  if (check) {
    lines.push(`Последняя проверка сайта: ${esc(mskStamp(new Date(check.at)))}`);
    lines.push(`Файлов на странице: ${check.filesOnSite}`);
    if (check.errors.length > 0) {
      lines.push(`⚠️ ${esc(check.errors.join('; ').slice(0, 300))}`);
    }
  } else {
    lines.push('_Проверок ещё не было_');
  }

  if (file) {
    lines.push('');
    lines.push(`Текущая неделя: ${esc(file.title)}`);
    if (file.site_updated) lines.push(`Обновлён на сайте: ${esc(file.site_updated)}`);

    // Следующая неделя обычно появляется заранее — про неё стоит сказать
    // отдельно, чтобы не выглядело, будто она уже действует
    if (newest && newest.id !== file.id && newest.week_start) {
      lines.push(`Уже выложена неделя с ${esc(humanDate(newest.week_start))}`);
    }
  } else {
    lines.push('');
    lines.push('_Расписание ещё не загружено_');
  }

  return { text: lines.join('\n'), keyboard: statusKeyboard(chat?.enabled ?? false) };
}

/**
 * Экран «О боте».
 *
 * Текст пропущен через esc(): писать обратные слэши руками нельзя — в строке
 * TypeScript `\.` превращается в обычную точку, экранирование теряется,
 * и Telegram отказывается разбирать разметку.
 */
function aboutScreen(): Screen {
  const source = 'https://www.muiv.ru/studentu/spo/raspisanie/';
  const author = 'https://hacktaika.ru';

  const lines = [
    '*О боте*',
    '',
    esc('Присылаю расписание колледжа МУИВ в этот чат.'),
    '',
    `${esc('Беру его с сайта')} [${esc('muiv.ru')}](${source}) ${esc(
      '— проверяю каждый час и показываю то, что там сейчас. Если расписание меняют, закреплённое сообщение обновляется само.',
    )}`,
    '',
    esc('Каждый день в 16:00 присылаю расписание на завтра и закрепляю его, кроме субботы.'),
    '',
    `⚡ ${esc('Сделано в')} [${esc('hacktaika.ru')}](${author})`,
  ];

  return {
    text: lines.join('\n'),
    keyboard: [[{ text: '↩︎ Меню', callback_data: 'm' }]],
  };
}

/** Соответствие «индекс → группа»: в callback_data влезает только номер. */
async function groupIndex(): Promise<{
  sheets: string[];
  groups: { group: string; sheet: string; index: number }[];
}> {
  const raw = await listGroups();
  const groups = raw.map((g, index) => ({ group: g.group, sheet: g.sheet ?? 'Прочие', index }));
  const sheets = [...new Set(groups.map((g) => g.sheet))].sort((a, b) => a.localeCompare(b, 'ru'));
  return { sheets, groups };
}

/** Что показывать в меню: личка это или группа, и кто нажал. */
async function contextOf(chat: TgChat, userId?: number): Promise<Context> {
  let username: string | null = null;
  try {
    username = await botUsername();
  } catch {
    // без имени просто не покажем кнопку «Добавить в группу»
  }
  return {
    isPrivate: chat.type === 'private',
    isOwner: userId === env.adminTelegramId,
    username,
  };
}

// ─── Команда /start ──────────────────────────────────────────────────────────

function isStart(text: string): boolean {
  return /^\/start(?:@[\w_]+)?\b/i.test(text.trim());
}

async function handleMessage(message: TgMessage): Promise<void> {
  const chatId = message.chat.id;
  const user = message.from;

  // Служебное сообщение о переезде приходит в старый чат — переносим настройки,
  // иначе бот замолчит в группе и перестанет слать расписание
  if (message.migrate_to_chat_id) {
    const moved = await migrateChat(chatId, message.migrate_to_chat_id);
    if (moved) {
      await log('command', `Чат переехал: ${chatId} → ${message.migrate_to_chat_id}`, {
        chatId: message.migrate_to_chat_id,
      });
    }
    return;
  }

  if (!isStart(message.text ?? '')) return;

  if (!(await allowRequest(chatId))) {
    await log('skip', `Rate limit в чате ${chatId}`, { chatId });
    return;
  }

  const isPrivate = message.chat.type === 'private';

  // В личке /start — это заявка на доступ либо вход для уже одобренного
  if (isPrivate && user) {
    if (!(await isApproved(user.id))) {
      const { status, isNew } = await requestAccess(
        user.id,
        user.username ?? null,
        user.first_name ?? null,
      );

      const screen = accessScreen(status === 'denied' ? 'denied' : 'pending');
      await sendMessage(chatId, screen.text, { silent: true });

      await log('command', `Заявка на доступ: ${status}${isNew ? ' (новая)' : ''}`, {
        chatId,
        details: { userId: user.id, username: user.username },
      });

      // Владельцу сообщаем только о новой заявке, чтобы не дёргать повторами
      if (isNew) {
        const notice = requestScreen(user);
        try {
          await sendMessage(env.adminTelegramId, notice.text, {
            silent: true,
            keyboard: notice.keyboard,
          });
        } catch (error) {
          await logError('Уведомление владельца о заявке', error);
        }
      }
      return;
    }

    await upsertChat(chatId, null, user.id);
    if (!(await getChat(chatId))?.enabled) await setChatEnabled(chatId, true);

    const screen = menuScreen(await getChat(chatId), await contextOf(message.chat, user.id));
    await sendMessage(chatId, screen.text, { silent: true, keyboard: screen.keyboard });
    return;
  }

  // В группе /start подключает чат, если это делает одобренный человек.
  // Без этого бот, уже сидящий в группе, подключить было нечем: события
  // «бота добавили» больше не будет, а молчать — худший из вариантов.
  const chat = await getChat(chatId);

  if (!chat) {
    if (!user || !(await isApproved(user.id))) {
      await log('skip', `/start без доступа в чате ${chatId}`, {
        chatId,
        details: { userId: user?.id },
      });
      await sendMessage(
        chatId,
        esc('Доступ не открыт. Напиши мне в личку и дождись одобрения.'),
        { silent: true },
      );
      return;
    }

    await upsertChat(chatId, message.chat.title ?? null, user.id);
    await setChatEnabled(chatId, true);
    await log('command', `Чат подключён через /start: ${chatId}`, {
      chatId,
      details: { userId: user.id, title: message.chat.title },
    });
  } else {
    await log('command', '/start', { chatId, details: { userId: user?.id } });
  }

  const fresh = await getChat(chatId);
  const screen = menuScreen(fresh, await contextOf(message.chat, user?.id));
  await sendMessage(chatId, screen.text, { silent: true, keyboard: screen.keyboard });
}

// ─── Кнопки ──────────────────────────────────────────────────────────────────

/**
 * Разбор нажатия. Гашение «часиков» передаётся отдельной функцией: его нельзя
 * ждать перед работой — это лишний круг до Telegram, а замеры показали, что
 * два последовательных вызова Bot API дают больше секунды задержки.
 */
async function runCallback(
  query: TgCallbackQuery,
  ack: (text?: string) => void,
): Promise<void> {
  const data = query.data ?? '';
  const message = query.message;
  if (!message) {
    ack();
    return;
  }

  const chatId = message.chat.id;
  const [chat, ctx] = await Promise.all([getChat(chatId), contextOf(message.chat, query.from.id)]);

  // Кнопки работают только в подключённом чате. Исключение — решения по
  // заявкам: они приходят владельцу в личку, где чата в базе может не быть.
  const isDecision = data.startsWith('ok:') || data.startsWith('no:');
  if (!chat && !isDecision) {
    await answerCallbackQuery(query.id, 'Чат не подключён');
    return;
  }

  // В группе кнопки жмут все участники сразу, поэтому лимит выше, чем на команды
  if (!(await allowRequest(chatId, 60))) {
    ack('Слишком часто, подожди минуту');
    return;
  }

  const edit = (screen: Screen) =>
    editMessageText(chatId, message.message_id, screen.text, screen.keyboard);

  /** Возвращает группы чата либо возвращает в меню с подсказкой. */
  const requireGroups = async (): Promise<string[] | null> => {
    const groups = chat?.groups ?? [];
    if (groups.length > 0) return groups;
    ack('Сначала выбери группу');
    await edit(menuScreen(chat, ctx));
    return null;
  };

  // ─── Меню и статус ─────────────────────────────────────────────────────────

  if (data === 'm') {
    ack();
    await edit(menuScreen(chat, ctx));
    return;
  }

  // Решение по заявке — только владелец бота
  if (data.startsWith('ok:') || data.startsWith('no:')) {
    if (query.from.id !== env.adminTelegramId) {
      ack('Недоступно');
      return;
    }

    const targetId = Number(data.slice(3));
    const approve = data.startsWith('ok:');
    await decideAccess(targetId, approve ? 'approved' : 'denied');
    ack(approve ? 'Доступ открыт' : 'Отказано');
    await log('command', `Заявка ${approve ? 'одобрена' : 'отклонена'}: ${targetId}`);

    // Человек должен узнать решение сам, не спрашивая
    if (approve) {
      try {
        const username = await botUsername().catch(() => null);
        await sendMessage(
          targetId,
          [
            `*${esc('Доступ открыт')}*`,
            '',
            esc('Теперь можно добавить меня в группу — кнопка ниже, дальше всё подскажу.'),
          ].join('\n'),
          {
            silent: false,
            keyboard: username
              ? [[{ text: '➕ Добавить в группу', url: `https://t.me/${username}?startgroup=true` }]]
              : undefined,
          },
        );
      } catch (error) {
        await logError(`Уведомление об одобрении ${targetId}`, error);
      }
    }

    await edit(await adminScreen());
    return;
  }

  // Сводка — только владельцу бота
  if (data === 'adm') {
    if (query.from.id !== env.adminTelegramId) {
      ack('Недоступно');
      return;
    }
    ack();
    await edit(await adminScreen());
    return;
  }

  if (data === 'st') {
    ack();
    await edit(await statusScreen(chat));
    return;
  }

  if (data === 'about') {
    ack();
    await edit(aboutScreen());
    return;
  }

  if (data === 'off' || data === 'on') {
    if (!(await isChatAdmin(chatId, query.from.id))) {
      ack('Только админ чата может это менять');
      return;
    }
    const enable = data === 'on';
    await setChatEnabled(chatId, enable);
    await answerCallbackQuery(
      query.id,
      enable ? 'Автоотправка включена' : 'Автоотправка выключена',
    );
    await log('command', `Автоотправка ${enable ? 'включена' : 'выключена'}`, { chatId });
    await edit(await statusScreen(await getChat(chatId)));
    return;
  }

  // ─── Расписание ────────────────────────────────────────────────────────────

  // `day:0` — сегодня, `day:1` — завтра
  if (data.startsWith('day:')) {
    const groups = await requireGroups();
    if (!groups) return;

    const offset = Number(data.slice(4));
    ack();
    await edit(
      await dayScreen(
        chatId,
        groups,
        mskDateOffset(offset),
        offset === 1 ? 'Расписание на завтра' : 'Расписание на сегодня',
      ),
    );
    return;
  }

  // `d:<дата>` — конкретный день. `d:0`…`d:5` и `d:all` остались в старых сообщениях
  if (data.startsWith('d:')) {
    const groups = await requireGroups();
    if (!groups) return;

    const key = data.slice(2);
    ack();

    if (key === 'all') {
      const { chunks, keyboard } = await weekScreen(chatId, groups, mskToday());
      await editMessageText(chatId, message.message_id, chunks[0], keyboard);
      return;
    }

    let dateIso = key;
    if (/^\d+$/.test(key)) {
      const { days } = await getWeek(groups[0], mskToday());
      dateIso = days[Number(key)]?.date ?? mskToday();
    }

    await edit(await dayScreen(chatId, groups, dateIso));
    return;
  }

  // `week` — текущая неделя, `w:<дата>` — неделя, содержащая эту дату
  if (data === 'week' || data.startsWith('w:')) {
    const groups = await requireGroups();
    if (!groups) return;

    ack();

    const from = data === 'week' ? mskToday() : data.slice(2);
    const { chunks, keyboard } = await weekScreen(chatId, groups, from);
    await editMessageText(chatId, message.message_id, chunks[0], keyboard);

    // Если неделя не влезла в одно сообщение — остальные части отправляем ниже
    for (const text of chunks.slice(1)) {
      await sendMessage(chatId, text, { silent: true });
    }
    return;
  }

  // ─── Выбор группы ──────────────────────────────────────────────────────────

  const { sheets, groups } = await groupIndex();

  if (data === 'grp' || data === 'back') {
    ack();

    if (sheets.length === 0) {
      await edit({
        text: esc('Расписание ещё не загружено. Попробуй через час.'),
        keyboard: menuKeyboard({
          groups: chat?.groups ?? [],
          isPrivate: ctx.isPrivate,
          isOwner: ctx.isOwner,
          username: ctx.username,
        }),
      });
      return;
    }

    await edit({ text: '*Выбери курс:*', keyboard: sheetKeyboard(sheets) });
    return;
  }

  if (data.startsWith('s:') || data.startsWith('p:')) {
    const [, sheetRaw, pageRaw] = data.split(':');
    const sheetIndex = Number(sheetRaw);
    const sheet = sheets[sheetIndex];

    if (!sheet) {
      ack('Список устарел');
      await edit({ text: '*Выбери курс:*', keyboard: sheetKeyboard(sheets) });
      return;
    }

    ack();
    const chosen = chat?.groups ?? [];
    await edit({
      text:
        `*${esc(sheet)}*\n` +
        esc(
          chosen.length > 0
            ? `Выбрано: ${chosen.join(', ')}. Нажми группу, чтобы добавить или убрать.`
            : `Выбери группу. Можно до ${MAX_GROUPS} — расписание придёт по обеим.`,
        ),
      keyboard: groupKeyboard(
        groups.filter((g) => g.sheet === sheet),
        sheetIndex,
        Number(pageRaw ?? 0) || 0,
        chosen,
      ),
    });
    return;
  }

  if (data.startsWith('g:')) {
    if (!(await isChatAdmin(chatId, query.from.id))) {
      ack('Только админ чата может менять группы');
      return;
    }

    const picked = groups[Number(data.slice(2))];
    if (!picked) {
      ack('Список устарел');
      await edit({ text: '*Выбери курс:*', keyboard: sheetKeyboard(sheets) });
      return;
    }

    await upsertChat(chatId, message.chat.title ?? null);
    const outcome = await toggleChatGroup(chatId, picked.group);

    if (outcome === 'limit') {
      ack(`Больше ${MAX_GROUPS} групп нельзя — сначала убери одну`);
      return;
    }

    ack(outcome === 'added' ? `Добавлено: ${picked.group}` : `Убрано: ${picked.group}`);
    await log('command', `Группы чата: ${outcome} ${picked.group}`, { chatId });

    // Остаёмся в списке: вторую группу выбирают тут же, не возвращаясь в меню
    const fresh = await getChat(chatId);
    const sheetIndex = sheets.indexOf(picked.sheet);
    await edit({
      text:
        `*${esc(picked.sheet)}*\n` +
        esc(
          (fresh?.groups ?? []).length > 0
            ? `Выбрано: ${(fresh?.groups ?? []).join(', ')}. Нажми «Готово», когда закончишь.`
            : `Выбери группу. Можно до ${MAX_GROUPS} — расписание придёт по обеим.`,
        ),
      keyboard: groupKeyboard(
        groups.filter((g) => g.sheet === picked.sheet),
        sheetIndex,
        0,
        fresh?.groups ?? [],
      ),
    });
    return;
  }

  // Переключение группы в режиме недели: `wg:<индекс>:<дата>`
  if (data.startsWith('wg:')) {
    const chosen = await requireGroups();
    if (!chosen) return;

    const [, indexRaw, dateIso] = data.split(':');
    ack();

    const { chunks, keyboard } = await weekScreen(
      chatId,
      chosen,
      dateIso || mskToday(),
      Number(indexRaw) || 0,
    );
    await editMessageText(chatId, message.message_id, chunks[0], keyboard);
    return;
  }

  ack();
}

// ─── Бота добавили или удалили ───────────────────────────────────────────────

const PRESENT = new Set(['member', 'administrator', 'creator', 'restricted']);

/**
 * Реакция на добавление бота в чат: сразу показываем меню.
 *
 * Без этого в группе не с чего начать — бот с включённым режимом приватности
 * ничего не показывает, и нужно знать, что надо вручную написать /start.
 */
async function handleMembership(event: TgChatMemberUpdate): Promise<void> {
  const chatId = event.chat.id;
  const status = event.new_chat_member.status;

  // Бота убрали из чата — выключаем автоотправку, чтобы не биться об ошибки
  if (!PRESENT.has(status)) {
    const known = await getChat(chatId);
    if (known) {
      await setChatEnabled(chatId, false);
      await log('skip', `Бота убрали из чата ${chatId}, автоотправка выключена`, { chatId });
    }
    return;
  }

  const chat = await getChat(chatId);

  // Подключить чат может только одобренный человек. Иначе бот не остаётся
  // в группе: молча висеть без дела — хуже, чем честно уйти.
  if (!chat && !(await isApproved(event.from.id))) {
    await log('skip', `Бота добавили без доступа в чат ${chatId}`, {
      chatId,
      details: { addedBy: event.from.id, title: event.chat.title },
    });

    try {
      await sendMessage(
        chatId,
        esc('Доступ не открыт. Напиши мне в личку и дождись одобрения.'),
        { silent: true },
      );
      await leaveChat(chatId);
    } catch (error) {
      await logError(`Выход из чата ${chatId} без доступа`, error);
    }
    return;
  }

  await upsertChat(chatId, event.chat.title ?? null, event.from.id);

  // Бота добавляют, чтобы он работал. Если чат был выключен — в том числе
  // потому, что бота до этого удалили, — включаем обратно, иначе расписание
  // молча перестало бы приходить.
  if (!chat?.enabled) await setChatEnabled(chatId, true);

  await log('command', `Бота добавили в чат ${chatId}`, {
    chatId,
    details: { title: event.chat.title, wasEnabled: chat?.enabled ?? null },
  });

  const screen = menuScreen(await getChat(chatId), await contextOf(event.chat, event.from.id));

  // В группе напоминаем про право закреплять — без него ежедневное
  // расписание отправится, но не закрепится
  const hint =
    event.chat.type === 'private'
      ? ''
      : `\n\n_${esc('Чтобы я мог закреплять расписание, дай мне право «Закрепление сообщений».')}_`;

  await sendMessage(chatId, screen.text + hint, { silent: true, keyboard: screen.keyboard });
}

/** Гасит «часики» параллельно с работой и дожидается обоих. */
async function handleCallback(query: TgCallbackQuery): Promise<void> {
  let acking: Promise<void> | null = null;
  const ack = (text?: string) => {
    acking ??= answerCallbackQuery(query.id, text);
  };

  try {
    await runCallback(query, ack);
  } finally {
    ack();
    await acking;
  }
}

/** Точка входа для вебхука. Никогда не бросает — Telegram не должен ретраить. */
export async function handleUpdate(update: TgUpdate): Promise<void> {
  const started = Date.now();
  try {
    if (update.message) await handleMessage(update.message);
    else if (update.callback_query) {
      await handleCallback(update.callback_query);
      // Длительность пишем в журнал: по ней видно, тормозит бот или сеть
      await log('command', `Нажатие ${update.callback_query.data ?? '—'}`, {
        chatId: update.callback_query.message?.chat.id ?? null,
        durationMs: Date.now() - started,
      });
    } else if (update.my_chat_member) await handleMembership(update.my_chat_member);
  } catch (error) {
    await logError('Обработка апдейта Telegram', error, {
      update: JSON.stringify(update).slice(0, 1000),
    });
  }
}
