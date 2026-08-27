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
import { readFileSync } from 'node:fs';
import { handleUpdate, type TgUpdate } from '../lib/bot';
import { tick } from '../lib/sync';
import { getChat, listGroups, upsertChat } from '../lib/db';

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

function message(text: string, from = OWNER, chatId = CHAT): TgUpdate {
  return {
    message: {
      message_id: Math.floor(Math.random() * 100000),
      from: { id: from },
      chat: { id: chatId, type: 'supergroup', title: 'Тестовая группа' },
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

/** Заставляет дублёр Telegram отклонять указанные методы. */
async function failMethods(methods: string[]): Promise<void> {
  await fetch(`${process.env.TELEGRAM_API_BASE}/bot/__fail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ methods }),
  });
}

// ─── Наполняем базу настоящим расписанием ────────────────────────────────────

head('Подготовка: загрузка расписания с сайта');
await resetChat();
await resetRateLimit();
const first = await tick(false);
ok(first.check !== null && first.check.errors.length === 0, 'сайт проверен без ошибок');
const groups = await listGroups();
ok(groups.length > 50, `в базе ${groups.length} групп`);

// ─── Список разрешённых чатов ────────────────────────────────────────────────

head('Список разрешённых чатов');
let m = mark();
await handleUpdate(message('/start', STRANGER, -999));
ok(sent(since(m)).length === 0, 'бот молчит в неизвестном чате');

m = mark();
await handleUpdate(message('/start', STRANGER, -997));
ok(sent(since(m)).length === 0, 'обычный участник не подключает новый чат');

m = mark();
await handleUpdate(message('/start', GROUP_ADMIN, -996));
ok(sent(since(m)).length === 0, 'админ группы, но не владелец бота, тоже не подключает');

// ─── Добавление в группу ─────────────────────────────────────────────────────

head('Бота добавили в группу');
m = mark();
await handleUpdate(membership('member', STRANGER, -998));
ok(sent(since(m)).length === 0, 'посторонний не подключает чат добавлением бота');

m = mark();
await handleUpdate(membership('member', OWNER));
let added = since(m);
ok(sent(added).length === 1, 'меню появляется само, без команд');
ok(texts(added).join('').includes('Расписание колледжа МУИВ'), 'это меню');
ok(texts(added).join('').includes('Закреплять сообщения'), 'напоминание про право закрепления');
ok(keyboardOf(added).length > 0, 'под меню есть кнопки');
ok((await getChat(CHAT))?.enabled === true, 'чат подключён и включён');

// В личке напоминание про закрепление не нужно
await resetChat();
m = mark();
await handleUpdate(membership('member', OWNER, OWNER, 'private'));
ok(!texts(since(m)).join('').includes('Закреплять сообщения'), 'в личке про закрепление молчим');

// Бота выгнали — автоотправка должна выключиться
await resetChat();
await handleUpdate(membership('member', OWNER));
m = mark();
await handleUpdate(membership('kicked', OWNER));
ok((await getChat(CHAT))?.enabled === false, 'после удаления бота автоотправка выключена');
ok(sent(since(m)).length === 0, 'при удалении бот ничего не пишет');

// Возвращаем чат в рабочее состояние для остальных проверок
await resetChat();
await resetRateLimit();
await handleUpdate(membership('member', OWNER));

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
for (let i = 0; i < 30; i++) await handleUpdate(button('m'));
const answered = edited(since(m)).length;
ok(answered === 20, `из 30 нажатий обработано ${answered} — лимит 20 в минуту`);

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
ok(second.autoSend === 'sent', 'повторная рассылка выполнена');
ok(after.some((c) => c.method === 'unpinChatMessage'), 'прошлое закрепление снято');

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
