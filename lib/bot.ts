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
  setChatEnabled,
  setChatGroup,
  upsertChat,
  getState,
  weekStarts,
  type Chat,
} from './db';
import { log, logError } from './log';
import { answerCallbackQuery, editMessageText, isChatAdmin, sendMessage, type InlineKeyboard } from './telegram';
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

function menuScreen(chat: Chat | null): Screen {
  const lines = ['*Расписание колледжа МУИВ*', ''];

  if (chat?.group_name) {
    lines.push(`👥 Группа: *${esc(chat.group_name)}*`);
    lines.push('');
    lines.push('Проверяю сайт каждый час и сообщаю, когда расписание меняется\\.');
    lines.push(
      chat.enabled
        ? 'Каждый день в 16:00 присылаю расписание на завтра и закрепляю его \\(кроме субботы\\)\\.'
        : '_Автоотправка выключена\\. Включить — в разделе «Статус»\\._',
    );
  } else {
    lines.push('Группа ещё не выбрана\\. Нажми «Выбрать группу» — дальше всё кнопками\\.');
  }

  return { text: lines.join('\n'), keyboard: menuKeyboard(chat?.group_name ?? null) };
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

// ─── Команда /start ──────────────────────────────────────────────────────────

function isStart(text: string): boolean {
  return /^\/start(?:@[\w_]+)?\b/i.test(text.trim());
}

async function handleMessage(message: TgMessage): Promise<void> {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  if (!isStart(message.text ?? '')) return;

  const chat = await getChat(chatId);
  const isOwner = userId === env.adminTelegramId;

  // Список разрешённых чатов: подключить новый чат может только владелец бота
  if (!chat && !isOwner) {
    await log('skip', `/start из неразрешённого чата ${chatId}`, { chatId });
    return;
  }

  if (chat && !chat.enabled && !isOwner) return;

  if (!(await allowRequest(chatId))) {
    await log('skip', `Rate limit в чате ${chatId}`, { chatId });
    return;
  }

  await log('command', '/start', { chatId, details: { userId } });

  await upsertChat(chatId, message.chat.title ?? null);
  // Новый чат подключает владелец бота — сразу включаем автоотправку
  if (!chat && isOwner) await setChatEnabled(chatId, true);

  const screen = menuScreen(await getChat(chatId));
  await sendMessage(chatId, screen.text, { silent: true, keyboard: screen.keyboard });
}

// ─── Кнопки ──────────────────────────────────────────────────────────────────

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

  const edit = (screen: Screen) =>
    editMessageText(chatId, message.message_id, screen.text, screen.keyboard);

  /** Возвращает группу чата либо возвращает в меню с подсказкой. */
  const requireGroup = async (): Promise<string | null> => {
    if (chat?.group_name) return chat.group_name;
    await answerCallbackQuery(query.id, 'Сначала выбери группу');
    await edit(menuScreen(chat));
    return null;
  };

  // ─── Меню и статус ─────────────────────────────────────────────────────────

  if (data === 'm') {
    await answerCallbackQuery(query.id);
    await edit(menuScreen(chat));
    return;
  }

  if (data === 'st') {
    await answerCallbackQuery(query.id);
    await edit(await statusScreen(chat));
    return;
  }

  if (data === 'off' || data === 'on') {
    if (!(await isChatAdmin(chatId, query.from.id))) {
      await answerCallbackQuery(query.id, 'Только админ чата может это менять');
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
    await answerCallbackQuery(query.id);
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
    await answerCallbackQuery(query.id);

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

    await answerCallbackQuery(query.id);

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
    await answerCallbackQuery(query.id);

    if (sheets.length === 0) {
      await edit({
        text: 'Расписание ещё не загружено\\. Попробуй через час\\.',
        keyboard: menuKeyboard(chat?.group_name ?? null),
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
      await answerCallbackQuery(query.id, 'Список устарел');
      await edit({ text: '*Выбери курс:*', keyboard: sheetKeyboard(sheets) });
      return;
    }

    await answerCallbackQuery(query.id);
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
      await answerCallbackQuery(query.id, 'Только админ чата может менять группу');
      return;
    }

    const group = groups[Number(data.slice(2))];
    if (!group) {
      await answerCallbackQuery(query.id, 'Список устарел');
      await edit({ text: '*Выбери курс:*', keyboard: sheetKeyboard(sheets) });
      return;
    }

    await upsertChat(chatId, message.chat.title ?? null);
    await setChatGroup(chatId, group.group);
    await answerCallbackQuery(query.id, `Выбрано: ${group.group}`);
    await log('command', `Группа чата установлена: ${group.group}`, { chatId });

    await edit(menuScreen(await getChat(chatId)));
    return;
  }

  await answerCallbackQuery(query.id);
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
  const isOwner = event.from.id === env.adminTelegramId;

  // Подключить новый чат может только владелец бота
  if (!chat && !isOwner) {
    await log('skip', `Бота добавили в неразрешённый чат ${chatId}`, {
      chatId,
      details: { addedBy: event.from.id, title: event.chat.title },
    });
    return;
  }

  await upsertChat(chatId, event.chat.title ?? null);
  if (!chat) await setChatEnabled(chatId, true);

  await log('command', `Бота добавили в чат ${chatId}`, {
    chatId,
    details: { title: event.chat.title },
  });

  const screen = menuScreen(await getChat(chatId));

  // В группе напоминаем про право закреплять — без него ежедневное
  // расписание отправится, но не закрепится
  const hint =
    event.chat.type === 'private'
      ? ''
      : '\n\n_Чтобы я мог закреплять расписание, дай мне право «Закреплять сообщения»\\._';

  await sendMessage(chatId, screen.text + hint, { silent: true, keyboard: screen.keyboard });
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
