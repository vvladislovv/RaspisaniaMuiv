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

      const body = raw ? JSON.parse(raw) : {};

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
      calls.push({ method, body });
      writeFileSync(logPath, JSON.stringify(calls, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: result(method, body) }));
    });
  })
  .listen(port, () => {
    console.log(`дублёр Telegram на http://127.0.0.1:${port} (журнал: ${logPath})`);
  });
