/**
 * Экраны владельца бота: сводка, доступ по заявкам, группы в работе и
 * загрузка расписания. Проверка, что жмёт именно владелец, — в `bot.ts`.
 */
import {
  accessCounts,
  accessList,
  catalogEntries,
  chatStats,
  errorCount,
  feedbackStats,
  getState,
  groupFileStatus,
  groupsInUse,
  pendingRequests,
  type AccessRow,
} from './db';
import { displayGroup } from './aliases';
import { esc, fitText, humanDate } from './format';
import {
  ACCESS_PAGE_SIZE,
  ACCESS_SECTIONS,
  accessOverviewKeyboard,
  accessSectionKeyboard,
  pageOf,
  type AccessSection,
  type Screen,
} from './keyboard';
import { describeUser } from './people';
import { LAST_CHECK_KEY, weekBounds, type CheckRecord } from './sweep';
import type { InlineKeyboard } from './telegram';
import { mondayOf, mskParts, mskStamp, weekAnchor } from './time';

const ADMIN_TO = { text: '↩︎ Сводка', callback_data: 'adm' };

/** `23.10 10:31` — в списках год и «МСК» только мешают читать. */
function shortStamp(iso: string | null): string {
  if (!iso) return '—';
  const p = mskParts(new Date(iso));
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(p.day)}.${two(p.month)} ${two(p.hour)}:${two(p.minute)}`;
}

function personOf(row: AccessRow): string {
  return describeUser({ ...row, id: row.user_id });
}

// ─── Загрузка расписания ─────────────────────────────────────────────────────

/** Сколько групп недели уже лежит в базе — всего и среди тех, что в работе. */
export interface LoadOverview {
  monday: string;
  total: number;
  ready: number;
  inUse: number;
  inUseReady: number;
  /** Группы в работе, у которых текущей недели в базе нет. */
  inUseWaiting: string[];
}

export async function loadOverview(): Promise<LoadOverview> {
  const [catalog, files, inUse] = await Promise.all([
    catalogEntries(),
    groupFileStatus(),
    groupsInUse(),
  ]);
  const { monday } = weekBounds(weekAnchor());
  const isReady = (group: string) => {
    const week = files.get(group)?.weekStart;
    return !!week && mondayOf(week) === monday;
  };

  const inUseNames = inUse.map((g) => g.group);
  const inUseWaiting = inUseNames.filter((g) => !isReady(g));

  return {
    monday,
    total: catalog.length,
    ready: catalog.filter((e) => isReady(e.group)).length,
    inUse: inUseNames.length,
    inUseReady: inUseNames.length - inUseWaiting.length,
    inUseWaiting,
  };
}

/** Одна строка для сводки: на каком этапе загрузка недели. */
function loadLine(load: LoadOverview): string {
  const done = load.ready === load.total && load.inUseWaiting.length === 0;
  return (
    `📦 ${esc(`Неделя с ${humanDate(load.monday)}:`)} ` +
    `${done ? '✅' : '⏳'} *${load.ready}* ${esc(`из ${load.total} групп`)}` +
    esc(`, в работе ${load.inUseReady} из ${load.inUse}`)
  );
}

/**
 * Подробности загрузки: что готово, что не скачалось и почему. Отвечает на
 * вопрос «на каком этапе расписание», не заглядывая в базу руками.
 */
export async function loadScreen(): Promise<Screen> {
  const [load, check] = await Promise.all([
    loadOverview(),
    getState<CheckRecord>(LAST_CHECK_KEY),
  ]);

  const lines = ['*Загрузка расписания*', esc(`Неделя с ${humanDate(load.monday)}`), ''];
  lines.push(esc(`Всех групп загружено: ${load.ready} из ${load.total}`));
  lines.push(esc(`Групп в работе загружено: ${load.inUseReady} из ${load.inUse}`));

  if (load.inUseWaiting.length > 0) {
    lines.push('');
    lines.push(`*${esc('⏳ В работе, но ещё без недели')}*`);
    for (const group of load.inUseWaiting) lines.push(esc(`• ${displayGroup(group)}`));
  }

  const sweep = check?.sweep;
  if (check) {
    lines.push('');
    lines.push(
      esc(
        `Последний проход: ${mskStamp(new Date(check.at))}` +
          (check.durationMs ? `, ${Math.round(check.durationMs / 1000)} с` : ''),
      ),
    );
    if (sweep) lines.push(esc(`В очереди было ${sweep.planned}, скачано ${sweep.fetched}`));
  } else {
    lines.push('');
    lines.push(`_${esc('Проходов ещё не было')}_`);
  }

  if (sweep && sweep.failed.length > 0) {
    lines.push('');
    lines.push(`*${esc(`⚠️ Не скачались (${sweep.failed.length})`)}*`);
    for (const { group, reason } of sweep.failed) {
      lines.push(esc(`• ${displayGroup(group)} — ${reason.slice(0, 120)}`));
    }
  }

  if (sweep && sweep.empty.length > 0) {
    lines.push('');
    lines.push(`*${esc(`📭 На сайте нет пар на эту неделю (${sweep.empty.length})`)}*`);
    lines.push(esc(sweep.empty.map(displayGroup).join(', ')));
  }

  return {
    text: fitText(lines),
    keyboard: [[{ text: '🔄 Обновить', callback_data: 'admload' }, ADMIN_TO]],
  };
}

// ─── Сводка ──────────────────────────────────────────────────────────────────

/** Сводка для владельца бота: сколько чатов, какие группы, есть ли ошибки. */
export async function adminScreen(): Promise<Screen> {
  const [stats, errors, check, access, pending, feedback, load] = await Promise.all([
    chatStats(),
    errorCount(24),
    getState<CheckRecord>(LAST_CHECK_KEY),
    accessCounts(),
    pendingRequests(8),
    feedbackStats(24),
    loadOverview(),
  ]);

  const lines = ['*Сводка*', ''];
  lines.push(`Чатов: *${stats.total}*, включено ${stats.enabled}, с группой ${stats.withGroup}`);
  lines.push(`Ошибок за сутки: ${errors === 0 ? '*0*' : `*${errors}*`}`);
  lines.push(
    `Доступ: одобрено ${access.approved}, ждут *${access.pending}*, отказано ${access.denied}`,
  );
  lines.push(`За сутки: 🐞 ${feedback.bugs}, 💡 ${feedback.ideas}`);
  lines.push(loadLine(load));

  if (check) {
    lines.push(`Проверка сайта: ${esc(mskStamp(new Date(check.at)))}`);
    if (check.errors.length > 0) lines.push(`⚠️ ${esc(check.errors.join('; ').slice(0, 200))}`);
  }

  if (pending.length > 0) {
    lines.push('');
    lines.push(`*${esc('Ждут решения')}*`);
    for (const row of pending) lines.push(`${esc(personOf(row))} · \`${row.user_id}\``);
  }

  if (stats.topGroups.length > 0) {
    lines.push('');
    lines.push(`*${esc('Группы')}*`);
    for (const row of stats.topGroups) {
      lines.push(`${esc(displayGroup(row.group))} — ${row.chats}`);
    }
  }

  const rows: InlineKeyboard = [];

  // Заявки решаются прямо из сводки: отдельного экрана для этого не нужно
  for (const row of pending) {
    rows.push([
      { text: `✅ ${personOf(row)}`, callback_data: `ok:${row.user_id}` },
      { text: '⛔️', callback_data: `no:${row.user_id}` },
    ]);
  }

  rows.push([
    { text: '👥 Доступ', callback_data: 'admacc' },
    { text: '📋 Все группы', callback_data: 'admgrp' },
  ]);
  rows.push([
    { text: '📦 Загрузка', callback_data: 'admload' },
    { text: '🔄 Обновить', callback_data: 'adm' },
  ]);
  rows.push([{ text: '↩︎ Меню', callback_data: 'm' }]);

  return { text: fitText(lines), keyboard: rows };
}

