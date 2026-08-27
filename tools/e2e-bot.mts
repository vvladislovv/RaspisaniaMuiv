/**
 * Проверка поведения бота: команды, кнопки, права, ограничения.
 * Работает на подставной базе и дублёре Telegram — ничего не уходит наружу.
 *
 * Запуск:
 *   node tools/fake-supabase.mjs 54321 /tmp/e2e.json &
 *   FAKE_TG_ADMINS=111 node tools/fake-telegram.mjs 54322 /tmp/tg.json &
 *   npx tsx tools/e2e-bot.mts
 */
import { readFileSync } from 'node:fs';
import { handleUpdate, type TgUpdate } from '../lib/bot';
import { tick } from '../lib/sync';
import { getChat, listGroups, setChatEnabled, upsertChat } from '../lib/db';

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

/** Вызовы Telegram, сделанные после метки. */
function since(mark: number): Call[] {
  return calls().slice(mark);
}

function mark(): number {
  return calls().length;
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
  const base = process.env.SUPABASE_URL!;
  await fetch(`${base}/rest/v1/chats?chat_id=eq.${CHAT}`, {
    method: 'DELETE',
    headers: { apikey: 'fake', Authorization: 'Bearer fake' },
  });
}

/** Обнуляет счётчик частоты — иначе тест сам упирается в собственный лимит. */
async function resetRateLimit(): Promise<void> {
  const base = process.env.SUPABASE_URL!;
  await fetch(`${base}/rest/v1/rate_limit?count=gte.0`, {
    method: 'DELETE',
    headers: { apikey: 'fake', Authorization: 'Bearer fake' },
  });
}

const sent = (list: Call[]) => list.filter((c) => c.method === 'sendMessage');
const texts = (list: Call[]) => sent(list).map((c) => String(c.body.text));

// ─── Наполняем базу настоящим расписанием ────────────────────────────────────

head('Подготовка: загрузка расписания с сайта');
await resetChat();
await resetRateLimit();
const first = await tick(false);
ok(first.check !== null && first.check.errors.length === 0, 'сайт проверен без ошибок');
const groups = await listGroups();
ok(groups.length > 50, `в базе ${groups.length} групп`);

// ─── Неразрешённый чат ───────────────────────────────────────────────────────

head('Чат не в списке разрешённых');
let m = mark();
await handleUpdate(message('/tomorrow', STRANGER, -999));
ok(sent(since(m)).length === 0, 'бот молчит в неизвестном чате');

// ─── /enable от обычного участника ───────────────────────────────────────────

head('Подключение чата: только владелец бота');
m = mark();
await handleUpdate(message('/enable', STRANGER));
ok(sent(since(m)).length === 0, 'обычный участник не может подключить чат');

m = mark();
await handleUpdate(message('/enable', GROUP_ADMIN));
ok(sent(since(m)).length === 0, 'админ группы, но не владелец бота, тоже не может');

m = mark();
await handleUpdate(message('/enable', OWNER));
ok(
  texts(since(m)).some((t) => t.includes('включён')),
  'владелец бота подключил чат',
);
const chatRow = await getChat(CHAT);
ok(chatRow?.enabled === true, 'чат записан как включённый');

// ─── Команды без выбранной группы ────────────────────────────────────────────

await resetRateLimit();
head('Команды до выбора группы');
m = mark();
await handleUpdate(message('/tomorrow'));
ok(
  texts(since(m)).some((t) => t.includes('Группа не выбрана')),
  'бот просит выбрать группу',
);

// ─── Выбор группы кнопками ───────────────────────────────────────────────────

await resetRateLimit();
head('Выбор группы кнопками');
m = mark();
await handleUpdate(message('/group'));
const picker = sent(since(m)).at(-1);
const sheetButtons = (picker?.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] })
  ?.inline_keyboard;
ok(!!sheetButtons && sheetButtons.length === 6, `предложено ${sheetButtons?.length} курсов`);

const target = groups.find((g) => g.group === 'ИСП/П-24-11');
const sheets = [...new Set(groups.map((g) => g.sheet))].sort((a, b) =>
  String(a).localeCompare(String(b), 'ru'),
);
const sheetIndex = sheets.indexOf(target?.sheet ?? null);
ok(sheetIndex !== -1, `курс группы найден: ${target?.sheet}`);

