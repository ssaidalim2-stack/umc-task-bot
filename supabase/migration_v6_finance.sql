-- ============================================================
-- Migration v6: финансы — доходы от клиентов, расходы, зарплаты команды.
-- Идемпотентно: можно запускать повторно.
--
-- Учёт ведётся по циклам 15→15 (как аналитика и календарь): cycle = 'YYYY-MM',
-- это цикл с 15-го числа этого месяца по 14-е следующего.
-- ============================================================

-- ---------- единый журнал денег ----------
-- kind:
--   income  — оплата от клиента (planned = ожидается, done = получено)
--   expense — прочий расход агентства (реклама, локация, реквизит, подписки…)
--   accrual — начисление сотруднику (сколько ему ДОЛЖНЫ за работу)
--   payout  — выплата сотруднику (сколько ему реально ОТДАЛИ, в т.ч. авансы)
-- Прибыль цикла считается по начислениям (сколько стоила работа), а не по выплатам:
-- аванс в одном цикле и доплата в другом не искажают прибыль ни одного из них.
create table if not exists fin_entries (
  id bigserial primary key,
  kind text not null,
  category text,                         -- fee|other | ads|subs|location|props|transport|equipment|other | salary|project_fixed|shoot|edit|graphic|bonus|deduction
  project_id int references projects(id) on delete set null,
  member_id bigint,                      -- telegram_id сотрудника (accrual / payout)
  cycle text not null,                   -- 'YYYY-MM': к какому циклу относится
  amount numeric(14,2) not null default 0,
  currency text not null default 'UZS',  -- UZS | USD
  rate numeric(12,2),                    -- курс ЦБ (сум за 1$), зафиксированный на дату операции
  status text not null default 'done',   -- planned | done | void
  due_on date,                           -- для ожидаемых оплат клиента
  paid_on date,                          -- фактическая дата денег
  note text,
  ref text unique,                       -- ключ автосоздания: повторный запуск не задвоит
  item_id bigint,                        -- пункт контент-плана (для сдельных начислений)
  created_by bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists fe_cycle_idx on fin_entries (cycle);
create index if not exists fe_kind_idx on fin_entries (kind);
create index if not exists fe_member_idx on fin_entries (member_id);
create index if not exists fe_project_idx on fin_entries (project_id);

-- ---------- схема оплаты сотрудника ----------
-- Человек может совмещать несколько правил (напр. Бобур: оклад ПМ + фикс за проекты).
-- kind:
--   salary         — оклад по должности, каждый цикл
--   project_fixed  — фикс за ведение проекта, каждый цикл (project_id обязателен)
--   shoot          — ставка за съёмку одного видео
--   edit           — ставка за монтаж одного видео
--   graphic        — ставка за одну графику
-- Для сдельных ставок project_id необязателен: ставка конкретного проекта
-- перебивает общую.
create table if not exists fin_pay_rules (
  id serial primary key,
  member_id bigint not null,
  kind text not null,
  project_id int references projects(id) on delete cascade,
  amount numeric(14,2) not null default 0,
  currency text not null default 'UZS',
  title text,                            -- подпись, напр. «Проджект-менеджер»
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists fpr_member_idx on fin_pay_rules (member_id);

-- ---------- условия оплаты клиента по проекту ----------
-- schedule: prepay (100% в начале цикла) | split (50% в начале, 50% в конце)
--           | post (100% в конце) | manual (оплаты вносятся вручную)
create table if not exists fin_project_terms (
  project_id int primary key references projects(id) on delete cascade,
  fee numeric(14,2) not null default 0,
  currency text not null default 'USD',
  schedule text not null default 'prepay',
  start_cycle text,                      -- с какого цикла ставить ожидаемые оплаты
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

-- ---------- цена подписки: продление сразу пишет расход ----------
alter table subscriptions add column if not exists price numeric(14,2);
alter table subscriptions add column if not exists currency text default 'USD';
