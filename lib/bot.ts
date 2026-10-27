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
  listGroups,
  migrateChat,
  setChatEnabled,
  setChatTopic,
  toggleChatGroup,
  currentGroups,
  weekDates,
  requestAccess,
  decideAccess,
  isApproved,
  getAccess,
  accessRequestsSince,
  getFileByName,
  groupFileName,
  resolveGroups,
  MAX_GROUPS,
  upsertChat,
  getState,
  setState,
  takeState,
  weekStarts,
  clearState,
  addFeedback,
  feedbackSince,
  type Chat,
  type FeedbackKind,
} from './db';
import { log, logError } from './log';
import {
  answerCallbackQuery,
  botUsername,
  leaveChat,
  editMessageText,
  isChatAdmin,
  sendMessage,
  TelegramError,
  type InlineKeyboard,
} from './telegram';
import { emojiTag, esc, formatWeek, humanDate, quote } from './format';
import {
  feedbackButton,
  feedbackCancelKeyboard,
  feedbackKindKeyboard,
  groupKeyboard,
  isAccessSection,
  menuKeyboard,
  scheduleKeyboard,
  sheetKeyboard,
  statusKeyboard,
  type Screen,
} from './keyboard';
import { dayNameOf, isIsoDate, mskDateOffset, mskDayStart, mskStamp, mskToday, weekAnchor } from './time';
import type { Day } from './parse';
import { env } from './env';
import { LAST_CHECK_KEY, weekCovers, type CheckRecord } from './sweep';
import { renderDay } from './render';
import {
  accessOverviewScreen,
  accessSectionScreen,
  adminScreen,
  groupsListScreen,
  loadScreen,
} from './admin';
import { describeUser } from './people';
import { displayGroup } from './aliases';

export { describeUser };

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
  /** Супергруппа с темами: у сообщений появляется message_thread_id. */
  is_forum?: boolean;
}

