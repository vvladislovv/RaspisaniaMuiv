/**
 * Регистрация вебхука Telegram. Вызывается вручную один раз после деплоя:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://<домен>/api/setup
 */
import { checkCronSecret } from '@/lib/auth';
import { deleteWebhook, getWebhookInfo, setWebhook } from '@/lib/telegram';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  if (!checkCronSecret(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action') ?? 'set';

  if (action === 'info') {
    return Response.json({ ok: true, info: await getWebhookInfo() });
  }

  if (action === 'delete') {
    await deleteWebhook();
    return Response.json({ ok: true, deleted: true });
  }

  // Вебхук должен смотреть на стабильный домен, а не на адрес конкретного
  // деплоя: иначе после следующего деплоя бот продолжит отвечать старым кодом.
  // Поэтому берём адрес, по которому вызвали setup, а VERCEL_URL не используем.
  const base = process.env.PUBLIC_BASE_URL?.trim() || `${url.protocol}//${url.host}`;
  const webhookUrl = `${base.replace(/\/$/, '')}/api/bot`;
  await setWebhook(webhookUrl);

  return Response.json({ ok: true, webhook: webhookUrl, info: await getWebhookInfo() });
}
