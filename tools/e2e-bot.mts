/**
 * Проверка поведения бота: /start, кнопки, права, ограничения, отказы Bot API.
 * Работает на подставной базе и дублёре Telegram — наружу уходит только
 * запрос к сайту МУИВ, чтобы наполнить базу настоящим расписанием.
 *
 * Запуск:
 *   node tools/fake-supabase.mjs 54321 /tmp/e2e.json &
 *   FAKE_TG_ADMINS=111,333 node tools/fake-telegram.mjs 54322 /tmp/tg.json &
 *   npx tsx tools/e2e-bot.mts
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleUpdate, type TgUpdate } from '../lib/bot';
import { refreshPinned, tick } from '../lib/sync';
import {
  getChat,
  groupFileName,
  listGroups,
  replaceSchedules,
  setPinnedMessage,
  upsertChat,
  upsertFile,
} from '../lib/db';
import { parseSchedule } from '../lib/parse';
import { weekBounds } from '../lib/sweep';
import { dayNameOf, mskDateOffset, weekAnchor } from '../lib/time';
import { esc, humanDate } from '../lib/format';

const LOG = process.env.FAKE_TG_LOG ?? '/tmp/tg.json';
const CHAT = -100777000;
/** Владелец бота: только он может подключить новый чат. */
const OWNER = Number(process.env.ADMIN_TELEGRAM_ID ?? '111');
/** Админ группы, но не владелец бота. */
const GROUP_ADMIN = 333;
/** Обычный участник. */
const STRANGER = 222;

let failures = 0;

function ok(condition: unknown, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

function head(title: string) {
  console.log(`\n─── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

interface Button {
  text: string;
  callback_data: string;
  url?: string;
}

interface Call {
  method: string;
  body: Record<string, unknown>;
  /** Дублёр отметил вызов как отклонённый. */
  failed?: boolean;
}

function calls(): Call[] {
  try {
    return JSON.parse(readFileSync(LOG, 'utf8')) as Call[];
  } catch {
    return [];
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mark = (): number => calls().length;
const since = (from: number): Call[] => calls().slice(from);
const sent = (list: Call[]) => list.filter((c) => c.method === 'sendMessage');
const edited = (list: Call[]) => list.filter((c) => c.method === 'editMessageText');
const texts = (list: Call[]) => [...sent(list), ...edited(list)].map((c) => String(c.body.text));

/** Кнопки из последнего успешного сообщения или правки. */
function keyboardOf(list: Call[]): Button[] {
  const last = [...sent(list), ...edited(list)].filter((c) => !c.failed).at(-1);
  const markup = last?.body.reply_markup as { inline_keyboard: Button[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat();
}

function find(buttons: Button[], fragment: string): Button | undefined {
  return buttons.find((b) => b.text.includes(fragment));
}

function message(
  text: string,
  from = OWNER,
  chatId = CHAT,
  type: 'supergroup' | 'private' = 'supergroup',
): TgUpdate {
  return {
    message: {
      message_id: Math.floor(Math.random() * 100000),
      from: { id: from, username: `user${from}`, first_name: `Имя${from}` },
      chat:
        type === 'private'
          ? { id: chatId, type: 'private' }
          : { id: chatId, type: 'supergroup', title: 'Тестовая группа' },
      text,
    },
  };
}

/** Сообщение внутри темы форума. */
function forumMessage(
  text: string,
  from: number,
  chatId: number,
  threadId: number | null,
  topicName?: string,
): TgUpdate {
  const base = message(text, from, chatId);
  base.message!.chat.is_forum = true;
  if (threadId !== null) {
    base.message!.message_thread_id = threadId;
    base.message!.is_topic_message = true;
    if (topicName) base.message!.reply_to_message = { forum_topic_created: { name: topicName } };
  }
  return base;
}

/** Нажатие кнопки под сообщением, которое лежит в теме форума. */
function forumButton(
  data: string,
  from: number,
  chatId: number,
  threadId: number | null,
): TgUpdate {
  const base = button(data, from, chatId);
  base.callback_query!.message!.chat.is_forum = true;
  if (threadId !== null) {
    base.callback_query!.message!.message_thread_id = threadId;
    base.callback_query!.message!.is_topic_message = true;
  }
  return base;
}

/** Событие «бота добавили в чат» или «убрали из чата». */
function membership(status: string, from = OWNER, chatId = CHAT, type = 'supergroup'): TgUpdate {
  return {
    my_chat_member: {
      chat: { id: chatId, type, title: 'Тестовая группа' },
      from: { id: from },
      new_chat_member: { status },
    },
  };
}

/** Служебное сообщение: обычная группа превратилась в супергруппу. */
function migration(oldId: number, newId: number): TgUpdate {
  return {
    message: {
      message_id: Math.floor(Math.random() * 100000),
      chat: { id: oldId, type: 'group', title: 'Тестовая группа' },
      migrate_to_chat_id: newId,
    },
  };
}

function button(data: string, from = OWNER, chatId = CHAT): TgUpdate {
  return {
    callback_query: {
      id: String(Math.floor(Math.random() * 100000)),
      from: { id: from },
      data,
      message: {
        message_id: 500,
        chat: { id: chatId, type: 'supergroup', title: 'Тестовая группа' },
      },
    },
  };
}

/** Нажатие в личке: там чата в базе может и не быть. */
function privateButton(data: string, from: number): TgUpdate {
  const base = button(data, from, from);
  base.callback_query!.message!.chat = { id: from, type: 'private' };
  return base;
}

/** Чистит заявки: доступ выдаётся заново в каждом прогоне. */
async function resetAccess(): Promise<void> {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/access?user_id=neq.0`, {
    method: 'DELETE',
    headers: { apikey: 'fake', Authorization: 'Bearer fake' },
  });
}

/**
 * Убирает следы прошлого прогона. Чистим все чаты, а не только основной:
 * тест по ходу подключает несколько, и остатки ломали повторный запуск.
 */
async function resetChat(): Promise<void> {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/chats?chat_id=neq.0`, {
    method: 'DELETE',
    headers: { apikey: 'fake', Authorization: 'Bearer fake' },
  });
}

/** Чистит баги и предложения между прогонами. */
async function resetFeedback(): Promise<void> {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/feedback?id=gte.0`, {
    method: 'DELETE',
    headers: { apikey: 'fake', Authorization: 'Bearer fake' },
  });
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/app_state?key=like.fb:*`, {
    method: 'DELETE',
    headers: { apikey: 'fake', Authorization: 'Bearer fake' },
  });
}

/** Сколько ошибок записано в журнал за всё время прогона. */
async function errorLogs(): Promise<number> {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/logs?kind=eq.error&select=id`, {
    headers: { apikey: 'fake', Authorization: 'Bearer fake' },
  });
  return ((await res.json()) as unknown[]).length;
}

/** Обнуляет счётчик обращений к базе. */
async function resetDbHits(): Promise<void> {
  await fetch(`${process.env.SUPABASE_URL}/__stats`, { method: 'POST' });
}

/** Сколько раз за это время дёрнули таблицу. */
async function dbHits(table: string): Promise<number> {
  const res = await fetch(`${process.env.SUPABASE_URL}/__stats`);
  const stats = (await res.json()) as Record<string, number>;
  return stats[table] ?? 0;
}

/** Обнуляет счётчик частоты — иначе тест сам упирается в собственный лимит. */
async function resetRateLimit(): Promise<void> {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/rate_limit?count=gte.0`, {
    method: 'DELETE',
    headers: { apikey: 'fake', Authorization: 'Bearer fake' },
  });
}

/**
 * Забывает скачанные файлы — следующая проверка сочтёт расписание изменившимся.
 * Дни удаляются вместе с файлами, как это делает `on delete cascade` в базе.
 */
async function forgetFiles(): Promise<void> {
  for (const table of ['files', 'schedules']) {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?id=gte.0`, {
      method: 'DELETE',
      headers: { apikey: 'fake', Authorization: 'Bearer fake' },
    });
  }
}

/** Забывает отметки о разосланных алертах — иначе повтор прогона их подавит. */
async function resetAlerts(): Promise<void> {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/app_state?key=like.alert:*`, {
    method: 'DELETE',
    headers: { apikey: 'fake', Authorization: 'Bearer fake' },
  });
}

/** Заставляет дублёр базы отдать несколько сбоев шлюза подряд. */
async function flakyDb(count: number, match = ''): Promise<void> {
  await fetch(`${process.env.SUPABASE_URL}/__flaky`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count, match, status: 504 }),
  });
}

/** Заставляет дублёр Telegram отклонять указанные методы. */
async function failMethods(methods: string[]): Promise<void> {
  await fetch(`${process.env.TELEGRAM_API_BASE}/bot/__fail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ methods }),
  });
}

/** Помечает чаты как недоступные: дублёр отвечает по ним 403. */
async function goneChats(chats: number[]): Promise<void> {
  await fetch(`${process.env.TELEGRAM_API_BASE}/bot/__gone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chats }),
  });
}

/** Помечает темы как удалённые: отправка в них получает 400. */
async function goneTopics(topics: number[]): Promise<void> {
  await fetch(`${process.env.TELEGRAM_API_BASE}/bot/__gone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topics }),
  });
}

/**
 * Кладёт текущую неделю каждой группе — как это сделал бы обход сайта:
 * своя запись в `files` на группу и Пн–Сб в `schedules`. Пары на
 * понедельник–пятницу, суббота пустая.
 */
async function seedCatalogWeeks(names: string[]): Promise<number> {
  const { monday } = weekBounds(weekAnchor());
  for (const group of names) {
    const days = Array.from({ length: 6 }, (_, i) => {
      const date = new Date(`${monday}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + i);
      const iso = date.toISOString().slice(0, 10);
      const lessons =
        i < 5
          ? [
              { pair: 1, time: '08:20-09:50', subject: `Пара 1 у ${group}`, teacher: 'Иванов Иван Иванович', room: '503', raw: '' },
              { pair: 2, time: '10:00-11:30', subject: `Пара 2 у ${group}`, teacher: null, room: 'Д', raw: '' },
            ]
          : [];
      return { date: iso, name: dayNameOf(iso), lessons };
    });
    const row = await upsertFile({
      name: groupFileName(group),
      url: `https://www.muiv.ru/studentu/spo/raspisanie/#group=${encodeURIComponent(group)}`,
      title: group,
      sha256: createHash('sha256').update(JSON.stringify(days)).digest('hex'),
      size: JSON.stringify(days).length,
      siteUpdated: null,
      weekStart: monday,
      parsedOk: true,
      parseError: null,
    });
    await replaceSchedules(row.id, { weekStart: monday, groups: [{ group, sheet: '', days }] });
  }
  return names.length;
}

/**
 * Наполняет базу из локального файла-фикстуры. Нужен, когда сайт МУИВ
 * недоступен: проверки поведения бота не должны зависеть от чужого сервера.
 */
async function seedFromFixture(marker = ''): Promise<boolean> {
  const fixture = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'tests',
    'fixtures',
    'week1.xlsx',
  );
  if (!existsSync(fixture)) return false;

  const buf = readFileSync(fixture);
  const workbook = parseSchedule(buf);
  const row = await upsertFile({
    name: 'week1.xlsx',
    url: 'https://www.muiv.ru/upload/fixture/week1.xlsx',
    title: 'Расписание из фикстуры',
    // marker меняет хеш — так изображается «файл на сайте поменялся»
    sha256: createHash('sha256').update(buf).update(marker).digest('hex'),
    size: buf.byteLength,
    siteUpdated: '25.08.2026',
    weekStart: workbook.weekStart,
    parsedOk: true,
    parseError: null,
  });
  await replaceSchedules(row.id, workbook);
  return true;
}

