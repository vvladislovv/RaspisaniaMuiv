/**
 * Подставной сервер Supabase (PostgREST) для локальной разработки и тестов.
 * Держит данные в памяти, сохраняет снимок в JSON — так можно прогнать
 * весь путь бота, не подключаясь к настоящей базе.
 *
 * Запуск: node tools/fake-supabase.mjs [порт] [файл-снимка]
 */
import http from 'node:http';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const port = Number(process.argv[2] ?? 54321);
const snapshot = process.argv[3] ?? '/tmp/fake-supabase.json';

const PRIMARY_KEYS = {
  chats: ['chat_id'],
  files: ['url'],
  schedules: ['id'],
  logs: ['id'],
  rate_limit: ['chat_id', 'window_start'],
  app_state: ['key'],
};

/** Значения по умолчанию из schema.sql — заглушка их не знает сама. */
const COLUMN_DEFAULTS = {
  chats: { enabled: true, group_name: null, pinned_msg_id: null, title: null },
  files: { parsed_ok: false, parse_error: null, week_start: null, site_updated: null },
  logs: { chat_id: null, details: null, duration_ms: null },
  rate_limit: { count: 0 },
};

const tables = existsSync(snapshot)
  ? JSON.parse(readFileSync(snapshot, 'utf8'))
  : { chats: [], files: [], schedules: [], logs: [], rate_limit: [], app_state: [] };

const sequences = {};

function nextId(table) {
  sequences[table] ??= Math.max(0, ...tables[table].map((r) => Number(r.id) || 0));
  return ++sequences[table];
}

function save() {
  writeFileSync(snapshot, JSON.stringify(tables, null, 2));
}

/** Приводит значение фильтра из строки запроса к типу поля. */
function coerce(raw) {
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const unquoted = raw.replace(/^"|"$/g, '');
  if (/^-?\d+$/.test(unquoted)) return Number(unquoted);
  return unquoted;
}

function applyFilters(rows, params) {
  let out = rows;

  for (const [key, raw] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(key)) continue;

    const negate = raw.startsWith('not.');
    const body = negate ? raw.slice(4) : raw;
    const [op, ...rest] = body.split('.');
    const value = coerce(rest.join('.'));

    const test = (row) => {
      const cell = row[key];
      switch (op) {
        case 'eq':
          return cell === value || String(cell) === String(value);
        case 'neq':
          return String(cell) !== String(value);
        case 'is':
          return value === null ? cell === null || cell === undefined : cell === value;
        case 'gte':
          return String(cell) >= String(value);
        case 'lte':
          return String(cell) <= String(value);
        case 'gt':
          return String(cell) > String(value);
        case 'lt':
          return String(cell) < String(value);
        case 'in':
          return String(value).split(',').includes(String(cell));
        default:
          return true;
      }
    };

    out = out.filter((row) => (negate ? !test(row) : test(row)));
  }

  return out;
}

function applyOrder(rows, searchParams) {
  const order = searchParams.get('order');
  if (!order) return rows;

  const keys = order.split(',').map((part) => {
    const [column, ...flags] = part.split('.');
    return { column, desc: flags.includes('desc'), nullsFirst: flags.includes('nullsfirst') };
  });

  return [...rows].sort((a, b) => {
    for (const { column, desc, nullsFirst } of keys) {
      const x = a[column];
      const y = b[column];
      if (x === y) continue;
      if (x === null || x === undefined) return nullsFirst ? -1 : 1;
      if (y === null || y === undefined) return nullsFirst ? 1 : -1;
      const cmp = x < y ? -1 : 1;
      return desc ? -cmp : cmp;
    }
    return 0;
  });
}

function keyOf(table, row, conflictColumns) {
  const columns = conflictColumns ?? PRIMARY_KEYS[table] ?? ['id'];
  return columns.map((c) => String(row[c])).join(' ');
}

function respond(res, status, body, single) {
  const payload = single ? (Array.isArray(body) ? (body[0] ?? null) : body) : body;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload ?? null));
}

