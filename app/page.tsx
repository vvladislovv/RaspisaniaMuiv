/**
 * Статус-страница: видно, когда МУИВ обновлял расписание и что сделал бот.
 * Только чтение, только серверный рендер, никаких секретов в разметке.
 */
import { checkStatusToken } from '@/lib/auth';
import { allChats, latestFile, logsSince, recentFiles, recentLogs, getState } from '@/lib/db';
import { LAST_CHECK_KEY } from '@/lib/sync';
import { mskParts, mskStamp } from '@/lib/time';
import { humanDate } from '@/lib/format';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CHECK_STALE_MINUTES = 90;

interface LastCheck {
  at: string;
  filesOnSite: number;
  changed: string[];
  errors: string[];
  durationMs?: number;
}

type HourState = 'ok' | 'err' | 'none';

/** Раскладывает проверки последних 24 часов по клеткам ленты. */
function buildRibbon(logs: { ts: string; kind: string }[]): { state: HourState; hour: number }[] {
  const nowHour = Math.floor(Date.now() / 3_600_000);
  const cells: { state: HourState; hour: number }[] = [];

  for (let i = 23; i >= 0; i--) {
    const bucket = nowHour - i;
    const inBucket = logs.filter((l) => Math.floor(new Date(l.ts).getTime() / 3_600_000) === bucket);
    const hourMsk = mskParts(new Date(bucket * 3_600_000)).hour;

    let state: HourState = 'none';
    if (inBucket.some((l) => l.kind === 'error')) state = 'err';
    else if (inBucket.some((l) => l.kind === 'check')) state = 'ok';

    cells.push({ state, hour: hourMsk });
  }

  return cells;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(2).replace('.', ',')} МБ`;
}

export default async function StatusPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  const params = await searchParams;

  if (!checkStatusToken(params.t ?? null)) {
    return (
      <main className="gate">
        <h1 className="wordmark" style={{ color: 'var(--ink)' }}>
          Доступ по ссылке
        </h1>
        <p className="empty">Открой страницу со своим токеном в адресе: ?t=…</p>
      </main>
    );
  }

  const [lastCheck, file, files, chats, logs, dayLogs] = await Promise.all([
    getState<LastCheck>(LAST_CHECK_KEY),
    latestFile(),
    recentFiles(12),
    allChats(),
    recentLogs(50),
    logsSince(24),
  ]);

  const checkedAt = lastCheck ? new Date(lastCheck.at) : null;
  const minutesAgo = checkedAt ? Math.floor((Date.now() - checkedAt.getTime()) / 60_000) : null;
  const alive = minutesAgo !== null && minutesAgo <= CHECK_STALE_MINUTES;

  const ribbon = buildRibbon(dayLogs);
  const sendHour = env.sendHourMsk;
  const withGroup = chats.filter((c) => c.group_name && c.enabled).length;

  return (
    <div className="shell">
      <header className="masthead">
        <h1 className="wordmark">
          МУИВ<span>·</span>Расписание
        </h1>
        <span className={`pulse ${alive ? 'pulse--alive' : 'pulse--dead'}`}>
          <span className="pulse-dot" aria-hidden="true" />
          {alive ? 'Проверки идут' : 'Проверок нет'}
        </span>
      </header>

      <main>
        <section className="headline">
          <div className="spine">Последняя проверка</div>
          <div className="headline-body">
            {checkedAt ? (
              <>
                <p className="stamp">{mskStamp(checkedAt)}</p>
                <p className="subline">
                  {minutesAgo === 0 ? 'только что' : `${minutesAgo} мин назад`} · на странице файлов:{' '}
                  {lastCheck?.filesOnSite ?? 0}
                  {lastCheck?.durationMs
                    ? ` · за ${(lastCheck.durationMs / 1000).toFixed(1).replace('.', ',')} с`
                    : ''}
                </p>
                {lastCheck && lastCheck.errors.length > 0 && (
                  <p className="subline" style={{ color: 'var(--accent)' }}>
                    {lastCheck.errors.join('; ')}
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="stamp stamp--muted">проверок ещё не было</p>
                <p className="subline">
                  Настрой часовой крон на /api/tick — и здесь появится время последнего обхода.
                </p>
              </>
            )}

            <div className="ribbon">
              <p className="eyebrow">Сутки по часам</p>
              <div className="ribbon-track" role="img" aria-label="Проверки за последние 24 часа">
                {ribbon.map((cell, i) => (
                  <div
                    key={i}
                    className={
                      'hour' +
                      (cell.state === 'ok' ? ' hour--ok' : cell.state === 'err' ? ' hour--err' : '') +
                      (cell.hour === sendHour ? ' hour--send' : '')
                    }
                    title={`${String(cell.hour).padStart(2, '0')}:00 МСК — ${
                      cell.state === 'ok' ? 'проверка прошла' : cell.state === 'err' ? 'ошибка' : 'проверки не было'
                    }`}
                  />
                ))}
              </div>
              <div className="ribbon-scale" aria-hidden="true">
                {ribbon.map((cell, i) => (
                  <span key={i}>{i % 3 === 0 ? String(cell.hour).padStart(2, '0') : ''}</span>
                ))}
              </div>
              <p className="legend">
                <span className="legend-item">
                  <span className="swatch swatch--ok" /> проверка прошла
                </span>
                <span className="legend-item">
                  <span className="swatch swatch--err" /> ошибка
                </span>
                <span className="legend-item">
                  <span className="swatch swatch--none" /> проверки не было
                </span>
                <span className="legend-item">засечка снизу — час рассылки ({sendHour}:00 МСК)</span>
              </p>
            </div>
          </div>
        </section>

        <div className="columns">
          <section className="panel">
            <h2 className="panel-title">Актуальный файл</h2>
            {file ? (
              <dl className="facts">
                <dt>Название</dt>
                <dd>{file.title}</dd>

                <dt>Обновлён на сайте</dt>
                <dd className="mono">{file.site_updated ?? '—'}</dd>

                <dt>Неделя с</dt>
                <dd>{file.week_start ? humanDate(file.week_start) : '—'}</dd>

                <dt>Заметили</dt>
                <dd className="mono">{mskStamp(new Date(file.changed_at))}</dd>

                <dt>Размер</dt>
                <dd className="mono">{formatBytes(file.size)}</dd>

                <dt>sha256</dt>
                <dd className="mono">{file.sha256.slice(0, 24)}…</dd>
              </dl>
            ) : (
              <p className="empty">Расписание ещё не загружено.</p>
            )}
          </section>

          <section className="panel">
            <h2 className="panel-title">Чаты</h2>
            {chats.length > 0 ? (
              <>
                <div className="scroller">
                  <table>
                    <thead>
                      <tr>
                        <th>Чат</th>
                        <th>Группа</th>
                      </tr>
                    </thead>
                    <tbody>
                      {chats.map((chat) => (
                        <tr key={chat.chat_id}>
                          <td>
                            <span
                              className={chat.enabled ? 'dot-on' : 'dot-off'}
                              aria-label={chat.enabled ? 'включён' : 'выключен'}
                            />
                            {chat.title ?? <span className="mono">{chat.chat_id}</span>}
                          </td>
                          <td>{chat.group_name ?? <span className="empty">не выбрана</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="subline">Получают рассылку: {withGroup} из {chats.length}</p>
              </>
            ) : (
              <p className="empty">Ни один чат ещё не подключён. Добавь бота в группу и напиши /enable.</p>
            )}
          </section>
        </div>

        <section className="panel">
          <h2 className="panel-title">История файлов</h2>
          {files.length > 0 ? (
            <div className="scroller">
              <table>
                <thead>
                  <tr>
                    <th>Заметили</th>
                    <th>Файл</th>
                    <th>На сайте</th>
                    <th>Размер</th>
                    <th>Разбор</th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((row) => (
                    <tr key={row.id}>
                      <td className="mono nowrap">{mskStamp(new Date(row.changed_at))}</td>
                      <td>{row.title}</td>
                      <td className="mono nowrap">{row.site_updated ?? '—'}</td>
                      <td className="mono nowrap">{formatBytes(row.size)}</td>
                      <td className={row.parsed_ok ? '' : 'kind kind--error'}>
                        {row.parsed_ok ? 'ок' : row.parse_error ?? 'ошибка'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty">Файлов пока не видели.</p>
          )}
        </section>

        <section className="panel">
          <h2 className="panel-title">Журнал</h2>
          {logs.length > 0 ? (
            <div className="scroller">
              <table>
                <thead>
                  <tr>
                    <th>Время</th>
                    <th>Событие</th>
                    <th>Что произошло</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((row) => (
                    <tr key={row.id}>
                      <td className="mono nowrap">{mskStamp(new Date(row.ts))}</td>
                      <td className={`kind${row.kind === 'error' ? ' kind--error' : ''}`}>{row.kind}</td>
                      <td>{row.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty">Журнал пуст.</p>
          )}
        </section>
      </main>

      <footer>
        Источник — <a href="https://www.muiv.ru/studentu/spo/raspisanie/">muiv.ru/studentu/spo/raspisanie</a>.
        Страница только читает данные: запустить проверку или изменить настройки отсюда нельзя.
      </footer>
    </div>
  );
}
