import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAjaxResponse } from '../lib/browser';

// Заглушка, снятая вживую с muiv.ru в октябре 2026: раздел расписания отдаёт 301 на `/`,
// а там страница техработ вместо сайта.
const MAINTENANCE_PAGE = `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>МУИВ</title></head>
<body><div class="status">Сервис временно недоступен</div>
<p class="subtitle">Работоспособность сервиса будет восстановлена в ближайшее время.</p></body></html>`;

test('parseAjaxResponse разбирает JSON-ответ ajax.php', () => {
  assert.deepEqual(parseAjaxResponse('{"studyform":"<a data-type=\\"item\\">Очная</a>"}'), {
    studyform: '<a data-type="item">Очная</a>',
  });
});

test('parseAjaxResponse называет техработы сайта прямо, а не показывает кусок HTML', () => {
  assert.throws(
    () => parseAjaxResponse(MAINTENANCE_PAGE),
    (error: Error) => {
      assert.match(error.message, /сайт МУИВ на техобслуживании/);
      assert.doesNotMatch(error.message, /<!DOCTYPE/);
      return true;
    },
  );
});

test('parseAjaxResponse сохраняет начало ответа для неизвестного не-JSON', () => {
  assert.throws(
    () => parseAjaxResponse('<html>что-то новое</html>'),
    /ajax\.php вернул не JSON: <html>что-то новое<\/html>/,
  );
});
