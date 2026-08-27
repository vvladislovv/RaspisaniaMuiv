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

async function call<T>(method: string, body: unknown, opts: CallOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${env.botToken}/${method}`, {
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

export function editMessageText(
  chatId: number,
  messageId: number,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<unknown> {
  return call('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'MarkdownV2',
    link_preview_options: { is_disabled: true },
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
  });
}

export function answerCallbackQuery(id: string, text?: string): Promise<unknown> {
  return call('answerCallbackQuery', { callback_query_id: id, text }, { retries: 1 });
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

export function getChatMember(chatId: number, userId: number): Promise<ChatMember> {
  return call<ChatMember>('getChatMember', { chat_id: chatId, user_id: userId }, { retries: 1 });
}

export function setWebhook(url: string): Promise<unknown> {
  return call('setWebhook', {
    url,
    secret_token: env.webhookSecret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
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
  try {
    const member = await getChatMember(chatId, userId);
    return member.status === 'creator' || member.status === 'administrator';
  } catch {
    return false;
  }
}
