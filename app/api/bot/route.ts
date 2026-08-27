/** Вебхук Telegram. Отвечает 200 всегда, чтобы Telegram не ретраил бесконечно. */
import { checkWebhookSecret } from '@/lib/auth';
import { handleUpdate, type TgUpdate } from '@/lib/bot';
import { logError } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  if (!checkWebhookSecret(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch (error) {
    await logError('Вебхук: не удалось разобрать JSON', error);
    return Response.json({ ok: true });
  }

  await handleUpdate(update);
  return Response.json({ ok: true });
}
