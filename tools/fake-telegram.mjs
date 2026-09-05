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
