/** Тонкая обёртка над Bot API: только то, что нужно боту. */
import { env } from './env';

export interface InlineButton {
  text: string;
  callback_data: string;
}

export type InlineKeyboard = InlineButton[][];

interface CallOptions {
  /** Сколько раз повторить при сетевой ошибке или 5xx. */
  retries?: number;
}

const TIMEOUT_MS = 12_000;

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

      const json = (await res.json()) as { ok: boolean; result?: T; description?: string; error_code?: number };

      if (json.ok) return json.result as T;

      // 4xx — повторять бессмысленно, кроме 429
      if (json.error_code === 429) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      throw new Error(`Telegram ${method}: ${json.description ?? 'неизвестная ошибка'}`);
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Telegram ${method}: сбой`);
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
 * Меняет текст сообщения, а если сообщения уже нет (удалили, слишком старое) —
 * отправляет новое. Иначе нажатие кнопки выглядело бы как «ничего не случилось».
 */
export async function editMessageText(
  chatId: number,
  messageId: number,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  try {
    await call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'MarkdownV2',
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn('editMessageText не прошёл, отправляю новым сообщением:', reason);
    await sendMessage(chatId, text, { keyboard, silent: true });
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
