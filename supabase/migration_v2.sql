-- ============================================================
-- Migration v2: проекты, контент-план, конвейер видео,
-- задачи с подтверждением, подписки, группы, отчёты
-- Идемпотентно: можно запускать повторно.
-- ============================================================

-- ---------- projects ----------
create table if not exists projects (
  id serial primary key,
  key text unique not null,
  name text not null,
  created_at timestamptz not null default now()
);

-- ---------- content_plans ----------
create table if not exists content_plans (
  id serial primary key,
  project_id int not null references projects(id) on delete cascade,
  period text not null,
  sheet_url text,
  video_target int not null default 0,
  graphic_target int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (project_id, period)
);

-- ---------- content_items (видео и графика) ----------
create table if not exists content_items (
  id bigserial primary key,
  plan_id int not null references content_plans(id) on delete cascade,
  project_id int not null references projects(id) on delete cascade,
  type text not null,                 -- video | graphic
  idx int not null,
  title text,
  format text,                        -- fun | sell (для видео)
  stage text not null default 'idea', -- video: idea|script|shoot|edit|published ; graphic: todo|done
  status text not null default 'in_progress', -- in_progress | done
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ci_plan_idx on content_items (plan_id);
create index if not exists ci_project_idx on content_items (project_id);

-- ---------- расширение tasks ----------
alter table tasks add column if not exists project_id int references projects(id) on delete set null;
alter table tasks add column if not exists kind text not null default 'adhoc';        -- adhoc | recurring | stage
alter table tasks add column if not exists recurrence text;                            -- daily|weekly|monthly|null
alter table tasks add column if not exists assignee_name text;                         -- если исполнитель ещё не в боте
alter table tasks add column if not exists needs_confirmation boolean not null default true;
alter table tasks add column if not exists confirmed_by bigint;
alter table tasks add column if not exists item_id bigint references content_items(id) on delete cascade;
-- status: new | in_progress | await_confirm | done | cancelled

-- ---------- subscriptions ----------
create table if not exists subscriptions (
  id serial primary key,
  app text not null,
  owner_id bigint,
  purchased_on date not null,
  period_days int not null default 30,
  expires_on date not null,
  reminded_before boolean not null default false,
  reminded_after boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- group_bindings ----------
create table if not exists group_bindings (
  id serial primary key,
  chat_id bigint not null,
  project_id int references projects(id) on delete cascade,
  specialty text,                      -- all|idea|script|shoot|edit|published|tasks
  created_at timestamptz not null default now(),
  unique (chat_id, project_id, specialty)
);

-- ---------- cron_markers (идемпотентность расписаний) ----------
create table if not exists cron_markers (
  marker text primary key,
  day date not null
);

-- ---------- app_settings (ключ-значение) ----------
create table if not exists app_settings (
  key text primary key,
  value text
);

-- ============================================================
-- SEED: проекты
-- ============================================================
insert into projects (key, name) values
  ('entrium','Entrium'),
  ('mystep','My Step'),
  ('ryan','Ryan Logistics'),
  ('sevencore','Sevencore Logistics'),
  ('cargogpt','Cargo GPT')
on conflict (key) do nothing;

-- ============================================================
-- SEED: контент-план июнь–июль 2026 (цели по видео/графике)
-- ============================================================
insert into content_plans (project_id, period, video_target, graphic_target, is_active)
select p.id, 'Июнь–Июль 2026', t.v, t.g, true
from (values
  ('entrium',10,3),
  ('mystep',10,3),
  ('ryan',12,15),
  ('sevencore',10,10),
  ('cargogpt',10,10)
) as t(key,v,g)
join projects p on p.key = t.key
on conflict (project_id, period) do nothing;

-- ============================================================
-- SEED: content_items (видео и графика) по целям плана
-- ============================================================
-- видео
insert into content_items (plan_id, project_id, type, idx, stage, status)
select cp.id, cp.project_id, 'video', g.n, 'idea', 'in_progress'
from content_plans cp
cross join lateral generate_series(1, cp.video_target) as g(n)
where cp.is_active
  and not exists (
    select 1 from content_items ci
    where ci.plan_id = cp.id and ci.type='video' and ci.idx = g.n
  );

-- графика
insert into content_items (plan_id, project_id, type, idx, stage, status)
select cp.id, cp.project_id, 'graphic', g.n, 'todo', 'in_progress'
from content_plans cp
cross join lateral generate_series(1, cp.graphic_target) as g(n)
where cp.is_active
  and not exists (
    select 1 from content_items ci
    where ci.plan_id = cp.id and ci.type='graphic' and ci.idx = g.n
  );

-- ============================================================
-- SEED: процессные задачи (на активный период) с именами исполнителей
-- ============================================================
insert into tasks (title, assignee_id, assignee_name, creator_id, kind, recurrence, status, needs_confirmation)
select v.title, null, v.who, 0, 'recurring', v.rec, 'new', true
from (values
  ('Проверка контент-плана','Саид','weekly'),
  ('Дача ТЗ','Бобур','weekly'),
  ('Включение таргета','Саид','weekly'),
  ('Назначение сьёмок','Бобур','weekly'),
  ('Проверка реквизитов','Бобур','weekly'),
  ('Назначение дедлайнов','Саид','weekly'),
  ('Сбор подписок','Саид','monthly')
) as v(title,who,rec)
where not exists (select 1 from tasks t where t.kind='recurring' and t.title = v.title);
