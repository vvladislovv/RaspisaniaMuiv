import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, formatDay, formatWeek, humanDate, shortName } from '../lib/format';
import type { Day } from '../lib/parse';

test('esc экранирует все специальные символы MarkdownV2', () => {
  assert.equal(esc('a_b*c[d]e(f)'), 'a\\_b\\*c\\[d\\]e\\(f\\)');
  assert.equal(esc('ИСП/П-24-11'), 'ИСП/П\\-24\\-11');
  assert.equal(esc('ауд. 531 ГК'), 'ауд\\. 531 ГК');
});

test('humanDate переводит ISO в русскую дату', () => {
  assert.equal(humanDate('2026-09-01'), '1 сентября');
  assert.equal(humanDate('2026-12-31'), '31 декабря');
});

test('shortName сокращает ФИО до инициалов', () => {
  assert.equal(shortName('Соломин Максим Сергеевич'), 'Соломин М. С.');
  assert.equal(shortName('Тофан Алина'), 'Тофан А.');
  assert.equal(shortName('Иванов'), 'Иванов');
});

const day: Day = {
  date: '2026-09-01',
  name: 'Вторник',
  lessons: [
    {
      pair: 4,
      time: '13:45-15:15',
      subject: 'Поддержка и тестирование программных модулей',
      teacher: 'Соломин Максим Сергеевич',
      room: '531 ГК',
      raw: '',
    },
  ],
};

