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
  listGroups,
  replaceSchedules,
  setPinnedMessage,
  upsertChat,
  upsertFile,
} from '../lib/db';
import { parseSchedule } from '../lib/parse';
import { mskDateOffset } from '../lib/time';

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
      from: { id: from },
      chat:
        type === 'private'
          ? { id: chatId, type: 'private' }
          : { id: chatId, type: 'supergroup', title: 'Тестовая группа' },
      text,
    },
  };
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

/** Убирает следы прошлого прогона, чтобы тест можно было запускать повторно. */
async function resetChat(): Promise<void> {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/chats?chat_id=eq.${CHAT}`, {
    method: 'DELETE',
    headers: { apikey: 'fake', Authorization: 'Bearer fake' },
  });
}

/** Обнуляет счётчик частоты — иначе тест сам упирается в собственный лимит. */
async function resetRateLimit(): Promise<void> {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/rate_limit?count=gte.0`, {
    method: 'DELETE',
    headers: { apikey: 'fake', Authorization: 'Bearer fake' },
  });
}

/** Забывает скачанные файлы — следующая проверка сочтёт расписание изменившимся. */
async function forgetFiles(): Promise<void> {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/files?id=gte.0`, {
    method: 'DELETE',
    headers: { apikey: 'fake', Authorization: 'Bearer fake' },
  });
}

/** Забывает отметки о разосланных алертах — иначе повтор прогона их подавит. */
async function resetAlerts(): Promise<void> {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/app_state?key=like.alert:*`, {
    method: 'DELETE',
    headers: { apikey: 'fake', Authorization: 'Bearer fake' },
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

// ─── Список разрешённых чатов ────────────────────────────────────────────────

head('Публичный доступ');
let m = mark();
await handleUpdate(message('/start', STRANGER, -999));
ok(sent(since(m)).length === 1, 'любой чат подключается сам');
ok((await getChat(-999))?.enabled === true, 'новый чат сразу включён');

m = mark();
await handleUpdate(message('/start', STRANGER, STRANGER, 'private'));
const dm = since(m);
ok(sent(dm).length === 1, 'в личке тоже отвечает');
ok(
  texts(dm).join('').includes('Как добавить в группу'),
  'в личке есть инструкция по добавлению в группу',
);
ok(
  texts(dm).join('').includes('Закрепление сообщений'),
  'сказано, какое право нужно дать',
);
ok(
  keyboardOf(dm).some((b) => String(b.url ?? '').includes('startgroup')),
  'есть кнопка-ссылка «Добавить в группу»',
);
ok(!find(keyboardOf(dm), 'Сводка'), 'постороннему сводка не предлагается');

m = mark();
await handleUpdate(message('/start', OWNER, OWNER, 'private'));
ok(!!find(keyboardOf(since(m)), 'Сводка'), 'владельцу предлагается сводка');

// ─── Добавление в группу ─────────────────────────────────────────────────────

head('Бота добавили в группу');
m = mark();
await handleUpdate(membership('member', STRANGER, -998));
ok(sent(since(m)).length === 1, 'бота может добавить любой — меню появляется');

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
ok(buttons.filter((b) => b.callback_data.startsWith('s:')).length === 6, 'предложено 6 курсов');
ok(!!find(buttons, 'Меню'), 'с экрана курсов есть путь назад');

const target = groups.find((g) => g.group === 'ИСП/П-24-11')!;
const sheets = [...new Set(groups.map((g) => g.sheet))].sort((a, b) =>
  String(a).localeCompare(String(b), 'ru'),
);
const sheetIndex = sheets.indexOf(target.sheet);
ok(sheetIndex !== -1, `курс группы найден: ${target.sheet}`);

m = mark();
await handleUpdate(button(`s:${sheetIndex}`));
buttons = keyboardOf(since(m));
const groupButton = buttons.find((b) => b.text === 'ИСП/П-24-11');
ok(!!groupButton, 'кнопка ИСП/П-24-11 есть в списке');

m = mark();
await handleUpdate(button(groupButton!.callback_data, STRANGER));
ok(
  String(since(m).findLast((c) => c.method === 'answerCallbackQuery')?.body.text ?? '').includes(
    'админ',
  ),
  'посторонний не может сменить группу',
);
ok((await getChat(CHAT))?.group_name === null, 'группа в базе не изменилась');

m = mark();
await handleUpdate(button(groupButton!.callback_data, GROUP_ADMIN));
ok((await getChat(CHAT))?.group_name === 'ИСП/П-24-11', 'админ группы выбрал группу');
ok(edited(since(m)).length === 1, 'после выбора сообщение заменяется на меню');
buttons = keyboardOf(since(m));
ok(!!find(buttons, 'Завтра') && !!find(buttons, 'Вся неделя'), 'в меню появилось расписание');

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
  (await getChat(CHAT))?.group_name === 'ИСП/П-24-11',
  'но подтвердить смену группы участник не может',
);

// ─── Статус и переключатель автоотправки ─────────────────────────────────────

await resetRateLimit();
head('Статус и автоотправка');
m = mark();
await handleUpdate(button('st'));
screen = since(m);
ok(texts(screen).join('').includes('Последняя проверка'), 'статус показывает время проверки');
ok(texts(screen).join('').includes('ИСП'), 'статус показывает группу');
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
// откажется разбирать разметку
const bare = about
  .replace(/\\./g, '')
  .replace(/\[[^\]]*\]\([^)]*\)/g, '')
  .replace(/[*_]/g, '');
ok(!/[.!()\-]/.test(bare), `в тексте нет неэкранированных символов: ${bare.slice(0, 60)}`);

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

// ─── Ограничение частоты ─────────────────────────────────────────────────────

head('Ограничение частоты');
await resetRateLimit();
m = mark();
for (let i = 0; i < 70; i++) await handleUpdate(button('m'));
const answered = edited(since(m)).length;
ok(answered === 60, `из 70 нажатий обработано ${answered} — лимит 60 в минуту`);

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

console.log(failures ? `\nПРОВАЛЕНО ПРОВЕРОК: ${failures}\n` : '\nВсе проверки прошли\n');
process.exitCode = failures ? 1 : 0;
