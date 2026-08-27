/** Обработка апдейтов Telegram: команды и кнопки. */
import {
  allowRequest,
  getChat,
  getDay,
  getWeek,
  latestFile,
  listGroups,
  setChatEnabled,
  setChatGroup,
  upsertChat,
  getState,
} from './db';
import { log, logError } from './log';
import { answerCallbackQuery, editMessageText, isChatAdmin, sendMessage, type InlineKeyboard } from './telegram';
import { esc, formatDay, formatEmptyDay, formatWeek, humanDate } from './format';
import { dayNameOf, mskDateOffset, mskStamp } from './time';
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
  username?: string;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
}

interface TgCallbackQuery {
  id: string;
  from: TgUser;
  data?: string;
  message?: TgMessage;
}

export interface TgUpdate {
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

// ─── Тексты ──────────────────────────────────────────────────────────────────

const HELP = [
  '*Бот расписания колледжа МУИВ*',
  '',
  'Каждый час проверяю сайт МУИВ\\. Как только расписание меняется — сообщаю\\.',
  'Каждый день в 16:00 присылаю расписание на завтра и закрепляю его \\(кроме субботы\\)\\.',
  '',
  '*Команды*',
  '/tomorrow — на завтра',
  '/today — на сегодня',
  '/week — вся неделя',
  '/group — выбрать группу',
  '/status — когда была последняя проверка',
  '/help — эта справка',
].join('\n');

const GROUPS_PER_PAGE = 24;

// ─── Вспомогательное ─────────────────────────────────────────────────────────

async function reply(chatId: number, text: string): Promise<void> {
  await sendMessage(chatId, text, { silent: true });
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** callback_data ограничена 64 байтами — группы адресуем индексом. */
function sheetKeyboard(sheets: string[]): InlineKeyboard {
  return chunk(
    sheets.map((sheet, i) => ({ text: sheet, callback_data: `s:${i}` })),
    1,
  );
}

function groupKeyboard(
  groups: { group: string; index: number }[],
  sheetIndex: number,
  page: number,
): InlineKeyboard {
  const pages = chunk(groups, GROUPS_PER_PAGE);
  const current = pages[page] ?? [];

  const rows: InlineKeyboard = chunk(
    current.map((g) => ({ text: g.group, callback_data: `g:${g.index}` })),
    3,
  );

  const nav: InlineKeyboard[number] = [];
  if (page > 0) nav.push({ text: '◀︎', callback_data: `p:${sheetIndex}:${page - 1}` });
  nav.push({ text: '↩︎ курсы', callback_data: 'back' });
  if (page + 1 < pages.length) nav.push({ text: '▶︎', callback_data: `p:${sheetIndex}:${page + 1}` });
  rows.push(nav);

  return rows;
}

const DAY_BUTTONS: InlineKeyboard = [
  [
    { text: 'Пн', callback_data: 'd:0' },
    { text: 'Вт', callback_data: 'd:1' },
    { text: 'Ср', callback_data: 'd:2' },
  ],
  [
    { text: 'Чт', callback_data: 'd:3' },
    { text: 'Пт', callback_data: 'd:4' },
    { text: 'Сб', callback_data: 'd:5' },
  ],
  [{ text: '📖 Вся неделя', callback_data: 'd:all' }],
];

/** Кэш соответствия «индекс → группа», чтобы влезть в лимит callback_data. */
async function groupIndex(): Promise<{ sheets: string[]; groups: { group: string; sheet: string; index: number }[] }> {
  const raw = await listGroups();
  const groups = raw.map((g, index) => ({ group: g.group, sheet: g.sheet ?? 'Прочие', index }));
  const sheets = [...new Set(groups.map((g) => g.sheet))].sort((a, b) => a.localeCompare(b, 'ru'));
  return { sheets, groups };
}

// ─── Команды ─────────────────────────────────────────────────────────────────

async function requireGroup(chatId: number): Promise<string | null> {
  const chat = await getChat(chatId);
  if (!chat?.group_name) {
    await reply(chatId, 'Группа не выбрана\\. Нажми /group и выбери свою\\.');
    return null;
  }
  return chat.group_name;
}

async function sendDay(chatId: number, offset: number, heading: string): Promise<void> {
  const group = await requireGroup(chatId);
  if (!group) return;

  const dateIso = mskDateOffset(offset);
  const file = await latestFile();
  const day = await getDay(group, dateIso);

  const opts = { group, siteUpdated: file?.site_updated ?? null, heading };
  const text = day
    ? formatDay(day, opts)
    : formatEmptyDay(dateIso, dayNameOf(dateIso), opts);

  await sendMessage(chatId, text, { silent: true });
}

async function sendWeekMessages(chatId: number): Promise<void> {
  const group = await requireGroup(chatId);
  if (!group) return;

  const { days, file } = await getWeek(group);
  const chunks = formatWeek(days, {
    group,
    siteUpdated: file?.site_updated ?? null,
    heading: file?.week_start ? `Неделя с ${humanDate(file.week_start)}` : 'Расписание на неделю',
  });

  for (const text of chunks) await sendMessage(chatId, text, { silent: true });
}

async function sendStatus(chatId: number): Promise<void> {
  const file = await latestFile();
  const check = await getState<{ at: string; filesOnSite: number; changed: string[]; errors: string[] }>(
    LAST_CHECK_KEY,
  );
  const chat = await getChat(chatId);

  const lines = ['*Статус*', ''];
  lines.push(`Группа чата: ${chat?.group_name ? esc(chat.group_name) : '_не выбрана_'}`);

  if (check) {
    lines.push(`Последняя проверка сайта: ${esc(mskStamp(new Date(check.at)))}`);
    lines.push(`Файлов на странице: ${check.filesOnSite}`);
    if (check.errors.length > 0) lines.push(`⚠️ Ошибки: ${esc(check.errors.join('; ').slice(0, 300))}`);
  } else {
    lines.push('_Проверок ещё не было_');
  }

  if (file) {
    lines.push('');
    lines.push(`Актуальный файл: ${esc(file.title)}`);
    if (file.site_updated) lines.push(`Дата обновления на сайте: ${esc(file.site_updated)}`);
    if (file.week_start) lines.push(`Неделя с ${esc(humanDate(file.week_start))}`);
  } else {
    lines.push('_Расписание ещё не загружено_');
  }

  await sendMessage(chatId, lines.join('\n'), { silent: true });
}

async function startGroupPicker(chatId: number): Promise<void> {
  const { sheets } = await groupIndex();
  if (sheets.length === 0) {
    await reply(chatId, 'Расписание ещё не загружено\\. Попробуй через час\\.');
    return;
  }
  await sendMessage(chatId, '*Выбери курс:*', {
    silent: true,
    keyboard: sheetKeyboard(sheets),
  });
}

// ─── Разбор сообщений ────────────────────────────────────────────────────────

function commandOf(text: string): string | null {
  const m = /^\/([a-z_]+)(?:@[\w_]+)?\b/i.exec(text.trim());
  return m ? m[1].toLowerCase() : null;
}

async function handleMessage(message: TgMessage): Promise<void> {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const text = message.text ?? '';
  const command = commandOf(text);
  if (!command) return;

  const chat = await getChat(chatId);
  const isAdminUser = userId === env.adminTelegramId;

  // Allowlist: в неизвестном чате отвечаем только админу бота
  if (!chat && !isAdminUser) {
    await log('skip', `Команда из неразрешённого чата ${chatId}`, { chatId, details: { command } });
    return;
  }

  if (chat && !chat.enabled && !isAdminUser) return;

  if (!(await allowRequest(chatId))) {
    await log('skip', `Rate limit в чате ${chatId}`, { chatId });
    return;
  }

  await log('command', `/${command}`, { chatId, details: { userId } });

  switch (command) {
    case 'start':
    case 'help':
      await upsertChat(chatId, message.chat.title ?? null);
      await sendMessage(chatId, HELP, { silent: true });
      if (!chat?.group_name) await startGroupPicker(chatId);
      return;

    case 'enable': {
      if (!userId || !(await isChatAdmin(chatId, userId))) {
        await reply(chatId, 'Включать бота может только админ чата\\.');
        return;
      }
      await upsertChat(chatId, message.chat.title ?? null);
      await setChatEnabled(chatId, true);
      await reply(chatId, 'Бот включён в этом чате\\. Выбери группу: /group');
      return;
    }

    case 'disable': {
      if (!userId || !(await isChatAdmin(chatId, userId))) {
        await reply(chatId, 'Выключать бота может только админ чата\\.');
        return;
      }
      await setChatEnabled(chatId, false);
      await reply(chatId, 'Автоотправка в этом чате выключена\\. Включить снова — /enable');
      return;
    }

    case 'group': {
      if (userId && !(await isChatAdmin(chatId, userId))) {
        await reply(chatId, 'Менять группу может только админ чата\\.');
        return;
      }
      await upsertChat(chatId, message.chat.title ?? null);
      await startGroupPicker(chatId);
      return;
    }

    case 'today':
      await sendDay(chatId, 0, 'Расписание на сегодня');
      return;

    case 'tomorrow':
      await sendDay(chatId, 1, 'Расписание на завтра');
      return;

    case 'week':
      await sendMessage(chatId, '*Какой день?*', { silent: true, keyboard: DAY_BUTTONS });
      return;

    case 'status':
      await sendStatus(chatId);
      return;

    default:
      return;
  }
}

// ─── Разбор кнопок ───────────────────────────────────────────────────────────

async function handleCallback(query: TgCallbackQuery): Promise<void> {
  const data = query.data ?? '';
  const message = query.message;
  if (!message) {
    await answerCallbackQuery(query.id);
    return;
  }

  const chatId = message.chat.id;
  const chat = await getChat(chatId);
  if (!chat && query.from.id !== env.adminTelegramId) {
    await answerCallbackQuery(query.id, 'Чат не подключён');
    return;
  }

  if (!(await allowRequest(chatId, 20))) {
    await answerCallbackQuery(query.id, 'Слишком часто, подожди минуту');
    return;
  }

  const { sheets, groups } = await groupIndex();

  // Выбор курса → список групп
  if (data.startsWith('s:')) {
    const sheetIndex = Number(data.slice(2));
    const sheet = sheets[sheetIndex];
    if (!sheet) {
      await answerCallbackQuery(query.id, 'Список устарел, нажми /group');
      return;
    }
    const inSheet = groups.filter((g) => g.sheet === sheet);
    await editMessageText(
      chatId,
      message.message_id,
      `*${esc(sheet)}*\nВыбери группу:`,
      groupKeyboard(inSheet, sheetIndex, 0),
    );
    await answerCallbackQuery(query.id);
    return;
  }

  // Пагинация групп
  if (data.startsWith('p:')) {
    const [, sheetRaw, pageRaw] = data.split(':');
    const sheet = sheets[Number(sheetRaw)];
    if (!sheet) {
      await answerCallbackQuery(query.id, 'Список устарел, нажми /group');
      return;
    }
    const inSheet = groups.filter((g) => g.sheet === sheet);
    await editMessageText(
      chatId,
      message.message_id,
      `*${esc(sheet)}*\nВыбери группу:`,
      groupKeyboard(inSheet, Number(sheetRaw), Number(pageRaw)),
    );
    await answerCallbackQuery(query.id);
    return;
  }

  if (data === 'back') {
    await editMessageText(chatId, message.message_id, '*Выбери курс:*', sheetKeyboard(sheets));
    await answerCallbackQuery(query.id);
    return;
  }

  // Выбор группы
  if (data.startsWith('g:')) {
    if (!(await isChatAdmin(chatId, query.from.id))) {
      await answerCallbackQuery(query.id, 'Только админ чата может менять группу');
      return;
    }
    const group = groups[Number(data.slice(2))];
    if (!group) {
      await answerCallbackQuery(query.id, 'Список устарел, нажми /group');
      return;
    }
    await upsertChat(chatId, message.chat.title ?? null);
    await setChatGroup(chatId, group.group);
    await editMessageText(
      chatId,
      message.message_id,
      `✅ Группа чата: *${esc(group.group)}*\n\nРасписание на завтра — /tomorrow`,
    );
    await answerCallbackQuery(query.id, `Выбрано: ${group.group}`);
    await log('command', `Группа чата установлена: ${group.group}`, { chatId });
    return;
  }

  // Кнопки дней недели
  if (data.startsWith('d:')) {
    const key = data.slice(2);
    if (key === 'all') {
      await answerCallbackQuery(query.id);
      await sendWeekMessages(chatId);
      return;
    }

    const groupName = chat?.group_name;
    if (!groupName) {
      await answerCallbackQuery(query.id, 'Сначала выбери группу: /group');
      return;
    }

    const { days, file } = await getWeek(groupName);
    const index = Number(key);
    const day = days[index];

    await answerCallbackQuery(query.id);

    if (!day) {
      await reply(chatId, 'На этот день данных нет\\.');
      return;
    }

    await sendMessage(
      chatId,
      formatDay(day, { group: groupName, siteUpdated: file?.site_updated ?? null }),
      { silent: true },
    );
    return;
  }

  await answerCallbackQuery(query.id);
}

/** Точка входа для вебхука. Никогда не бросает — Telegram не должен ретраить. */
export async function handleUpdate(update: TgUpdate): Promise<void> {
  try {
    if (update.message) await handleMessage(update.message);
    else if (update.callback_query) await handleCallback(update.callback_query);
  } catch (error) {
    await logError('Обработка апдейта Telegram', error, {
      update: JSON.stringify(update).slice(0, 1000),
    });
  }
}
