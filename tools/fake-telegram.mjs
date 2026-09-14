/**
 * Дублёр Telegram Bot API для локальных проверок бота.
 * Отвечает как настоящий API и складывает все вызовы в JSON-файл,
 * чтобы тест мог проверить, что именно бот отправил.
 *
 * Запуск: node tools/fake-telegram.mjs [порт] [файл-журнала]
 */
import http from 'node:http';
import { writeFileSync } from 'node:fs';

const port = Number(process.argv[2] ?? 54322);
const logPath = process.argv[3] ?? '/tmp/fake-telegram.json';

const calls = [];
let messageId = 1000;

/**
 * Методы, которые нужно ронять. Управляется запросом на /__fail —
 * так тест проверяет, что бот выживает при отказах Bot API.
 */
let failing = new Set();

/**
 * Чаты, из которых бота «выгнали»: любой вызов к ним получает 403.
 * Управляется запросом на /__gone — так проверяется, что бот не будит
 * владельца из-за апдейта из недоступного чата.
 */
let gone = new Set();

/** Темы, которых «больше нет»: отправка в них получает 400. */
let goneTopics = new Set();

/** Последний текст правки на чат — чтобы изображать «message is not modified». */
const lastEdit = new Map();

/**
 * Грубая, но полезная проверка MarkdownV2 — настоящий Telegram именно так
 * ронял бы sendMessage/editMessageText с этим текстом. Раньше заглушка
 * молча принимала любой текст, и опечатка в экранировании (например, сырой
 * URL с точкой прямо в тексте) обнаруживалась только в проде.
 *
 * Логика: вырезаем все правильно оформленные сущности (жирный, курсив, код,
 * зачёркивание, спойлер, ссылки — с учётом их формальных пар), а всё, что
 * осталось, должно иметь любой из 18 зарезервированных символов
 * экранированным обратным слэшем.
 */
const MDV2_RESERVED = '_*[]()~`>#+-=|{}.!';

function stripEntities(text) {
  let prev;
  let out = text;
  do {
    prev = out;
    out = out
      // Раскрывающаяся блок-цитата: **>...|| — свой тип сущности Telegram,
      // не «пустой жирный» + обычная цитата (см. lib/format.ts: quote())
      .replace(/\*\*>([\s\S]*?)\|\|/g, '$1')
      // Ссылка или кастомный эмодзи (![глиф](tg://emoji?id=...)) — текст
      // внутри всё равно проверяется дальше как обычный
      .replace(/!?\[([^\]\n]*)\]\(([^)\n\\]|\\.)*\)/g, '$1')
      // Жирный/подчёркивание/зачёркивание/код — одинарные маркеры вокруг непустого текста
      .replace(/\*([^*\n]+)\*/g, '$1')
      .replace(/(?<![a-zA-Zа-яА-Я0-9])_([^_\n]+)_(?![a-zA-Zа-яА-Я0-9])/g, '$1')
      .replace(/~([^~\n]+)~/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/\|\|([^|\n]+)\|\|/g, '$1')
      // Блок-цитата: `>` в начале строки — легальный маркер, не текст
      .replace(/^>/gm, '');
  } while (out !== prev);
  return out;
}

/** Возвращает текст ошибки, если разметка невалидна, иначе null. */
function checkMarkdownV2(text) {
  // Сначала снимаем все экранированные символы — их наличие само по себе
  // законно везде, включая внутри и снаружи сущностей
  const withoutEscapes = text.replace(/\\./g, '');
  const stripped = stripEntities(withoutEscapes);

  for (const ch of stripped) {
    if (MDV2_RESERVED.includes(ch)) {
      return `Bad Request: can't parse entities: Character '${ch}' is reserved and must be escaped with the preceding '\\'`;
    }
  }
  return null;
}

/** Кто считается админом чата — задаётся через переменную окружения. */
const admins = new Set(
  (process.env.FAKE_TG_ADMINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

function result(method, body) {
  switch (method) {
    case 'sendMessage':
      return { message_id: ++messageId, chat: { id: body.chat_id }, text: body.text };
    case 'getChatMember':
      return { status: admins.has(String(body.user_id)) ? 'administrator' : 'member' };
    case 'getMe':
      return { id: 1, is_bot: true, username: 'fake_bot' };
    case 'setMyDescription':
    case 'setMyShortDescription':
      return true;
    case 'getWebhookInfo':
      return { url: 'https://example.test/api/bot', has_custom_certificate: false };
    default:
      return true;
  }
}

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const method = req.url.split('/').pop();

      if (method === '__fail') {
        failing = new Set(raw ? JSON.parse(raw).methods : []);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, failing: [...failing] }));
        return;
      }

      if (method === '__gone') {
        const payload = raw ? JSON.parse(raw) : {};
        gone = new Set((payload.chats ?? []).map(String));
        goneTopics = new Set((payload.topics ?? []).map(String));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, gone: [...gone], goneTopics: [...goneTopics] }));
        return;
      }

      const body = raw ? JSON.parse(raw) : {};

      if (body.chat_id !== undefined && gone.has(String(body.chat_id))) {
        calls.push({ method, body, failed: true });
        writeFileSync(logPath, JSON.stringify(calls, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error_code: 403,
            description: 'Forbidden: bot is not a member of the supergroup chat',
          }),
        );
        return;
      }

      if (
        body.message_thread_id !== undefined &&
        goneTopics.has(String(body.message_thread_id))
      ) {
        calls.push({ method, body, failed: true });
        writeFileSync(logPath, JSON.stringify(calls, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: 'Bad Request: message thread not found',
          }),
        );
        return;
      }

      if (failing.has(method)) {
        calls.push({ method, body, failed: true });
        writeFileSync(logPath, JSON.stringify(calls, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: `Bad Request: ${method} отклонён (заглушка)`,
          }),
        );
        return;
      }
      // Повтор той же правки: Telegram отвечает ошибкой, а не успехом
      if (method === 'editMessageText' && lastEdit.get(String(body.chat_id)) === body.text) {
        calls.push({ method, body, notModified: true });
        writeFileSync(logPath, JSON.stringify(calls, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: 'Bad Request: message is not modified',
          }),
        );
        return;
      }
      if (
        (method === 'sendMessage' || method === 'editMessageText') &&
        body.parse_mode === 'MarkdownV2' &&
        typeof body.text === 'string'
      ) {
        const markdownError = checkMarkdownV2(body.text);
        if (markdownError) {
          calls.push({ method, body, failed: true, markdownError });
          writeFileSync(logPath, JSON.stringify(calls, null, 2));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error_code: 400, description: markdownError }));
          return;
        }
      }

      if (method === 'editMessageText') lastEdit.set(String(body.chat_id), body.text);

      calls.push({ method, body });
      writeFileSync(logPath, JSON.stringify(calls, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: result(method, body) }));
    });
  })
  .listen(port, () => {
    console.log(`дублёр Telegram на http://127.0.0.1:${port} (журнал: ${logPath})`);
  });