const rpc = {
  increment_rate_limit({ p_chat_id, p_window }) {
    const existing = tables.rate_limit.find(
      (r) => String(r.chat_id) === String(p_chat_id) && r.window_start === p_window,
    );
    if (existing) {
      existing.count += 1;
      return existing.count;
    }
    tables.rate_limit.push({ chat_id: p_chat_id, window_start: p_window, count: 1 });
    return 1;
  },
  prune_old_rows() {
    return null;
  },
};

function handleRpc(segments, raw, res) {
  const name = segments[segments.indexOf('rpc') + 1];
  const handler = rpc[name];
  if (!handler) return respond(res, 404, { message: `нет функции ${name}` });
  const value = handler(raw ? JSON.parse(raw) : {});
  save();
  return respond(res, 200, value);
}

function handleInsert(table, url, req, raw, res, single) {
  const incoming = raw ? JSON.parse(raw) : [];
  const list = Array.isArray(incoming) ? incoming : [incoming];
  const conflict = url.searchParams.get('on_conflict')?.split(',');
  const prefer = req.headers.prefer ?? '';
  const merge = prefer.includes('merge-duplicates');
  const ignore = prefer.includes('ignore-duplicates');
  const written = [];

  for (const row of list) {
    // Значения по умолчанию применяются только при вставке: при слиянии
    // (upsert по существующей строке) обновляются лишь переданные колонки.
    const record = { ...row };
    const existingIndex = conflict
      ? tables[table].findIndex((r) => keyOf(table, r, conflict) === keyOf(table, record, conflict))
      : -1;

    if (existingIndex !== -1 && merge) {
      tables[table][existingIndex] = { ...tables[table][existingIndex], ...record };
      written.push(tables[table][existingIndex]);
      continue;
    }
    if (existingIndex !== -1 && ignore) {
      written.push(tables[table][existingIndex]);
      continue;
    }
    if (existingIndex !== -1) {
      return respond(res, 409, {
        code: '23505',
        message: `duplicate key value violates unique constraint on ${table}`,
      });
    }

    for (const [column, value] of Object.entries(COLUMN_DEFAULTS[table] ?? {})) {
      if (record[column] === undefined) record[column] = value;
    }

    if (['files', 'schedules', 'logs'].includes(table) && record.id === undefined) {
      record.id = nextId(table);
    }
    if (table === 'chats' && record.created_at === undefined) {
      record.created_at = new Date().toISOString();
    }
    if (table === 'logs' && record.ts === undefined) {
      record.ts = new Date().toISOString();
    }
    if (table === 'files' && record.first_seen === undefined) {
      record.first_seen = new Date().toISOString();
    }

    tables[table].push(record);
    written.push(record);
  }

  save();
  return respond(res, 201, written, single);
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const segments = url.pathname.split('/').filter(Boolean);
    const single = (req.headers.accept ?? '').includes('vnd.pgrst.object');

    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });

    req.on('end', () => {
      try {
        if (segments.includes('rpc')) return handleRpc(segments, raw, res);

        const table = segments[segments.length - 1];
        if (!tables[table]) return respond(res, 404, { message: `нет таблицы ${table}` });

        const params = [...url.searchParams.entries()];

        if (req.method === 'GET') {
          let rows = applyFilters(tables[table], params);
          rows = applyOrder(rows, url.searchParams);
          const limit = url.searchParams.get('limit');
          if (limit) rows = rows.slice(0, Number(limit));
          return respond(res, 200, rows, single);
        }

        if (req.method === 'POST') return handleInsert(table, url, req, raw, res, single);

        if (req.method === 'PATCH') {
          const patch = raw ? JSON.parse(raw) : {};
          const rows = applyFilters(tables[table], params);
          for (const row of rows) Object.assign(row, patch);
          save();
          return respond(res, 200, rows, single);
        }

        if (req.method === 'DELETE') {
          const doomed = new Set(applyFilters(tables[table], params));
          tables[table] = tables[table].filter((row) => !doomed.has(row));
          save();
          return respond(res, 200, [...doomed], single);
        }

        return respond(res, 405, { message: `метод ${req.method} не поддержан` });
      } catch (error) {
        console.error('заглушка упала:', error);
        return respond(res, 500, { message: String(error) });
      }
    });
  })
  .listen(port, () => {
    console.log(`заглушка Supabase на http://127.0.0.1:${port} (снимок: ${snapshot})`);
  });
