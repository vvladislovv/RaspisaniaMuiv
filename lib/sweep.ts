/**
 * Обход всех групп колледжа: что качать на этом тике и в каком порядке.
 *
 * Раньше часовой тик тянул только группы, на которые кто-то подписан, и
 * качал их все подряд за один вызов. Это ломалось двумя способами: новая
 * подписка оставалась без расписания до следующего тика (и бот честно писал
 * «Пар нет», взяв чужой файл), а с ростом числа групп тик упирался в лимит
 * функции в 60 секунд и не записывал вообще ничего.
 *
 * Теперь в базе держится неделя каждой группы каталога. Тик берёт столько
 * групп, сколько успевает, сохраняет каждую сразу после скачивания и
 * продолжает с того же места через час. Здесь — только чистые решения без
 * походов в сеть, чтобы их можно было проверить тестами.
 */
import type { Day } from './parse';
import { dayNameOf, mondayOf } from './time';

/** Ключ записи о последней проверке сайта в `app_state`. */
export const LAST_CHECK_KEY = 'last_check';

/** Что известно о группе перед обходом. */
export interface SweepCandidate {
  group: string;
  /** На группу подписан хотя бы один включённый чат. */
  subscribed: boolean;
  /** Последнее успешное скачивание; null — ещё ни разу. */
  fetchedAt: string | null;
  /**
   * Последняя попытка, чем бы она ни кончилась. Без неё группа, по которой
   * сайт отдаёт пустую неделю (заочники, ещё не выложенное воскресенье),
   * навсегда оставалась «самой давней» и вставала первой на каждом тике —
   * а до остальных очередь так и не доходила.
   */
  attemptedAt?: string | null;
  /** Понедельник недели, которая лежит в базе; null — ничего нет. */
  storedMonday: string | null;
}

/** Ключ в `app_state`: когда какую группу пробовали последний раз. */
export const SWEEP_ATTEMPTS_KEY = 'sweep_attempts';

/**
 * Подписанную группу перекачиваем не чаще раза в 45 минут: тики приходят
 * из двух источников, и два тика в один час не должны качать её дважды.
 */
export const SUBSCRIBED_REFRESH_MS = 45 * 60 * 1000;

/**
 * Группы без подписчиков — раз в сутки. Их расписание нужно на случай,
 * если группу выберут: тогда оно уже лежит в базе, и ждать тика не нужно.
 */
export const IDLE_REFRESH_MS = 20 * 60 * 60 * 1000;

/**
 * Группу без подписчиков, у которой на сайте пока нет недели, переспрашиваем
 * не чаще раза в три часа: иначе пустые заочные группы съедали бы каждый тик.
 */
export const IDLE_RETRY_MS = 3 * 60 * 60 * 1000;

/**
 * Подписанную группу без недели переспрашиваем на каждом тике, но не чаще
 * раза в 20 минут: второй крон, пришедший следом, не должен качать её снова.
 */
export const SUBSCRIBED_RETRY_MS = 20 * 60 * 1000;

/**
 * Сколько мест в очереди отдаём подписанным группам на одно место остальным.
 * Без этой доли при полусотне подписанных групп тик целиком уходил бы на
 * них, и неделя остальных групп так никогда бы и не загрузилась.
 */
export const SUBSCRIBED_SHARE = 3;

/**
 * Очерёдность групп на тик. Порядок важнее полноты: тик успевает не всё,
 * поэтому первыми идут те, без кого кто-то прямо сейчас сидит без расписания.
 *
 * 1. подписанные, у которых нет текущей недели, — на каждом тике;
 * 2. подписанные, проверенные больше 45 минут назад (ловим правки колледжа);
 * 3. остальные без текущей недели — раз в три часа;
 * 4. остальные, не обновлявшиеся сутки.
 *
 * Первая ступень идёт целиком. Дальше на каждые `SUBSCRIBED_SHARE` мест
 * подписанных — одно место остальным (см. `SUBSCRIBED_SHARE`). Внутри
 * ступени — сначала те, к кому дольше всего не обращались. Свежие группы
 * в план не попадают.
 */