// ─── Наполняем базу расписанием ──────────────────────────────────────────────

head('Подготовка: загрузка расписания');
await resetChat();
await resetRateLimit();
await resetAlerts();
await resetAccess();
const first = await tick(false);
const siteReachable = first.check !== null && first.check.errors.length === 0;

if (siteReachable) {
  ok(true, 'сайт проверен без ошибок');
} else {
  console.log(`  ⚠ сайт недоступен (${first.check?.errors[0] ?? '—'}), беру локальный файл`);
  ok(await seedFromFixture(), 'база наполнена из фикстуры');
}

const groups = await listGroups();
ok(groups.length > 50, `в базе ${groups.length} групп`);

// Без сайта неделю групп каталога кладём сами — так, как это делает обход.
// Последнюю группу оставляем пустой: на ней проверяется «ещё не загружено»
const UNLOADED = groups[groups.length - 1].group;
if (!siteReachable) {
  const seeded = await seedCatalogWeeks(groups.map((g) => g.group).filter((g) => g !== UNLOADED));
  ok(seeded === groups.length - 1, `у групп каталога есть текущая неделя: ${seeded}`);
}

// ─── Список разрешённых чатов ────────────────────────────────────────────────

head('Доступ только по заявке');
let m = mark();
await handleUpdate(message('/start', STRANGER, STRANGER, 'private'));
let first_ = since(m);
ok(
  texts(first_).join('').includes('Заявка на доступ отправлена'),
  'посторонний получает ответ про заявку',
);
const accessButtons = keyboardOf(sent(first_).filter((c) => c.body.chat_id === STRANGER));
ok(
  accessButtons.length === 1 && accessButtons[0].text.includes('Баг или идея'),
  'кроме «баг или идея» кнопок ему не дают',
);
ok(
  sent(first_).some(
    (c) => c.body.chat_id === OWNER && String(c.body.text).includes('Новая заявка'),
  ),
  'владельцу пришло уведомление о заявке',
);
ok(
  keyboardOf(
    sent(first_).filter((c) => c.body.chat_id === OWNER),
  ).some((b) => b.callback_data?.startsWith('ok:')),
  'в уведомлении есть кнопка разрешить',
);

// Повторное обращение не должно плодить уведомления
await resetRateLimit();
m = mark();
await handleUpdate(message('/start', STRANGER, STRANGER, 'private'));
ok(
  !sent(since(m)).some((c) => c.body.chat_id === OWNER),
  'повторная заявка владельца не дёргает',
);

// Два одновременных /start не должны дать два уведомления
await resetAccess();
await resetRateLimit();
m = mark();
await Promise.all([
  handleUpdate(message('/start', STRANGER, STRANGER, 'private')),
  handleUpdate(message('/start', STRANGER, STRANGER, 'private')),
]);
ok(
  sent(since(m)).filter((c) => c.body.chat_id === OWNER).length === 1,
  `два одновременных обращения дали одно уведомление: ${sent(since(m)).filter((c) => c.body.chat_id === OWNER).length}`,
);

// Имя и юзернейм не должны повторяться в тексте заявки
const notice = sent(since(m)).find((c) => c.body.chat_id === OWNER)!;
const noticeText = String(notice.body.text);
ok(
  (noticeText.match(/user222/g) ?? []).length <= 1,
  'в заявке нет повторяющегося имени',
);
ok(noticeText.includes(String(STRANGER)), 'в заявке есть id');

head('Добавление в группу без доступа');
m = mark();
await handleUpdate(membership('member', STRANGER, -991));
const denied_ = since(m);
ok(
  texts(denied_).join('').includes('Доступ не открыт'),
  'бот объясняет, почему не работает',
);
ok(denied_.some((c) => c.method === 'leaveChat'), 'и покидает чат');
ok((await getChat(-991)) === null, 'чат в базе не создан');

head('Апдейт из чата, откуда бота уже выгнали');
await resetAlerts();
await resetRateLimit();
{
  const GONE = -992;
  await goneChats([GONE]);
  m = mark();
  // Так выглядит добавление по ссылке «➕ Добавить в группу»: Telegram шлёт
  // сразу два апдейта — «бота добавили» и /start. Первый выгоняет бота из
  // чужого чата, второй неизбежно упирается в 403. Это не поломка.
  await handleUpdate(message('/start@fake_bot true', STRANGER, GONE));
  const raced = since(m);
  ok(
    raced.some((c) => c.method === 'sendMessage' && c.body.chat_id === GONE && c.failed),
    'ответ в недоступный чат ожидаемо отклонён',
  );
  ok(
    sent(raced).every((c) => c.body.chat_id !== OWNER),
    'но владельцу алерт об этом не уходит',
  );
  await goneChats([]);
}

head('Владелец одобряет заявку');
await resetRateLimit();
m = mark();
await handleUpdate(button(`ok:${STRANGER}`, OWNER, OWNER));
const approved_ = since(m);
ok(
  sent(approved_).some(
    (c) => c.body.chat_id === STRANGER && String(c.body.text).includes('Доступ открыт'),
  ),
  'человек узнаёт об одобрении сам',
);
ok(
  keyboardOf(sent(approved_).filter((c) => c.body.chat_id === STRANGER)).some((b) =>
    String(b.url ?? '').includes('startgroup'),
  ),
  'и сразу получает кнопку добавить в группу',
);

// Посторонний не может решать заявки
m = mark();
await handleUpdate(button(`ok:${GROUP_ADMIN}`, STRANGER, STRANGER));
ok(
  String(since(m).findLast((c) => c.method === 'answerCallbackQuery')?.body.text ?? '').includes(
    'Недоступно',
  ),
  'решать заявки может только владелец',
);

head('Бот уже в группе, а чата в базе нет');
await resetRateLimit();
{
  const ORPHAN = -993;
  // Посторонний должен получить объяснение, а не молчание
  m = mark();
  await handleUpdate(message('/start', GROUP_ADMIN, ORPHAN));
  ok(
    texts(since(m)).join('').includes('Доступ не открыт'),
    'без доступа бот объясняет причину, а не молчит',
  );
  ok((await getChat(ORPHAN)) === null, 'чат при этом не подключается');

  // Одобренный подключает чат командой, без повторного добавления бота
  m = mark();
  await handleUpdate(message('/start', OWNER, ORPHAN));
  ok((await getChat(ORPHAN))?.enabled === true, 'одобренный подключает чат через /start');
  ok(
    texts(since(m)).join('').includes('Расписание колледжа МУИВ'),
    'и сразу видит меню',
  );
}

head('Одобренный подключает группу');
await resetRateLimit();
m = mark();
await handleUpdate(membership('member', STRANGER, -992));
ok(sent(since(m)).length === 1, 'меню появляется само');
ok(!since(m).some((c) => c.method === 'leaveChat'), 'из чата не уходит');
ok((await getChat(-992))?.enabled === true, 'чат подключён');

// ─── Добавление в группу ─────────────────────────────────────────────────────

head('Бота добавили в группу');
m = mark();
await handleUpdate(membership('member', OWNER));
let added = since(m);
ok(sent(added).length === 1, 'меню появляется само, без команд');
ok(texts(added).join('').includes('Расписание колледжа МУИВ'), 'это меню');
ok(texts(added).join('').includes('Закрепление сообщений'), 'напоминание про право закрепления');
ok(keyboardOf(added).length > 0, 'под меню есть кнопки');
ok((await getChat(CHAT))?.enabled === true, 'чат подключён и включён');

// В личке напоминание про закрепление не нужно
await resetChat();
m = mark();
await handleUpdate(membership('member', OWNER, OWNER, 'private'));
ok(
  !texts(since(m)).join('').includes('дай мне право'),
  'в личке напоминания про закрепление нет',
);

// Бота выгнали — автоотправка должна выключиться
await resetChat();
await handleUpdate(membership('member', OWNER));
m = mark();
await handleUpdate(membership('kicked', OWNER));
ok((await getChat(CHAT))?.enabled === false, 'после удаления бота автоотправка выключена');
ok(sent(since(m)).length === 0, 'при удалении бот ничего не пишет');

// Бота вернули — автоотправка должна ожить, иначе расписание молча пропадёт
m = mark();
await handleUpdate(membership('member', OWNER));
ok((await getChat(CHAT))?.enabled === true, 'после возвращения бота автоотправка включена');
ok(sent(since(m)).length === 1, 'при возвращении снова показывается меню');

// Возвращаем чат в рабочее состояние для остальных проверок
await resetChat();
await resetRateLimit();
await handleUpdate(membership('member', OWNER));

// ─── Переезд группы в супергруппу ────────────────────────────────────────────

head('Группа превратилась в супергруппу');
const OLD_ID = -400111;
const NEW_ID = -1004001110000;
await handleUpdate(membership('member', OWNER, OLD_ID, 'group'));
await handleUpdate(button('grp', OWNER, OLD_ID));
{
  const before = await getChat(OLD_ID);
  ok(before?.enabled === true, 'старая группа подключена');

  m = mark();
  await handleUpdate(migration(OLD_ID, NEW_ID));
  ok(sent(since(m)).length === 0, 'при переезде бот не пишет лишнего');

  const moved = await getChat(NEW_ID);
  ok(moved?.enabled === true, 'настройки переехали на новый id');
  ok((await getChat(OLD_ID)) === null, 'старая запись удалена');

  // После переезда кнопки должны работать по новому id
  await resetRateLimit();
  m = mark();
  await handleUpdate(button('m', OWNER, NEW_ID));
  ok(edited(since(m)).length === 1, 'кнопки работают в переехавшей группе');
}

// ─── Команд больше нет ───────────────────────────────────────────────────────

await resetRateLimit();
head('Из команд остался только /start');
for (const command of ['/tomorrow', '/today', '/week', '/group', '/status', '/help', '/enable']) {
  m = mark();
  await handleUpdate(message(command, OWNER));
  ok(sent(since(m)).length === 0, `${command} игнорируется`);
}

m = mark();
await handleUpdate(message('просто текст', OWNER));
ok(sent(since(m)).length === 0, 'обычный текст игнорируется');

// ─── /start открывает меню ───────────────────────────────────────────────────

await resetRateLimit();
head('/start открывает меню');
m = mark();
await handleUpdate(message('/start', OWNER));
const menu = since(m);
ok(sent(menu).length === 1, 'меню пришло одним сообщением');
ok(texts(menu).join('').includes('Расписание колледжа МУИВ'), 'в меню есть заголовок');

let buttons = keyboardOf(menu);
ok(!!find(buttons, 'Выбрать группу'), 'без группы предлагается её выбрать');
ok(!find(buttons, 'Завтра'), 'без группы расписание не предлагается');
ok((await getChat(CHAT))?.enabled === true, 'чат включён');

// Обычный участник в подключённом чате тоже должен видеть меню
m = mark();
await handleUpdate(message('/start', STRANGER));
ok(sent(since(m)).length === 1, 'участник подключённого чата получает меню');

// ─── Выбор группы кнопками ───────────────────────────────────────────────────

await resetRateLimit();
head('Выбор группы кнопками');
m = mark();
await handleUpdate(button('grp'));
buttons = keyboardOf(since(m));
ok(
  buttons.filter((b) => b.callback_data.startsWith('s:')).length >= 4,
  `предложено курсов: ${buttons.filter((b) => b.callback_data.startsWith('s:')).length}`,
);
ok(!!find(buttons, 'Меню'), 'с экрана курсов есть путь назад');

