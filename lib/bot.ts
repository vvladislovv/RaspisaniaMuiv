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
  setChatGroup,
  upsertChat,
  getState,
  weekStarts,
  type Chat,
} from './db';
import { log, logError } from './log';
import {
  answerCallbackQuery,
  botUsername,
  editMessageText,
  isChatAdmin,
  sendMessage,
  type InlineKeyboard,
} from './telegram';
import { esc, formatDay, formatEmptyDay, formatWeek, humanDate } from './format';
import { groupKeyboard, menuKeyboard, scheduleKeyboard, sheetKeyboard, statusKeyboard } from './keyboard';
import { dayNameOf, mskDateOffset, mskStamp, mskToday } from './time';
import { env } from './env';
import { LAST_CHECK_KEY } from './sync';

// ─── Типы апдейтов (только используемые поля) ────────────────────────────────

interface TgUser {
  id: number;
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

  if (chat?.group_name) {
    lines.push(`👥 Группа: *${esc(chat.group_name)}*`);
    lines.push('');
    lines.push(esc('Проверяю сайт каждый час и обновляю закреплённое расписание.'));
    lines.push(
      chat.enabled
        ? esc('Каждый день в 16:00 присылаю расписание на завтра и закрепляю его, кроме субботы.')
        : `_${esc('Автоотправка выключена. Включить — в разделе «Статус».')}_`,
    );
  } else {
    lines.push(esc('Группа ещё не выбрана. Нажми «Выбрать группу» — дальше всё кнопками.'));
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
      group: chat?.group_name ?? null,
      isPrivate: ctx.isPrivate,
      isOwner: ctx.isOwner,
      username: ctx.username,
    }),
  };
}

/** Сводка для владельца бота: сколько чатов, какие группы, есть ли ошибки. */
async function adminScreen(): Promise<Screen> {
  const [stats, errors, check, file] = await Promise.all([
    chatStats(),
    errorCount(24),
    getState<{ at: string; filesOnSite: number; errors: string[] }>(LAST_CHECK_KEY),
    latestFile(),
  ]);

  const lines = ['*Сводка*', ''];
  lines.push(`Чатов: *${stats.total}*, включено ${stats.enabled}, с группой ${stats.withGroup}`);
  lines.push(`Ошибок за сутки: ${errors === 0 ? '*0*' : `*${errors}*`}`);

  if (check) {
    lines.push(`Проверка сайта: ${esc(mskStamp(new Date(check.at)))}`);
    if (check.errors.length > 0) lines.push(`⚠️ ${esc(check.errors.join('; ').slice(0, 200))}`);
  }
  if (file) lines.push(`Файл: ${esc(file.title)}`);

  if (stats.topGroups.length > 0) {
    lines.push('');
    lines.push(`*${esc('Группы')}*`);
    for (const row of stats.topGroups) {
      lines.push(`${esc(row.group)} — ${row.chats}`);
    }
  }

  return {
    text: lines.join('\n'),
    keyboard: [
      [{ text: '🔄 Обновить', callback_data: 'adm' }],
      [{ text: '↩︎ Меню', callback_data: 'm' }],
    ],
  };
}

/** Экран одного дня. */
async function dayScreen(group: string, dateIso: string, heading?: string): Promise<Screen> {
  const [{ days, file }, weeks] = await Promise.all([getWeek(group, dateIso), weekStarts()]);
  const day = days.find((d) => d.date === dateIso) ?? null;

  const opts = { group, siteUpdated: file?.site_updated ?? null, heading };
  const text = day ? formatDay(day, opts) : formatEmptyDay(dateIso, dayNameOf(dateIso), opts);

  return {
    text,
    keyboard: scheduleKeyboard(days, day ? dateIso : null, file?.week_start ?? null, weeks),
  };
}

/**
 * Экран недели. Неделя может не влезть в одно сообщение, поэтому текст
 * возвращается частями: первая идёт в правку, остальные — отдельными сообщениями.
 */
async function weekScreen(
  group: string,
  fromIso: string,
): Promise<{ chunks: string[]; keyboard: InlineKeyboard }> {
  const [{ days, file }, weeks] = await Promise.all([getWeek(group, fromIso), weekStarts()]);

  const chunks = formatWeek(days, {
    group,
    siteUpdated: file?.site_updated ?? null,
    heading: file?.week_start ? `Неделя с ${humanDate(file.week_start)}` : 'Расписание на неделю',
  });

  return { chunks, keyboard: scheduleKeyboard(days, null, file?.week_start ?? null, weeks) };
}

