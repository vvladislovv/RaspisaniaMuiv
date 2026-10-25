import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_CONFIRM_MS,
  confirmEmptyWeek,
  emptyWeek,
  IDLE_REFRESH_MS,
  IDLE_RETRY_MS,
  SUBSCRIBED_REFRESH_MS,
  forEachUntil,
  planSweep,
  weekBounds,
  weekCovers,
  weekOfGroup,
  type SweepCandidate,
} from '../lib/sweep';
import type { Day } from '../lib/parse';

const NOW = Date.parse('2026-10-23T10:00:00Z');
const MONDAY = '2026-10-19';
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function candidate(group: string, extra: Partial<SweepCandidate> = {}): SweepCandidate {
  return { group, subscribed: false, fetchedAt: null, storedMonday: null, ...extra };
}

const lesson = { pair: 1, time: '08:20-09:50', subject: 'Право', teacher: null, room: null, raw: '' };

test('первыми качаются подписанные группы без текущей недели', () => {
  const plan = planSweep(
    [
      candidate('без подписки, пусто'),
      candidate('подписана, неделя есть', {
        subscribed: true,
        fetchedAt: ago(SUBSCRIBED_REFRESH_MS + 1),
        storedMonday: MONDAY,
      }),
      candidate('подписана, пусто', { subscribed: true }),
    ],
    MONDAY,
    NOW,
  );

  assert.deepEqual(plan, ['подписана, пусто', 'подписана, неделя есть', 'без подписки, пусто']);
});

test('подписанная группа со старой неделей считается незагруженной', () => {
  // В воскресенье неделя меняется: прошлая в базе не спасает
  const plan = planSweep(
    [
      candidate('старая неделя', {
        subscribed: true,
        fetchedAt: ago(30 * 60_000),
        storedMonday: '2026-10-12',
      }),
    ],
    MONDAY,
    NOW,
  );
  assert.deepEqual(plan, ['старая неделя']);
});

test('свежие группы в план не попадают', () => {
  const plan = planSweep(
    [
      candidate('подписана, только что', {
        subscribed: true,
        fetchedAt: ago(SUBSCRIBED_REFRESH_MS - 60_000),
        storedMonday: MONDAY,
      }),
      candidate('без подписки, утром', {
        fetchedAt: ago(IDLE_REFRESH_MS - 60_000),
        storedMonday: MONDAY,
      }),
    ],
    MONDAY,
    NOW,
  );
  assert.deepEqual(plan, []);
});

test('без подписки группа перекачивается раз в сутки', () => {
  const plan = planSweep(
    [candidate('вчерашняя', { fetchedAt: ago(IDLE_REFRESH_MS + 1), storedMonday: MONDAY })],
    MONDAY,
    NOW,
  );
  assert.deepEqual(plan, ['вчерашняя']);
});

test('внутри ступени первыми идут самые давние, затем никогда не скачанные раньше всех', () => {
  const plan = planSweep(
    [
      candidate('час назад', { subscribed: true, fetchedAt: ago(3_600_000), storedMonday: MONDAY }),
      candidate('три часа назад', {
        subscribed: true,
        fetchedAt: ago(3 * 3_600_000),
        storedMonday: MONDAY,
      }),
    ],
    MONDAY,
    NOW,
  );
  assert.deepEqual(plan, ['три часа назад', 'час назад']);

  const never = planSweep(
    [candidate('Б', { fetchedAt: ago(IDLE_RETRY_MS + 1) }), candidate('А'), candidate('В')],
    MONDAY,
    NOW,
  );
  // Ни разу не скачанные — раньше всех, между собой по алфавиту
  assert.deepEqual(never, ['А', 'В', 'Б']);
});

test('пустая на сайте группа не встаёт первой на каждом тике', () => {
  // Сайт отдал пустую неделю: данных нет, но попытка была только что.
  // Без учёта попыток такие группы навсегда занимали голову очереди
  const plan = planSweep(
    [
      candidate('пустая, только что пробовали', { attemptedAt: ago(60_000) }),
      candidate('ни разу не пробовали'),
      candidate('подписана, пустая, только что', { subscribed: true, attemptedAt: ago(60_000) }),
      candidate('подписана, пустая, давно', { subscribed: true, attemptedAt: ago(3_600_000) }),
    ],
    MONDAY,
    NOW,
  );

  // Подписанные без недели пробуем на каждом тике, но не вторым кроном
  // следом; неподписанную пустую отложили на три часа
  assert.deepEqual(plan, ['подписана, пустая, давно', 'ни разу не пробовали']);

  const later = planSweep(
    [candidate('пустая', { attemptedAt: ago(IDLE_RETRY_MS + 1) })],
    MONDAY,
    NOW,
  );
  assert.deepEqual(later, ['пустая'], 'через три часа её снова спрашивают');
});