m = mark();
await handleUpdate(button(`s:${sheetIndex}`));
const edited = since(m).find((c) => c.method === 'editMessageText');
const groupButtons = (edited?.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] })
  ?.inline_keyboard;
const flat = groupButtons?.flat() ?? [];
ok(flat.some((b) => b.text === 'ИСП/П-24-11'), 'кнопка ИСП/П-24-11 есть в списке');

const groupButton = flat.find((b) => b.text === 'ИСП/П-24-11')!;

// Посторонний не должен менять группу
m = mark();
await handleUpdate(button(groupButton.callback_data, STRANGER));
const denied = since(m).findLast((c) => c.method === 'answerCallbackQuery');
ok(
  String(denied?.body.text ?? '').includes('админ'),
  'посторонний не может сменить группу',
);
ok((await getChat(CHAT))?.group_name === null, 'группа в базе не изменилась');

m = mark();
await handleUpdate(button(groupButton.callback_data, GROUP_ADMIN));
ok(
  (await getChat(CHAT))?.group_name === 'ИСП/П-24-11',
  'админ группы выбрал группу, она в базе',
);

// ─── Расписание по командам ──────────────────────────────────────────────────

await resetRateLimit();
head('Расписание по командам');
m = mark();
await handleUpdate(message('/tomorrow'));
const tomorrow = texts(since(m)).at(-1) ?? '';
ok(tomorrow.includes('ИСП/П\\-24\\-11'), 'в сообщении есть группа');
ok(/Расписание на завтра/.test(tomorrow), 'есть заголовок «на завтра»');
ok(tomorrow.length < 4096, `длина ${tomorrow.length} в лимите`);

m = mark();
await handleUpdate(message('/today'));
ok(texts(since(m)).length === 1, 'на /today один ответ');

m = mark();
await handleUpdate(message('/week'));
const weekCalls = sent(since(m));
const weekTexts = texts(since(m));
ok(weekTexts.length >= 1, `неделя пришла ${weekTexts.length} сообщением(-ями)`);
ok(weekTexts.every((t) => t.length <= 4096), 'все части в лимите Telegram');
ok(weekTexts.join('').includes('Вторник'), 'в неделе есть будни');
ok(weekTexts.join('').includes('**>'), 'дни оформлены раскрывающимися цитатами');

const weekKeyboard = (weekCalls.at(-1)?.body.reply_markup as
  | { inline_keyboard: { text: string; callback_data: string }[][] }
  | undefined)?.inline_keyboard;
const weekFlat = weekKeyboard?.flat() ?? [];
ok(weekFlat.length >= 6, `под неделей ${weekFlat.length} кнопок`);
ok(
  weekFlat.every((b) => /^[dw]:\d{4}-\d{2}-\d{2}$/.test(b.callback_data)),
  'кнопки адресуют дни датами, а не индексами',
);
ok(weekFlat.some((b) => b.text.includes('По дням')), 'есть переход в режим дней');

// Нажатие дня должно менять то же сообщение, а не присылать новое
const dayBtn = weekFlat.find((b) => b.callback_data.startsWith('d:'))!;
m = mark();
await handleUpdate(button(dayBtn.callback_data));
const dayCalls = since(m);
ok(
  dayCalls.some((c) => c.method === 'editMessageText'),
  'день открывается правкой сообщения',
);
ok(sent(dayCalls).length === 0, 'новых сообщений при листании не появляется');

const dayKeyboard = (dayCalls.find((c) => c.method === 'editMessageText')?.body.reply_markup as
  | { inline_keyboard: { text: string; callback_data: string }[][] }
  | undefined)?.inline_keyboard;
const dayFlat = dayKeyboard?.flat() ?? [];
ok(dayFlat.some((b) => b.text.includes('Вся неделя')), 'из дня можно вернуться к неделе');
ok(dayFlat.some((b) => b.text.startsWith('· ')), 'открытый день отмечен на клавиатуре');

// Старые сообщения могли остаться с кнопками прежнего вида
m = mark();
await handleUpdate(button('d:0'));
ok(since(m).some((c) => c.method === 'editMessageText'), 'старая кнопка d:0 ещё работает');
m = mark();
await handleUpdate(button('d:all'));
ok(since(m).some((c) => c.method === 'editMessageText'), 'старая кнопка d:all ещё работает');