export function planSweep(candidates: SweepCandidate[], monday: string, now: number): string[] {
  const ageOf = (c: SweepCandidate): number => {
    const touched = [c.fetchedAt, c.attemptedAt]
      .filter((t): t is string => !!t)
      .map((t) => Date.parse(t));
    return touched.length > 0 ? now - Math.max(...touched) : Number.POSITIVE_INFINITY;
  };

  const tierOf = (c: SweepCandidate, age: number): number | null => {
    const ready = c.storedMonday === monday;
    if (c.subscribed) {
      if (!ready) return age >= SUBSCRIBED_RETRY_MS ? 0 : null;
      return age >= SUBSCRIBED_REFRESH_MS ? 1 : null;
    }
    if (!ready) return age >= IDLE_RETRY_MS ? 2 : null;
    return age >= IDLE_REFRESH_MS ? 3 : null;
  };

  const ordered = candidates
    .map((c) => {
      const age = ageOf(c);
      return { group: c.group, age, tier: tierOf(c, age) };
    })
    .filter((x): x is { group: string; age: number; tier: number } => x.tier !== null)
    .sort((a, b) => a.tier - b.tier || b.age - a.age || a.group.localeCompare(b.group, 'ru'));

  const urgent = ordered.filter((x) => x.tier === 0).map((x) => x.group);
  const subscribed = ordered.filter((x) => x.tier === 1).map((x) => x.group);
  const idle = ordered.filter((x) => x.tier >= 2).map((x) => x.group);

  return [...urgent, ...interleave(subscribed, idle, SUBSCRIBED_SHARE)];
}

/** `first` по `every` штук, затем один из `second`; остаток — в конец. */
function interleave<T>(first: T[], second: T[], every: number): T[] {
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < first.length || j < second.length) {
    for (let k = 0; k < every && i < first.length; k++) out.push(first[i++]);
    if (j < second.length) out.push(second[j++]);
  }
  return out;
}

/** Понедельник и суббота учебной недели, в которую попадает дата. */
export function weekBounds(anchorIso: string): { monday: string; saturday: string } {
  const monday = mondayOf(anchorIso);
  const saturday = new Date(`${monday}T00:00:00Z`);
  saturday.setUTCDate(saturday.getUTCDate() + 5);
  return { monday, saturday: saturday.toISOString().slice(0, 10) };
}

/**
 * Неделя группы из ответа сайта, Пн–Сб.
 *
 * Сайт отдаёт всю текущую неделю (с прошедшими днями) и дальше — окно на
 * 10–12 дней, поэтому обрезаем до недели `anchorIso`. День без пар сайт не
 * присылает вовсе; такие дни дозаполняем пустыми, чтобы кнопка дня не
 * пропадала.
 *
 * Если в неделе нет ни одной пары, верить этому можно, только когда сайт
 * уже выложил пары на дни после неё: тогда неделя правда пустая (каникулы,
 * практика). Иначе возвращаем null — так выглядят и ещё не выложенная неделя
 * (в воскресенье — следующая), и сбой сайта, отдавшего пустую таблицу.
 * Записать такое — значит разослать всем «Пар нет» и перетереть настоящее
 * расписание.
 */