// Названия групп колледж меняет между файлами, поэтому берём любой курс,
// где групп хватает на проверку лимита в две штуки
const target = groups.find(
  (g) => groups.filter((x) => x.sheet === g.sheet).length >= 3,
)!;
const sheets = [...new Set(groups.map((g) => g.sheet))].sort((a, b) =>
  String(a).localeCompare(String(b), 'ru'),
);
const sheetIndex = sheets.indexOf(target.sheet);
ok(!!target, `взят курс с запасом групп: ${target?.sheet}`);
ok(sheetIndex !== -1, 'курс найден в списке');

m = mark();
await handleUpdate(button(`s:${sheetIndex}`));
buttons = keyboardOf(since(m));
const groupButton = buttons.find((b) => b.callback_data.startsWith('g:'));
ok(!!groupButton, 'в списке есть кнопки групп');

m = mark();
await handleUpdate(button(groupButton!.callback_data, STRANGER));
ok(
  String(since(m).findLast((c) => c.method === 'answerCallbackQuery')?.body.text ?? '').includes(
    'админ',
  ),
  'посторонний не может менять группы',
);
ok(((await getChat(CHAT))?.groups ?? []).length === 0, 'группы в базе не изменились');

m = mark();
await handleUpdate(button(groupButton!.callback_data, GROUP_ADMIN));
ok(((await getChat(CHAT))?.groups ?? []).length === 1, 'админ группы выбрал первую группу');
ok(edited(since(m)).length === 1, 'список остаётся открытым для второй группы');
buttons = keyboardOf(since(m));
ok(!!find(buttons, '✓ '), 'выбранная группа помечена галочкой');
ok(!!find(buttons, 'Готово'), 'появилась кнопка «Готово»');

// ─── Вторая группа ───────────────────────────────────────────────────────────

head('Выбор второй группы');
const second2 = buttons.find((b) => b.callback_data.startsWith('g:') && !b.text.startsWith('✓'))!;
m = mark();
await handleUpdate(button(second2.callback_data, GROUP_ADMIN));
let chosen = (await getChat(CHAT))?.groups ?? [];
ok(chosen.length === 2, `выбрано две группы: ${chosen.join(', ')}`);

// Третья не должна влезть
const third3 = keyboardOf(since(m)).find(
  (b) => b.callback_data.startsWith('g:') && !b.text.startsWith('✓'),
)!;
m = mark();
await handleUpdate(button(third3.callback_data, GROUP_ADMIN));
ok(
  String(since(m).findLast((c) => c.method === 'answerCallbackQuery')?.body.text ?? '').includes(
    'нельзя',
  ),
  'третью группу добавить нельзя',
);
ok(((await getChat(CHAT))?.groups ?? []).length === 2, 'групп по-прежнему две');

// Повторное нажатие снимает выбор
m = mark();
await handleUpdate(button(second2.callback_data, GROUP_ADMIN));
ok(((await getChat(CHAT))?.groups ?? []).length === 1, 'повторное нажатие убирает группу');
await handleUpdate(button(second2.callback_data, GROUP_ADMIN));
chosen = (await getChat(CHAT))?.groups ?? [];
ok(chosen.length === 2, 'и возвращает обратно');

await resetRateLimit();
m = mark();
await handleUpdate(button('m'));
buttons = keyboardOf(since(m));
ok(!!find(buttons, 'Завтра') && !!find(buttons, 'Вся неделя'), 'в меню появилось расписание');
{
  const menuText = texts(since(m)).join('');
  ok(
    menuText.includes(esc(chosen[0])) && menuText.includes(esc(chosen[1])),
    'меню показывает обе группы',
  );
}

head('День показывает обе группы, неделя — по одной');
m = mark();
await handleUpdate(button('day:1'));
const dayText = texts(since(m)).join('');
ok(
  dayText.includes(esc(chosen[0])) && dayText.includes(esc(chosen[1])),
  'в сообщении на день видны обе группы',
);

m = mark();
await handleUpdate(button('week'));
const weekButtons = keyboardOf(since(m));
ok(
  weekButtons.filter((b) => b.callback_data.startsWith('wg:')).length === 2,
  'в неделе есть переключатель между двумя группами',
);
ok(
  weekButtons.some((b) => b.text.startsWith('· ')),
  'активная группа отмечена',
);

const other = weekButtons.find((b) => b.callback_data.startsWith('wg:') && !b.text.startsWith('· '))!;
m = mark();
await handleUpdate(button(other.callback_data));
const switched = since(m);
ok(
  texts(switched).join('').includes(esc(other.text)),
  'переключение показывает неделю второй группы',
);

// Переключатель обязан остаться, иначе обратно не вернуться
const backButtons = keyboardOf(switched);
ok(
  backButtons.filter((b) => b.callback_data.startsWith('wg:')).length === 2,
  'после переключения переключатель на месте',
);
ok(
  backButtons.filter((b) => /^d:\d{4}/.test(b.callback_data)).length >= 5,
  'и дни недели тоже',
);

// Якорь недели одинаков у обеих кнопок: неделя не должна съезжать
const anchors = new Set(
  backButtons.filter((b) => b.callback_data.startsWith('wg:')).map((b) => b.callback_data.split(':')[2]),
);
ok(anchors.size === 1, `обе кнопки указывают на одну неделю: ${[...anchors].join(', ')}`);

// Группа без пар на этой неделе не должна ломать клавиатуру
{
  const { db } = await import('../lib/db');
  const empty = 'ГРУППА-БЕЗ-ПАР';
  await db().from('chats').update({ groups: [chosen[0], empty] }).eq('chat_id', CHAT);
  await resetRateLimit();
  m = mark();
  await handleUpdate(button('week'));
  const wb = keyboardOf(since(m));
  ok(
    wb.filter((b) => /^d:\d{4}/.test(b.callback_data)).length >= 5,
    'дни на месте даже с потерянной второй группой',
  );
  await db().from('chats').update({ groups: chosen }).eq('chat_id', CHAT);
}

// ─── Листание расписания ─────────────────────────────────────────────────────

await resetRateLimit();
head('Листание расписания');
m = mark();
await handleUpdate(button('day:1'));
let screen = since(m);
ok(edited(screen).length === 1, 'завтра открывается правкой сообщения');
ok(sent(screen).length === 0, 'новых сообщений не появляется');
ok(texts(screen).join('').includes('Расписание на завтра'), 'заголовок «на завтра»');

m = mark();
await handleUpdate(button('week'));
screen = since(m);
ok(edited(screen).length === 1, 'неделя открывается правкой');
ok(texts(screen).join('').includes('**>'), 'дни оформлены раскрывающимися цитатами');

buttons = keyboardOf(screen);
const dayButtons = buttons.filter((b) => /^d:\d{4}-\d{2}-\d{2}$/.test(b.callback_data));
ok(dayButtons.length >= 5, `кнопок дней ${dayButtons.length}, адресуют датами`);
ok(!!find(buttons, 'По дням'), 'из недели можно перейти к дням');
ok(!!find(buttons, 'Меню'), 'из недели есть путь в меню');

m = mark();
await handleUpdate(button(dayButtons[1].callback_data));
screen = since(m);
ok(edited(screen).length === 1, 'день открывается правкой');
buttons = keyboardOf(screen);
ok(!!find(buttons, 'Вся неделя'), 'из дня можно вернуться к неделе');
ok(buttons.some((b) => b.text.startsWith('· ')), 'открытый день отмечен');

m = mark();
await handleUpdate(button('m'));
buttons = keyboardOf(since(m));
ok(!!find(buttons, 'Завтра'), 'кнопка «Меню» возвращает в меню');

// Старые сообщения могли остаться с кнопками прежнего вида
m = mark();
await handleUpdate(button('d:0'));
ok(edited(since(m)).length === 1, 'старая кнопка d:0 ещё работает');
m = mark();
await handleUpdate(button('d:all'));
ok(edited(since(m)).length === 1, 'старая кнопка d:all ещё работает');

// ─── Обычный участник группы ─────────────────────────────────────────────────

await resetRateLimit();
head('Обычный участник группы пользуется расписанием');
m = mark();
await handleUpdate(button('day:1', STRANGER));
ok(edited(since(m)).length === 1, 'участник открывает расписание на завтра');

m = mark();
await handleUpdate(button('week', STRANGER));
ok(edited(since(m)).length === 1, 'участник открывает неделю');

buttons = keyboardOf(since(m));
const someDay = buttons.find((b) => /^d:\d{4}-\d{2}-\d{2}$/.test(b.callback_data))!;
m = mark();
await handleUpdate(button(someDay.callback_data, STRANGER));
ok(edited(since(m)).length === 1, 'участник листает дни');

m = mark();
await handleUpdate(button('st', STRANGER));
ok(edited(since(m)).length === 1, 'участник смотрит статус');

// Смотреть можно всем, менять настройки — только админам
m = mark();
await handleUpdate(button('grp', STRANGER));
ok(edited(since(m)).length === 1, 'участник видит список курсов');
const someGroup = keyboardOf(since(m)).find((b) => b.callback_data.startsWith('s:'))!;
m = mark();
await handleUpdate(button(someGroup.callback_data, STRANGER));
const groupBtn = keyboardOf(since(m)).find((b) => b.callback_data.startsWith('g:'))!;
m = mark();
await handleUpdate(button(groupBtn.callback_data, STRANGER));
ok(
  ((await getChat(CHAT))?.groups ?? []).length === 2,
  'но изменить состав групп участник не может',
);

// ─── Статус и переключатель автоотправки ─────────────────────────────────────

await resetRateLimit();
head('Статус и автоотправка');
m = mark();
await handleUpdate(button('st'));
screen = since(m);
ok(texts(screen).join('').includes('Последняя проверка'), 'статус показывает время проверки');
ok(texts(screen).join('').includes(esc(chosen[0])), 'статус показывает группу');
ok(
  texts(screen).join('').includes(esc(`неделя с ${humanDate(weekBounds(weekAnchor()).monday)}`)),
  'статус говорит, какая неделя лежит в базе у своей группы',
);
ok(
  !texts(screen).join('').includes('Текущая неделя'),
  'и не называет чужой файл «текущей неделей»',
);
buttons = keyboardOf(screen);
const offButton = find(buttons, 'Выключить');
ok(!!offButton, 'есть переключатель автоотправки');

m = mark();
await handleUpdate(button(offButton!.callback_data, STRANGER));
ok((await getChat(CHAT))?.enabled === true, 'посторонний не выключает автоотправку');

m = mark();
await handleUpdate(button(offButton!.callback_data, GROUP_ADMIN));
ok((await getChat(CHAT))?.enabled === false, 'админ выключил автоотправку');
buttons = keyboardOf(since(m));
ok(!!find(buttons, 'Включить'), 'переключатель сменил надпись');

m = mark();
await handleUpdate(button('on', GROUP_ADMIN));
ok((await getChat(CHAT))?.enabled === true, 'админ включил обратно');

// ─── О боте ──────────────────────────────────────────────────────────────────

