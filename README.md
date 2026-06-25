# Team Task Bot 🤖

Telegram-бот для задач команды: создание задач, уведомления, напоминания о дедлайнах,
назначение исполнителей, статусы через кнопки. RU/UZ. Полностью бесплатный хостинг.

**Стек:** grammY + Supabase (Postgres) + Vercel (webhook) + GitHub Actions (напоминания).

Полное ТЗ — в [`ТЗ.md`](./ТЗ.md).

---

## Что нужно (всё бесплатно)

- Аккаунт **Telegram** (есть)
- Аккаунт **Supabase** (есть) — база данных
- Аккаунт **Vercel** (есть) — хостинг бота
- Аккаунт **GitHub** (есть) — код + планировщик напоминаний

Локальный Node.js **не нужен** — всё собирается в облаке Vercel.

---

## Шаг 1. Создать бота в Telegram

1. Открой [@BotFather](https://t.me/BotFather) → `/newbot`.
2. Задай имя и username (должен заканчиваться на `bot`).
3. Скопируй **токен** вида `123456:ABC-...` → это `BOT_TOKEN`.
4. Узнай свой Telegram ID: напиши [@userinfobot](https://t.me/userinfobot), он пришлёт число → это твой `ADMIN_IDS`.

---

## Шаг 2. Создать базу в Supabase

1. [supabase.com](https://supabase.com) → твой проект (или New project, бесплатный).
2. **SQL Editor → New query** → вставь содержимое [`supabase/schema.sql`](./supabase/schema.sql) → **Run**.
3. **Project Settings → API** скопируй:
   - `Project URL` → это `SUPABASE_URL`
   - `service_role` secret → это `SUPABASE_SERVICE_KEY` (⚠️ секретный, не публикуй).

---

## Шаг 3. Залить код на GitHub

Из папки проекта (`~/team-task-bot`):

```bash
cd ~/team-task-bot
git init
git add .
git commit -m "Team task bot"
git branch -M main
git remote add origin https://github.com/<твой_логин>/team-task-bot.git
git push -u origin main
```

(Репозиторий заранее создай на github.com → New repository → `team-task-bot`, private.)

---

## Шаг 4. Задеплоить на Vercel

1. [vercel.com](https://vercel.com) → **Add New → Project** → импортируй репозиторий `team-task-bot`.
2. В разделе **Environment Variables** добавь (значения из шагов 1–2):

   | Имя | Значение |
   |-----|----------|
   | `BOT_TOKEN` | токен от BotFather |
   | `WEBHOOK_SECRET` | любая длинная случайная строка |
   | `SUPABASE_URL` | URL проекта Supabase |
   | `SUPABASE_SERVICE_KEY` | service_role ключ |
   | `ADMIN_IDS` | твой Telegram ID (несколько — через запятую) |
   | `CRON_SECRET` | любая длинная случайная строка |
   | `TIMEZONE` | `Asia/Tashkent` |
   | `DEFAULT_LANG` | `ru` |

3. **Deploy**. После деплоя скопируй адрес вида `https://team-task-bot-xxxx.vercel.app` → это `APP_URL`.

---

## Шаг 5. Подключить webhook (бот начнёт отвечать)

Открой в браузере одну ссылку, подставив свои значения:

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<APP_URL>/api/bot&secret_token=<WEBHOOK_SECRET>&allowed_updates=["message","callback_query"]
```

Пример:
```
https://api.telegram.org/bot123456:ABC.../setWebhook?url=https://team-task-bot-xxxx.vercel.app/api/bot&secret_token=mysecret123&allowed_updates=["message","callback_query"]
```

Ответ `{"ok":true,...}` = webhook установлен. Напиши боту `/start` — он ответит. 🎉

---

## Шаг 6. Включить напоминания (каждые 15 минут, бесплатно)

Vercel на бесплатном плане запускает Cron только раз в день, поэтому напоминания
гоняем через GitHub Actions (файл `.github/workflows/cron.yml` уже в репозитории).

1. GitHub → репозиторий → **Settings → Secrets and variables → Actions → New repository secret**:
   - `APP_URL` = `https://team-task-bot-xxxx.vercel.app`
   - `CRON_SECRET` = та же строка, что в Vercel
2. Вкладка **Actions** → разреши workflows. Готово — каждые 15 минут бот проверяет дедлайны.

> Альтернатива без GitHub Actions: бесплатный [cron-job.org](https://cron-job.org) →
> создать задание GET-запроса на `https://<APP_URL>/api/cron?secret=<CRON_SECRET>` каждые 15 мин.

---

## Как пользоваться

**Все:**
- `/start` — регистрация + выбор языка (RU/UZ)
- `/mytasks` — мои активные задачи
- `/lang` — сменить язык
- `/help` — помощь

**Админы:**
- `/newtask` — создать задачу (пошагово: название → описание → исполнитель → дедлайн → приоритет)
- `/tasks` — все активные задачи
- `/team` — список команды и ролей
- `/setrole <telegram_id> admin|member <специализация>` — назначить доступ и роль
  - пример: `/setrole 555555555 member дизайнер`

Под карточкой задачи у исполнителя есть кнопки **«Взять в работу»** и **«Готово»** —
статус меняется на месте, при «Готово» админу приходит уведомление.

**Состав команды на старте:** добавь людей — пусть каждый напишет боту `/start`,
затем ты через `/setrole` выставишь роли (Бобур — smm, Самандар/Асрор — монтажёр,
Владимир — дизайнер).

---

## Обновление кода

После правок:
```bash
git add . && git commit -m "update" && git push
```
Vercel пересоберёт автоматически.
