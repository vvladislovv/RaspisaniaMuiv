/** Тонкая обёртка над Bot API: только то, что нужно боту. */
import { env } from './env';

export interface InlineButton {
  text: string;
  /** Обычная кнопка: присылает нажатие боту. */
  callback_data?: string;
  /** Кнопка-ссылка: например, «добавить бота в группу». */
  url?: string;
}

export type InlineKeyboard = InlineButton[][];

interface CallOptions {
  /** Сколько раз повторить при сетевой ошибке или 5xx. */
  retries?: number;
}

const TIMEOUT_MS = 12_000;

/** Ошибка Bot API с кодом: по нему видно, что чат потерян навсегда. */
export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
  ) {
    super(`Telegram ${method}: ${description}`);
    this.name = 'TelegramError';
  }

  /** Чат недоступен безвозвратно: бота выгнали, заблокировали, чат удалён. */
  get chatIsGone(): boolean {
    if (this.code === 403) return true;
    return (
      this.code === 400 &&
      /chat not found|group chat was deactivated|PEER_ID_INVALID/i.test(this.description)
    );
  }
}

/**
 * Адрес Bot API. Переопределяется только для локальных проверок
 * (tools/e2e-bot.mts поднимает дублёр вместо настоящего Telegram).
 */
const API_BASE = process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org';

