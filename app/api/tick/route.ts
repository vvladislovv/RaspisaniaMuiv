/** Часовой тик: вызывается внешним кроном (cron-job.org) и Vercel Cron. */
import { checkCronSecret } from '@/lib/auth';
import { tick, noteFileFailure, noteFileOk, refreshPinned } from '@/lib/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TICK_STREAK_KEY = 'Часовой тик';

async function run(request: Request): Promise<Response> {
  if (!checkCronSecret(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);

  // Перерисовывает уже закреплённые сообщения текущим кодом форматирования,
  // не трогая сайт. Обычный тик правит закреп только когда сайт сам что-то
  // изменил (см. tick() в lib/sync.ts) — этот путь нужен, когда меняется
  // только код показа (например, дописали «ГК» к номеру аудитории), а
  // расписание на сайте то же самое, и ждать естественного повода нет смысла.
  if (url.searchParams.get('refreshPinned') === '1') {
    const updated = await refreshPinned();
    return Response.json({ ok: true, refreshedPinned: updated });
  }

  const force = url.searchParams.get('force') === '1';

  try {
    const result = await tick(force);
    // Тик целиком прошёл — если до этого была серия сбоев (например, Supabase
    // временно недоступна), она кончилась
    await noteFileOk(TICK_STREAK_KEY);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    // Разовый Gateway Timeout от Supabase — обычная сетевая погода, а не
    // повод будить владельца: следующий тик через час чаще всего проходит
    // сам. Та же терпимость, что и для отдельного файла/проверки сайта
    // (см. shouldAlertOnStreak в lib/sync.ts) — первый промах молчит,
    // со второго подряд приходит алерт.
    await noteFileFailure(TICK_STREAK_KEY, error);
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export const GET = run;
export const POST = run;
