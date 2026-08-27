/** Проверка секретов и прав. */
import { timingSafeEqual } from 'node:crypto';
import { env } from './env';

/** Сравнение строк без утечки информации через время выполнения. */
export function secretsEqual(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual требует одинаковой длины — сначала выравниваем через хеш-подобный приём
  if (bufA.length !== bufB.length) {
    // всё равно выполняем сравнение, чтобы время не зависело от длины
    timingSafeEqual(bufB, bufB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Проверяет секрет крона: заголовок `Authorization: Bearer …` или `?secret=`. */
export function checkCronSecret(request: Request): boolean {
  const expected = env.cronSecret;
  const header = request.headers.get('authorization');
  if (header?.startsWith('Bearer ')) {
    if (secretsEqual(header.slice(7).trim(), expected)) return true;
  }
  // Vercel Cron присылает свой заголовок с тем же секретом
  const vercelHeader = request.headers.get('x-vercel-cron-secret');
  if (secretsEqual(vercelHeader, expected)) return true;

  const url = new URL(request.url);
  return secretsEqual(url.searchParams.get('secret'), expected);
}

/** Проверяет секретный токен вебхука Telegram. */
export function checkWebhookSecret(request: Request): boolean {
  return secretsEqual(
    request.headers.get('x-telegram-bot-api-secret-token'),
    env.webhookSecret,
  );
}

/** Проверяет токен статус-страницы, если он задан. */
export function checkStatusToken(token: string | null): boolean {
  const expected = env.statusToken;
  if (!expected) return true;
  return secretsEqual(token, expected);
}
