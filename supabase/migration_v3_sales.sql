-- ============================================================
-- Migration v3: отдел продаж — лог контактов с потенциальными клиентами
-- Идемпотентно: можно запускать повторно.
-- ============================================================

create table if not exists sales_leads (
  id bigserial primary key,
  name text,                          -- имя человека
  niche text,                         -- ниша
  instagram text,
  phone text,                         -- номер для связи
  called_at text,                     -- когда был звонок (свободный текст, как дедлайны в контент-плане)
  response text,                      -- какой был ответ
  status text not null default 'new', -- new | in_progress | interested | rejected | won
  added_by bigint,                    -- telegram_id того, кто добавил (= кто общался)
  added_by_name text,                 -- снэпшот имени на момент добавления
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sl_added_by_idx on sales_leads (added_by);
create index if not exists sl_status_idx on sales_leads (status);
