import { Bot, InlineKeyboard } from "grammy";
import * as db from "./db";
import * as d2 from "./db2";
import * as views from "./views";
import { STAGE_OWNERS, STAGE_LABEL, nextStage, APPS } from "./projects";

const ENV_ADMINS: number[] = (process.env.ADMIN_IDS || "").split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n));

function isAdmin(m: db.Member | null, id: number): boolean {
  return Boolean(m?.is_admin) || ENV_ADMINS.includes(id);
}

async function nav(ctx: any, v: { text: string; kb: InlineKeyboard }) {
  const opts = { parse_mode: "Markdown" as const, reply_markup: v.kb };
  try {
    await ctx.editMessageText(v.text, opts);
  } catch {
    try { await ctx.reply(v.text, opts); } catch { await ctx.reply(v.text, { reply_markup: v.kb }); }
  }
  try { await ctx.answerCallbackQuery(); } catch {}
}

async function projectsKeyboard(prefix: string): Promise<InlineKeyboard> {
  const projects = await d2.getProjects();
  const kb = new InlineKeyboard();
  for (const p of projects) kb.text(p.name, `${prefix}:${p.id}`).row();
  return kb;
}

export function registerV2(bot: Bot) {
  // ----- главное меню -----
  bot.command("menu", async (ctx) => {
    await ctx.reply("🏠 Главное меню:", { reply_markup: views.mainMenu() });
  });
  bot.command("app", async (ctx) => {
    const url = process.env.APP_URL || "https://umc-task-bot.vercel.app";
    await ctx.reply("🚀 Открой приложение:", { reply_markup: new InlineKeyboard().webApp("Открыть UMC Task", url) });
  });
  bot.callbackQuery("home", async (ctx) => {
    await nav(ctx, { text: "🏠 Главное меню:", kb: views.mainMenu() });
  });

  // ----- контент-план -----
  bot.callbackQuery("cp_menu", async (ctx) => nav(ctx, await views.contentPlanMenu()));
  bot.callbackQuery(/^cp_proj:(\d+)$/, async (ctx) => nav(ctx, await views.projectView(+ctx.match![1])));

  // ----- видео -----
  bot.callbackQuery("vid_projects", async (ctx) =>
    nav(ctx, { text: "🎬 Выбери проект:", kb: await projectsKeyboard("vid_proj") })
  );
  bot.callbackQuery(/^vid_proj:(\d+)$/, async (ctx) => nav(ctx, await views.videoList(+ctx.match![1])));
  bot.callbackQuery(/^vid_item:(\d+)$/, async (ctx) => {
    const v = await views.videoCard(+ctx.match![1]);
    if (v) await nav(ctx, v);
  });
  bot.callbackQuery(/^vid_fmt:(\d+):(fun|sell)$/, async (ctx) => {
    await d2.updateItem(+ctx.match![1], { format: ctx.match![2] });
    const v = await views.videoCard(+ctx.match![1]);
    if (v) await nav(ctx, v);
  });
  bot.callbackQuery(/^vid_adv:(\d+)$/, async (ctx) => {
    const id = +ctx.match![1];
    const item = await d2.getItem(id);
    if (!item) return ctx.answerCallbackQuery();
    const nx = nextStage(item.stage);
    if (!nx) return ctx.answerCallbackQuery({ text: "Уже опубликовано" });
    const status = nx === "published" ? "done" : "in_progress";
    await d2.updateItem(id, { stage: nx, status });
    await notifyStage(bot, item.project_id, item.idx, nx);
    const v = await views.videoCard(id);
    if (v) await nav(ctx, v);
  });
  bot.callbackQuery(/^gfx_done:(\d+)$/, async (ctx) => {
    const projectId = +ctx.match![1];
    const graphics = await d2.listItems(projectId, "graphic");
    const next = graphics.find((g) => g.stage !== "done");
    if (next) await d2.updateItem(next.id, { stage: "done", status: "done" });
    await nav(ctx, await views.projectView(projectId));
  });

  // ----- задачи -----
  bot.callbackQuery("tasks_my", async (ctx) => {
    const m = await db.getMember(ctx.from.id);
    if (!m) return ctx.answerCallbackQuery({ text: "Сначала /start" });
    const tasks = await d2.tasksForMember(m);
    const open = tasks.filter((t) => t.status === "new" || t.status === "in_progress");
    const kb = new InlineKeyboard();
    const lines = ["✅ *Твои задачи:*", ""];
    if (open.length === 0) lines.push("Активных задач нет 🎉");
    for (const t of open) {
      lines.push(`• ${t.title}`);
      kb.text(`✅ ${t.title}`.slice(0, 60), `task_done:${t.id}`).row();
    }
    kb.text("⬅️ В меню", "home");
    await nav(ctx, { text: lines.join("\n"), kb });
  });
  bot.callbackQuery(/^task_done:(\d+)$/, async (ctx) => {
    const id = +ctx.match![1];
    const t = await d2.getTaskRow(id);
    if (!t) return ctx.answerCallbackQuery();
    await d2.setTaskStatus(id, "await_confirm");
    await ctx.answerCallbackQuery({ text: "Отправлено на подтверждение" });
    // уведомить подтверждающих (Саид + Бобур + env-админы)
    const confirmers = await collectConfirmers();
    const who = (await db.getMember(ctx.from.id))?.name || "Исполнитель";
    const kb = new InlineKeyboard().text("✅ Подтвердить", `task_confirm:${id}`);
    for (const cid of confirmers) {
      if (cid === ctx.from.id) continue;
      try { await bot.api.sendMessage(cid, `🔔 ${who} выполнил задачу #${id}: «${t.title}». Подтвердить?`, { reply_markup: kb }); } catch {}
    }
  });
  bot.callbackQuery(/^task_confirm:(\d+)$/, async (ctx) => {
    const m = await db.getMember(ctx.from.id);
    if (!isAdmin(m, ctx.from.id)) return ctx.answerCallbackQuery({ text: "Только Саид/Бобур" });
    const id = +ctx.match![1];
    const t = await d2.getTaskRow(id);
    if (!t) return ctx.answerCallbackQuery();
    await d2.setTaskStatus(id, "done", { confirmed_by: ctx.from.id });
    await ctx.answerCallbackQuery({ text: "Подтверждено ✅" });
    try { await ctx.editMessageText(`✅ Задача #${id} «${t.title}» подтверждена.`); } catch {}
    if (t.assignee_id) { try { await bot.api.sendMessage(t.assignee_id, `✅ Твоя задача «${t.title}» подтверждена. Отлично!`); } catch {} }
  });

  // ----- отчёт -----
  bot.callbackQuery("report_now", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Готовлю отчёт…" });
    const r = await views.buildReport("Текущий отчёт");
    try {
      await ctx.replyWithPhoto(r.chartUrl, { caption: r.text, parse_mode: "Markdown" });
    } catch {
      await ctx.reply(r.text, { parse_mode: "Markdown" });
    }
  });

  // ----- подписки -----
  bot.callbackQuery("subs", async (ctx) => {
    const subs = await d2.listSubscriptions();
    const lines = ["💳 *Подписки:*", ""];
    if (subs.length === 0) lines.push("Пока нет. Добавить: /addsub Название ГГГГ-ММ-ДД [дней]\nНапр.: /addsub CapCut 2026-06-01 30");
    for (const s of subs) lines.push(`• ${s.app} — до ${s.expires_on}`);
    lines.push("");
    lines.push(`Приложения: ${APPS.join(", ")}`);
    const kb = new InlineKeyboard().text("⬅️ В меню", "home");
    await nav(ctx, { text: lines.join("\n"), kb });
  });

  // ----- команды админа / групп -----
  bot.command("setsheet", async (ctx) => {
    const m = await db.getMember(ctx.from!.id);
    if (!isAdmin(m, ctx.from!.id)) return ctx.reply("⛔ Только админ.");
    const [key, url] = (ctx.match as string).trim().split(/\s+/);
    if (!key || !url) return ctx.reply("Использование: /setsheet <проект> <ссылка>\nПроекты: entrium, mystep, ryan, sevencore, cargogpt");
    const proj = (await d2.getProjects()).find((p) => p.key === key.toLowerCase());
    if (!proj) return ctx.reply("Проект не найден.");
    await d2.setSheetUrl(proj.id, url);
    await ctx.reply(`✅ Ссылка на Google-таблицу для ${proj.name} сохранена.`);
  });

  bot.command("addsub", async (ctx) => {
    const m = await db.getMember(ctx.from!.id);
    if (!isAdmin(m, ctx.from!.id)) return ctx.reply("⛔ Только админ.");
    const parts = (ctx.match as string).trim().split(/\s+/);
    if (parts.length < 2) return ctx.reply("Использование: /addsub <Название> <ГГГГ-ММ-ДД> [дней]\nНапр.: /addsub CapCut 2026-06-01 30");
    const app = parts[0];
    const date = parts[1];
    const days = parseInt(parts[2] || "30", 10);
    await d2.addSubscription(app, ctx.from!.id, date, days);
    await ctx.reply(`✅ Подписка ${app} добавлена (куплена ${date}, ${days} дн.). Напомню перед окончанием и после.`);
  });

  bot.command("bind", async (ctx) => {
    if (ctx.chat.type === "private") return ctx.reply("Эту команду используй В ГРУППЕ, куда добавлен бот.\nФормат: /bind <проект> <раздел>\nРазделы: all, idea, script, shoot, edit, published");
    const m = await db.getMember(ctx.from!.id);
    if (!isAdmin(m, ctx.from!.id)) return ctx.reply("⛔ Только админ может привязать группу.");
    const [key, specialty] = (ctx.match as string).trim().split(/\s+/);
    if (!key) return ctx.reply("Формат: /bind <проект> <раздел>\nПроекты: entrium, mystep, ryan, sevencore, cargogpt\nРазделы: all, idea, script, shoot, edit, published");
    const proj = (await d2.getProjects()).find((p) => p.key === key.toLowerCase());
    if (!proj) return ctx.reply("Проект не найден.");
    await d2.addBinding(ctx.chat.id, proj.id, (specialty || "all").toLowerCase());
    await ctx.reply(`✅ Группа привязана к проекту ${proj.name} (раздел: ${specialty || "all"}). Сюда будут приходить ТЗ и дедлайны по этому разделу.`);
  });
}

// уведомление ответственных за этап + постинг в привязанные группы
async function notifyStage(bot: Bot, projectId: number, idx: number, stage: string) {
  const proj = await d2.getProject(projectId);
  const owners = STAGE_OWNERS[stage] || [];
  const msg = `🎬 ${proj?.name} — Видео #${idx}\nЭтап: ${STAGE_LABEL[stage]}\nТвой шаг — приступай.`;
  for (const anchor of owners) {
    const mem = await d2.resolveMember(anchor);
    if (mem) { try { await bot.api.sendMessage(mem.telegram_id, msg); } catch {} }
  }
  // группы
  const bindings = await d2.bindingsFor(projectId, stage);
  for (const b of bindings) { try { await bot.api.sendMessage(b.chat_id, msg); } catch {} }
}

async function collectConfirmers(): Promise<number[]> {
  const ids = new Set<number>(ENV_ADMINS);
  for (const anchor of ["Саид", "Бобур"]) {
    const m = await d2.resolveMember(anchor);
    if (m) ids.add(m.telegram_id);
  }
  const admins = await db.listAdmins();
  admins.forEach((a) => ids.add(a.telegram_id));
  return [...ids];
}
