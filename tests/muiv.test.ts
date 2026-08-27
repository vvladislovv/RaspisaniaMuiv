import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jhash, parseFileList } from '../lib/muiv';

test('jhash совпадает со значениями из браузера', () => {
  // Пары (код из куки __js_p_, хеш, который поставил браузер) — снято с живого сайта
  assert.equal(jhash(311), 115);
  assert.equal(jhash(430), 724);
});

test('parseFileList находит файл, название и дату обновления', () => {
  const html = `
    <div class="doc">
      <a href="/upload/iblock/7fd/abc/Raspisanie-kolledzh.xlsx">
        <span>Расписание колледж 31-5 августа-сентября (1 неделя)</span>
      </a>
      <div class="doc__meta">59,09 кБ <span>Дата обновления: 25.08.2026</span></div>
    </div>`;

  const files = parseFileList(html);
  assert.equal(files.length, 1);
  assert.equal(files[0].url, 'https://www.muiv.ru/upload/iblock/7fd/abc/Raspisanie-kolledzh.xlsx');
  assert.equal(files[0].title, 'Расписание колледж 31-5 августа-сентября (1 неделя)');
  assert.equal(files[0].siteUpdated, '25.08.2026');
  assert.equal(files[0].siteSize, '59,09 кБ');
});

test('parseFileList не дублирует одинаковые ссылки', () => {
  const html = `
    <a href="/upload/a/x.xlsx">Раз</a>
    <a href="/upload/a/x.xlsx">Раз ещё</a>
    <a href="/upload/documents/privacy-policy.pdf">Политика</a>`;
  assert.equal(parseFileList(html).length, 1);
});
