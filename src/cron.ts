import * as db from "./db";
import { t, Lang } from "./i18n";
import { safeSend } from "./bot";

const DEFAULT_LANG = (process.env.DEFAULT_LANG as Lang) || "ru";
const HOUR = 60 * 60 * 1000;

function langOf(m: db.Member | null): Lang {
  return (m?.lang as Lang) || DEFAULT_LANG;
}

// Проверка дедлайнов и отправка напоминаний. Возвращает счётчик отправленного.
export async function runReminders(): Promise<{ checked: number; sent: number }> {
  const tasks = await db.listTasksForReminders();
  const now = Date.now();
  let sent = 0;

  for (const task of tasks) {
    if (!task.deadline) continue;
    const dl = new Date(task.deadline).getTime();
    const diff = dl - now; // >0: ещё не наступил
    const assignee = await db.getMember(task.assignee_id);
    const lang = langOf(assignee);

    // Просрочка
    if (diff <= 0 && !task.reminded_overdue) {
      await safeSend(task.assignee_id, t(lang, "remind_overdue_assignee", { id: task.id, title: task.title }));
      const admins = await db.listAdmins();
      for (const a of admins) {
        const al = langOf(a);
        await safeSend(
          a.telegram_id,
          t(al, "remind_overdue_admin", {
            id: task.id,
            title: task.title,
            assignee: assignee?.name || String(task.assignee_id),
          })
        );
      }
      await db.markReminded(task.id, "reminded_overdue");
      sent++;
      continue;
    }

    // За 1 час
    if (diff > 0 && diff <= HOUR && !task.reminded_1h) {
      await safeSend(task.assignee_id, t(lang, "remind_1h", { id: task.id, title: task.title }));
      await db.markReminded(task.id, "reminded_1h");
      sent++;
      continue;
    }

    // За 24 часа
    if (diff > HOUR && diff <= 24 * HOUR && !task.reminded_24h) {
      await safeSend(task.assignee_id, t(lang, "remind_24h", { id: task.id, title: task.title }));
      await db.markReminded(task.id, "reminded_24h");
      sent++;
    }
  }

  return { checked: tasks.length, sent };
}
