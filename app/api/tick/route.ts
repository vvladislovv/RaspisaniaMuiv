/** Часовой тик: вызывается внешним кроном (cron-job.org) и Vercel Cron. */
import { checkCronSecret } from '@/lib/auth';
import { tick } from '@/lib/sync';
import { logError } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function run(request: Request): Promise<Response> {
  if (!checkCronSecret(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const force = new URL(request.url).searchParams.get('force') === '1';

  try {
    const result = await tick(force);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    await logError('Часовой тик', error);
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export const GET = run;
export const POST = run;