test('давность считается по последнему обращению — успешному или нет', () => {
  const plan = planSweep(
    [
      candidate('скачана давно, пробовали недавно', {
        subscribed: true,
        fetchedAt: ago(5 * 3_600_000),
        attemptedAt: ago(10 * 60_000),
        storedMonday: MONDAY,
      }),
    ],
    MONDAY,
    NOW,
  );
  // Свежая попытка (пусть и неудачная) — значит, гонять её снова рано
  assert.deepEqual(plan, []);
});

test('weekBounds даёт понедельник и субботу недели', () => {
  assert.deepEqual(weekBounds('2026-10-23'), { monday: '2026-10-19', saturday: '2026-10-24' });
  assert.deepEqual(weekBounds('2026-10-19'), { monday: '2026-10-19', saturday: '2026-10-24' });
});

test('weekOfGroup обрезает окно сайта до недели и дозаполняет пустые дни', () => {
  const raw: Day[] = [
    { date: '2026-10-17', name: 'Суббота', lessons: [lesson] },
    { date: '2026-10-20', name: 'Вторник', lessons: [lesson] },
    { date: '2026-10-24', name: 'Суббота', lessons: [lesson, lesson] },
    { date: '2026-10-26', name: 'Понедельник', lessons: [lesson] },
  ];

  const week = weekOfGroup(raw, '2026-10-23');
  assert.ok(week);
  assert.deepEqual(
    week.map((d) => d.date),
    ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'],
  );
  assert.equal(week[0].lessons.length, 0);
  assert.equal(week[0].name, 'Понедельник');
  // Суббота с парами — тот самый день, который показывался как «Пар нет»
  assert.equal(week[5].lessons.length, 2);
});

test('weekOfGroup не выдумывает неделю без единой пары', () => {
  // Так выглядит ещё не выложенная неделя или сбой сайта: писать «Пар нет» нельзя
  assert.equal(weekOfGroup([], '2026-10-23'), null);
  assert.equal(
    weekOfGroup([{ date: '2026-10-20', name: 'Вторник', lessons: [] }], '2026-10-23'),
    null,
  );
  // Пары есть, но только на прошлой неделе
  assert.equal(
    weekOfGroup([{ date: '2026-10-13', name: 'Вторник', lessons: [lesson] }], '2026-10-23'),
    null,
  );
});

test('weekCovers отличает «пар нет» от «не загружено»', () => {
  const file = { week_start: '2026-10-19' };
  assert.equal(weekCovers(file, '2026-10-24'), true);
  // Воскресенье той же недели: данных нет, но неделя загружена — это «пар нет»
  assert.equal(weekCovers(file, '2026-10-25'), true);
  assert.equal(weekCovers(file, '2026-10-26'), false);
  assert.equal(weekCovers(null, '2026-10-24'), false);
  assert.equal(weekCovers({ week_start: null }, '2026-10-24'), false);
});

test('forEachUntil не начинает новое после дедлайна, но доделывает начатое', async () => {
  const done: number[] = [];
  const deadline = Date.now() + 30;

  // Каждый элемент заканчивается уже после дедлайна: оба рабочих успевают
  // взять по одному, доделывают его, а следующий уже не берут
  const taken = await forEachUntil([1, 2, 3, 4, 5, 6, 7, 8], 2, deadline, async (n) => {
    while (Date.now() <= deadline) await new Promise((r) => setTimeout(r, 5));
    done.push(n);
  });

  assert.equal(taken, 2);
  assert.deepEqual(done.sort(), [1, 2]);

  // Дедлайн уже прошёл — не берём ничего
  assert.equal(await forEachUntil([1, 2], 2, Date.now() - 1, async () => {}), 0);
});

test('forEachUntil проходит всё, если время есть, и не падает на пустом списке', async () => {
  const seen: string[] = [];
  const taken = await forEachUntil(['a', 'b', 'c'], 5, Date.now() + 10_000, async (x) => {
    seen.push(x);
  });
  assert.equal(taken, 3);
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.equal(await forEachUntil([], 3, Date.now() + 1000, async () => {}), 0);
});

test('подписанную группу без недели не качают дважды за 20 минут', async () => {
  const { SUBSCRIBED_RETRY_MS } = await import('../lib/sweep');
  const recent = planSweep(
    [candidate('только что', { subscribed: true, attemptedAt: ago(SUBSCRIBED_RETRY_MS - 60_000) })],
    MONDAY,
    NOW,
  );
  assert.deepEqual(recent, [], 'второй крон следом её не трогает');

  const later = planSweep(
    [candidate('давно', { subscribed: true, attemptedAt: ago(SUBSCRIBED_RETRY_MS + 1) })],
    MONDAY,
    NOW,
  );
  assert.deepEqual(later, ['давно']);
});