async function call<T>(method: string, body: unknown, opts: CallOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${API_BASE}/bot${env.botToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      const json = (await res.json()) as {
        ok: boolean;
        result?: T;
        description?: string;
        error_code?: number;
        parameters?: { retry_after?: number };
      };

      if (json.ok) return json.result as T;

      const failure = new TelegramError(
        method,
        json.error_code ?? 0,
        json.description ?? 'неизвестная ошибка',
      );

      // 429 — Telegram просит подождать и сам говорит сколько. Ошибку
      // запоминаем: если попытки кончатся, в журнал должно попасть
      // «Too Many Requests», а не безликое «сбой».
      if (json.error_code === 429) {
        lastError = failure;
        if (attempt === retries) break;
        const waitSeconds = json.parameters?.retry_after ?? attempt;
        await new Promise((r) => setTimeout(r, Math.min(waitSeconds, 5) * 1000));
        continue;
      }

      throw failure;
    } catch (error) {
      lastError = error;

      // Отказ по вине запроса повторять бессмысленно: ответ будет тот же,
      // а три круга втрое увеличивают и задержку, и нагрузку на API.
      // Повторяем только сетевые сбои и ошибки сервера Telegram.
      if (error instanceof TelegramError && error.code >= 400 && error.code < 500) break;

      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Telegram ${method}: не удалось за ${retries} попыток`);
}

export interface SentMessage {
  message_id: number;
}

export function sendMessage(
  chatId: number,
  text: string,
  extra: {
    keyboard?: InlineKeyboard;
    silent?: boolean;
    replyTo?: number;
    plain?: boolean;
  } = {},
): Promise<SentMessage> {
  return call<SentMessage>('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: extra.plain ? undefined : 'MarkdownV2',
    disable_notification: extra.silent ?? false,
    link_preview_options: { is_disabled: true },
    reply_to_message_id: extra.replyTo,
    reply_markup: extra.keyboard ? { inline_keyboard: extra.keyboard } : undefined,
  });
}

/**
 * Меняет текст сообщения.
 *
 * По умолчанию, если сообщения уже нет (удалили, слишком старое), отправляет
 * новое — иначе нажатие кнопки выглядело бы как «ничего не случилось».
 * Для фоновой перерисовки закреплённого сообщения запасной вариант выключают:
 * там новое сообщение было бы спамом в группе.
 */
export async function editMessageText(
  chatId: number,
  messageId: number,
  text: string,
  keyboard?: InlineKeyboard,
  opts: { fallbackToSend?: boolean } = {},
): Promise<boolean> {
  try {
    await call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'MarkdownV2',
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    });
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    // Нажали ту же кнопку ещё раз — Telegram отвечает «message is not modified».
    // Экран уже показывает то, что нужно: это успех, а не повод слать новое
    // сообщение, иначе повторное нажатие плодило бы дубликаты в чате.
    if (/message is not modified/i.test(reason)) return true;

    if (opts.fallbackToSend === false) {
      console.warn('editMessageText не прошёл, новое сообщение слать не будем:', reason);
      return false;
    }

    console.warn('editMessageText не прошёл, отправляю новым сообщением:', reason);
    await sendMessage(chatId, text, { keyboard, silent: true });
    return false;
  }
}

/**
 * Гасит «часики» на кнопке. Это только косметика, и Telegram отклоняет запрос,
 * если нажатие устарело (холодный старт функции, старое сообщение). Поэтому
 * ошибка здесь никогда не должна прерывать саму работу по нажатию.
 */
export async function answerCallbackQuery(id: string, text?: string): Promise<void> {
  try {
    await call('answerCallbackQuery', { callback_query_id: id, text }, { retries: 1 });
  } catch (error) {
    console.warn(
      'answerCallbackQuery не прошёл:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function pinChatMessage(chatId: number, messageId: number): Promise<unknown> {
  return call('pinChatMessage', {
    chat_id: chatId,
    message_id: messageId,
    disable_notification: true,
  });
}

export function unpinChatMessage(chatId: number, messageId: number): Promise<unknown> {
  return call('unpinChatMessage', { chat_id: chatId, message_id: messageId }, { retries: 1 });
}

export interface ChatMember {
  status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';
}

/** Служебный аккаунт, от имени которого пишут анонимные админы супергрупп. */
export const GROUP_ANONYMOUS_BOT_ID = 1087968824;

export function getChatMember(chatId: number, userId: number): Promise<ChatMember> {
  return call<ChatMember>('getChatMember', { chat_id: chatId, user_id: userId }, { retries: 1 });
}

export function setWebhook(url: string): Promise<unknown> {
  return call('setWebhook', {
    url,
    secret_token: env.webhookSecret,
    // my_chat_member нужен, чтобы поймать момент добавления бота в группу
    // и сразу показать меню — иначе в группе не с чего начать.
    allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    drop_pending_updates: true,
  });
}

/**
 * Список команд бота в интерфейсе Telegram. У бота одна команда — /start,
 * остальное живёт в кнопках, поэтому меню команд должно быть коротким.
 */
export function setMyCommands(): Promise<unknown> {
  return call('setMyCommands', {
    commands: [{ command: 'start', description: 'Открыть меню расписания' }],
  });
}

const DESCRIPTION_LIMIT = 512;
const SHORT_DESCRIPTION_LIMIT = 120;

/**
 * Описание бота в его профиле и в пустом чате. Обычный текст, без разметки.
 *
 * Берётся из переменных окружения. Если переменная пуста — код ничего не
 * трогает: правка через @BotFather не должна пропадать при следующем деплое.
 *
 * Аватарку через Bot API поставить нельзя — только через @BotFather.
 */
export async function setMyDescriptions(): Promise<{ description: boolean; short: boolean }> {
  const description = env.botDescription;
  const short = env.botShortDescription;

  if (description && description.length > DESCRIPTION_LIMIT) {
    throw new Error(
      `BOT_DESCRIPTION длиннее ${DESCRIPTION_LIMIT} символов (${description.length})`,
    );
  }
  if (short && short.length > SHORT_DESCRIPTION_LIMIT) {
    throw new Error(
      `BOT_SHORT_DESCRIPTION длиннее ${SHORT_DESCRIPTION_LIMIT} символов (${short.length})`,
    );
  }

  if (description) await call('setMyDescription', { description });
  if (short) await call('setMyShortDescription', { short_description: short });

  return { description: Boolean(description), short: Boolean(short) };
}

let cachedUsername: string | null = null;

/** Имя бота — нужно для ссылки «добавить в группу». Спрашиваем один раз. */
export async function botUsername(): Promise<string> {
  if (cachedUsername) return cachedUsername;
  const me = await call<{ username: string }>('getMe', {}, { retries: 2 });
  cachedUsername = me.username;
  return cachedUsername;
}

export function getWebhookInfo(): Promise<unknown> {
  return call('getWebhookInfo', {});
}

export function deleteWebhook(): Promise<unknown> {
  return call('deleteWebhook', { drop_pending_updates: true });
}

/** Является ли пользователь админом чата (или глобальным админом бота). */
export async function isChatAdmin(chatId: number, userId: number): Promise<boolean> {
  if (userId === env.adminTelegramId) return true;
  // В личке любой пользователь — «админ» своего чата
  if (chatId === userId) return true;
  // Анонимный админ супергруппы приходит от служебного GroupAnonymousBot,
  // а от его имени может действовать только админ
  if (userId === GROUP_ANONYMOUS_BOT_ID) return true;
  try {
    const member = await getChatMember(chatId, userId);
    return member.status === 'creator' || member.status === 'administrator';
  } catch {
    return false;
  }
}

/** Покидает чат: бота добавили без разрешения — оставаться незачем. */
export function leaveChat(chatId: number): Promise<unknown> {
  return call('leaveChat', { chat_id: chatId }, { retries: 1 });
}