await resetRateLimit();
head('Кастомный эмодзи в подписи');
await resetRateLimit();
{
  const withEmoji = (id: string): TgUpdate => ({
    message: {
      message_id: Math.floor(Math.random() * 100000),
      from: { id: OWNER, username: 'owner', first_name: 'Владелец' },
      chat: { id: OWNER, type: 'private' },
      text: '🦅',
      entities: [{ type: 'custom_emoji', custom_emoji_id: id, offset: 0, length: 1 }],
    },
  });

  m = mark();
  await handleUpdate(withEmoji('5368324170671202286'));
  const learned = since(m);
  ok(
    texts(learned).join('').includes('tg://emoji?id=5368324170671202286'),
    'бот показал предпросмотр с кастомным эмодзи',
  );
  ok(
    texts(learned).join('').includes('этот эмодзи теперь стоит в подписи'),
    'и подтвердил, что запомнил',
  );

  // Проверяем, что он попал в экран «О боте»
  await resetRateLimit();
  m = mark();
  await handleUpdate(button('about'));
  const about = texts(since(m)).join('');
  ok(about.includes('tg://emoji?id=5368324170671202286'), 'подпись использует заданный эмодзи');
  ok(about.includes('Хактайке'), 'автор подписан по-русски');
  ok(!about.includes('hacktaika.ru]'), 'английского названия в тексте нет');

  // Telegram отказал — сохранять нельзя
  await failMethods(['sendMessage']);
  m = mark();
  await handleUpdate(withEmoji('000000000000000000'));
  await failMethods([]);
  await resetRateLimit();
  m = mark();
  await handleUpdate(button('about'));
  ok(
    texts(since(m)).join('').includes('5368324170671202286'),
    'после отказа Telegram остаётся прежний эмодзи',
  );
}

head('Экран «О боте»');
m = mark();
await handleUpdate(button('m'));
ok(!!find(keyboardOf(since(m)), 'О боте'), 'в меню есть кнопка «О боте»');

m = mark();
await handleUpdate(button('about', STRANGER));
screen = since(m);
ok(edited(screen).length === 1, 'экран открывается правкой сообщения');
const about = texts(screen).join('');
ok(about.includes('hacktaika'), 'указан автор — hacktaika.ru');
ok(about.includes('О боте'), 'есть заголовок');
ok(!!find(keyboardOf(screen), 'Меню'), 'есть путь назад в меню');

// Ни один спецсимвол не должен остаться неэкранированным, иначе Telegram
// откажется разбирать разметку. Снимаем то, что ставим сами: экранирование,
// ссылки, кастомный эмодзи и жирный с курсивом.
const bare = about
  .replace(/!\[[^\]]*\]\(tg:\/\/emoji\?id=\d+\)/g, '')
  .replace(/\\./g, '')
  .replace(/\[[^\]]*\]\([^)]*\)/g, '')
  .replace(/[*_]/g, '');
ok(!/[.!()\-]/.test(bare), `в тексте нет неэкранированных символов: ${bare.slice(0, 60)}`);

// ─── Переименование группы в новом файле ─────────────────────────────────────

await resetRateLimit();
head('Колледж переименовал группу');
{
  const { toggleChatGroup, getChat: read, normalizeGroup } = await import('../lib/db');
  const real = (await listGroups())[0].group;
  // Изображаем старое написание: другой регистр и дефисы вместо пробелов
  const oldStyle = real.toUpperCase().replace(/\s/g, '-');

  await fetch(`${process.env.SUPABASE_URL}/rest/v1/chats?chat_id=eq.${CHAT}`, {
    method: 'PATCH',
    headers: {
      apikey: 'fake',
      Authorization: 'Bearer fake',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ groups: [oldStyle] }),
  });

  ok(
    normalizeGroup(oldStyle) === normalizeGroup(real),
    'старое и новое написание сравниваются как одно',
  );

  m = mark();
  await handleUpdate(button('day:1'));
  const after = (await read(CHAT))?.groups ?? [];
  ok(after[0] === real, `название обновилось само: ${oldStyle} -> ${after[0]}`);
  ok(
    !texts(since(m)).join('').includes('больше нет в расписании'),
    'предупреждения нет: группа нашлась',
  );

  // А исчезнувшая группа должна давать явное предупреждение, а не «пар нет»
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/chats?chat_id=eq.${CHAT}`, {
    method: 'PATCH',
    headers: {
      apikey: 'fake',
      Authorization: 'Bearer fake',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ groups: ['ГРУППА-КОТОРОЙ-НЕТ'] }),
  });

  m = mark();
  await handleUpdate(button('day:1'));
  const lost = since(m);
  ok(
    texts(lost).join('').includes('больше нет в расписании'),
    'про исчезнувшую группу бот предупреждает',
  );
  ok(
    !!find(keyboardOf(lost), 'Выбрать группу'),
    'и сразу даёт кнопку выбрать заново',
  );

  // Одна группа потерялась, вторая рабочая: расписание и дни должны остаться
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/chats?chat_id=eq.${CHAT}`, {
    method: 'PATCH',
    headers: {
      apikey: 'fake',
      Authorization: 'Bearer fake',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ groups: ['ГРУППА-КОТОРОЙ-НЕТ', real] }),
  });
  await resetRateLimit();
  m = mark();
  await handleUpdate(button('day:1'));
  const mixed = since(m);
  const mixedButtons = keyboardOf(mixed);
  ok(
    mixedButtons.filter((b) => /^d:\d{4}/.test(b.callback_data)).length >= 5,
    `дни листаются: ${mixedButtons.filter((b) => /^d:\d{4}/.test(b.callback_data)).length} кнопок`,
  );
  ok(!!find(mixedButtons, 'Выбрать группу'), 'и кнопка выбрать заново тоже есть');
  ok(
    texts(mixed).join('').includes(esc(real)) &&
      texts(mixed).join('').includes('больше нет в расписании'),
    'в сообщении и рабочая группа, и предупреждение',
  );

  // Клавиатура должна показывать всю неделю, а не только дни с парами
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/chats?chat_id=eq.${CHAT}`, {
    method: 'PATCH',
    headers: {
      apikey: 'fake',
      Authorization: 'Bearer fake',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ groups: [real] }),
  });
  m = mark();
  await handleUpdate(button('day:1'));
  const dayBtns = keyboardOf(since(m)).filter((b) => /^d:\d{4}/.test(b.callback_data));
  ok(dayBtns.length >= 5, `в клавиатуре вся неделя: ${dayBtns.length} дней`);

  // Возвращаем рабочее состояние
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/chats?chat_id=eq.${CHAT}`, {
    method: 'PATCH',
    headers: {
      apikey: 'fake',
      Authorization: 'Bearer fake',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ groups: chosen }),
  });
  void toggleChatGroup;
}

// ─── Повторное нажатие той же кнопки ─────────────────────────────────────────

await resetRateLimit();
head('Повторное нажатие не плодит сообщения');
m = mark();
await handleUpdate(button('about'));
await handleUpdate(button('about'));
await handleUpdate(button('about'));
const repeats = since(m);
ok(
  sent(repeats).filter((c) => c.body.chat_id === CHAT).length === 0,
  'три нажатия подряд — ни одного нового сообщения в чате',
);
ok(
  edited(repeats).length === 3,
  `на три нажатия ровно три обращения к API, а не повторы: ${edited(repeats).length}`,
);

// ─── Перезалив файла под другим именем ───────────────────────────────────────

await resetRateLimit();
head('Колледж перезалил неделю под новым именем');
{
  const { upsertFile: put, weekStarts: weeks, dropSupersededWeeks } = await import('../lib/db');

  // Тест сам себе готовит «оригинал» той же недели — раньше это делал общий
  // подготовительный шаг (когда сайт был недоступен из песочницы и данные
  // всегда брались из фикстуры), но теперь сайт достижим через браузер, и
  // тот шаг фикстуру не грузит. Без явного посева тест ломается не из-за
  // бага, а из-за отсутствия своей же исходной записи.
  await seedFromFixture();
  const before = await weeks();

  // Та же неделя, но имя другое и начало сместилось на день — ровно так
  // колледж заменил «31-5 августа-сентября» на «1-5 сентября»
  const renamed = await put({
    name: 'week1-renamed.xlsx',
    url: 'https://www.muiv.ru/upload/fixture/week1-renamed.xlsx',
    title: 'Расписание из фикстуры (перезалив)',
    sha256: 'renamed',
    size: 1,
    siteUpdated: '04.09.2026',
    weekStart: '2026-09-01',
    parsedOk: true,
    parseError: null,
  });

  const withDuplicate = await weeks();
  ok(
    withDuplicate.length === before.length,
    `навигация не показывает лишнюю неделю: было ${before.length}, стало ${withDuplicate.length}`,
  );

  const removed = await dropSupersededWeeks(renamed.id, '2026-09-01');
  ok(removed >= 1, `устаревшая запись о той же неделе удалена: ${removed}`);

  const after = await weeks();
  ok(after.length === before.length, 'недель по-прежнему столько же');

  // Возвращаем расписание из фикстуры, чтобы дальше было на чём проверять
  await seedFromFixture('after-rename');
}

// ─── Сбои базы ───────────────────────────────────────────────────────────────

await resetRateLimit();
head('Разовый сбой базы не должен ничего ронять');
{
  // Один Gateway Timeout на чтении — экран всё равно должен открыться
  await flakyDb(1);
  m = mark();
  await handleUpdate(button('m'));
  ok(edited(since(m)).length === 1, 'нажатие пережило один 504 от базы');

  // Косметическая отметка файла: её сбой не должен ронять проверку
  await flakyDb(9, '/files');
  let threw = false;
  try {
    const { touchFile } = await import('../lib/db');
    await touchFile('week1.xlsx');
  } catch {
    threw = true;
  }
  ok(!threw, 'сбой отметки файла не бросает исключение');

  await flakyDb(0);
}

// ─── Подавление повторных алертов ────────────────────────────────────────────

head('Повторные алерты владельцу');
await resetAlerts();
{
  const { logError } = await import('../lib/log');
  m = mark();
  await logError('Проверка подавления', new Error('первая'));
  const firstAlert = sent(since(m)).filter((c) => c.body.chat_id === OWNER).length;
  ok(firstAlert === 1, 'первая ошибка уходит владельцу');

  m = mark();
  await logError('Проверка подавления', new Error('вторая'));
  ok(
    sent(since(m)).filter((c) => c.body.chat_id === OWNER).length === 0,
    'та же ошибка повторно не беспокоит',
  );

  m = mark();
  await logError('Другая ошибка', new Error('третья'));
  ok(
    sent(since(m)).filter((c) => c.body.chat_id === OWNER).length === 1,
    'но другая ошибка приходит',
  );
}

// ─── Устойчивость ────────────────────────────────────────────────────────────

await resetRateLimit();
head('Устойчивость к мусору');
m = mark();
await handleUpdate(button('g:99999'));
ok(
  String(since(m).findLast((c) => c.method === 'answerCallbackQuery')?.body.text ?? '').includes(
    'устарел',
  ),
  'на устаревший индекс группы — понятный ответ',
);

m = mark();
await handleUpdate(button('чтотоневалидное'));
ok(since(m).length > 0, 'неизвестная кнопка не роняет обработчик');

await handleUpdate({} as TgUpdate);
ok(true, 'пустой апдейт не роняет обработчик');

// Подделанные нажатия: даты и числа из кнопки не должны доходить до базы
// мусором и превращаться в ошибку с алертом владельцу
{
  const errorsBefore = await errorLogs();
  for (const data of [
    'day:abc',
    'day:5',
    'd:2026-13-45',
    'd:../../etc',
    'w:garbage',
    'w:2026-02-30',
    'wg:0:garbage',
    'ob:xyz',
    'p:0:-5',
    'ok:abc',
    'no:-1:p:0',
    'acc:z:9',
  ]) {
    await resetRateLimit();
    await handleUpdate(button(data));
  }
  ok((await errorLogs()) === errorsBefore, 'подделанные нажатия не дают ни одной ошибки');

  await resetRateLimit();
  m = mark();
  await handleUpdate(button('w:2026-13-45'));
  ok(
    String(since(m).findLast((c) => c.method === 'answerCallbackQuery')?.body.text ?? '').includes(
      'устарела',
    ),
    'на мусорную дату — понятный ответ',
  );
}

