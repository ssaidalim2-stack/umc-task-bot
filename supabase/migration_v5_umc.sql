-- ============================================================
-- Migration v5: раздел umc.uz — воронка привлечения профилей на площадку
-- (блогеры / специалисты / бизнес), ведёт отдел продаж.
-- Идемпотентно: можно запускать повторно.
-- ============================================================

create table if not exists umc_leads (
  id bigserial primary key,
  kind text not null default 'blogger',   -- blogger | specialist | business
  name text,                              -- имя человека или название компании
  category text,                          -- ниша/категория (Blogers, Design, Education...)
  instagram text,
  phone text,
  email text,
  followers text,                         -- подписчики (текстом: "67 938", "~100k")
  city text,                              -- локация / регион аудитории
  note text,                              -- комментарий, договорённости
  profile_url text,                       -- ссылка на профиль на umc.uz, когда заведён
  status text not null default 'new',     -- new | contacted | invited | registered | rejected
  added_by bigint,                        -- telegram_id того, кто добавил (= кто ведёт)
  added_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ul_kind_idx on umc_leads (kind);
create index if not exists ul_status_idx on umc_leads (status);
create index if not exists ul_added_by_idx on umc_leads (added_by);
