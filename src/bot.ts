import { Bot } from "grammy";
import { t, Lang } from "./i18n";
import * as db from "./db";
import {
  langKeyboard,
  skipKeyboard,
  assigneeKeyboard,
  deadlineKeyboard,
  priorityKeyboard,
  taskCardKeyboard,
} from "./keyboards";
import { renderCard, renderTaskLine } from "./render";
import { quickDeadline, parseCustomDeadline } from "./time";
import { registerV2 } from "./v2";
import { mainMenu } from "./views";

export const bot = new Bot(process.env.BOT_TOKEN as string);

// регистрируем v2-обработчики ДО message:text-визарда (иначе команды не сработают)
registerV2(bot);

const ENV_ADMINS: number[] = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !Number.isNaN(n));

const DEFAULT_LANG = (process.env.DEFAULT_LANG as Lang) || "ru";

function langOf(m: db.Member | null): Lang {
  return (m?.lang as Lang) || DEFAULT_LANG;
}

function isAdmin(m: db.Member | null, tgId: number): boolean {
  return Boolean(m?.is_admin) || ENV_ADMINS.includes(tgId);
}

function displayName(from: { first_name?: string; last_name?: string; username?: string }): string {
  return [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || "user";
}

// ---------------- Commands ----------------

bot.command("start", async (ctx) => {
  const from = ctx.from!;
  const existing = await db.getMember(from.id);
  const member = await db.upsertMember({
    telegram_id: from.id,
    name: existing?.name || displayName(from),
    username: from.username || existing?.username || null,
    // первичные админы из env становятся админами автоматически
    is_admin: existing?.is_admin ?? ENV_ADMINS.includes(from.id),
    specialization: existing?.specialization ?? null,
    lang: existing?.lang || DEFAULT_LANG,
  });
  await ctx.reply(t(langOf(member), "start_welcome", { name: member.name || "" }), {
    reply_markup: langKeyboard(),
  });
});

bot.command("lang", async (ctx) => {
  await ctx.reply(t(DEFAULT_LANG, "lang_choose"), { reply_markup: langKeyboard() });
});

bot.command("help", async (ctx) => {
  const m = await db.getMember(ctx.from!.id);
  await ctx.reply(t(langOf(m), "help"));
});

bot.command("mytasks", async (ctx) => {
  const m = await db.getMember(ctx.from!.id);
  if (!m) return ctx.reply(t(DEFAULT_LANG, "not_registered"));
  const lang = langOf(m);
  const tasks = await db.listMyActiveTasks(ctx.from!.id);
  if (tasks.length === 0) return ctx.reply(t(lang, "mytasks_empty"));
  const lines = [t(lang, "mytasks_header")];
  for (const task of tasks) lines.push(renderTaskLine(lang, task, m));
  await ctx.reply(lines.join("\n"));
});

bot.command("tasks", async (ctx) => {
  const m = await db.getMember(ctx.from!.id);
  if (!m) return ctx.reply(t(DEFAULT_LANG, "not_registered"));
  const lang = langOf(m);
  if (!isAdmin(m, ctx.from!.id)) return ctx.reply(t(lang, "admin_only"));
  const tasks = await db.listAllTasks();
  if (tasks.length === 0) return ctx.reply(t(lang, "tasks_empty"));
  const members = await db.listMembers();
  const byId = new Map(members.map((x) => [x.telegram_id, x]));
  const lines = [t(lang, "tasks_header")];
  for (const task of tasks) lines.push(renderTaskLine(lang, task, byId.get(task.assignee_id) || null));
  await ctx.reply(lines.join("\n"));
});

bot.command("team", async (ctx) => {
  const m = await db.getMember(ctx.from!.id);
  if (!m) return ctx.reply(t(DEFAULT_LANG, "not_registered"));
  const lang = langOf(m);
  if (!isAdmin(m, ctx.from!.id)) return ctx.reply(t(lang, "admin_only"));
  const members = await db.listMembers();
  const lines = [t(lang, "team_header")];
  for (const x of members) {
    lines.push(
      t(lang, "team_line", {
        admin: x.is_admin ? "👑 " : "",
        name: x.name || "",
        username: x.username || "-",
        role: x.specialization || t(lang, "role_none"),
      })
    );
  }
  await ctx.reply(lines.join("\n"));
});

// /setrole <telegram_id> admin|member <specialization>
bot.command("setrole", async (ctx) => {
  const m = await db.getMember(ctx.from!.id);
  if (!m) return ctx.reply(t(DEFAULT_LANG, "not_registered"));
  const lang = langOf(m);
  if (!isAdmin(m, ctx.from!.id)) return ctx.reply(t(lang, "admin_only"));
  const parts = (ctx.match as string).trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return ctx.reply(t(lang, "setrole_usage"));
  const targetId = parseInt(parts[0], 10);
  const access = parts[1].toLowerCase();
  const spec = parts.slice(2).join(" ") || null;
  const target = await db.getMember(targetId);
  if (!target) return ctx.reply(t(lang, "setrole_notfound"));
  const wantAdmin = access === "admin";
  await db.setMemberRole(targetId, wantAdmin, spec ?? target.specialization);
  await ctx.reply(
    t(lang, "setrole_done", {
      name: target.name || String(targetId),
      access: t(lang, wantAdmin ? "access_admin" : "access_member"),
      role: spec || target.specialization || t(lang, "role_none"),
    })
  );
});

// /newtask — старт мастера (только админ)
bot.command("newtask", async (ctx) => {
  const m = await db.getMember(ctx.from!.id);
  if (!m) return ctx.reply(t(DEFAULT_LANG, "not_registered"));
  const lang = langOf(m);
  if (!isAdmin(m, ctx.from!.id)) return ctx.reply(t(lang, "admin_only"));
  await db.setSession(ctx.from!.id, { step: "title", draft: {} });
  await ctx.reply(t(lang, "nt_start"), { parse_mode: "Markdown" });
});

bot.command("cancel", async (ctx) => {
  const m = await db.getMember(ctx.from!.id);
  await db.clearSession(ctx.from!.id);
  await ctx.reply(t(langOf(m), "nt_cancelled"));
});

// ---------------- Callback queries ----------------

bot.callbackQuery(/^lang:(ru|uz)$/, async (ctx) => {
  const lang = ctx.match![1] as Lang;
  await db.setMemberLang(ctx.from.id, lang);
  const m = await db.getMember(ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.reply(t(lang, "lang_set"));
  if (m) {
    await ctx.reply(
      t(lang, "start_registered", {
        name: m.name || "",
        role: m.specialization || t(lang, "role_none"),
        access: t(lang, isAdmin(m, ctx.from.id) ? "access_admin" : "access_member"),
      })
    );
    await ctx.reply("🏠 Главное меню:", { reply_markup: mainMenu() });
  }
});

bot.callbackQuery("nt_skipdesc", async (ctx) => {
  await ctx.answerCallbackQuery();
  await advanceToAssignee(ctx, null);
});

bot.callbackQuery(/^nt_assignee:(\d+)$/, async (ctx) => {
  const assigneeId = parseInt(ctx.match![1], 10);
  const m = await db.getMember(ctx.from.id);
  const lang = langOf(m);
  const s = await db.getSession(ctx.from.id);
  s.draft = { ...(s.draft || {}), assignee_id: assigneeId };
  s.step = "deadline";
  await db.setSession(ctx.from.id, s);
  await ctx.answerCallbackQuery();
  await ctx.reply(t(lang, "nt_ask_deadline"), { parse_mode: "Markdown", reply_markup: deadlineKeyboard(lang) });
});

bot.callbackQuery(/^nt_dl:(today|tomorrow|3d|week|custom|none)$/, async (ctx) => {
  const code = ctx.match![1];
  const m = await db.getMember(ctx.from.id);
  const lang = langOf(m);
  const s = await db.getSession(ctx.from.id);
  await ctx.answerCallbackQuery();
  if (code === "custom") {
    s.step = "deadline_custom";
    await db.setSession(ctx.from.id, s);
    return ctx.reply(t(lang, "nt_deadline_ask_custom"), { parse_mode: "Markdown" });
  }
  const dl = quickDeadline(code);
  s.draft = { ...(s.draft || {}), deadline: dl ? dl.toISOString() : null };
  s.step = "priority";
  await db.setSession(ctx.from.id, s);
  await ctx.reply(t(lang, "nt_ask_priority"), { parse_mode: "Markdown", reply_markup: priorityKeyboard(lang) });
});

bot.callbackQuery(/^nt_prio:(low|normal|high)$/, async (ctx) => {
  const priority = ctx.match![1];
  await ctx.answerCallbackQuery();
  await finishTask(ctx, priority);
});

// Смена статуса задачи: ts:<action>:<taskId>
bot.callbackQuery(/^ts:(take|done|info):(\d+)$/, async (ctx) => {
  const action = ctx.match![1];
  const taskId = parseInt(ctx.match![2], 10);
  const actor = await db.getMember(ctx.from.id);
  const lang = langOf(actor);
  const task = await db.getTask(taskId);
  if (!task) return ctx.answerCallbackQuery();

  if (action === "info") {
    return ctx.answerCallbackQuery({
      text: task.description
        ? t(lang, "cb_info", { id: taskId, desc: task.description })
        : t(lang, "cb_no_desc"),
      show_alert: true,
    });
  }

  // менять статус могут исполнитель или админ
  if (task.assignee_id !== ctx.from.id && !isAdmin(actor, ctx.from.id)) {
    return ctx.answerCallbackQuery({ text: t(lang, "cb_no_access"), show_alert: true });
  }

  const newStatus = action === "take" ? "in_progress" : "done";
  await db.updateTaskStatus(taskId, newStatus);
  await db.logAction(taskId, ctx.from.id, newStatus);
  const updated = await db.getTask(taskId);
  const assignee = await db.getMember(task.assignee_id);

  try {
    await ctx.editMessageText(renderCard(lang, updated!, assignee), {
      reply_markup: taskCardKeyboard(taskId, lang, newStatus),
    });
  } catch (_) {
    /* сообщение могло быть неизменно */
  }
  await ctx.answerCallbackQuery({ text: t(lang, action === "take" ? "cb_taken" : "cb_done") });

  // уведомить создателя/админов о завершении
  if (newStatus === "done") {
    const recipients = new Set<number>([task.creator_id]);
    const admins = await db.listAdmins();
    admins.forEach((a) => recipients.add(a.telegram_id));
    recipients.delete(ctx.from.id);
    for (const rid of recipients) {
      const r = await db.getMember(rid);
      const rl = langOf(r);
      await safeSend(rid, t(rl, "creator_done_notice", {
        assignee: assignee?.name || String(task.assignee_id),
        id: taskId,
        title: task.title,
      }));
    }
  }
});

// ---------------- Text (мастер: title / desc / custom deadline) ----------------

bot.on("message:text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return; // команды обрабатываются выше
  const m = await db.getMember(ctx.from!.id);
  const lang = langOf(m);
  const s = await db.getSession(ctx.from!.id);
  if (!s.step) return; // нет активного мастера — игнор

  if (s.step === "title") {
    s.draft = { ...(s.draft || {}), title: ctx.message.text.trim() };
    s.step = "desc";
    await db.setSession(ctx.from!.id, s);
    return ctx.reply(t(lang, "nt_ask_desc"), { parse_mode: "Markdown", reply_markup: skipKeyboard(lang) });
  }

  if (s.step === "desc") {
    return advanceToAssignee(ctx, ctx.message.text.trim());
  }

  if (s.step === "deadline_custom") {
    const dl = parseCustomDeadline(ctx.message.text);
    if (!dl) return ctx.reply(t(lang, "nt_deadline_bad"), { parse_mode: "Markdown" });
    s.draft = { ...(s.draft || {}), deadline: dl.toISOString() };
    s.step = "priority";
    await db.setSession(ctx.from!.id, s);
    return ctx.reply(t(lang, "nt_ask_priority"), { parse_mode: "Markdown", reply_markup: priorityKeyboard(lang) });
  }
});

// ---------------- Helpers ----------------

async function advanceToAssignee(ctx: any, description: string | null) {
  const m = await db.getMember(ctx.from.id);
  const lang = langOf(m);
  const s = await db.getSession(ctx.from.id);
  s.draft = { ...(s.draft || {}), description };
  s.step = "assignee";
  await db.setSession(ctx.from.id, s);
  const members = await db.listMembers();
  if (members.length === 0) {
    await db.clearSession(ctx.from.id);
    return ctx.reply(t(lang, "nt_no_members"));
  }
  await ctx.reply(t(lang, "nt_ask_assignee"), {
    parse_mode: "Markdown",
    reply_markup: assigneeKeyboard(members),
  });
}

async function finishTask(ctx: any, priority: string) {
  const creator = await db.getMember(ctx.from.id);
  const lang = langOf(creator);
  const s = await db.getSession(ctx.from.id);
  const d = s.draft || {};
  if (!d.title || !d.assignee_id) {
    await db.clearSession(ctx.from.id);
    return ctx.reply(t(lang, "nt_cancelled"));
  }
  const task = await db.createTask({
    title: d.title,
    description: d.description ?? null,
    assignee_id: d.assignee_id,
    creator_id: ctx.from.id,
    deadline: d.deadline ?? null,
    priority,
  });
  await db.clearSession(ctx.from.id);
  await db.logAction(task.id, ctx.from.id, "created");

  await ctx.reply(t(lang, "nt_created_creator", { id: task.id }));

  // уведомление исполнителю на его языке
  const assignee = await db.getMember(d.assignee_id);
  const al = langOf(assignee);
  const text = t(al, "card_new_for_assignee") + "\n\n" + renderCard(al, task, assignee);
  const sent = await safeSend(d.assignee_id, text, {
    reply_markup: taskCardKeyboard(task.id, al, "new"),
  });
  if (sent && (sent as any).message_id) {
    await db.setTaskMessageId(task.id, (sent as any).message_id);
  }
}

export async function safeSend(chatId: number, text: string, extra?: any) {
  try {
    return await bot.api.sendMessage(chatId, text, extra);
  } catch (e) {
    console.error("sendMessage failed for", chatId, e);
    return null;
  }
}

// единоразовая инициализация (для serverless)
let initialized = false;
export async function ensureInit() {
  if (!initialized) {
    await bot.init();
    initialized = true;
  }
}