// ─── Ограничение частоты ─────────────────────────────────────────────────────

head('Ограничение частоты');
await resetRateLimit();
// Окно лимита — календарная минута. Если она сменится посреди прогона,
// счётчик обнулится и пройдёт больше шестидесяти: это не поломка лимита,
// поэтому проверяем строго только когда окно осталось тем же.
const windowAt = () => Math.floor(Date.now() / 60_000);
const windowBefore = windowAt();
m = mark();
for (let i = 0; i < 70; i++) await handleUpdate(button('m'));
const answered = edited(since(m)).length;

if (windowAt() === windowBefore) {
  ok(answered === 60, `из 70 нажатий обработано ${answered} — лимит 60 в минуту`);
} else {
  ok(
    answered >= 60 && answered < 70,
    `минута сменилась посреди прогона, обработано ${answered} — лимит всё равно сработал`,
  );
}

// ─── Отказы Bot API ──────────────────────────────────────────────────────────

await resetRateLimit();
head('Отказы Telegram не должны терять работу');

// «query is too old» случается при холодном старте функции: гашение кнопки
// не прошло, но расписание всё равно обязано показаться
await failMethods(['answerCallbackQuery']);
m = mark();
await handleUpdate(button('week'));
ok(
  edited(since(m)).some((c) => !c.failed),
  'при отказе answerCallbackQuery расписание всё равно показано',
);

// сообщение с кнопками удалили — правка не пройдёт, нужен новый ответ
await failMethods(['editMessageText']);
m = mark();
await handleUpdate(button('m'));
ok(
  sent(since(m)).some((c) => !c.failed),
  'при отказе editMessageText отправляется новое сообщение',
);

await failMethods([]);

// ─── Автоотправка ────────────────────────────────────────────────────────────

await resetRateLimit();
head('Автоотправка на завтра и закрепление');
await upsertChat(CHAT, 'Тестовая группа');
m = mark();
const forced = await tick(true);
let after = since(m);
ok(
  forced.autoSend === 'sent',
  `рассылка выполнена: отправлено ${forced.sent}, ошибок ${forced.failed}`,
);
ok(sent(after).length >= 1, 'сообщение отправлено');
ok(after.some((c) => c.method === 'pinChatMessage'), 'сообщение закреплено');
ok(keyboardOf(after).length > 0, 'под закреплённым сообщением есть кнопки');
ok((await getChat(CHAT))?.pinned_msg_id !== null, 'id закреплённого сообщения сохранён');

m = mark();
const second = await tick(true);
after = since(m);
ok(second.sent === 0, 'повторный тик не шлёт расписание второй раз');
ok(
  sent(after).filter((c) => c.body.chat_id === CHAT).length === 0,
  'в чат ничего не ушло',
);

// Наступил следующий день: дата закреплённого другая, значит шлём заново
await setPinnedMessage(CHAT, 900, '2020-01-01');
m = mark();
const third = await tick(true);
after = since(m);
ok(third.sent === 1, 'на новый день расписание уходит');
ok(after.some((c) => c.method === 'unpinChatMessage'), 'прошлое закрепление снято');

// ─── Обновление расписания на сайте ──────────────────────────────────────────

await resetRateLimit();
head('Колледж поменял файл');
const pinnedBefore = await getChat(CHAT);
ok(!!pinnedBefore?.pinned_msg_id, 'закреплённое сообщение есть');
ok(!!pinnedBefore?.pinned_date, 'дата закреплённого дня сохранена');

m = mark();
const updated = await refreshPinned();
after = since(m);
ok(updated === 1, 'закреплённое сообщение перерисовано');
ok(sent(after).length === 0, 'НИ ОДНОГО нового сообщения в чат при обновлении');
ok(
  !texts(after).join('').includes('обновилось'),
  'сообщения «расписание обновилось» больше нет',
);
ok(
  edited(after).some((c) => c.body.message_id === pinnedBefore!.pinned_msg_id),
  'правится именно закреплённое сообщение',
);
ok(
  !texts(after).join('').includes('/tomorrow') && !texts(after).join('').includes('/week'),
  'в текстах нет упоминаний несуществующих команд',
);
ok(keyboardOf(after).length > 0, 'кнопки под закреплённым сохранились');

// Если правка не прошла (сообщение удалили) — новое слать нельзя, это спам
await failMethods(['editMessageText']);
m = mark();
await refreshPinned();
ok(sent(since(m)).length === 0, 'при неудачной правке новое сообщение не отправляется');
await failMethods([]);

// Если закреплённого сообщения нет — просто молчим
await setPinnedMessage(CHAT, null, null);
m = mark();
ok((await refreshPinned()) === 0, 'без закреплённого сообщения обновлять нечего');
ok(sent(since(m)).length === 0, 'и ничего не отправляется');

// Полный тик при изменении файла тоже не должен писать в чат
if (siteReachable) {
  await setPinnedMessage(CHAT, 900, mskDateOffset(1));
  await forgetFiles();
  m = mark();
  const changedTick = await tick(false);
  ok(changedTick.check!.changed.length > 0, 'проверка увидела изменение файлов');
  ok(sent(since(m)).length === 0, 'при обновлении файла тик не пишет в чат');
}

head('Правила расписания рассылки');
const notForced = await tick(false);
ok(
  ['skipped-hour', 'skipped-saturday', 'skipped-already', 'sent'].includes(
    String(notForced.autoSend),
  ),
  `без force решение принято по времени: ${notForced.autoSend}`,
);

// ─── Сбои сайта МУИВ ─────────────────────────────────────────────────────────

