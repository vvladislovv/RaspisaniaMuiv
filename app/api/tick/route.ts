/** Часовой тик: вызывается внешним кроном (cron-job.org) и Vercel Cron. */
import { checkCronSecret } from '@/lib/auth';
import { tick, noteFileFailure, noteFileOk } from '@/lib/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TICK_STREAK_KEY = 'Часовой тик';

async function run(request: Request): Promise<Response> {
  if (!checkCronSecret(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const force = new URL(request.url).searchParams.get('force') === '1';

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
