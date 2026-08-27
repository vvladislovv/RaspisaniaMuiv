/**
 * Логирование. Каждое событие уходит в БД и в консоль Vercel.
 * Ошибки дополнительно уходят админу в личку — молча ничего не теряем.
 */
import { writeLog } from './db';
import { sendMessage } from './telegram';
import { env } from './env';
import { esc } from './format';

export type LogKind = 'check' | 'file_changed' | 'send' | 'command' | 'error' | 'skip';

export async function log(
  kind: LogKind,
  message: string,
  extra: { chatId?: number | null; details?: unknown; durationMs?: number | null } = {},
): Promise<void> {
  console.log(`[${kind}] ${message}`, extra.details ?? '');
  try {
    await writeLog({ kind, message, ...extra });
  } catch (error) {
    console.error('Лог не записан:', error);
  }
}

/** Логирует ошибку и пытается уведомить админа. Никогда не бросает. */
export async function logError(context: string, error: unknown, details?: unknown): Promise<void> {
  const text = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  console.error(`[error] ${context}: ${text}`, stack ?? '');

  try {
    await writeLog({
      kind: 'error',
      message: `${context}: ${text}`,
      details: { stack: stack?.slice(0, 4000), ...(details as object | undefined) },
    });
  } catch (dbError) {
    console.error('Ошибка не записана в БД:', dbError);
  }

  try {
    await sendMessage(
      env.adminTelegramId,
      `⚠️ *Ошибка бота расписания*\n\n${esc(context)}\n\n\`${esc(text.slice(0, 500))}\``,
      { silent: true },
    );
  } catch (tgError) {
    console.error('Алерт админу не отправлен:', tgError);
  }
}
