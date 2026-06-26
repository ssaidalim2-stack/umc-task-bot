import * as db from "./db";
import * as d2 from "./db2";
import { t, Lang } from "./i18n";
import { bot, safeSend } from "./bot";
import { buildReport } from "./views";

const DEFAULT_LANG = (process.env.DEFAULT_LANG as Lang) || "ru";
const HOUR = 60 * 60 * 1000;
const TZ_OFFSET = 5 * HOUR; // Asia/Tashkent

function langOf(m: db.Member | null): Lang {
  return (m?.lang as Lang) || DEFAULT_LANG;
}

export async function runReminders(): Promise<{ checked: number; sent: number }> {
  let sent = 0;
  const now = Date.now();
  const local = new Date(now + TZ_OFFSET);
  const hour = local.getUTCHours();
  const dow = local.getUTCDay(); // 0=Sun
  const dom = local.getUTCDate();
  const day = local.toISOString().slice(0, 10);

  sent += await deadlineReminders(now);
  sent += await subscriptionReminders(day);

  // 3×/день дайджесты задач (08:00, 14:00, 20:00)
  if ([8, 14, 20].includes(hour)) {
    if (await d2.claimMarker(`digest_${hour}`, day)) sent += await sendDigests();
  }

  // отчёты в 08:00 утра
  if (hour === 8) {
    if (await d2.claimMarker("report_daily", day)) sent += await sendReport("Ежедневный отчёт");
    if (dow === 1 && (await d2.claimMarker("report_weekly", day))) sent += await sendReport("Еженедельный отчёт");
    if (dom === 1 && (await d2.claimMarker("report_monthly", day))) sent += await sendReport("Ежемесячный отчёт");
  }

  // синхронизация из Google-таблиц 2 раза в день (09:00 и 18:00)
  if ([9, 18].includes(hour) && (await d2.claimMarker(`sheetsync_${hour}`, day))) {
    try { const { syncFromSheets } = await import("./sheets"); await syncFromSheets(); sent++; } catch (e) { console.error("sheetsync", e); }
  }

  // сброс повторяющихся задач
  if (dow === 1 && hour === 6 && (await d2.claimMarker("reset_weekly", day))) await resetRecurring("weekly");
  if (dom === 1 && hour === 6 && (await d2.claimMarker("reset_monthly", day))) await resetRecurring("monthly");

  return { checked: 0, sent };
}

// ---------- дедлайны ----------
async function deadlineReminders(now: number): Promise<number> {
  const tasks = await db.listTasksForReminders();
  let sent = 0;
  for (const task of tasks as any[]) {
    if (!task.deadline || !task.assignee_id) continue;
    const dl = new Date(task.deadline).getTime();
    const diff = dl - now;
    const assignee = await db.getMember(task.assignee_id);
    const lang = langOf(assignee);
    if (diff <= 0 && !task.reminded_overdue) {
      await safeSend(task.assignee_id, t(lang, "remind_overdue_assignee", { id: task.id, title: task.title }));
      for (const a of await db.listAdmins())
        await safeSend(a.telegram_id, t(langOf(a), "remind_overdue_admin", { id: task.id, title: task.title, assignee: assignee?.name || String(task.assignee_id) }));
      await db.markReminded(task.id, "reminded_overdue"); sent++;
    } else if (diff > 0 && diff <= HOUR && !task.reminded_1h) {
      await safeSend(task.assignee_id, t(lang, "remind_1h", { id: task.id, title: task.title }));
      await db.markReminded(task.id, "reminded_1h"); sent++;
    } else if (diff > HOUR && diff <= 24 * HOUR && !task.reminded_24h) {
      await safeSend(task.assignee_id, t(lang, "remind_24h", { id: task.id, title: task.title }));
      await db.markReminded(task.id, "reminded_24h"); sent++;
    }
  }
  return sent;
}

// ---------- подписки ----------
async function subscriptionReminders(today: string): Promise<number> {
  const subs = await d2.listSubscriptions();
  let sent = 0;
  const admins = await db.listAdmins();
  const recipients = admins.map((a) => a.telegram_id);
  for (const s of subs) {
    const daysLeft = Math.round((new Date(s.expires_on).getTime() - new Date(today).getTime()) / 86400000);
    if (daysLeft <= 3 && daysLeft >= 0 && !s.reminded_before) {
      for (const r of recipients) await safeSend(r, `💳 Подписка *${s.app}* заканчивается через ${daysLeft} дн. (${s.expires_on}). Продлить?`, { parse_mode: "Markdown" });
      await d2.markSub(s.id, "reminded_before"); sent++;
    }
    if (daysLeft < 0 && !s.reminded_after) {
      for (const r of recipients) await safeSend(r, `⚠️ Подписка *${s.app}* закончилась (${s.expires_on}). Отключи/продли.`, { parse_mode: "Markdown" });
      await d2.markSub(s.id, "reminded_after"); sent++;
    }
  }
  return sent;
}

// ---------- дайджесты 3×/день ----------
async function sendDigests(): Promise<number> {
  const members = await db.listMembers();
  let sent = 0;
  for (const m of members) {
    const tasks = await d2.tasksForMember(m);
    const open = tasks.filter((x) => x.status === "new" || x.status === "in_progress");
    if (open.length > 0) {
      const lines = [`☀️ Доброе утро, ${m.name}! Твои задачи на сегодня:`, ""];
      open.forEach((tk) => lines.push(`• ${tk.title}`));
      lines.push("", "Открой /menu → ✅ Мои задачи, чтобы отметить выполнение.");
      await safeSend(m.telegram_id, lines.join("\n")); sent++;
    }
  }
  // если задач в системе не осталось — поздравить админов
  const allOpen = (await d2.listOpenTasks()).filter((t) => t.status === "new" || t.status === "in_progress");
  if (allOpen.length === 0) {
    for (const a of await db.listAdmins()) { await safeSend(a.telegram_id, "🎉 Все задачи выполнены! Отличная работа команды."); sent++; }
  }
  return sent;
}

// ---------- отчёты ----------
async function sendReport(title: string): Promise<number> {
  const r = await buildReport(title);
  let sent = 0;
  for (const a of await db.listAdmins()) {
    try { await bot.api.sendPhoto(a.telegram_id, r.chartUrl, { caption: r.text, parse_mode: "Markdown" }); }
    catch { await safeSend(a.telegram_id, r.text, { parse_mode: "Markdown" }); }
    sent++;
  }
  return sent;
}

// ---------- сброс повторяющихся ----------
async function resetRecurring(recurrence: string): Promise<void> {
  const tasks = await d2.listOpenTasks();
  // переоткрываем выполненные повторяющиеся; но listOpenTasks не вернёт done — отдельный запрос
  const { supabase } = await import("./db");
  await supabase.from("tasks").update({ status: "new", confirmed_by: null }).eq("kind", "recurring").eq("recurrence", recurrence).eq("status", "done");
}