// ─── Доступ ──────────────────────────────────────────────────────────────────

/**
 * Обзор доступа: только счётчики и вход в разделы. Раньше здесь был один
 * список всех людей с кнопкой на каждого — при двух сотнях человек он не
 * влезал ни в лимит сообщения, ни в лимит кнопок, и экран не открывался.
 */
export async function accessOverviewScreen(): Promise<Screen> {
  const counts = await accessCounts();
  return {
    text: [
      '*Доступ*',
      '',
      `✅ Одобрено: *${counts.approved}*`,
      `⏳ Ждут решения: *${counts.pending}*`,
      `⛔️ Отказано: *${counts.denied}*`,
      '',
      `_${esc(`Открой раздел — там по ${ACCESS_PAGE_SIZE} человек на странице, с кнопкой на каждого.`)}_`,
    ].join('\n'),
    keyboard: accessOverviewKeyboard(counts),
  };
}

/** Страница одного раздела доступа: кто, когда, и кнопка поменять решение. */
export async function accessSectionScreen(section: AccessSection, page: number): Promise<Screen> {
  const info = ACCESS_SECTIONS[section];
  const all = await accessList(info.status);
  const shown = pageOf(all, page, ACCESS_PAGE_SIZE);

  const lines = [`*${esc(`${info.emoji} ${info.title} · ${all.length}`)}*`];
  if (shown.pages > 1) lines.push(`_${esc(`Страница ${shown.page + 1} из ${shown.pages}`)}_`);
  lines.push('');

  if (all.length === 0) {
    lines.push(esc('— пусто —'));
  } else {
    shown.items.forEach((row, index) => {
      const number = shown.page * ACCESS_PAGE_SIZE + index + 1;
      // Для ждущих важно, когда пришли; для решённых — когда решили
      const when = section === 'p' ? row.requested_at : row.decided_at;
      lines.push(
        `${number}\\. ${esc(personOf(row))} · \`${row.user_id}\` · ${esc(shortStamp(when))}`,
      );
    });
  }

  return {
    text: fitText(lines),
    keyboard: accessSectionKeyboard(
      section,
      shown.items.map((row) => ({ id: row.user_id, label: personOf(row) })),
      shown.page,
      shown.pages,
    ),
  };
}

// ─── Группы в работе ─────────────────────────────────────────────────────────

/**
 * Полный список групп, на которые сейчас подписан хоть один включённый
 * чат — без обрезки до топ-8, как в сводке.
 */
export async function groupsListScreen(): Promise<Screen> {
  const groups = await groupsInUse();

  const lines = [`*${esc(`Все группы в работе (${groups.length})`)}*`, ''];
  if (groups.length === 0) {
    lines.push(esc('Пока ни один чат не выбрал группу.'));
  } else {
    for (const { group, chats } of groups) {
      const titles = chats.map((c) => c.title ?? `чат ${c.chat_id}`).join(', ');
      lines.push(`${esc(displayGroup(group))} — ${chats.length}`);
      lines.push(`_${esc(titles.slice(0, 300))}_`);
      lines.push('');
    }
  }

  return { text: fitText(lines).trimEnd(), keyboard: [[ADMIN_TO]] };
}
