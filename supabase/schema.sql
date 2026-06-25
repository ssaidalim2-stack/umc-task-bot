-- Схема БД для Telegram-бота задач команды
-- Выполни в Supabase → SQL Editor → New query → Run

-- Участники команды
create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint unique not null,
  name text,
  username text,
  is_admin boolean not null default false,
  specialization text,
  lang text not null default 'ru',
  created_at timestamptz not null default now()
);

-- Задачи
create table if not exists tasks (
  id bigserial primary key,
  title text not null,
  description text,
  assignee_id bigint not null,            -- telegram_id исполнителя
  creator_id bigint not null,             -- telegram_id создателя
  deadline timestamptz,                   -- хранится в UTC
  priority text not null default 'normal',-- low | normal | high
  status text not null default 'new',     -- new | in_progress | done | paused | cancelled
  reminded_24h boolean not null default false,
  reminded_1h boolean not null default false,
  reminded_overdue boolean not null default false,
  chat_message_id bigint,                 -- id сообщения-карточки в чате исполнителя
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tasks_assignee_idx on tasks (assignee_id);
create index if not exists tasks_status_idx on tasks (status);
create index if not exists tasks_deadline_idx on tasks (deadline);

-- Состояние пошаговых диалогов (мастер /newtask), т.к. серверлесс без памяти
create table if not exists sessions (
  telegram_id bigint primary key,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- История действий по задачам (опционально, для будущих отчётов)
create table if not exists task_log (
  id bigserial primary key,
  task_id bigint references tasks(id) on delete cascade,
  actor_id bigint,
  action text,
  created_at timestamptz not null default now()
);