test('подписанные группы не вытесняют остальные из очереди целиком', async () => {
  const { SUBSCRIBED_SHARE } = await import('../lib/sweep');
  const stale = ago(2 * 3_600_000);
  const subscribed = Array.from({ length: 10 }, (_, i) =>
    candidate(`п${String(i).padStart(2, '0')}`, { subscribed: true, fetchedAt: stale, storedMonday: MONDAY }),
  );
  const idle = Array.from({ length: 3 }, (_, i) => candidate(`о${i}`));

  const plan = planSweep([...subscribed, ...idle], MONDAY, NOW);
  assert.equal(plan.length, 13);
  // На каждые SUBSCRIBED_SHARE подписанных — одна из остальных
  assert.deepEqual(plan.slice(0, SUBSCRIBED_SHARE + 1).map((g) => g[0]), [
    ...Array(SUBSCRIBED_SHARE).fill('п'),
    'о',
  ]);
  // Срочные (подписанные без недели) — всё равно раньше всех
  const urgent = planSweep([...idle, candidate('срочно', { subscribed: true })], MONDAY, NOW);
  assert.equal(urgent[0], 'срочно');
});

test('неделя без пар записывается, если сайт уже выложил пары дальше', () => {
  // Каникулы: на этой неделе пусто, а на следующей пары есть — неделя правда пустая
  const holiday = weekOfGroup(
    [{ date: '2026-10-27', name: 'Вторник', lessons: [lesson] }],
    '2026-10-23',
  );
  assert.ok(holiday);
  assert.equal(holiday.length, 6);
  assert.ok(holiday.every((d) => d.lessons.length === 0));

  // Пары только в прошлом — это не «выложено дальше»
  assert.equal(
    weekOfGroup([{ date: '2026-10-17', name: 'Суббота', lessons: [lesson] }], '2026-10-23'),
    null,
  );
});

test('в воскресенье загруженная следующая неделя — это «пар нет», а не «не загружено»', () => {
  // В воскресенье обход уже кладёт следующую неделю (weekAnchor → понедельник)
  assert.equal(weekCovers({ week_start: '2026-10-26' }, '2026-10-25'), true);
  // Прошлая неделя в воскресенье тоже его покрывает
  assert.equal(weekCovers({ week_start: '2026-10-19' }, '2026-10-25'), true);
  // А вот субботу следующая неделя не покрывает
  assert.equal(weekCovers({ week_start: '2026-10-26' }, '2026-10-24'), false);
});

test('confirmEmptyWeek: пустую неделю принимает, только продержав её пустой при живом сайте', () => {
  const t0 = Date.parse('2026-10-24T22:00:00Z');
  const first = confirmEmptyWeek(undefined, '2026-10-26', 0.9, t0);
  assert.equal(first.confirmed, false);
  assert.equal(first.seen.since, new Date(t0).toISOString());

  const early = confirmEmptyWeek(first.seen, '2026-10-26', 0.9, t0 + EMPTY_CONFIRM_MS - 1);
  assert.equal(early.confirmed, false);

  const later = confirmEmptyWeek(first.seen, '2026-10-26', 0.9, t0 + EMPTY_CONFIRM_MS);
  assert.equal(later.confirmed, true);
});

test('confirmEmptyWeek: не верит пустоте, если у остальных групп недели тоже нет', () => {
  const t0 = Date.parse('2026-10-24T22:00:00Z');
  const seen = { monday: '2026-10-26', since: new Date(t0).toISOString() };
  const verdict = confirmEmptyWeek(seen, '2026-10-26', 0.1, t0 + 24 * 3600_000);
  assert.equal(verdict.confirmed, false);
});

test('confirmEmptyWeek: отметка прошлой недели не засчитывается новой', () => {
  const t0 = Date.parse('2026-10-26T10:00:00Z');
  const stale = { monday: '2026-10-19', since: '2026-10-19T00:00:00.000Z' };
  const verdict = confirmEmptyWeek(stale, '2026-10-26', 0.9, t0);
  assert.equal(verdict.confirmed, false);
  assert.equal(verdict.seen.monday, '2026-10-26');
});

test('emptyWeek даёт шесть пустых дней Пн–Сб', () => {
  const week = emptyWeek('2026-10-27');
  assert.deepEqual(week.map((d) => d.date), [
    '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31',
  ]);
  assert.ok(week.every((d) => d.lessons.length === 0));
});