interface TgMessageEntity {
  type: string;
  custom_emoji_id?: string;
  offset: number;
  length: number;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  entities?: TgMessageEntity[];
  /** Группа превратилась в супергруппу: чат переехал на новый идентификатор. */
  migrate_to_chat_id?: number;
  /** Тема форума. Появляется и у обычных ответов, поэтому одного её мало. */
  message_thread_id?: number;
  /** Сообщение действительно лежит в теме, а не просто отвечает кому-то. */
  is_topic_message?: boolean;
  /** У сообщения из темы сюда попадает служебное «тема создана» с названием. */
  reply_to_message?: { forum_topic_created?: { name?: string } };
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

// ─── Экраны ──────────────────────────────────────────────────────────────────

interface Context {
  isPrivate: boolean;
  isOwner: boolean;
  username: string | null;
  /** Супергруппа с темами: можно выбрать, в какую слать расписание. */
  isForum: boolean;
  /** Тема, в которой человек сейчас разговаривает с ботом. */
  threadId: number | null;
}

/**
 * Тема форума, в которой пришло сообщение.
 *
 * Проверяем is_topic_message, а не только message_thread_id: в обычной
 * супергруппе он появляется и у простого ответа на чужое сообщение, и без
 * этой проверки бот привязался бы к «теме», которой не существует.
 */
function threadOf(message: TgMessage | undefined): number | null {
  if (!message?.is_topic_message) return null;
  return message.message_thread_id ?? null;
}

/** Название темы, если Telegram приложил его к сообщению. */
function topicNameOf(message: TgMessage | undefined): string | null {
  const name = message?.reply_to_message?.forum_topic_created?.name;
  return name ? name.slice(0, 100) : null;
}

/** Как называть тему в тексте: «Общее» — это форум без выбранной темы. */
function topicLabel(chat: Chat | null): string {
  if (!chat?.topic_id) return 'Общее';
  return chat.topic_name ?? `тема №${chat.topic_id}`;
}

function menuScreen(chat: Chat | null, ctx: Context): Screen {
  const lines = ['*Расписание колледжа МУИВ*', ''];

  const groups = chat?.groups ?? [];

  if (groups.length > 0) {
    lines.push(
      `👥 ${groups.length > 1 ? 'Группы' : 'Группа'}: ` +
        groups.map((g) => `*${esc(displayGroup(g))}*`).join(', '),
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

  // Форум: расписание без указания темы падает в «Общее» и теряется,
  // поэтому в меню всегда видно, куда оно уходит, и как это поменять
  if (ctx.isForum) {
    lines.push('');
    lines.push(`🧵 Тема для расписания: *${esc(topicLabel(chat))}*`);
    if (ctx.threadId !== (chat?.topic_id ?? null)) {
      lines.push(
        `_${esc('Чтобы расписание приходило сюда, нажми «Слать в эту тему».')}_`,
      );
    }
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
      // Кнопка нужна только там, где тема отличается от выбранной: в самой
      // выбранной теме менять нечего
      offerTopic: ctx.isForum && ctx.threadId !== (chat?.topic_id ?? null),
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

  // Кнопка «баг или идея» есть и здесь: сломанное чинить полезно,
  // даже если сообщает человек, которого ещё не пустили к расписанию
  return { text: lines.join('\n'), keyboard: [[feedbackButton(true, null)]] };
}

// ─── Баги и предложения ──────────────────────────────────────────────────────

/**
 * Как называется тег. Владельцу важно с первого взгляда понимать, что
 * пришло: сломанное чинят сразу, идею откладывают.
 */
const FEEDBACK_KINDS: Record<FeedbackKind, { title: string; emoji: string; tag: string }> = {
  bug: { title: 'Баг', emoji: '🐞', tag: '#баг' },
  idea: { title: 'Предложение', emoji: '💡', tag: '#предложение' },
};

/**
 * Сколько багов и предложений человек может передать за день (сутки по МСК).
 *
 * Без одобренного доступа — одно: написать может кто угодно, и это главная
 * дверь для спама. С доступом — три: хватит описать пару поломок, но не
 * хватит, чтобы завалить владельца.
 */
export const FEEDBACK_PER_DAY = { approved: 3, other: 1 } as const;

export function feedbackLimit(approved: boolean): number {
  return approved ? FEEDBACK_PER_DAY.approved : FEEDBACK_PER_DAY.other;
}

/**
 * Сколько уведомлений об обратной связи в час владелец получает от всех
 * вместе. Сверх этого сообщения сохраняются и видны в сводке, но в личку
 * не идут: тысяча новых аккаунтов по одному сообщению — та же тысяча.
 */
const FEEDBACK_NOTIFY_PER_HOUR = 30;

/** Длиннее не примем: это заметка автору, а не переписка. */
const FEEDBACK_MAX_LEN = 1000;

/** Ключ ожидания: человек выбрал тег и сейчас пишет текст. */
function feedbackKey(userId: number): string {
  return `fb:${userId}`;
}

/** Ожидание протухает: выбранный вчера тег к сегодняшнему сообщению не относится. */
const FEEDBACK_WAIT_MS = 30 * 60 * 1000;

interface FeedbackWait {
  kind: FeedbackKind;
  at: string;
}

/** «1 сообщение», «3 сообщения», «5 сообщений». */
function messagesWord(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'сообщений';
  if (mod10 === 1) return 'сообщение';
  if (mod10 >= 2 && mod10 <= 4) return 'сообщения';
  return 'сообщений';
}

/** Сколько человек ещё может отправить сегодня. */
async function feedbackLeft(userId: number): Promise<{ limit: number; left: number }> {
  const [approved, used] = await Promise.all([
    isApproved(userId),
    feedbackSince(mskDayStart(), userId),
  ]);
  const limit = feedbackLimit(approved);
  return { limit, left: Math.max(0, limit - used) };
}

/** Лимит на сегодня исчерпан: говорим прямо, сколько можно и когда снова. */
function feedbackLimitScreen(limit: number): Screen {
  const more =
    limit < FEEDBACK_PER_DAY.approved
      ? ` С одобренным доступом — до ${FEEDBACK_PER_DAY.approved}.`
      : '';
  return {
    text: [
      '*Баг или предложение*',
      '',
      esc(`На сегодня всё: в день можно передать ${limit} ${messagesWord(limit)}.${more}`),
      esc('Завтра можно снова — лимит обнуляется в полночь по Москве.'),
    ].join('\n'),
    keyboard: [[{ text: '↩︎ Меню', callback_data: 'm' }]],
  };
}

/** Экран выбора тега. */
function feedbackScreen(left: number): Screen {
  return {
    text: [
      '*Баг или предложение*',
      '',
      esc('Нашёл ошибку или придумал, чего не хватает? Выбери, что это, и напиши одним сообщением — я передам автору.'),
      '',
      `_${esc(`Сегодня можно ещё: ${left}`)}_`,
    ].join('\n'),
    keyboard: feedbackKindKeyboard(),
  };
}

/** Экран ожидания текста. */
function feedbackComposeScreen(kind: FeedbackKind, left: number): Screen {
  const info = FEEDBACK_KINDS[kind];
  return {
    text: [
      `${info.emoji} *${esc(info.title)}*`,
      '',
      esc(
        kind === 'bug'
          ? 'Напиши следующим сообщением, что сломалось и как это повторить.'
          : 'Напиши следующим сообщением, чего не хватает.',
      ),
      '',
      `_${esc(`Одно сообщение, до ${FEEDBACK_MAX_LEN} символов. Сегодня можно ещё: ${left}.`)}_`,
    ].join('\n'),
    keyboard: feedbackCancelKeyboard(),
  };
}

/**
 * Экран обратной связи с учётом лимита: выбор тега, ожидание текста или
 * «на сегодня всё». Ожидание текста заводится только если лимит не исчерпан,
 * иначе человек напишет длинное сообщение, а бот его не примет.
 */
async function feedbackEntry(userId: number, kind: FeedbackKind | null): Promise<Screen> {
  const { limit, left } = await feedbackLeft(userId);
  if (left === 0) {
    await clearState(feedbackKey(userId));
    return feedbackLimitScreen(limit);
  }
  if (!kind) {
    await clearState(feedbackKey(userId));
    return feedbackScreen(left);
  }
  await setState(feedbackKey(userId), { kind, at: new Date().toISOString() });
  return feedbackComposeScreen(kind, left);
}

/** Уведомление владельцу: тег видно первой строкой. */
function feedbackNotice(kind: FeedbackKind, user: TgUser, text: string): string {
  const info = FEEDBACK_KINDS[kind];
  return [
    `${info.emoji} *${esc(info.title)}* ${esc(info.tag)}`,
    '',
    esc(describeUser(user)),
    `\`${user.id}\``,
    '',
    quote(text.split('\n').map((line) => esc(line))),
  ].join('\n');
}

/**
 * Сколько уведомлений о новых заявках владелец получает в час. Обычный
 * наплыв (двести человек за утро) сюда укладывается; сверх — заявки всё
 * равно видны в разделе «Ждут решения».
 */
const ACCESS_NOTIFY_PER_HOUR = 60;

async function shouldNotifyRequest(): Promise<boolean> {
  const lastHour = await accessRequestsSince(new Date(Date.now() - 3_600_000).toISOString());
  if (lastHour <= ACCESS_NOTIFY_PER_HOUR) return true;
  await log('skip', 'Заявка без уведомления владельцу: слишком много за час', {
    details: { lastHour },
  });
  return false;
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

/**
 * Владельцу: доступ открыт, но человеку об этом сообщить не вышло. Если не
 * дойдёт и это, экран заявок всё равно должен обновиться, поэтому отказ
 * пишем в журнал и идём дальше.
 */
async function tellOwnerUnreachable(
  person: string,
  userId: number,
  error: TelegramError,
): Promise<void> {
  const text = [
    `*${esc('Доступ открыт, но сообщение не дошло')}*`,
    '',
    `${esc(person)} · \`${userId}\``,
    esc(`Telegram: ${error.description}`),
    '',
    esc('Пусть разблокирует бота и нажмёт /start: доступ уже работает.'),
  ].join('\n');

  try {
    await sendMessage(env.adminTelegramId, text);
  } catch (sendError) {
    await logError('Сообщение владельцу о недоставленном одобрении', sendError, { userId });
  }
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
  const { text, keyboard } = await renderDay(chatId, stored, dateIso, await weekStarts(), heading);
  return { text, keyboard };
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
  const { groups, missing } = await currentGroups(chatId, stored);
  const active = Math.min(Math.max(groupIndex, 0), Math.max(groups.length - 1, 0));
  const group = groups[active] ?? '';

  // Файл теперь свой у каждой группы (не один на всех, как раньше с xlsx) —
  // «файл на эту дату» без привязки к группе мог случайно попасть на файл
  // другой группы или вообще без пар. getWeek уже ищет файл именно этой
  // группы. Недели у групп почти всегда совпадают (обе обрезаны до одной
  // календарной недели при скачивании — см. ingestGroup), поэтому кнопки
  // при переключении группы не «съезжают».
  const [{ days, file }, weeks] = await Promise.all([
    group ? getWeek(group, fromIso) : Promise.resolve({ days: [] as Day[], file: null }),
    weekStarts(),
  ]);

  const allDates = file ? await weekDates(file.id) : [];

  const chunks = formatWeek(days, {
    group,
    siteUpdated: file?.site_updated ?? null,
    heading: file?.week_start ? `Неделя с ${humanDate(file.week_start)}` : 'Расписание на неделю',
  });

  // Кнопки дней — по всей неделе из файла, даже если у группы пар нет:
  // иначе переключатель групп и навигация по неделям пропадали
  const withLessons = new Map(days.map((d) => [d.date, d]));
  const keyboardDays = allDates.map(
    (date) => withLessons.get(date) ?? { date, name: dayNameOf(date), lessons: [] },
  );

  // Якорь — начало недели: он не зависит от того, какая группа выбрана,
  // поэтому кнопки не «съезжают» при переключении
  const anchor = file?.week_start ?? fromIso;

  return {
    chunks,
    keyboard: scheduleKeyboard(
      keyboardDays,
      null,
      file?.week_start ?? null,
      weeks,
      groups.length > 1 ? { groups, activeIndex: active, dateIso: anchor } : undefined,
      missing,
    ),
  };
}

/**
 * Статус чата: что с расписанием именно его групп. Раньше здесь стояла
 * «текущая неделя» одного общего файла — с AJAX у каждой группы свой файл,
 * и в строку попадало имя случайной чужой группы.
 */
async function statusScreen(chat: Chat | null): Promise<Screen> {
  const groups = chat?.groups ?? [];
  const [check, resolution] = await Promise.all([
    getState<CheckRecord>(LAST_CHECK_KEY),
    resolveGroups(groups),
  ]);
  const canonical = groups.map((g) => resolution.actual.get(g) ?? g);
  const files = await Promise.all(canonical.map((g) => getFileByName(groupFileName(g))));

  const lines = ['*Статус*', ''];
  lines.push(
    `👥 ${groups.length > 1 ? 'Группы' : 'Группа'}: ` +
      (groups.length > 0 ? groups.map((g) => `*${esc(displayGroup(g))}*`).join(', ') : '_не выбрана_'),
  );
  lines.push(`🔔 Автоотправка: ${chat?.enabled ? 'включена' : 'выключена'}`);

  if (canonical.length > 0) {
    lines.push('');
    const today = weekAnchor();
    canonical.forEach((group, index) => {
      const file = files[index];
      const state =
        file?.parsed_ok && weekCovers(file, today)
          ? `неделя с ${humanDate(file.week_start!)}, проверено ${mskStamp(new Date(file.last_seen))}`
          : 'расписание этой недели ещё не загружено';
      lines.push(esc(`📦 ${displayGroup(group)}: ${state}`));
    });
  }

  lines.push('');
  if (check) {
    lines.push(`Последняя проверка сайта: ${esc(mskStamp(new Date(check.at)))}`);
    // Только ошибки своих групп: чужие человеку ничего не скажут
    const own = check.errors.filter((e) => canonical.some((g) => e.startsWith(`${g}:`)));
    if (own.length > 0) lines.push(`⚠️ ${esc(own.join('; ').slice(0, 300))}`);
  } else {
    lines.push('_Проверок ещё не было_');
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
/** Как подписывается автор. Кастомный эмодзи владелец задаёт сам, прислав его боту. */
export interface CreditEmoji {
  /** Обычный эмодзи: он же запасной, если кастомный не отобразится. */
  glyph: string;
  /** id кастомного эмодзи, если владелец его задал. */
  customId: string | null;
}

/**
 * Белая птица из набора «ХакТайка» — последний эмодзи набора.
 * Запасной глиф выбран похожим: там, где кастомный эмодзи не отобразится
 * (системные уведомления, пересылка без Premium), останется белая птица.
 */
const DEFAULT_CREDIT: CreditEmoji = { glyph: '🕊', customId: '5399882430721071735' };
const CREDIT_EMOJI_KEY = 'credit_emoji';

async function creditEmoji(): Promise<CreditEmoji> {
  const saved = await getState<CreditEmoji>(CREDIT_EMOJI_KEY);
  if (!saved) return DEFAULT_CREDIT;
  return {
    glyph: saved.glyph || DEFAULT_CREDIT.glyph,
    customId: saved.customId ?? null,
  };
}

/**
 * Обучалка после одобрения доступа: несколько экранов подряд, только
 * «Далее»/«Назад» — без меню и лишних кнопок, чтобы не отвлекать до конца.
 * Шаги: что за бот → как добавить в группу и какие права дать → как искать
 * свою группу (после переименования специальностей 3–4 курса).
 */
const ONBOARDING_STEPS = 3;

function onboardingScreen(step: number, username: string | null): Screen {
  const s = Math.min(Math.max(step, 0), ONBOARDING_STEPS - 1);

  const pages: string[] = [
    [
      '*Как пользоваться ботом*  ·  шаг 1 из 3',
      '',
      esc('Я присылаю расписание колледжа МУИВ. Проверяю сайт каждый час и слежу за изменениями.'),
      '',
      esc('Работаю и в личке (только для тебя), и в группе (для всех сразу) — на следующем шаге покажу, как добавить меня в группу.'),
    ].join('\n'),
    [
      '*Как пользоваться ботом*  ·  шаг 2 из 3',
      '',
      esc('Добавление в группу:'),
      username
        ? `${esc('1. Кнопка')} «➕ Добавить в группу» ${esc('в меню, или ')}[${esc('ссылка')}](https://t.me/${username}?startgroup=true)`
        : esc('1. Добавь меня в группу обычным способом Telegram — «Добавить участника».'),
      esc('2. Сделай меня админом группы и дай право «Закрепление сообщений» — без него ежедневное расписание отправится, но не закрепится.'),
      esc('3. Если в группе есть темы (форум) — открой нужную тему и напиши /start, расписание пойдёт именно туда, а не в «Общее».'),
    ].join('\n'),
    [
      '*Как пользоваться ботом*  ·  шаг 3 из 3',
      '',
      esc('Как искать свою группу:'),
      esc(
        'Колледж переименовал специальности 3–4 курса — например, ИСП/П-23-09.1 теперь на сайте называется КБо 111п-23.',
      ),
      esc('В списке выбора я показываю оба варианта — привычное имя и рядом в скобках настоящее с сайта, — ищи по любому.'),
      '',
      esc('Дальше — жми «Выбрать группу» и находи свою.'),
    ].join('\n'),
  ];

  const nav: InlineKeyboard[number] = [];
  if (s > 0) nav.push({ text: '◀ Назад', callback_data: `ob:${s - 1}` });
  nav.push(
    s < ONBOARDING_STEPS - 1
      ? { text: 'Далее ▶', callback_data: `ob:${s + 1}` }
      : { text: '👥 Выбрать группу', callback_data: 'grp' },
  );

  return { text: pages[s], keyboard: [nav] };
}

function aboutScreen(credit: CreditEmoji): Screen {
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
    `${emojiTag(credit.glyph, credit.customId)} ${esc('Сделано в')} [${esc('Хактайке')}](${author})`,
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
async function contextOf(
  chat: TgChat,
  userId?: number,
  message?: TgMessage,
): Promise<Context> {
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
    isForum: chat.is_forum === true,
    threadId: threadOf(message),
  };
}

/**
 * Запоминает кастомный эмодзи из сообщения владельца.
 *
 * Telegram разрешает боту кастомные эмодзи, только если у владельца есть
 * Premium, — поэтому сразу проверяем отправкой: сохраняем лишь то, что
 * Telegram принял, иначе экран «О боте» сломался бы молча.
 *
 * Возвращает true, если сообщение было именно про эмодзи.
 */
async function learnCreditEmoji(chatId: number, message: TgMessage): Promise<boolean> {
  const entity = message.entities?.find((e) => e.type === 'custom_emoji' && e.custom_emoji_id);
  if (!entity?.custom_emoji_id) return false;

  const text = message.text ?? '';
  // Глиф — то, что стоит на месте эмодзи: он же запасной вариант
  const glyph =
    Array.from(text).slice(entity.offset, entity.offset + entity.length).join('') ||
    DEFAULT_CREDIT.glyph;

  const candidate: CreditEmoji = { glyph, customId: entity.custom_emoji_id };

  try {
    const preview = aboutScreen(candidate);
    await sendMessage(chatId, preview.text, { silent: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await sendMessage(
      chatId,
      [
        `*${esc('Telegram не принял этот эмодзи')}*`,
        '',
        `\`${esc(reason.slice(0, 300))}\``,
        '',
        esc('Кастомные эмодзи бот может отправлять, только если у владельца есть Telegram Premium.'),
      ].join('\n'),
      { silent: true },
    );
    await log('skip', 'Кастомный эмодзи отклонён Telegram', {
      chatId,
      details: { customId: entity.custom_emoji_id, reason },
    });
    return true;
  }

  await setState(CREDIT_EMOJI_KEY, candidate);
  await sendMessage(
    chatId,
    esc('Готово — этот эмодзи теперь стоит в подписи. Выше видно, как получилось.'),
    { silent: true },
  );
  await log('command', 'Кастомный эмодзи задан', {
    chatId,
    details: { customId: entity.custom_emoji_id, glyph },
  });
  return true;
}

// ─── Команда /start ──────────────────────────────────────────────────────────

function isStart(text: string): boolean {
  return /^\/start(?:@[\w_]+)?\b/i.test(text.trim());
}

/**
 * Что стоит за `/start` в ссылке вида `t.me/bot?start=fb`.
 *
 * Из группы обратную связь принять нельзя: у бота включён режим приватности,
 * обычных сообщений он там не видит. Ссылка переводит человека в личку сразу
 * на нужный экран, чтобы он не искал его руками.
 */
function startPayload(text: string): 'fb' | FeedbackKind | null {
  const payload = text.trim().replace(/^\/start(?:@[\w_]+)?/i, '').trim().toLowerCase();
  if (payload === 'fb' || payload === 'bug' || payload === 'idea') return payload;
  return null;
}

/**
 * Текст после выбора тега. Возвращает true, если сообщение было обратной
 * связью и обработано, — тогда дальше его разбирать не нужно.
 */
async function handleFeedbackText(chatId: number, user: TgUser, raw: string): Promise<boolean> {
  const key = feedbackKey(user.id);
  const wait = await getState<FeedbackWait>(key);
  if (!wait) return false;

  // Тег выбрали полчаса назад: к этому сообщению он уже вряд ли относится
  if (Date.now() - new Date(wait.at).getTime() > FEEDBACK_WAIT_MS) {
    await clearState(key);
    return false;
  }

  const text = raw.trim();
  if (text.length === 0) return false;

  if (text.length > FEEDBACK_MAX_LEN) {
    await sendMessage(
      chatId,
      esc(`Слишком длинно: ${text.length} символов из ${FEEDBACK_MAX_LEN}. Сократи и пришли ещё раз.`),
      { silent: true, keyboard: feedbackCancelKeyboard() },
    );
    return true;
  }

  // Ожидание забираем атомарно: два сообщения подряд, доставленные
  // параллельно, иначе оба прошли бы проверку лимита ниже
  if (!(await takeState<FeedbackWait>(key))) return true;

  // Лимит проверяем ещё раз: экран с тегом могли открыть вчера или в двух
  // окнах сразу, а считается только то, что реально передано
  const { limit, left } = await feedbackLeft(user.id);
  if (left === 0) {
    const screen = feedbackLimitScreen(limit);
    await sendMessage(chatId, screen.text, { silent: true, keyboard: screen.keyboard });
    await log('skip', `Обратная связь: дневной лимит у ${user.id}`, {
      chatId,
      details: { userId: user.id, limit },
    });
    return true;
  }

  const info = FEEDBACK_KINDS[wait.kind];

  await addFeedback({
    chatId,
    userId: user.id,
    username: user.username ?? null,
    firstName: user.first_name ?? null,
    kind: wait.kind,
    text,
  });

  // Уведомление владельцу — не критично для человека: он своё сообщение
  // уже отдал, и «спасибо» он должен увидеть даже если Telegram подвёл
  const lastHour = await feedbackSince(new Date(Date.now() - 3_600_000).toISOString());
  if (lastHour > FEEDBACK_NOTIFY_PER_HOUR) {
    await log('skip', 'Обратная связь сохранена без уведомления: слишком много за час', {
      chatId,
      details: { userId: user.id, lastHour },
    });
  } else {
    try {
      await sendMessage(env.adminTelegramId, feedbackNotice(wait.kind, user, text), {
        silent: false,
      });
    } catch (error) {
      await logError('Уведомление владельца об обратной связи', error);
    }
  }

  await sendMessage(
    chatId,
    [
      `✅ *${esc('Передал автору')}* ${esc(info.tag)}`,
      '',
      esc('Спасибо — так бот становится лучше.'),
    ].join('\n'),
    { silent: true, keyboard: [[{ text: '↩︎ Меню', callback_data: 'm' }]] },
  );

  await log('command', `Обратная связь: ${wait.kind}`, {
    chatId,
    details: { userId: user.id, length: text.length },
  });
  return true;
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

  // Владелец присылает кастомный эмодзи — бот запоминает его для подписи
  // «Сделано в Хактайке». Просить у него id вручную было бы лишним трудом.
  if (
    user?.id === env.adminTelegramId &&
    message.chat.type === 'private' &&
    (await learnCreditEmoji(chatId, message))
  ) {
    return;
  }

  // Человек выбрал тег и пишет текст. Ловим до всех прочих правил: команд
  // у бота нет, и без этого сообщение молча пропало бы.
  if (message.chat.type === 'private' && user && !isStart(message.text ?? '')) {
    if (message.text && (await handleFeedbackText(chatId, user, message.text))) return;
  }

  if (!isStart(message.text ?? '')) return;

  if (!(await allowRequest(chatId))) {
    await log('skip', `Rate limit в чате ${chatId}`, { chatId });
    return;
  }

  const isPrivate = message.chat.type === 'private';

  // В личке /start — это заявка на доступ либо вход для уже одобренного
  if (isPrivate && user) {
    // Пришли по ссылке «баг или идея» из группы — сразу нужный экран.
    // Это до проверки доступа: сообщить о поломке может кто угодно.
    const payload = startPayload(message.text ?? '');
    if (payload) {
      const screen = await feedbackEntry(user.id, payload === 'fb' ? null : payload);
      await sendMessage(chatId, screen.text, { silent: true, keyboard: screen.keyboard });
      await log('command', `Обратная связь: экран ${payload}`, {
        chatId,
        details: { userId: user.id },
      });
      return;
    }

    if (!(await isApproved(user.id))) {
      const { status, isNew } = await requestAccess(
        user.id,
        user.username ?? null,
        user.first_name ?? null,
      );

      const screen = accessScreen(status === 'denied' ? 'denied' : 'pending');
      await sendMessage(chatId, screen.text, { silent: true, keyboard: screen.keyboard });

      await log('command', `Заявка на доступ: ${status}${isNew ? ' (новая)' : ''}`, {
        chatId,
        details: { userId: user.id, username: user.username },
      });

      // Владельцу сообщаем только о новой заявке, чтобы не дёргать повторами.
      // Волна заявок сверх потолка ждёт в «Доступ → Ждут решения» без
      // уведомления: сотни сообщений подряд в личку — это уже атака
      if (isNew && (await shouldNotifyRequest())) {
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
  // Отвечать нужно в ту же тему, где спросили: иначе ответ улетит в «Общее»
  const threadId = threadOf(message);

  if (!chat) {
    if (!user || !(await isApproved(user.id))) {
      await log('skip', `/start без доступа в чате ${chatId}`, {
        chatId,
        details: { userId: user?.id },
      });
      await sendMessage(
        chatId,
        esc('Доступ не открыт. Напиши мне в личку и дождись одобрения.'),
        { silent: true, threadId },
      );
      return;
    }

    await upsertChat(chatId, message.chat.title ?? null, user.id);
    await setChatEnabled(chatId, true);

    // Подключили из темы — значит расписание ждут именно там. Просить
    // отдельно нажать кнопку было бы лишним шагом на пустом месте.
    if (threadId !== null) await setChatTopic(chatId, threadId, topicNameOf(message));

    await log('command', `Чат подключён через /start: ${chatId}`, {
      chatId,
      details: { userId: user.id, title: message.chat.title, topicId: threadId },
    });
  } else {
    await log('command', '/start', { chatId, details: { userId: user?.id } });
  }

  const fresh = await getChat(chatId);
  const screen = menuScreen(fresh, await contextOf(message.chat, user?.id, message));
  await sendMessage(chatId, screen.text, {
    silent: true,
    keyboard: screen.keyboard,
    threadId,
  });
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
  const [chat, ctx] = await Promise.all([
    getChat(chatId),
    contextOf(message.chat, query.from.id, message),
  ]);

  // Кнопки работают только в подключённом чате. Исключение — решения по
  // заявкам: они приходят владельцу в личку, где чата в базе может не быть.
  const isDecision = data.startsWith('ok:') || data.startsWith('no:');
  // Экраны владельца тоже: сводку и заявки он открывает из уведомлений в
  // личке, и запись о его личке в базе для этого не нужна
  const isOwnerScreen =
    ctx.isOwner && ctx.isPrivate && (data.startsWith('adm') || data.startsWith('acc:'));
  // Баги и предложения принимаем от кого угодно, в том числе из личек,
  // которых нет в базе: у неодобренного человека записи о чате не будет
  const isFeedback = data === 'fb' || data.startsWith('fb:');
  // Обучалка и весь путь выбора группы из неё («Выбрать группу» → курс →
  // группа) приходят в личку сразу после одобрения — до первого /start,
  // то есть раньше, чем в базе появится запись о чате. Сама группа (data
  // начинается с «g:») создаёт запись через upsertChat перед сохранением,
  // а до этого шага чат ещё не нужен — только смотрим списки.
  const isSetupFlow =
    ctx.isPrivate &&
    (data.startsWith('ob:') || data === 'grp' || data.startsWith('s:') || data.startsWith('g:'));
  if (
    !chat &&
    !isDecision &&
    !isOwnerScreen &&
    !isFeedback &&
    !isSetupFlow &&
    !(ctx.isPrivate && data === 'm')
  ) {
    // Через ack, а не напрямую: иначе на нажатие уходило два ответа
    ack('Чат не подключён');
    return;
  }

  // В группе кнопки жмут все участники сразу, поэтому лимит выше, чем на команды
  if (!(await allowRequest(chatId, 60, 'button'))) {
    ack('Слишком часто, подожди минуту');
    return;
  }

  const edit = (screen: Screen) =>
    editMessageText(chatId, message.message_id, screen.text, screen.keyboard);

  // В личке пользоваться ботом можно только с одобренным доступом — и
  // проверяем это на каждом нажатии, а не только на /start: иначе
  // отозванный доступ продолжал бы работать по старым кнопкам. Баги и
  // предложения принимаем от всех, решения по заявкам — от владельца.
  if (ctx.isPrivate && !isFeedback && !isDecision && !isOwnerScreen) {
    const access = await getAccess(query.from.id);
    if (!ctx.isOwner && access?.status !== 'approved') {
      ack(data === 'm' ? undefined : 'Доступ не открыт');
      if (data === 'm') await edit(accessScreen(access?.status === 'denied' ? 'denied' : 'pending'));
      return;
    }
  }

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

  // ─── Баги и предложения ────────────────────────────────────────────────────

  if (data === 'fb') {
    ack();
    await edit(await feedbackEntry(query.from.id, null));
    return;
  }

  if (data === 'fb:bug' || data === 'fb:idea') {
    // Принять текст можно только в личке: в группе бот обычных сообщений
    // не видит — у него включён режим приватности
    if (!ctx.isPrivate) {
      const username = await botUsername().catch(() => null);
      ack(username ? 'Напиши мне в личку' : 'Это работает только в личке');
      return;
    }

    const kind: FeedbackKind = data === 'fb:bug' ? 'bug' : 'idea';
    ack();
    await edit(await feedbackEntry(query.from.id, kind));
    return;
  }

  // Решение по заявке — только владелец бота
  if (data.startsWith('ok:') || data.startsWith('no:')) {
    if (query.from.id !== env.adminTelegramId) {
      ack('Недоступно');
      return;
    }

    const [, idRaw, origin, pageRaw] = data.split(':');
    const targetId = Number(idRaw);
    // Нажатие можно подделать: в базу и в Telegram идёт только настоящий id
    if (!Number.isSafeInteger(targetId) || targetId <= 0) {
      ack('Кнопка устарела');
      return;
    }

    const approve = data.startsWith('ok:');
    const previous = await getAccess(targetId);
    const before = previous?.status ?? null;
    await decideAccess(targetId, approve ? 'approved' : 'denied');
    // Отозвали доступ — расписание в его личку больше не шлём
    if (!approve) await setChatEnabled(targetId, false);
    ack(approve ? 'Доступ открыт' : 'Отказано');
    await log('command', `Заявка ${approve ? 'одобрена' : 'отклонена'}: ${targetId}`);

    // Человек должен узнать решение сам, не спрашивая. Подробности (как
    // добавить в группу, какие права дать, как искать свою группу) — в
    // пошаговой обучалке по кнопке, а не всё сразу одним текстом. Повторное
    // нажатие «Разрешить» уже одобренному обучалку второй раз не шлёт.
    if (approve && before !== 'approved') {
      try {
        const username = await botUsername().catch(() => null);
        const screen = onboardingScreen(0, username);
        // Прямая ссылка «Добавить в группу» — отдельной строкой поверх
        // шагов обучалки: чтобы не листать все шаги, если человек и так
        // знает, что делать
        const keyboard = username
          ? [[{ text: '➕ Добавить в группу', url: `https://t.me/${username}?startgroup=true` }], ...screen.keyboard]
          : screen.keyboard;
        await sendMessage(
          targetId,
          `*${esc('Доступ открыт')}*\n\n${screen.text}`,
          { silent: false, keyboard },
        );
      } catch (error) {
        // Человек заблокировал бота или закрыл аккаунт: доступ уже сохранён, а
        // доставить сообщение нельзя. Это не поломка бота. «Ошибка бота» тут
        // вредна вдвойне: она не говорит, кому не дошло, и раз в час гасится
        // лимитом, так что остальных, кого одобрили подряд, владелец не увидит.
        // Поэтому говорим владельцу прямо, кому и что передать.
        if (error instanceof TelegramError && error.chatIsGone) {
          await log('skip', `Одобрение без уведомления: ${error.description}`, {
            details: { userId: targetId },
          });
          await tellOwnerUnreachable(describeUser({ ...previous, id: targetId }), targetId, error);
        } else {
          await logError('Уведомление об одобрении', error, { userId: targetId });
        }
      }
    }

    // Возвращаемся туда, откуда решали: в раздел и на ту же страницу
    if (isAccessSection(origin)) {
      await edit(await accessSectionScreen(origin, Number(pageRaw) || 0));
    } else {
      await edit(origin === 'acc' ? await accessOverviewScreen() : await adminScreen());
    }
    return;
  }

  // Сводка и её разделы — только владельцу бота
  if (data.startsWith('adm') || data.startsWith('acc:')) {
    if (query.from.id !== env.adminTelegramId) {
      ack('Недоступно');
      return;
    }
    ack();

    if (data.startsWith('acc:')) {
      const [, section, pageRaw] = data.split(':');
      await edit(
        isAccessSection(section)
          ? await accessSectionScreen(section, Number(pageRaw) || 0)
          : await accessOverviewScreen(),
      );
      return;
    }

    const screens: Record<string, () => Promise<Screen>> = {
      adm: adminScreen,
      admacc: accessOverviewScreen,
      admgrp: groupsListScreen,
      admload: loadScreen,
    };
    await edit(await (screens[data] ?? adminScreen)());
    return;
  }

  if (data === 'st') {
    ack();
    await edit(await statusScreen(chat));
    return;
  }

  if (data === 'about') {
    ack();
    await edit(aboutScreen(await creditEmoji()));
    return;
  }

  if (data.startsWith('ob:')) {
    ack();
    const username = await botUsername().catch(() => null);
    await edit(onboardingScreen(Number(data.slice(3)) || 0, username));
    return;
  }

  if (data === 'off' || data === 'on') {
    if (!(await isChatAdmin(chatId, query.from.id))) {
      ack('Только админ чата может это менять');
      return;
    }
    const enable = data === 'on';
    await setChatEnabled(chatId, enable);
    ack(enable ? 'Автоотправка включена' : 'Автоотправка выключена');
    await log('command', `Автоотправка ${enable ? 'включена' : 'выключена'}`, { chatId });
    await edit(await statusScreen(await getChat(chatId)));
    return;
  }

  // Куда слать расписание в форуме. Списка тем Bot API не даёт, поэтому
  // тема задаётся местом нажатия: где нажали — туда и слать.
  if (data === 'topic') {
    if (!(await isChatAdmin(chatId, query.from.id))) {
      ack('Только админ чата может это менять');
      return;
    }

    const threadId = ctx.threadId;
    await setChatTopic(chatId, threadId, topicNameOf(message));
    ack(threadId === null ? 'Буду слать в «Общее»' : 'Буду слать в эту тему');
    await log('command', `Тема для расписания: ${threadId ?? 'общее'}`, {
      chatId,
      details: { topicId: threadId, topicName: topicNameOf(message) },
    });

    await edit(menuScreen(await getChat(chatId), ctx));
    return;
  }

  // ─── Расписание ────────────────────────────────────────────────────────────

  // `day:0` — сегодня, `day:1` — завтра
  if (data.startsWith('day:')) {
    const groups = await requireGroups();
    if (!groups) return;

    // Нажатие можно подделать, а `mskDateOffset(NaN)` — это «NaN-NaN-NaN»
    // в запросе к базе и алерт владельцу на ровном месте
    const offset = Number(data.slice(4));
    if (offset !== 0 && offset !== 1) {
      ack('Кнопка устарела');
      return;
    }
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
    if (key !== 'all' && !/^\d$/.test(key) && !isIsoDate(key)) {
      ack('Кнопка устарела');
      return;
    }
    ack();

    if (key === 'all') {
      const { chunks, keyboard } = await weekScreen(chatId, groups, weekAnchor());
      await editMessageText(chatId, message.message_id, chunks[0], keyboard);
      return;
    }

    let dateIso = key;
    if (/^\d+$/.test(key)) {
      const { days } = await getWeek(groups[0], weekAnchor());
      dateIso = days[Number(key)]?.date ?? mskToday();
    }

    await edit(await dayScreen(chatId, groups, dateIso));
    return;
  }

  // `week` — текущая неделя, `w:<дата>` — неделя, содержащая эту дату
  if (data === 'week' || data.startsWith('w:')) {
    const groups = await requireGroups();
    if (!groups) return;

    const from = data === 'week' ? weekAnchor() : data.slice(2);
    if (!isIsoDate(from)) {
      ack('Кнопка устарела');
      return;
    }
    ack();

    const { chunks, keyboard } = await weekScreen(chatId, groups, from);
    await editMessageText(chatId, message.message_id, chunks[0], keyboard);

    // Если неделя не влезла в одно сообщение — остальные части отправляем ниже
    for (const text of chunks.slice(1)) {
      await sendMessage(chatId, text, { silent: true, threadId: ctx.threadId });
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

    ack(
      outcome === 'added'
        ? `Добавлено: ${displayGroup(picked.group)}`
        : `Убрано: ${displayGroup(picked.group)}`,
    );
    await log('command', `Группы чата: ${outcome} ${picked.group}`, { chatId });

    // Остаёмся в списке: вторую группу выбирают тут же, не возвращаясь в меню.
    // Ack и edit — это отдельные запросы к Telegram и уходят сразу; человек
    // видит результат мгновенно, а не после того, как отработает всё ниже.
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

    // Расписание группы уже лежит в базе: тик держит неделю каждой группы
    // каталога. Браузер здесь не поднимаем — именно он под наплывом людей
    // ронял бота (`ERR_INSUFFICIENT_RESOURCES`) и тормозил нажатия до 9 секунд.
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
      isIsoDate(dateIso ?? '') ? dateIso : weekAnchor(),
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

  // Блокировать и разблокировать бота в личке можно сколько угодно быстро,
  // и каждое такое событие — запись в базу и сообщение. Лимит тот же, что
  // на команды
  if (!(await allowRequest(chatId))) {
    await log('skip', `Rate limit на событиях участия в чате ${chatId}`, { chatId });
    return;
  }

  const chat = await getChat(chatId);

  // Подключить чат может только одобренный человек.
  //
  // В личке это нажатие Start (или разблокировка бота): заводить чат здесь
  // нельзя — иначе неодобренный и даже отклонённый человек получал бы чат
  // в базе и, через него, все кнопки. Экран без доступа покажет /start.
  // Из лички Telegram «выйти» не даёт (leaveChat падает с Bad Request).
  if (!chat && event.chat.type === 'private' && !(await isApproved(event.from.id))) {
    await log('skip', `Личка без доступа: ${chatId}`, { chatId });
    return;
  }

  // В группе бот не остаётся: молча висеть без дела — хуже, чем честно уйти
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
    } catch (error) {
      await log('skip', `Не смог объяснить отказ в чате ${chatId}`, {
        chatId,
        details: { reason: error instanceof Error ? error.message : String(error) },
      });
    }
    // Уходим, даже если объяснить не вышло (например, писать запрещено)
    try {
      await leaveChat(chatId);
    } catch (error) {
      await logError('Выход из чата без доступа', error, { chatId });
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
  const hints: string[] = [];
  if (event.chat.type !== 'private') {
    hints.push(
      esc('Сделай меня админом и дай право «Закрепление сообщений» — иначе расписание отправится, но не закрепится.'),
    );
  }
  // Добавили в форум: событие приходит без темы, и расписание пошло бы
  // в «Общее». Сказать про это надо сразу, а не когда оно туда упадёт.
  if (event.chat.is_forum) {
    hints.push(esc('В группе есть темы: открой нужную, напиши /start — и расписание пойдёт туда.'));
  }
  const hint = hints.length > 0 ? `\n\n_${hints.join(' ')}_` : '';

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

/** Чат апдейта — нужен только для журнала, поэтому без разбора всех видов. */
function chatIdOf(update: TgUpdate): number | null {
  return (
    update.message?.chat.id ??
    update.callback_query?.message?.chat.id ??
    update.my_chat_member?.chat.id ??
    null
  );
}

/** С какой длительности нажатие считается медленным и попадает в журнал. */
const SLOW_PRESS_MS = 1500;

/** Точка входа для вебхука. Никогда не бросает — Telegram не должен ретраить. */
export async function handleUpdate(update: TgUpdate): Promise<void> {
  const started = Date.now();
  try {
    if (update.message) await handleMessage(update.message);
    else if (update.callback_query) {
      await handleCallback(update.callback_query);
      // В журнал — только медленные нажатия: по ним видно, тормозит бот или
      // сеть. Писать каждое значило бы десятки тысяч строк в день на пару
      // сотен человек и забитую бесплатную базу от одного любителя кликать
      const durationMs = Date.now() - started;
      if (durationMs >= SLOW_PRESS_MS) {
        await log('command', `Медленное нажатие ${update.callback_query.data ?? '—'}`, {
          chatId: update.callback_query.message?.chat.id ?? null,
          durationMs,
        });
      }
    } else if (update.my_chat_member) await handleMembership(update.my_chat_member);
  } catch (error) {
    // Чата уже нет: бота выгнали или он сам ушёл, пока апдейт лежал в очереди.
    // Так бывает при добавлении по ссылке «➕ Добавить в группу»: Telegram
    // присылает и «бота добавили», и /start, а необладатель доступа получает
    // отказ и выход из чата — второй апдейт неизбежно упирается в 403.
    // Это не поломка, будить владельца незачем — хватит записи в журнале.
    if (error instanceof TelegramError && error.chatIsGone) {
      await log('skip', `Апдейт из недоступного чата: ${error.description}`, {
        chatId: chatIdOf(update),
        details: { update: JSON.stringify(update).slice(0, 1000) },
      });
      return;
    }

    await logError('Обработка апдейта Telegram', error, {
      update: JSON.stringify(update).slice(0, 1000),
    });
  }
}