export function weekOfGroup(rawDays: Day[], anchorIso: string): Day[] | null {
  const { monday, saturday } = weekBounds(anchorIso);
  const inWeek = rawDays.filter((d) => d.date >= monday && d.date <= saturday);
  const hasLessons = inWeek.some((d) => d.lessons.length > 0);
  const publishedLater = rawDays.some((d) => d.date > saturday && d.lessons.length > 0);
  if (!hasLessons && !publishedLater) return null;

  const byDate = new Map(inWeek.map((d) => [d.date, d]));
  const cursor = new Date(`${monday}T00:00:00Z`);
  while (cursor.toISOString().slice(0, 10) <= saturday) {
    const date = cursor.toISOString().slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, { date, name: dayNameOf(date), lessons: [] });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Ключ в `app_state`: с какого момента сайт отдаёт группе пустую неделю. */
export const EMPTY_SEEN_KEY = 'sweep_empty_seen';

/**
 * Сколько сайт должен подряд отдавать группе пустую неделю, чтобы поверить,
 * что пар у неё правда нет: так живут заочники в межсессионные недели. Меньше
 * нельзя — в воскресенье вечером колледж ещё выкладывает неделю по группам.
 */
export const EMPTY_CONFIRM_MS = 6 * 60 * 60 * 1000;

/**
 * Какая доля каталога должна уже лежать в базе на эту неделю. Это отличает
 * «у группы пар нет» от «сайт сегодня отдаёт пустые таблицы»: при сбое пустой
 * окажется не одна группа, а все.
 */
export const EMPTY_CONFIRM_READY_SHARE = 0.5;

/** Когда впервые увидели пустую неделю группы. */
export interface EmptySeen {
  monday: string;
  since: string;
}

/**
 * Решение по группе, чью неделю сайт отдал без единой пары (см. `weekOfGroup`).
 * Возвращает обновлённую отметку и подтверждение, что неделя правда пустая.
 */
export function confirmEmptyWeek(
  seen: EmptySeen | undefined,
  monday: string,
  readyShare: number,
  now: number,
): { confirmed: boolean; seen: EmptySeen } {
  const current = seen && seen.monday === monday ? seen : { monday, since: new Date(now).toISOString() };
  const confirmed =
    readyShare >= EMPTY_CONFIRM_READY_SHARE && now - Date.parse(current.since) >= EMPTY_CONFIRM_MS;
  return { confirmed, seen: current };
}

/** Неделя Пн–Сб без единой пары — для группы, у которой пар подтверждённо нет. */
export function emptyWeek(anchorIso: string): Day[] {
  const { monday, saturday } = weekBounds(anchorIso);
  const days: Day[] = [];
  const cursor = new Date(`${monday}T00:00:00Z`);
  while (cursor.toISOString().slice(0, 10) <= saturday) {
    const date = cursor.toISOString().slice(0, 10);
    days.push({ date, name: dayNameOf(date), lessons: [] });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * Есть ли в базе неделя, куда попадает дата.
 *
 * Без этой проверки отсутствие данных выглядело как «Пар нет»: дня нет в
 * базе — значит и пар нет. Это верно, только если неделя целиком загружена
 * (тогда нет дня — это воскресенье). Если же недели нет вовсе, честно
 * сказать можно только «ещё не загружено».
 */
export function weekCovers(file: { week_start: string | null } | null, dateIso: string): boolean {
  if (!file?.week_start) return false;
  const stored = mondayOf(file.week_start);
  if (stored === mondayOf(dateIso)) return true;

  // Воскресенье — между неделями: в базе к этому дню уже лежит следующая
  // (см. weekAnchor), а пар в воскресенье не бывает. Это «Пар нет», а не
  // «не загружено»
  const nextDay = new Date(`${dateIso}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return nextDay.getUTCDay() === 1 && stored === nextDay.toISOString().slice(0, 10);
}

/** Что произошло за один проход — для сводки владельца и статус-страницы. */
export interface SweepReport {
  /** Неделя, к которой приводим базу. */
  monday: string;
  /** Сколько групп было в плане на этот тик. */
  planned: number;
  /** Сколько успели скачать. */
  fetched: number;
  /** Сайт не отдал ни одной пары на эту неделю. */
  empty: string[];
  failed: { group: string; reason: string }[];
}

/** Запись о последней проверке сайта, как она лежит в `app_state`. */
export interface CheckRecord {
  at: string;
  filesOnSite: number;
  changed: string[];
  errors: string[];
  durationMs?: number;
  sweep?: SweepReport;
}

/**
 * Обрабатывает элементы несколькими «рабочими» до дедлайна.
 *
 * Новый элемент не начинается после дедлайна; начатые доделываются. Порядок
 * старта сохраняется — очередь из `planSweep` проходится сверху вниз.
 * Возвращает, сколько элементов успели взять в работу.
 */
export async function forEachUntil<T>(
  items: T[],
  workers: number,
  deadline: number,
  fn: (item: T) => Promise<void>,
): Promise<number> {
  let next = 0;

  const worker = async () => {
    while (Date.now() < deadline) {
      const index = next++;
      if (index >= items.length) return;
      await fn(items[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, () => worker()));
  return Math.min(next, items.length);
}