async function statusScreen(chat: Chat | null): Promise<Screen> {
  const [file, check] = await Promise.all([
    latestFile(),
    getState<{ at: string; filesOnSite: number; changed: string[]; errors: string[] }>(
      LAST_CHECK_KEY,
    ),
  ]);

  const lines = ['*Статус*', ''];
  lines.push(`👥 Группа: ${chat?.group_name ? `*${esc(chat.group_name)}*` : '_не выбрана_'}`);
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
    lines.push(`Файл: ${esc(file.title)}`);
    if (file.site_updated) lines.push(`Обновлён на сайте: ${esc(file.site_updated)}`);
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
  const userId = message.from?.id;

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

  const chat = await getChat(chatId);
  const isNew = !chat;

  await upsertChat(chatId, message.chat.title ?? null);
  // Бот публичный: любой чат подключается сам. Выключенный чат включаем
  // обратно только по /start — то есть по явному действию человека.
  if (!chat?.enabled) await setChatEnabled(chatId, true);

  await log('command', '/start', {
    chatId,
    details: { userId, isNew, type: message.chat.type, title: message.chat.title },
  });

  const screen = menuScreen(await getChat(chatId), await contextOf(message.chat, userId));
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

  // В группе кнопки жмут все участники сразу, поэтому лимит выше, чем на команды
  if (!(await allowRequest(chatId, 60))) {
    ack('Слишком часто, подожди минуту');
    return;
  }

  const edit = (screen: Screen) =>
    editMessageText(chatId, message.message_id, screen.text, screen.keyboard);

  /** Возвращает группу чата либо возвращает в меню с подсказкой. */
  const requireGroup = async (): Promise<string | null> => {
    if (chat?.group_name) return chat.group_name;
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
    const group = await requireGroup();
    if (!group) return;

    const offset = Number(data.slice(4));
    ack();
    await edit(
      await dayScreen(
        group,
        mskDateOffset(offset),
        offset === 1 ? 'Расписание на завтра' : 'Расписание на сегодня',
      ),
    );
    return;
  }

  // `d:<дата>` — конкретный день. `d:0`…`d:5` и `d:all` остались в старых сообщениях
  if (data.startsWith('d:')) {
    const group = await requireGroup();
    if (!group) return;

    const key = data.slice(2);
    ack();

    if (key === 'all') {
      const { chunks, keyboard } = await weekScreen(group, mskToday());
      await editMessageText(chatId, message.message_id, chunks[0], keyboard);
      return;
    }

    let dateIso = key;
    if (/^\d+$/.test(key)) {
      const { days } = await getWeek(group, mskToday());
      dateIso = days[Number(key)]?.date ?? mskToday();
    }

    await edit(await dayScreen(group, dateIso));
    return;
  }

  // `week` — текущая неделя, `w:<дата>` — неделя, содержащая эту дату
  if (data === 'week' || data.startsWith('w:')) {
    const group = await requireGroup();
    if (!group) return;

    ack();

    const from = data === 'week' ? mskToday() : data.slice(2);
    const { chunks, keyboard } = await weekScreen(group, from);
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
          group: chat?.group_name ?? null,
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
    await edit({
      text: `*${esc(sheet)}*\nВыбери группу:`,
      keyboard: groupKeyboard(
        groups.filter((g) => g.sheet === sheet),
        sheetIndex,
        Number(pageRaw ?? 0) || 0,
      ),
    });
    return;
  }

  if (data.startsWith('g:')) {
    if (!(await isChatAdmin(chatId, query.from.id))) {
      ack('Только админ чата может менять группу');
      return;
    }

    const group = groups[Number(data.slice(2))];
    if (!group) {
      ack('Список устарел');
      await edit({ text: '*Выбери курс:*', keyboard: sheetKeyboard(sheets) });
      return;
    }

    await upsertChat(chatId, message.chat.title ?? null);
    await setChatGroup(chatId, group.group);
    ack(`Выбрано: ${group.group}`);
    await log('command', `Группа чата установлена: ${group.group}`, { chatId });

    await edit(menuScreen(await getChat(chatId), ctx));
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

  await upsertChat(chatId, event.chat.title ?? null);

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
  try {
    if (update.message) await handleMessage(update.message);
    else if (update.callback_query) await handleCallback(update.callback_query);
    else if (update.my_chat_member) await handleMembership(update.my_chat_member);
  } catch (error) {
    await logError('Обработка апдейта Telegram', error, {
      update: JSON.stringify(update).slice(0, 1000),
    });
  }
}