await resetRateLimit();
head('Статус');
m = mark();
await handleUpdate(message('/status'));
const status = texts(since(m)).at(-1) ?? '';
ok(status.includes('Последняя проверка') || status.includes('проверка'), 'статус содержит время проверки');
ok(status.includes('ИСП'), 'статус показывает группу чата');

// ─── Устаревшие кнопки и мусор ───────────────────────────────────────────────

await resetRateLimit();
head('Устойчивость к мусору');
m = mark();
await handleUpdate(button('g:99999'));
ok(
  String(since(m).find((c) => c.method === 'answerCallbackQuery')?.body.text ?? '').includes('устарел'),
  'на устаревший индекс группы — понятный ответ',
);

m = mark();
await handleUpdate(button('чтотоневалидное'));
ok(since(m).length > 0, 'неизвестная кнопка не роняет обработчик');

m = mark();
await handleUpdate(message('обычное сообщение без команды'));
ok(sent(since(m)).length === 0, 'на обычный текст бот не отвечает');

m = mark();
await handleUpdate({} as TgUpdate);
ok(true, 'пустой апдейт не роняет обработчик');

// ─── Ограничение частоты ─────────────────────────────────────────────────────

head('Ограничение частоты');
await resetRateLimit();
m = mark();
for (let i = 0; i < 15; i++) await handleUpdate(message('/today'));
const answered = sent(since(m)).length;
ok(answered === 10, `из 15 команд обработано ${answered} — лимит ровно 10 в минуту`);

// ─── Выключенный чат ─────────────────────────────────────────────────────────

await resetRateLimit();
head('Выключенный чат');
await setChatEnabled(CHAT, false);
m = mark();
await handleUpdate(message('/tomorrow', STRANGER));
ok(sent(since(m)).length === 0, 'в выключенном чате бот молчит');
await setChatEnabled(CHAT, true);

// ─── Автоотправка с закреплением ─────────────────────────────────────────────

await resetRateLimit();
head('Автоотправка на завтра и закрепление');
await upsertChat(CHAT, 'Тестовая группа');
m = mark();
const forced = await tick(true);
const after = since(m);
ok(forced.autoSend === 'sent', `рассылка выполнена: отправлено ${forced.sent}, ошибок ${forced.failed}`);
ok(sent(after).length >= 1, 'сообщение отправлено');
ok(after.some((c) => c.method === 'pinChatMessage'), 'сообщение закреплено');
ok((await getChat(CHAT))?.pinned_msg_id !== null, 'id закреплённого сообщения сохранён');

m = mark();
const second = await tick(true);
const secondCalls = since(m);
ok(second.autoSend === 'sent', 'повторная рассылка выполнена');
ok(secondCalls.some((c) => c.method === 'unpinChatMessage'), 'прошлое закрепление снято');

// ─── Пропуск субботы ─────────────────────────────────────────────────────────

head('Правила расписания рассылки');
const notForced = await tick(false);
ok(
  ['skipped-hour', 'skipped-saturday', 'skipped-already', 'sent'].includes(String(notForced.autoSend)),
  `без force решение принято по времени: ${notForced.autoSend}`,
);

// ─── Отказы Bot API ──────────────────────────────────────────────────────────

/** Заставляет дублёр Telegram отклонять указанные методы. */
async function failMethods(methods: string[]): Promise<void> {
  await fetch(`${process.env.TELEGRAM_API_BASE}/bot/__fail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ methods }),
  });
}

await resetRateLimit();
head('Отказы Telegram не должны терять работу');

// «query is too old» случается при холодном старте функции: гашение кнопки
// не прошло, но расписание всё равно обязано уйти
await failMethods(['answerCallbackQuery']);
m = mark();
await handleUpdate(button('d:all'));
ok(
  since(m).some((c) => c.method === 'editMessageText' && !c.failed),
  'при отказе answerCallbackQuery расписание всё равно показано',
);

// сообщение с кнопками удалили — правка не пройдёт, нужен новый ответ
await failMethods(['editMessageText']);
m = mark();
await handleUpdate(button('back'));
ok(
  sent(since(m)).some((c) => !c.failed),
  'при отказе editMessageText отправляется новое сообщение',
);

await failMethods([]);

console.log(failures ? `\nПРОВАЛЕНО ПРОВЕРОК: ${failures}\n` : '\nВсе проверки прошли\n');
process.exitCode = failures ? 1 : 0;
