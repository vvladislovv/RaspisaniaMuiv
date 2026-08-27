/**
 * Сквозная проверка без настоящей базы и без отправки в Telegram.
 *
 * Ходит на настоящий сайт МУИВ, скачивает файл, разбирает, пишет в подставную
 * базу (tools/fake-supabase.mjs) и проверяет, что чтение из базы даёт то же
 * расписание, что и парсер.
 *
 * Запуск:
 *   node tools/fake-supabase.mjs 54321 /tmp/e2e.json &
 *   npx tsx tools/e2e-local.mts
 */
import { checkSite } from '../lib/sync';
import { getDay, getWeek, latestFile, listGroups, recentLogs, upsertChat, setChatGroup, getChat } from '../lib/db';
import { formatDay } from '../lib/format';

const GROUP = process.env.E2E_GROUP ?? 'ИСП/П-24-11';
const CHAT_ID = Number(process.env.E2E_CHAT_ID ?? '-1');

function head(title: string) {
  console.log(`\n─── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

function ok(condition: unknown, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    return;
  }
  console.error(`  ✗ ${message}`);
  process.exitCode = 1;
}

head('Проверка сайта и запись в базу');
const started = Date.now();
const result = await checkSite();
console.log(`  файлов на сайте: ${result.filesOnSite}`);
console.log(`  изменилось: ${result.changed.length ? result.changed.join(', ') : 'нет'}`);
console.log(`  ошибок: ${result.errors.length ? result.errors.join('; ') : 'нет'}`);
console.log(`  заняло: ${((Date.now() - started) / 1000).toFixed(1)} с`);
ok(result.filesOnSite > 0, 'файлы на странице найдены');
ok(result.errors.length === 0, 'ошибок нет');

head('Актуальный файл в базе');
const file = await latestFile();
console.log(`  ${file?.title}`);
console.log(`  обновлён на сайте: ${file?.site_updated} · неделя с ${file?.week_start}`);
console.log(`  размер: ${file?.size} байт · sha256: ${file?.sha256.slice(0, 16)}…`);
ok(file?.parsed_ok === true, 'файл разобран без ошибок');
ok(!!file?.week_start, 'начало недели определено');

head('Список групп для кнопок');
const groups = await listGroups();
const sheets = [...new Set(groups.map((g) => g.sheet))];
console.log(`  групп: ${groups.length}, курсов (листов): ${sheets.length}`);
console.log(`  курсы: ${sheets.join(' | ')}`);
ok(groups.length > 50, 'групп больше пятидесяти');
ok(groups.some((g) => g.group === GROUP), `группа ${GROUP} есть в списке`);

head(`Неделя группы ${GROUP} из базы`);
const week = await getWeek(GROUP, '2026-08-31');
ok(week.days.length > 0, 'дни в базе есть');
for (const day of week.days) {
  const pairs = day.lessons.map((l) => l.pair).join(',');
  console.log(`  ${day.date} ${day.name.padEnd(12)} пар: ${day.lessons.length} (${pairs})`);
  ok(
    day.lessons.every((l) => l.subject && !/^\d+$/.test(l.subject)),
    `${day.date}: все предметы осмысленные`,
  );
}

head('Готовое сообщение (как увидит группа)');
const target = week.days.find((d) => d.lessons.length > 0);
if (target) {
  const text = formatDay(target, {
    group: GROUP,
    siteUpdated: file?.site_updated ?? null,
    heading: 'Расписание на завтра',
  });
  console.log(
    text
      .split('\n')
      .map((line) => '  | ' + line.replace(/\\(.)/g, '$1').replace(/[*_]/g, ''))
      .join('\n'),
  );
  ok(text.length < 4096, `длина сообщения ${text.length} в лимите Telegram`);
} else {
  ok(false, 'не нашлось дня с парами');
}

head('Привязка чата к группе');
if (CHAT_ID !== -1) {
  await upsertChat(CHAT_ID, 'Проверочный чат');
  await setChatGroup(CHAT_ID, GROUP);
  const chat = await getChat(CHAT_ID);
  console.log(`  чат ${CHAT_ID} -> ${chat?.group_name}`);
  ok(chat?.group_name === GROUP, 'группа сохранилась в базе');
  ok(chat?.enabled === true, 'чат включён');
} else {
  console.log('  пропущено: не задан E2E_CHAT_ID');
}

head('Выбор недели, когда на сайте лежит несколько файлов');
const weekStarts = [
  ...new Set(
    (await Promise.all(
      week.days.map(async (d) => (await getWeek(GROUP, d.date)).file?.week_start ?? null),
    )).filter(Boolean),
  ),
];
console.log(`  недели в базе: ${weekStarts.join(', ')}`);
for (const day of week.days) {
  const picked = await getWeek(GROUP, day.date);
  const inside = picked.days.some((d) => d.date === day.date);
  ok(inside, `${day.date}: показывается неделя, содержащая эту дату`);
}
const lastDay = week.days.at(-1)!.date;
const afterWeek = await getWeek(GROUP, lastDay);
ok(
  afterWeek.days.some((d) => d.date === lastDay),
  'в последний учебный день неделя ещё текущая, а не следующая',
);

head('Поиск дня, которого нет в файле');
const missing = await getDay(GROUP, '2030-01-01');
ok(missing === null, 'на отсутствующую дату возвращается null, а не ошибка');

head('Журнал');
const logs = await recentLogs(10);
for (const row of logs.slice(0, 6)) console.log(`  ${row.ts} [${row.kind}] ${row.message}`);
ok(logs.some((l) => l.kind === 'check'), 'проверка записана в журнал');
ok(!logs.some((l) => l.kind === 'error'), 'ошибок в журнале нет');

console.log(
  process.exitCode ? '\nЕСТЬ ПРОВАЛИВШИЕСЯ ПРОВЕРКИ\n' : '\nВсе проверки прошли\n',
);