await resetRateLimit();
await resetAlerts();
head('Один промах сайта не будит владельца');
{
  const { noteFileFailure, noteFileOk } = await import('../lib/sync');
  const title = 'Проверочный файл';
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/app_state?key=like.siteFail:*`, {
    method: 'DELETE',
    headers: { apikey: 'fake', Authorization: 'Bearer fake' },
  });

  m = mark();
  await noteFileFailure(title, new Error('The operation was aborted due to timeout'));
  ok(
    sent(since(m)).every((c) => c.body.chat_id !== OWNER),
    'первый промах владельцу не уходит',
  );

  m = mark();
  await noteFileFailure(title, new Error('The operation was aborted due to timeout'));
  ok(
    sent(since(m)).some(
      (c) => c.body.chat_id === OWNER && String(c.body.text).includes('Скачивание файла'),
    ),
    'второй промах подряд — уже алерт',
  );

  // Удачное скачивание обнуляет серию: следующий одиночный промах снова молчит
  await resetAlerts();
  await noteFileOk(title);
  m = mark();
  await noteFileFailure(title, new Error('The operation was aborted due to timeout'));
  ok(
    sent(since(m)).every((c) => c.body.chat_id !== OWNER),
    'после успешной проверки серия обнулилась',
  );
}

// ─── Привязка групп к чатам ──────────────────────────────────────────────────

await resetRateLimit();
head('У каждого чата — ровно его группы');
{
  const A = -100777200;
  const B = -100777201;
  const C = -100777202;

  // Названия не должны быть началом друг друга: иначе проверка «в тексте нет
  // чужой группы» соврала бы на «БАД 26-09» внутри «БАД 26-09.1»
  const names = groups.map((g) => g.group);
  const distinct = names.filter(
    (name) => !names.some((other) => other !== name && other.startsWith(name)),
  );
  const [g1, g2, g3] = distinct;
  ok(!!g1 && !!g2 && !!g3, `взяты непересекающиеся группы: ${g1}, ${g2}, ${g3}`);

  const { toggleChatGroup } = await import('../lib/db');
  await upsertChat(A, 'Чат А');
  await toggleChatGroup(A, g1);
  await upsertChat(B, 'Чат Б');
  await toggleChatGroup(B, g2);
  await toggleChatGroup(B, g3);
  await upsertChat(C, 'Чат В');
  await toggleChatGroup(C, g1);

  ok((await getChat(A))?.groups.join('|') === g1, 'выбор чата А сохранён как есть');
  ok((await getChat(B))?.groups.join('|') === `${g2}|${g3}`, 'у чата Б сохранены обе, по порядку');

  for (const id of [A, B, C]) await setPinnedMessage(id, null, '2020-01-01');
  m = mark();
  await tick(true);
  const out = since(m);

  const textFor = (id: number) =>
    sent(out)
      .filter((c) => c.body.chat_id === id)
      .map((c) => String(c.body.text))
      .join('\n');

  ok(
    textFor(A).includes(esc(g1)) &&
      !textFor(A).includes(esc(g2)) &&
      !textFor(A).includes(esc(g3)),
    'чат А получил только свою группу',
  );
  ok(
    textFor(B).includes(esc(g2)) &&
      textFor(B).includes(esc(g3)) &&
      !textFor(B).includes(esc(g1)),
    'чат Б получил обе свои и ни одной чужой',
  );
  ok(textFor(C).includes(esc(g1)), 'чат В со своей группой не остался без расписания');
  ok(
    (await getChat(A))?.groups.join('|') === g1,
    'после рассылки выбор чата А не поменялся',
  );
}

// ─── Нагрузка на базу ────────────────────────────────────────────────────────

await resetRateLimit();
head('Расписание читается один раз на всю рассылку');
{
  const many = [-100777210, -100777211, -100777212, -100777213, -100777214, -100777215];
  const { toggleChatGroup } = await import('../lib/db');
  const shared = groups[0].group;

  for (const id of many) {
    await upsertChat(id, `Массовый ${id}`);
    await toggleChatGroup(id, shared);
    await setPinnedMessage(id, null, '2020-01-01');
  }

  await resetDbHits();
  const before = await tick(true);
  const reads = await dbHits('schedules');

  ok(before.sent! >= many.length, `разослано чатов: ${before.sent}`);
  // Без общего кэша один только список групп читался бы по разу на чат.
  // Порог с запасом: важно, что число не растёт вместе с числом чатов.
  ok(reads <= 6, `таблица расписания прочитана ${reads} раз на ${before.sent} чатов`);
}

// ─── Кэш чтений ──────────────────────────────────────────────────────────────

head('Кэш не протекает между одновременными вызовами');
{
  const { withReadCache, listGroups: read } = await import('../lib/db');

  // Внутри одного вызова список групп читается один раз
  await resetDbHits();
  await withReadCache(async () => {
    await read();
    await read();
    await read();
  });
  ok((await dbHits('groups_catalog')) === 1, 'внутри одного вызова — одно чтение');

  // Два наложившихся вызова: важно, что начатый раньше кончается раньше —
  // именно так общая переменная модуля оставляла свой кэш висеть навсегда,
  // и все дальнейшие запросы получали бы устаревшее расписание
  await resetDbHits();
  let letAFinish: () => void = () => {};
  let letBFinish: () => void = () => {};
  const aGate = new Promise<void>((r) => {
    letAFinish = r;
  });
  const bGate = new Promise<void>((r) => {
    letBFinish = r;
  });

  const a = withReadCache(async () => {
    await read();
    await aGate;
  });
  await pause(80); // дать A прочитать и встать на ожидание

  const b = withReadCache(async () => {
    await read();
    await bGate;
    await read(); // должно взяться из собственного кэша B
  });
  await pause(80);

  letAFinish();
  await a; // A закончился, пока B ещё работает

  letBFinish();
  await b;

  const overlapped = await dbHits('groups_catalog');
  ok(overlapped === 2, `у каждого вызова свой кэш: чтений ${overlapped}`);

  // Вне вызова (вебхук бота) каталог живёт в памяти пару минут: он нужен
  // почти каждому нажатию, а меняется раз в сутки. Сброс — по записи каталога
  const { forgetSharedCache } = await import('../lib/db');
  forgetSharedCache();
  await resetDbHits();
  await read();
  await read();
  ok((await dbHits('groups_catalog')) === 1, 'вне вызова каталог читается один раз на пару минут');
  forgetSharedCache();
  await read();
  ok((await dbHits('groups_catalog')) === 2, 'после сброса — снова из базы');
}

// ─── Баги и предложения ──────────────────────────────────────────────────────

await resetRateLimit();
await resetFeedback();
head('Баги и предложения');
{
  // Человек без доступа: сообщать о поломках он всё равно должен уметь
  const REPORTER = 4242;

  m = mark();
  await handleUpdate(message('/start', REPORTER, REPORTER, 'private'));
  // Смотрим именно его сообщение: последним в пачке уходит уведомление владельцу
  const toReporter = sent(since(m)).filter((c) => c.body.chat_id === REPORTER);
  ok(!!find(keyboardOf(toReporter), 'Баг или идея'), 'кнопка есть даже без доступа');

  await resetRateLimit();
  m = mark();
  await handleUpdate(privateButton('fb', REPORTER));
  const kinds = keyboardOf(since(m));
  ok(!!find(kinds, 'Баг') && !!find(kinds, 'Предложение'), 'предлагается выбрать тег');

  await resetRateLimit();
  m = mark();
  await handleUpdate(privateButton('fb:bug', REPORTER));
  ok(texts(since(m)).join('').includes('сломалось'), 'бот ждёт текст');

  await resetRateLimit();
  m = mark();
  await handleUpdate(
    message('Кнопка «Завтра» показывает вчерашний день', REPORTER, REPORTER, 'private'),
  );
  let out = since(m);
  const notice = sent(out).find((c) => c.body.chat_id === OWNER);
  ok(!!notice, 'владельцу пришло уведомление');
  ok(String(notice?.body.text ?? '').includes('#баг'), 'в уведомлении виден тег');
  ok(String(notice?.body.text ?? '').includes('Баг'), 'и его название');
  ok(String(notice?.body.text ?? '').includes('Завтра'), 'и сам текст сообщения');
  ok(
    sent(out).some(
      (c) => c.body.chat_id === REPORTER && String(c.body.text).includes('Передал'),
    ),
    'человеку сказали спасибо',
  );

  // Следующее сообщение — уже обычное: тег одноразовый
  await resetRateLimit();
  m = mark();
  await handleUpdate(message('просто болтаю', REPORTER, REPORTER, 'private'));
  ok(sent(since(m)).length === 0, 'без выбранного тега бот на текст не реагирует');

  // Без одобренного доступа — одно сообщение в день, и об этом говорят сразу,
  // а не после того, как человек напишет длинный текст
  await resetRateLimit();
  m = mark();
  await handleUpdate(privateButton('fb:idea', REPORTER));
  out = since(m);
  ok(texts(out).join('').includes('На сегодня всё'), 'без доступа второе за день не принимается');
  ok(texts(out).join('').includes(esc('С одобренным доступом — до 3')), 'и сказано, как получить больше');
  await resetRateLimit();
  m = mark();
  await handleUpdate(message('Пусть показывает преподавателя', REPORTER, REPORTER, 'private'));
  ok(sent(since(m)).length === 0, 'текст после отказа никуда не уходит');

  await resetRateLimit();
  m = mark();
  await handleUpdate(message('/start bug', REPORTER, REPORTER, 'private'));
  ok(texts(since(m)).join('').includes('На сегодня всё'), 'ссылка из группы тоже упирается в лимит');

  // Ровно путь со скриншота 23.10: новый человек, заявка ждёт; «Баг» →
  // текст → снова «Баг или идея» → «Баг» → текст. На проде старый код
  // принял оба сообщения; теперь второе не принимается вовсе
  {
    const NEWCOMER = 7718;
    await resetRateLimit();
    await handleUpdate(message('/start', NEWCOMER, NEWCOMER, 'private'));
    const steps: [string, TgUpdate][] = [
      ['fb', privateButton('fb', NEWCOMER)],
      ['fb:bug', privateButton('fb:bug', NEWCOMER)],
      ['текст 1', message('фывафыва', NEWCOMER, NEWCOMER, 'private')],
      ['fb', privateButton('fb', NEWCOMER)],
      ['fb:bug', privateButton('fb:bug', NEWCOMER)],
      ['текст 2', message('фывафывафыв', NEWCOMER, NEWCOMER, 'private')],
    ];
    m = mark();
    const shown: string[] = [];
    for (const [, update] of steps) {
      await resetRateLimit();
      const before = mark();
      await handleUpdate(update);
      shown.push(texts(since(before)).join(' | '));
    }
    out = since(m);
    const toOwner = sent(out).filter(
      (c) => c.body.chat_id === OWNER && String(c.body.text).includes('#баг'),
    );
    ok(toOwner.length === 1, `владельцу ушёл ровно один баг: ${toOwner.length}`);
    ok(shown[3].includes('На сегодня всё'), 'после первого бага «Баг или идея» уже говорит «на сегодня всё»');
    ok(!shown[4].includes('сломалось'), 'повторный «Баг» не открывает ввод текста');
    ok(!shown[5].includes('Передал'), 'второй текст не передан');
  }

  // С одобренным доступом — три в день
  const APPROVED = 4343;
  const { decideAccess, setState } = await import('../lib/db');
  await decideAccess(APPROVED, 'approved');

  await resetRateLimit();
  m = mark();
  await handleUpdate(privateButton('fb', APPROVED));
  ok(texts(since(m)).join('').includes(esc('Сегодня можно ещё: 3')), 'одобренному видно, сколько осталось');

  // Предложение приходит со своим тегом
  await resetRateLimit();
  await handleUpdate(privateButton('fb:idea', APPROVED));
  await resetRateLimit();
  m = mark();
  await handleUpdate(message('Пусть показывает преподавателя', APPROVED, APPROVED, 'private'));
  ok(
    String(sent(since(m)).find((c) => c.body.chat_id === OWNER)?.body.text ?? '').includes(
      '#предложение',
    ),
    'у предложения свой тег',
  );

  // Слишком длинное не проходит и в лимит не засчитывается
  await resetRateLimit();
  await handleUpdate(privateButton('fb:bug', APPROVED));
  await resetRateLimit();
  m = mark();
  await handleUpdate(message('я'.repeat(1500), APPROVED, APPROVED, 'private'));
  out = since(m);
  ok(texts(out).join('').includes('Слишком длинно'), 'слишком длинное отклонено');
  ok(sent(out).every((c) => c.body.chat_id !== OWNER), 'и владельцу не ушло');

  for (let i = 0; i < 2; i++) {
    await resetRateLimit();
    await handleUpdate(privateButton('fb:bug', APPROVED));
    await resetRateLimit();
    await handleUpdate(message(`ещё баг ${i}`, APPROVED, APPROVED, 'private'));
  }
  await resetRateLimit();
  m = mark();
  await handleUpdate(privateButton('fb:bug', APPROVED));
  out = since(m);
  ok(texts(out).join('').includes('На сегодня всё'), 'четвёртое за день у одобренного не принимается');
  ok(!texts(out).join('').includes('С одобренным доступом'), 'и про доступ ему не рассказывают');

  // Тег выбран раньше, а лимит кончился в другом окне: текст всё равно не проходит
  await setState(`fb:${APPROVED}`, { kind: 'bug', at: new Date().toISOString() });
  await resetRateLimit();
  m = mark();
  await handleUpdate(message('пятый подряд', APPROVED, APPROVED, 'private'));
  out = since(m);
  ok(texts(out).join('').includes('На сегодня всё'), 'лимит проверяется и при отправке текста');
  ok(sent(out).every((c) => c.body.chat_id !== OWNER), 'сверх лимита владельца не дёргаем');

  // Два сообщения в одно ожидание, доставленные параллельно, — принимается одно
  const RACER = 4444;
  await decideAccess(RACER, 'approved');
  await setState(`fb:${RACER}`, { kind: 'bug', at: new Date().toISOString() });
  await resetRateLimit();
  m = mark();
  await Promise.all([
    handleUpdate(message('первое', RACER, RACER, 'private')),
    handleUpdate(message('второе', RACER, RACER, 'private')),
  ]);
  out = since(m);
  ok(
    sent(out).filter((c) => c.body.chat_id === OWNER).length === 1,
    'из двух параллельных сообщений в одно ожидание принято одно',
  );

  // В группе кнопка ведёт ссылкой в личку: обычных сообщений бот там не видит
  await resetRateLimit();
  m = mark();
  await handleUpdate(message('/start', OWNER));
  const inGroup = find(keyboardOf(since(m)), 'Баг или идея');
  ok(!!inGroup?.url && inGroup.url.includes('start=fb'), 'из группы кнопка ведёт в личку');

  await resetFeedback();
}

// ─── Группы с темами ─────────────────────────────────────────────────────────

await resetRateLimit();
head('Форум: расписание уходит в выбранную тему');
{
  const FORUM = -100777100;
  const TOPIC = 42;
  const OTHER = 77;
  const { toggleChatGroup } = await import('../lib/db');

  // Подключение прямо из темы: где написали /start — туда и слать
  m = mark();
  await handleUpdate(forumMessage('/start', OWNER, FORUM, TOPIC, 'Расписание'));
  let out = since(m);
  let forum = await getChat(FORUM);
  ok(forum?.topic_id === TOPIC, 'тема запомнена при подключении');
  ok(forum?.topic_name === 'Расписание', 'название темы сохранено');
  ok(
    sent(out).some((c) => c.body.chat_id === FORUM && c.body.message_thread_id === TOPIC),
    'ответ пришёл в ту же тему, а не в «Общее»',
  );
  ok(texts(out).join('').includes('Тема для расписания'), 'в меню видно, куда идёт расписание');
  ok(!find(keyboardOf(out), 'эту тему'), 'в самой выбранной теме менять нечего');

  // Меню, открытое в другой теме, предлагает переключиться
  await resetRateLimit();
  m = mark();
  await handleUpdate(forumMessage('/start', OWNER, FORUM, OTHER, 'Флудилка'));
  ok(!!find(keyboardOf(since(m)), 'эту тему'), 'из другой темы предлагается переключить');

  // Обычный участник настройку не меняет
  await resetRateLimit();
  m = mark();
  await handleUpdate(forumButton('topic', STRANGER, FORUM, OTHER));
  ok(
    String(since(m).findLast((c) => c.method === 'answerCallbackQuery')?.body.text ?? '').includes(
      'админ',
    ),
    'менять тему может только админ чата',
  );
  ok((await getChat(FORUM))?.topic_id === TOPIC, 'тема осталась прежней');

  // Админ переключает нажатием внутри нужной темы
  await resetRateLimit();
  m = mark();
  await handleUpdate(forumButton('topic', OWNER, FORUM, OTHER));
  ok((await getChat(FORUM))?.topic_id === OTHER, 'админ переключил тему нажатием в ней');

  // Автоотправка уважает выбор
  await toggleChatGroup(FORUM, groups[0].group);
  await setPinnedMessage(FORUM, null, '2020-01-01');
  await resetRateLimit();
  m = mark();
  await tick(true);
  out = since(m).filter((c) => c.body.chat_id === FORUM);
  ok(
    sent(out).some((c) => !c.failed && c.body.message_thread_id === OTHER),
    'расписание пришло в выбранную тему',
  );

  // Тему удалили: расписание всё равно должно дойти, а настройку забываем
  await goneTopics([OTHER]);
  await setPinnedMessage(FORUM, null, '2020-01-01');
  await resetRateLimit();
  m = mark();
  await tick(true);
  out = since(m).filter((c) => c.body.chat_id === FORUM);
  ok(
    out.some((c) => c.body.message_thread_id === OTHER && c.failed),
    'в удалённую тему Telegram не пускает',
  );
  ok(
    sent(out).some((c) => !c.failed && c.body.message_thread_id === undefined),
    'расписание всё равно ушло — в «Общее»',
  );
  ok((await getChat(FORUM))?.topic_id === null, 'мёртвая тема забыта');
  await goneTopics([]);

  // В обычной группе ничего этого быть не должно
  await resetRateLimit();
  m = mark();
  await handleUpdate(message('/start', OWNER));
  out = since(m);
  ok(!texts(out).join('').includes('Тема для расписания'), 'в группе без тем про темы молчим');
  ok(
    sent(out).every((c) => c.body.message_thread_id === undefined),
    'и тему в отправку не подставляем',
  );
}

// ─── Доступ: разделы и страницы ──────────────────────────────────────────────

await resetRateLimit();
head('Доступ: разделы со страницами');
{
  const { requestAccess, getAccess } = await import('../lib/db');
  // Двадцать заявок — больше двух страниц по восемь
  const WAVE = Array.from({ length: 20 }, (_, i) => 7000 + i);
  for (const id of WAVE) await requestAccess(id, `wave${id}`, `Волна ${id}`);

  m = mark();
  await handleUpdate(privateButton('admacc', OWNER));
  let out = since(m);
  let kb = keyboardOf(out);
  ok(!!find(kb, 'Ждут решения ('), 'в обзоре есть раздел «Ждут решения»');
  ok(!!find(kb, 'Одобрены (') && !!find(kb, 'Отказано ('), 'и разделы одобренных и отказанных');
  ok(kb.length <= 6, `в обзоре нет простыни из кнопок: ${kb.length}`);

  await resetRateLimit();
  m = mark();
  await handleUpdate(privateButton('acc:p:0', OWNER));
  out = since(m);
  kb = keyboardOf(out);
  const people = kb.filter((b) => b.callback_data?.startsWith('ok:'));
  ok(people.length === 8, `на странице 8 человек: ${people.length}`);
  ok(!!find(kb, '1 / '), 'видно, какая это страница');
  ok(texts(out).join('').includes('Страница 1 из'), 'и в тексте тоже');
  const nextPage = kb.find((b) => b.text === '▶︎');
  ok(!!nextPage, 'есть кнопка на следующую страницу');

  await resetRateLimit();
  m = mark();
  await handleUpdate(privateButton(nextPage!.callback_data, OWNER));
  out = since(m);
  kb = keyboardOf(out);
  ok(texts(out).join('').includes('Страница 2 из'), 'листается на вторую страницу');
  const pick = kb.find((b) => b.callback_data?.startsWith('ok:'))!;
  ok(pick.callback_data.endsWith(':p:1'), `решение помнит раздел и страницу: ${pick.callback_data}`);

  const pickedId = Number(pick.callback_data.split(':')[1]);
  await resetRateLimit();
  m = mark();
  await handleUpdate(privateButton(pick.callback_data, OWNER));
  out = since(m);
  ok((await getAccess(pickedId))?.status === 'approved', 'человек одобрен со страницы раздела');
  ok(texts(out).join('').includes('Страница 2 из'), 'после решения остаёмся на той же странице');
  ok(
    sent(out).some((c) => c.body.chat_id === pickedId && String(c.body.text).includes('Доступ открыт')),
    'одобренному пришла обучалка',
  );

  // Двойное нажатие «Разрешить» не шлёт обучалку второй раз
  await resetRateLimit();
  m = mark();
  await handleUpdate(privateButton(`ok:${pickedId}:p:1`, OWNER));
  ok(
    !sent(since(m)).some((c) => c.body.chat_id === pickedId),
    'повторное одобрение не шлёт обучалку снова',
  );

  await resetRateLimit();
  m = mark();
  await handleUpdate(privateButton('acc:a:0', OWNER));
  kb = keyboardOf(since(m));
  ok(kb.some((b) => b.text.startsWith('🚫 Отозвать')), 'в одобренных — кнопка отозвать');

  // Номер страницы за концом списка приводится к последней странице
  await resetRateLimit();
  m = mark();
  await handleUpdate(privateButton('acc:p:99', OWNER));
  ok(texts(since(m)).join('').includes('Страница 3 из 3'), 'страница за концом — последняя');

  await resetRateLimit();
  m = mark();
  await handleUpdate(privateButton('acc:p:0', STRANGER));
  ok(
    !texts(since(m)).join('').includes('Ждут решения') &&
      since(m).some((c) => c.method === 'answerCallbackQuery'),
    'чужому разделы доступа не открываются',
  );

  // Все экраны укладываются в лимиты Telegram даже на сотнях людей
  const { accessSectionScreen } = await import('../lib/admin');
  for (const id of Array.from({ length: 300 }, (_, i) => 9000 + i)) {
    await requestAccess(id, null, 'Очень длинное имя человека, который пришёл в бота'.repeat(2));
  }
  const big = await accessSectionScreen('p', 0);
  ok(big.text.length < 4096, `текст страницы в лимите: ${big.text.length}`);
  ok(big.keyboard.flat().length <= 100, `кнопок не больше 100: ${big.keyboard.flat().length}`);
  ok(
    big.keyboard.flat().every((b) => (b.callback_data ?? '').length <= 64),
    'callback_data каждой кнопки не длиннее 64 байт',
  );

  await resetAccess();
}

// ─── Обходы доступа ──────────────────────────────────────────────────────────

await resetRateLimit();
head('Без одобрения бот не открывается никаким путём');
{
  const { decideAccess, getChat: chatOf, requestAccess } = await import('../lib/db');
  const NEWBIE = 5151;
  const DENIED = 5252;
  await requestAccess(NEWBIE, 'newbie', 'Новичок');
  await requestAccess(DENIED, 'denied', 'Отказ');
  await decideAccess(DENIED, 'denied');

  // Заблокировать и разблокировать бота в личке — это my_chat_member
  for (const who of [NEWBIE, DENIED]) {
    await resetRateLimit();
    m = mark();
    await handleUpdate(membership('member', who, who, 'private'));
    ok((await chatOf(who)) === null, `разблокировка в личке не заводит чат (${who})`);
    ok(sent(since(m)).length === 0, 'и меню не присылает');
  }

  // Подделанные нажатия в личке без доступа
  for (const data of ['day:1', 'week', 'g:0', 'grp', 'st', 'about']) {
    await resetRateLimit();
    m = mark();
    await handleUpdate(privateButton(data, DENIED));
    ok(
      String(since(m).findLast((c) => c.method === 'answerCallbackQuery')?.body.text ?? '') !==
        '' && edited(since(m)).length === 0,
      `«${data}» без доступа не открывается`,
    );
  }
  ok((await chatOf(DENIED)) === null, 'подделанный выбор группы не завёл чат');

  // Отзыв доступа работает сразу, без нового /start
  const REVOKED = 5353;
  await decideAccess(REVOKED, 'approved');
  await resetRateLimit();
  await handleUpdate(message('/start', REVOKED, REVOKED, 'private'));
  ok((await chatOf(REVOKED))?.enabled === true, 'одобренный получил личку');
  await resetRateLimit();
  await handleUpdate(privateButton(`no:${REVOKED}:a:0`, OWNER));
  ok((await chatOf(REVOKED))?.enabled === false, 'после отзыва его личка выключена из рассылки');
  await resetRateLimit();
  m = mark();
  await handleUpdate(privateButton('day:1', REVOKED));
  ok(edited(since(m)).length === 0, 'и старые кнопки больше не работают');
  await resetRateLimit();
  m = mark();
  await handleUpdate(privateButton('m', REVOKED));
  ok(texts(since(m)).join('').includes('Доступ не открыт'), '«Меню» показывает, что доступа нет');
  await resetRateLimit();
  m = mark();
  await handleUpdate(privateButton('fb', REVOKED));
  ok(texts(since(m)).join('').includes('Баг или предложение'), 'а баг сообщить по-прежнему можно');

  // Группа без доступа: бот уходит, даже если писать туда ему нельзя
  const MUTED = -100777700;
  await failMethods(['sendMessage']);
  await resetRateLimit();
  m = mark();
  await handleUpdate(membership('member', DENIED, MUTED));
  ok(since(m).some((c) => c.method === 'leaveChat'), 'из чужой группы бот уходит и без сообщения');
  await failMethods([]);

  await resetAccess();
}

// ─── Счётчики команд и нажатий ───────────────────────────────────────────────

await resetRateLimit();
head('Нажатия одного не съедают /start у всей группы');
{
  for (let i = 0; i < 15; i++) await handleUpdate(button('m', STRANGER));
  m = mark();
  await handleUpdate(message('/start', STRANGER));
  ok(sent(since(m)).length === 1, '/start отвечает и после пятнадцати нажатий');

  const { recentLogs } = await import('../lib/db');
  ok(
    !(await recentLogs(200)).some((l) => l.message.startsWith('Нажатие ')),
    'быстрые нажатия не пишутся в журнал строкой на каждое',
  );
}

// ─── Нет данных — это не «пар нет» ───────────────────────────────────────────

await resetRateLimit();
await resetAlerts();
head('Нет расписания в базе — это не «Пар нет»');
{
  const NODATA = -100777400;
  const { db, getChat: chatOf } = await import('../lib/db');
  const { sendTomorrow } = await import('../lib/sync');

  await upsertChat(NODATA, 'Группа без скачанного расписания', OWNER);
  await db().from('chats').update({ groups: [UNLOADED], enabled: true }).eq('chat_id', NODATA);
  await setPinnedMessage(NODATA, null, null);

  m = mark();
  await handleUpdate(button('day:1', OWNER, NODATA));
  let text = texts(since(m)).join('');
  ok(text.includes(esc('ещё не загружено')), 'день без данных так и называется');
  ok(!text.includes('Пар нет'), 'и не выдаётся за день без пар');

  await resetRateLimit();
  m = mark();
  await handleUpdate(button('week', OWNER, NODATA));
  text = texts(since(m)).join('');
  ok(text.includes(esc('ещё не загружено')), 'неделя без данных — тоже');

  // Рассылка такой чат придерживает, пока ждать ещё есть смысл
  m = mark();
  const waited = await sendTomorrow(Date.now() + 20_000, false);
  ok(waited.waiting >= 1, `чат ждёт расписание: ${waited.waiting}`);
  ok(sent(since(m)).every((c) => c.body.chat_id !== NODATA), 'в него ничего не ушло');
  ok((await chatOf(NODATA))?.pinned_date !== mskDateOffset(1), 'и он не помечен отправленным');
  ok(waited.pending >= waited.waiting, 'ждущие считаются недоставленными — тик вернётся к ним');

  // Ждать больше некогда: уходит честное «не загружено», владелец узнаёт сам
  m = mark();
  const forced = await sendTomorrow(Date.now() + 20_000, true);
  const toChat = sent(since(m)).filter((c) => c.body.chat_id === NODATA);
  ok(forced.sent >= 1 && toChat.length === 1, 'после срока ожидания сообщение уходит');
  ok(String(toChat[0]?.body.text ?? '').includes(esc('ещё не загружено')), 'с честным текстом');
  ok(
    sent(since(m)).some(
      (c) => c.body.chat_id === OWNER && String(c.body.text).includes('Рассылка без расписания'),
    ),
    'владелец получил алерт, что у группы нет расписания',
  );

  await db().from('chats').update({ enabled: false }).eq('chat_id', NODATA);
}

// ─── Перерисовка закрепов только у изменившихся групп ────────────────────────

await resetRateLimit();
head('Закрепы перерисовываются только у изменившихся групп');
{
  const A = -100777500;
  const B = -100777501;
  const [groupA, groupB] = [groups[0].group, groups[1].group];
  const { db, getState: stateOf } = await import('../lib/db');
  const today = mskDateOffset(0);

  for (const [chat, group] of [[A, groupA], [B, groupB]] as const) {
    await upsertChat(chat, `Закреп ${group}`, OWNER);
    await db().from('chats').update({ groups: [group], enabled: true }).eq('chat_id', chat);
    await setPinnedMessage(chat, 5000 + Math.abs(chat % 100), today);
  }

  m = mark();
  await refreshPinned([groupA]);
  let editedChats = new Set(edited(since(m)).map((c) => Number(c.body.chat_id)));
  ok(editedChats.has(A), 'чат изменившейся группы перерисован');
  ok(!editedChats.has(B), 'чат другой группы не тронут');

  // Время кончилось — недоделанное запоминается и идёт первым на следующем тике
  m = mark();
  await refreshPinned([groupB], Date.now() - 1);
  ok(edited(since(m)).length === 0, 'после дедлайна ничего не правится');
  ok(((await stateOf<string[]>('pinned_stale_groups')) ?? []).includes(groupB), 'группа запомнена');

  m = mark();
  await refreshPinned([]);
  editedChats = new Set(edited(since(m)).map((c) => Number(c.body.chat_id)));
  ok(editedChats.has(B), 'на следующем проходе её закреп перерисован');
  ok((await stateOf<string[]>('pinned_stale_groups')) === null, 'и память об этом очищена');

  await db().from('chats').update({ enabled: false }).in('chat_id', [A, B]);
}

// ─── Обход всех групп на заглушке сайта ──────────────────────────────────────

await resetRateLimit();
head('Обход всех групп: очередь, дедлайн, пустые недели');
{
  const { checkSite } = await import('../lib/sync');
  const { activeChats, catalogEntries, db, getWeek, groupFileStatus, getState: stateOf } =
    await import('../lib/db');
  const { LAST_CHECK_KEY, SWEEP_ATTEMPTS_KEY } = await import('../lib/sweep');
  type CheckRecord = import('../lib/sweep').CheckRecord;
  type SiteAccess = import('../lib/sync').SiteAccess;
  type BrowserSession = import('../lib/browser').BrowserSession;

  const { monday } = weekBounds(weekAnchor());
  const catalog = await catalogEntries();
  const all = catalog.map((e) => e.group);
  const [EMPTY, BROKEN, KEEP] = [all[2], all[3], all[5]];

  const fetchedLog: string[] = [];
  const emptyNow = new Set<string>([EMPTY]);
  let delayMs = 0;
  let catalogOverride: typeof catalog | null = null;

  const weekFor = (group: string) =>
    Array.from({ length: 5 }, (_, i) => {
      const d = new Date(`${monday}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + i);
      const iso = d.toISOString().slice(0, 10);
      return {
        date: iso,
        name: dayNameOf(iso),
        lessons: [{ pair: 1, time: '08:20-09:50', subject: `Обход ${group}`, teacher: null, room: null, raw: '' }],
      };
    });

  const fakeSite: SiteAccess = {
    openSession: async <T,>(_url: string, fn: (session: BrowserSession) => Promise<T>) =>
      fn({ page: null as never }),
    fetchCatalog: async () => catalogOverride ?? catalog,
    fetchGroupSchedule: async (_page, entry) => {
      fetchedLog.push(entry.group);
      if (delayMs) await pause(delayMs);
      if (entry.group === BROKEN) throw new Error('ajax.php вернул не JSON: <!DOCTYPE html>');
      if (emptyNow.has(entry.group)) return [];
      return weekFor(entry.group);
    },
  };

  const clearSweepState = async () => {
    await forgetFiles();
    await db().from('app_state').delete().in('key', [SWEEP_ATTEMPTS_KEY, 'catalog_refreshed_date']);
    fetchedLog.length = 0;
  };

  const subscribed = new Set(
    (await activeChats()).flatMap((c) => c.groups).filter((g) => all.includes(g)),
  );

  // Холодный старт: в базе ни одной недели
  await clearSweepState();
  let result = await checkSite(Date.now() + 30_000, fakeSite);
  let record = await stateOf<CheckRecord>(LAST_CHECK_KEY);
  let files = await groupFileStatus();

  ok(fetchedLog.length === all.length, `за проход скачаны все ${all.length} групп каталога`);
  ok(files.size === all.length - 2, `в базе неделя у всех, кроме пустой и сломанной: ${files.size}`);
  ok(!files.has(EMPTY), 'пустую неделю с сайта не записали');
  ok(!files.has(BROKEN), 'сломанный ответ не записали');
  ok(record?.sweep?.empty.includes(EMPTY) === true, 'в отчёте видно, у кого сайт не отдал пар');
  ok(
    record?.sweep?.failed.some((f) => f.group === BROKEN && f.reason.includes('не JSON')) === true,
    'и кто не скачался и почему',
  );
  ok(result.changed.length === all.length - 2, 'изменения отмечены у всех записанных');
  const lastSubscribed = Math.max(...[...subscribed].map((g) => fetchedLog.indexOf(g)));
  const firstIdle = fetchedLog.findIndex((g) => !subscribed.has(g));
  ok(subscribed.size > 0 && lastSubscribed < firstIdle, 'подписанные группы скачаны первыми');
  {
    const week = await getWeek(all[0], monday);
    ok(week.days.length === 6, 'неделя дозаполнена до субботы');
    ok(week.days[0].lessons.length === 1 && week.days[5].lessons.length === 0, 'пары на месте');
  }
  const attempts = (await stateOf<Record<string, string>>(SWEEP_ATTEMPTS_KEY)) ?? {};
  ok(Object.keys(attempts).length === all.length, 'попытки запомнены у всех, включая пустые');

  // Сразу второй проход: всё свежее, пустую и сломанную не дёргаем каждый тик
  fetchedLog.length = 0;
  result = await checkSite(Date.now() + 30_000, fakeSite);
  record = await stateOf<CheckRecord>(LAST_CHECK_KEY);
  ok(fetchedLog.length === 0, `второй проход подряд ничего не качает: ${fetchedLog.join(', ')}`);
  ok(record?.sweep?.planned === 0, 'очередь пуста');

  // Пустой ответ сайта не стирает уже загруженную неделю
  emptyNow.add(KEEP);
  const keepBefore = (await groupFileStatus()).get(KEEP);
  await db()
    .from('files')
    .update({ last_seen: new Date(Date.now() - 3 * 3_600_000).toISOString() })
    .eq('name', groupFileName(KEEP));
  await db().from('app_state').delete().eq('key', SWEEP_ATTEMPTS_KEY);
  const KEEPER = -100777600;
  await upsertChat(KEEPER, 'Подписка на группу', OWNER);
  await db().from('chats').update({ groups: [KEEP], enabled: true }).eq('chat_id', KEEPER);
  fetchedLog.length = 0;
  await checkSite(Date.now() + 30_000, fakeSite);
  ok(fetchedLog[0] === KEEP, 'давно не проверенная подписанная группа пошла первой');
  ok(
    (await groupFileStatus()).get(KEEP)?.weekStart === keepBefore?.weekStart,
    'неделя на месте после пустого ответа',
  );
  ok(
    (await getWeek(KEEP, monday)).days.some((d) => d.lessons.length > 0),
    'и пары никуда не делись',
  );
  emptyNow.delete(KEEP);
  await db().from('chats').update({ enabled: false }).eq('chat_id', KEEPER);

  // Дедлайн: сделанное сохраняется, следующий проход продолжает с того же места
  await clearSweepState();
  delayMs = 40;
  const firstRun = await checkSite(Date.now() + 300, fakeSite);
  const firstFetched = [...fetchedLog];
  files = await groupFileStatus();
  ok(
    firstFetched.length > 0 && firstFetched.length < all.length,
    `до дедлайна успели часть: ${firstFetched.length} из ${all.length}`,
  );
  ok(files.size > 0, `и она уже в базе: ${files.size}`);
  ok(firstRun.filesOnSite === firstFetched.length - (firstFetched.includes(BROKEN) ? 1 : 0), 'отчёт сходится');

  delayMs = 0;
  fetchedLog.length = 0;
  await checkSite(Date.now() + 30_000, fakeSite);
  const overlap = fetchedLog.filter((g) => firstFetched.includes(g) && !subscribed.has(g));
  ok(overlap.length === 0, `второй проход не качает заново уже скачанное: ${overlap.join(', ')}`);
  {
    const loaded = await groupFileStatus();
    const missingNow = all.filter((g) => !loaded.has(g) && g !== EMPTY && g !== BROKEN);
    ok(missingNow.length === 0, `за два прохода загружено всё, не хватает: ${missingNow.join(', ')}`);

  }

  // Курс пришёл с сайта пустым — это сбой, а не расформирование всех групп
  await db().from('app_state').delete().eq('key', 'catalog_refreshed_date');
  const lostYear = catalog[0].year;
  catalogOverride = catalog.filter((e) => e.year !== lostYear);
  await checkSite(Date.now() + 30_000, fakeSite);
  ok(
    (await catalogEntries()).some((e) => e.year === lostYear),
    `каталог не потерял «${lostYear}» из-за пустого ответа`,
  );
  ok(
    (await catalogEntries()).length === catalog.length,
    'остальные курсы обновлены, ничего не пропало',
  );
  ok(
    (await stateOf<string>('catalog_refreshed_date')) === mskDateOffset(0),
    'и каталог не переспрашивается на каждом тике',
  );
  catalogOverride = null;
}