test('formatDay собирает сообщение и экранирует опасные символы', () => {
  const text = formatDay(day, { group: 'ИСП/П-24-11', siteUpdated: '25.08.2026' });
  assert.match(text, /Вторник/);
  assert.match(text, /ИСП\/П\\-24\\-11/);
  assert.match(text, /Соломин М\\\. С\\\./);

  // Ни один спецсимвол MarkdownV2 не должен остаться неэкранированным.
  // Снимаем разметку, которую ставим сами: экранирование, жирный, курсив
  // и `>` в начале строк цитаты.
  const bare = text
    .replace(/\\./g, '')
    .split('\n')
    .map((line) => line.replace(/^>/, ''))
    .join('\n')
    .replace(/\*/g, '')
    .replace(/_/g, '');
  assert.doesNotMatch(bare, /[[\]()~`>#+=|{}]/);
});

test('formatDay кладёт пары в цитату', () => {
  const text = formatDay(day, { group: 'ИСП/П-24-11' });
  const quoted = text.split('\n').filter((line) => line.startsWith('>'));
  assert.ok(quoted.length >= 3, 'пары должны быть строками цитаты');
  assert.match(quoted.join('\n'), /\*4\\\.\* \*13:45–15:15\*/);
});

test('formatWeek делает дни раскрывающимися цитатами', () => {
  const chunks = formatWeek([day], { group: 'ИСП/П-24-11' });
  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /\*\*>/, 'должна быть раскрывающаяся цитата');
  assert.match(chunks[0], /\|\|$/, 'цитата должна закрываться меткой раскрытия');
  assert.match(chunks[0], /1 пара/);
});

test('formatDay не задваивает «ауд.», если сайт уже положил префикс в ячейку', () => {
  const withPrefix: Day = {
    ...day,
    lessons: [{ ...day.lessons[0], room: 'ауд.206 (колледж)' }],
  };
  const text = formatDay(withPrefix, { group: 'ИСП/П-24-11' });
  assert.match(text, /ауд\\\. 206 \\\(колледж\\\)/);
  assert.doesNotMatch(text, /ауд\\\. ауд/);
});

test('formatDay добавляет «ГК», если сайт не указал здание аудитории', () => {
  const bare: Day = {
    ...day,
    lessons: [{ ...day.lessons[0], room: '503' }],
  };
  const text = formatDay(bare, { group: 'ИСП/П-24-11' });
  assert.match(text, /ауд\\\. 503 ГК/);
});

test('formatDay не приписывает «ГК» аудитории колледжа', () => {
  const college: Day = {
    ...day,
    lessons: [{ ...day.lessons[0], room: 'ауд.206 (колледж)' }],
  };
  const text = formatDay(college, { group: 'ИСП/П-24-11' });
  assert.doesNotMatch(text, /ГК/);
});

test('formatDay пишет «Вебинар» вместо аудитории «Д» — это дистанционное занятие, а не корпус', () => {
  const remote: Day = {
    ...day,
    lessons: [{ ...day.lessons[0], room: 'Д' }],
  };
  const text = formatDay(remote, { group: 'ИСП/П-24-11' });
  assert.match(text, /Вебинар/);
  assert.doesNotMatch(text, /ауд\\\. Д/);
  assert.doesNotMatch(text, /ГК/);
});

test('formatDay без пар пишет «Пар нет»', () => {
  const text = formatDay({ date: '2026-09-06', name: 'Воскресенье', lessons: [] }, { group: 'ИСП/П-24-11' });
  assert.match(text, /Пар нет/);
});

test('formatWeek режет длинную неделю на части в лимит Telegram', () => {
  const fat: Day = {
    ...day,
    lessons: Array.from({ length: 5 }, (_, i) => ({
      ...day.lessons[0],
      pair: i + 1,
      subject: 'Очень длинное название предмета '.repeat(12),
    })),
  };
  const chunks = formatWeek(Array.from({ length: 6 }, () => fat), { group: 'ИСП/П-24-11' });
  assert.ok(chunks.length > 1, 'должно разрезаться на несколько сообщений');
  for (const chunk of chunks) assert.ok(chunk.length <= 4096, `часть длиной ${chunk.length}`);
});

test('describeUser не повторяет одно и то же имя дважды', async () => {
  const { describeUser } = await import('../lib/bot');

  // Точное совпадение и совпадение с точностью до регистра и подчёркиваний
  assert.equal(describeUser({ first_name: 'Devil_clown03', username: 'Devil_clown03' }), '@Devil_clown03');
  assert.equal(describeUser({ first_name: 'devil clown03', username: 'Devil_clown03' }), '@Devil_clown03');

  // Настоящий случай: в имени лишняя буква
  assert.equal(
    describeUser({ first_name: 'Deviil_clown03', username: 'Devil_clown03' }),
    '@Devil_clown03',
  );

  // Короткие и явно разные имена склеивать нельзя
  assert.equal(describeUser({ first_name: 'Анна', username: 'anna1' }), 'Анна (@anna1)');
  assert.equal(
    describeUser({ first_name: 'Александр', username: 'vladislav' }),
    'Александр (@vladislav)',
  );
  assert.equal(describeUser({ first_name: 'Владислав', username: 'dislov' }), 'Владислав (@dislov)');
  assert.equal(describeUser({ first_name: 'Владислав' }), 'Владислав');
  assert.equal(describeUser({ username: 'dislov' }), '@dislov');
  assert.equal(describeUser({ id: 42 }), 'ID 42');
});

test('emojiTag собирает кастомный эмодзи и запасной глиф', async () => {
  const { emojiTag } = await import('../lib/format');

  // Без id — обычный эмодзи как есть
  assert.equal(emojiTag('🦅', null), '🦅');

  // С id — разметка MarkdownV2, глиф внутри как запасной
  assert.equal(
    emojiTag('🦅', '5368324170671202286'),
    '![🦅](tg://emoji?id=5368324170671202286)',
  );

  // Глиф со спецсимволом должен быть экранирован
  assert.equal(emojiTag('!', '123'), '![\\!](tg://emoji?id=123)');
});

test('подпись автора: белая птица из набора «ХакТайка», текст по-русски', async () => {
  const { emojiTag, esc } = await import('../lib/format');

  const line = `${emojiTag('🕊', '5399882430721071735')} ${esc('Сделано в')} [${esc('Хактайке')}](https://hacktaika.ru)`;

  assert.match(line, /tg:\/\/emoji\?id=5399882430721071735/);
  assert.match(line, /\[Хактайке\]/);
  // Ссылка стоит на слове, а не на адресе
  assert.doesNotMatch(line, /\[hacktaika/);
});

test('formatDayFor не выдаёт отсутствие данных за «Пар нет»', async () => {
  const { formatDayFor, NOT_LOADED_TEXT } = await import('../lib/format');

  // Тот самый случай из жалобы: у группы суббота с парами, но её неделя ещё
  // не скачана — честно говорим «не загружено», а не «пар нет»
  const text = formatDayFor('2026-10-24', 'Суббота', [
    { group: 'к/о/к ЮР/са 25-09', day: null, noData: true },
  ]);
  assert.ok(text.includes(esc(NOT_LOADED_TEXT)));
  assert.ok(!text.includes('Пар нет'));

  // Неделя загружена, а дня нет — это действительно день без пар
  const empty = formatDayFor('2026-10-25', 'Воскресенье', [
    { group: 'к/о/к ЮР/са 25-09', day: null, noData: false },
  ]);
  assert.match(empty, /Пар нет/);

  // Две группы: у одной пары, у другой данных нет — каждая со своим текстом
  const mixed = formatDayFor('2026-09-01', 'Вторник', [
    { group: 'ИСП/П-24-11', day },
    { group: 'КБо 21-24', day: null, noData: true },
  ]);
  assert.match(mixed, /Поддержка и тестирование/);
  assert.ok(mixed.includes(esc(NOT_LOADED_TEXT)));
});

test('formatWeek без данных говорит «не загружено»', async () => {
  const { NOT_LOADED_TEXT } = await import('../lib/format');
  const [chunk] = formatWeek([], { group: 'КБо 21-24' });
  assert.ok(chunk.includes(esc(NOT_LOADED_TEXT)));
});

test('fitText режет по целым строкам и укладывается в лимит Telegram', async () => {
  const { fitText } = await import('../lib/format');

  const short = fitText(['раз', 'два']);
  assert.equal(short, 'раз\nдва');

  const lines = Array.from({ length: 500 }, (_, i) => `строка номер ${i} с текстом`);
  const fitted = fitText(lines);
  assert.ok(fitted.length < 4096, `длина ${fitted.length}`);
  assert.match(fitted, /и ещё \d+ строк/);
  // Ни одна строка не разорвана посередине
  for (const line of fitted.split('\n').slice(0, -1)) assert.ok(lines.includes(line), line);
});

test('roomLabel: каждый вид записи аудитории, встреченный на сайте', async () => {
  const { roomLabel } = await import('../lib/format');

  // Все виды из базы на неделю 19–24 октября 2026: сайт пишет аудиторию
  // как придётся — с «ауд.» и без, дважды, с точкой в конце, словами
  const cases: [string, string | null][] = [
    // Номер с колледжем — как было
    ['ауд.312 (колледж)', 'ауд. 312 (колледж)'],
    ['ауд.308 (Колледж)', 'ауд. 308 (Колледж)'],
    // Вебинар
    ['Д', 'Вебинар'],
    // Голый номер — главный корпус
    ['433', 'ауд. 433 ГК'],
    ['ауд.125', 'ауд. 125 ГК'],
    ['ауд. 108', 'ауд. 108 ГК'],
    // «ауд.» дважды и точки по краям
    ['ауд.ауд. 536.', 'ауд. 536 ГК'],
    ['ауд.536 ауд.', 'ауд. 536 ГК'],
    ['ауд.ауд.536', 'ауд. 536 ГК'],
    // Места без номера — не «аудитория» и не корпус ГК
    ['Спортивный зал (колледж)', 'Спортивный зал (колледж)'],
    ['спортзал', 'Спортзал'],
    ['спортивный зал', 'Спортивный зал'],
    ['Спортивный зал', 'Спортивный зал'],
    ['ауд.Стадион (колледж)', 'Стадион (колледж)'],
    ['Стадион "Торпедо"', 'Стадион "Торпедо"'],
    ['ауд.Стадион.', 'Стадион'],
  ];

  for (const [raw, expected] of cases) {
    assert.equal(roomLabel(raw), expected, raw);
  }
});

test('roomLabel не показывает пустую аудиторию и не трогает слова с «ауд» внутри', async () => {
  const { roomLabel } = await import('../lib/format');

  assert.equal(roomLabel(''), null);
  assert.equal(roomLabel('   '), null);
  assert.equal(roomLabel('ауд.'), null);
  assert.equal(roomLabel('ауд. .'), null);
  assert.equal(roomLabel('д.'), 'Вебинар');
  assert.equal(roomLabel('Аудитория самоподготовки'), 'Аудитория самоподготовки');
});

test('formatDay показывает спортзал и стадион без «ауд.» и «ГК»', () => {
  const text = formatDay(
    {
      ...day,
      lessons: [
        { ...day.lessons[0], room: 'спортзал' },
        { ...day.lessons[0], pair: 5, room: 'ауд.ауд. 536.' },
      ],
    },
    { group: 'ИСП/П-24-11' },
  );
  assert.match(text, /Спортзал/);
  assert.doesNotMatch(text, /ауд\\\. спортзал/i);
  assert.match(text, /ауд\\\. 536 ГК/);
  assert.doesNotMatch(text, /ауд\\\. ауд/);
  assert.doesNotMatch(text, /536\\\./);
});
