/**
 * Замер задержек изнутри функции: сколько стоит поход в базу и в Telegram.
 * Нужен, чтобы оптимизировать по числам, а не по догадкам. Закрыт CRON_SECRET.
 */
import { checkCronSecret } from '@/lib/auth';
import { db, getChat, weekStarts, getWeek, listGroups, allChats, currentGroups } from '@/lib/db';
import { dayScreen, weekScreen } from '@/lib/bot';
import { mskDateOffset } from '@/lib/time';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function timed<T>(name: string, fn: () => Promise<T>): Promise<[string, number]> {
  const started = Date.now();
  try {
    await fn();
  } catch {
    // Для замера важна длительность, а не результат
  }
  return [name, Date.now() - started];
}

export async function GET(request: Request): Promise<Response> {
  if (!checkCronSecret(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);

  // Рендер экранов на живых данных: так видно, что делает боевой код,
  // и при этом в Telegram ничего не уходит
  if (url.searchParams.get('screens') === '1') {
    const chats = await allChats();
    const tomorrow = mskDateOffset(1);

    const rendered = await Promise.all(
      chats
        .filter((chat) => (chat.groups ?? []).length > 0)
        .map(async (chat) => {
          const resolved = await currentGroups(chat.chat_id, chat.groups);
          const day = await dayScreen(chat.chat_id, chat.groups, tomorrow, 'Расписание на завтра');
          const week = await weekScreen(chat.chat_id, chat.groups, tomorrow);
          return {
            chat: chat.title ?? `личка ${chat.chat_id}`,
            topic: chat.topic_id ? (chat.topic_name ?? `#${chat.topic_id}`) : null,
            stored: chat.groups,
            resolved: resolved.groups,
            missing: resolved.missing,
            dayText: day.text,
            dayButtons: day.keyboard.flat().map((b) => b.text),
            weekButtons: week.keyboard.flat().map((b) => b.text),
            weekLength: week.chunks[0]?.length ?? 0,
          };
        }),
    );

    return Response.json({ tomorrow, chats: rendered });
  }

  const group = url.searchParams.get('group') ?? 'ИСП/п 24-11';
  const chatId = env.adminTelegramId;

  const sequential = Object.fromEntries(
    await Promise.all([]).then(async () => [
      await timed('supabase.getChat', () => getChat(chatId)),
      await timed('supabase.rpc', async () => {
        await db().rpc('increment_rate_limit', {
          p_chat_id: -1,
          p_window: new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString(),
        });
      }),
      await timed('supabase.weekStarts', () => weekStarts()),
      await timed('supabase.getWeek', () => getWeek(group, '2026-09-01')),
      await timed('supabase.listGroups', () => listGroups()),
      await timed('telegram.getMe', () =>
        fetch(`https://api.telegram.org/bot${env.botToken}/getMe`).then((r) => r.json()),
      ),
    ]),
  );

  const parallelStarted = Date.now();
  await Promise.all([getChat(chatId), weekStarts(), getWeek(group, '2026-09-01')]);
  const parallelMs = Date.now() - parallelStarted;

  return Response.json({
    region: process.env.VERCEL_REGION ?? null,
    sequentialMs: sequential,
    threeQueriesInParallelMs: parallelMs,
  });
}