// ─── Тики не накладываются ───────────────────────────────────────────────────

await resetRateLimit();
head('Два тика разом не идут');
{
  const { acquireLock, releaseLock, db } = await import('../lib/db');

  ok(await acquireLock('tick_lock', 75_000), 'замок взят');
  m = mark();
  const busy = await tick(true);
  ok(busy.locked === true, 'второй тик видит замок и ничего не делает');
  ok(sent(since(m)).length === 0, 'и ничего не рассылает');
  ok(!(await acquireLock('tick_lock', 75_000)), 'второй раз тот же замок не берётся');
  await releaseLock('tick_lock');

  const free = await tick(true);
  ok(!free.locked, 'после снятия замка тик идёт');
  ok(await acquireLock('tick_lock', 75_000), 'и сам замок за собой снимает');

  // Тик убили по таймауту, замок остался: через срок он протухает
  await db()
    .from('app_state')
    .update({ updated_at: new Date(Date.now() - 120_000).toISOString() })
    .eq('key', 'tick_lock');
  ok(await acquireLock('tick_lock', 75_000), 'протухший замок не мешает следующему тику');
  await releaseLock('tick_lock');
}

console.log(failures ? `\nПРОВАЛЕНО ПРОВЕРОК: ${failures}\n` : '\nВсе проверки прошли\n');
process.exitCode = failures ? 1 : 0;
