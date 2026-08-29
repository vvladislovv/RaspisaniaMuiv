-- Схема БД для бота расписания МУИВ.
-- Запускать в Supabase → SQL Editor. Идемпотентно.

create table if not exists chats (
  chat_id       bigint primary key,
  title         text,
  group_name    text,
  enabled       boolean not null default true,
  pinned_msg_id bigint,
  -- какой день показывает закреплённое сообщение: нужно, чтобы при обновлении
  -- файла перерисовать его тем же днём, а не «завтрашним» от текущей даты
  pinned_date   date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table chats add column if not exists pinned_date date;

create table if not exists files (
  id           bigserial primary key,
  url          text not null unique,
  title        text not null,
  sha256       text not null,
  size         integer not null,
  site_updated text,
  week_start   date,
  parsed_ok    boolean not null default false,
  parse_error  text,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  changed_at   timestamptz not null default now()
);

create index if not exists files_changed_at_idx on files (changed_at desc);

create table if not exists schedules (
  id         bigserial primary key,
  file_id    bigint not null references files (id) on delete cascade,
  group_name text not null,
  sheet_name text,
  day_date   date not null,
  day_name   text not null,
  lessons    jsonb not null,
  unique (file_id, group_name, day_date)
);

create index if not exists schedules_lookup_idx on schedules (group_name, day_date);

create table if not exists logs (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  kind        text not null,
  chat_id     bigint,
  message     text not null,
  details     jsonb,
  duration_ms integer
);

create index if not exists logs_ts_idx on logs (ts desc);

create table if not exists rate_limit (
  chat_id      bigint not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (chat_id, window_start)
);

-- Состояние приложения: одна строка, ключ-значение.
create table if not exists app_state (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Доступ только через service_role с сервера. Публичных политик нет.
alter table chats      enable row level security;
alter table files      enable row level security;
alter table schedules  enable row level security;
alter table logs       enable row level security;
alter table rate_limit enable row level security;
alter table app_state  enable row level security;

-- Чистка старых логов и счётчиков rate limit.
create or replace function prune_old_rows() returns void language sql as $$
  delete from logs where ts < now() - interval '30 days';
  delete from rate_limit where window_start < now() - interval '1 hour';
$$;

-- Атомарный инкремент счётчика rate limit: возвращает новое значение.
create or replace function increment_rate_limit(p_chat_id bigint, p_window timestamptz)
returns integer language plpgsql as $$
declare
  new_count integer;
begin
  insert into rate_limit (chat_id, window_start, count)
  values (p_chat_id, p_window, 1)
  on conflict (chat_id, window_start)
  do update set count = rate_limit.count + 1
  returning count into new_count;
  return new_count;
end;
$$;
