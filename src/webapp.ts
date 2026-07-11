import crypto from "node:crypto";
import { InlineKeyboard } from "grammy";
import * as db from "./db";
import * as d2 from "./db2";
import { bot } from "./bot";
import { VIDEO_STAGES, STAGE_LABEL, STAGE_OWNERS, nextStage } from "./projects";

// ---------- проверка подписи Telegram WebApp ----------
export function validateInitData(initData: string): { ok: boolean; user?: any } {
  try {
    const token = process.env.BOT_TOKEN as string;
    const params = new URLSearchParams(initData);
    const hash = params.get("hash") || "";
    params.delete("hash");
    const dcs = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v}`).join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
    const calc = crypto.createHmac("sha256", secret).update(dcs).digest("hex");
    if (calc !== hash) return { ok: false };
    const user = JSON.parse(params.get("user") || "{}");
    return { ok: true, user };
  } catch {
    return { ok: false };
  }
}

const ENV_ADMINS: number[] = (process.env.ADMIN_IDS || "").split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n));

// ---------- роли и вкладки ----------
export function roleOf(member: db.Member | null, isAdmin: boolean): string {
  if (isAdmin) return "admin";
  const s = ((member?.specialization || "") + " " + (member?.name || "") + " " + (member?.username || "")).toLowerCase();
  if (/менедж|manager|smm|бобур|боб|bob/.test(s)) return "manager";
  if (/монтаж|editor|монтаж[её]р|асрор|asror/.test(s)) return "editor";
  if (/видеограф|съ[её]м|videograph|video|саманд|saman/.test(s)) return "videographer";
  if (/дизайн|design|влад|vlad/.test(s)) return "designer";
  return "member";
}

const TABS_BY_ROLE: Record<string, string[]> = {
  admin: ["home", "board", "tasks", "tz", "plan", "video", "work", "report", "subs"],
  manager: ["home", "board", "tasks", "tz", "plan", "work", "report"],
  videographer: ["home", "mywork", "tasks"],
  editor: ["home", "mywork", "tasks"],
  designer: ["home", "mywork", "tasks"],
  member: ["home", "tasks"],
};

const SECTION = {
  video: { label: "Видео", anchor: "Самандар", specialty: "shoot" },
  design: { label: "Дизайн", anchor: "Владимир", specialty: "design" },
  edit: { label: "Монтаж", anchor: "Асрор", specialty: "edit" },
} as const;

const TEAM_ANCHORS = [
  { anchor: "Бобур", role: "Менеджер" },
  { anchor: "Самандар", role: "Видеограф" },
  { anchor: "Асрор", role: "Монтажёр" },
  { anchor: "Владимир", role: "Дизайнер" },
];

function isAdminId(member: db.Member | null, id: number) {
  return Boolean(member?.is_admin) || ENV_ADMINS.includes(id);
}

// разбор дедлайна: "12.07", "12.07.2026", "12.07 18:30" (время Asia/Tashkent)
export function parseDeadline(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const now = new Date();
  const d = +m[1], mo = +m[2];
  let y = m[3] ? +m[3] : now.getUTCFullYear();
  if (y < 100) y += 2000;
  const hh = m[4] ? +m[4] : 18, mi = m[5] ? +m[5] : 0;
  const localMs = Date.UTC(y, mo - 1, d, hh, mi);
  if (Number.isNaN(localMs)) return null;
  return new Date(localMs - 5 * 3600 * 1000).toISOString(); // UTC+5
}

// поля пункта контент-плана храним JSON-ом в content_items.title (без изменения схемы)
function parseItemData(title: string | null): any {
  try { const d = JSON.parse(title || "{}"); return d && typeof d === "object" ? d : {}; } catch { return title ? { script: title } : {}; }
}
function serializeItem(v: any) {
  const d = parseItemData(v.title);
  return { id: v.id, idx: v.idx, type: v.type, stage: v.stage, lang: d.lang || "", theme: d.theme || "", script: d.script || "", reference: d.reference || "", props: d.props || "", shoot_date: d.shoot_date || "", deadline: d.deadline || "" };
}

// ---------- сбор данных ----------
export async function getData(userId: number) {
  // один «залп» параллельных запросов вместо десятков последовательных
  const today = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10); // Asia/Tashkent
  const [member0, projects, plans, items, members, openTasks, subs, doneTasks, dailyTpl, dailyDone, dailyTotal] = await Promise.all([
    db.getMember(userId), d2.getProjects(), d2.getAllPlans(), d2.getAllItems(), db.listMembers(), d2.listOpenTasks(), d2.listSubscriptions(), d2.recentDoneTasks(15),
    d2.listDailyTemplates(), d2.dailyDoneToday(userId, today), d2.dailyAllTime(userId),
  ]);
  let member = member0;
  if (!member) { member = await db.upsertMember({ telegram_id: userId, is_admin: ENV_ADMINS.includes(userId), lang: "ru" }); members.push(member); }
  const isAdmin = isAdminId(member, userId);
  const role = roleOf(member, isAdmin);
  const tabs = TABS_BY_ROLE[role] || ["tasks"];

  const activePlanByProject = new Map(plans.filter((p) => p.is_active).map((p) => [p.project_id, p]));
  const plansByProject = new Map<number, any[]>();
  for (const pl of plans) { const a = plansByProject.get(pl.project_id) || []; a.push({ id: pl.id, period: pl.period, is_active: pl.is_active }); plansByProject.set(pl.project_id, a); }
  const planByProject = activePlanByProject;
  const period = plans.find((p) => p.is_active)?.period || plans[0]?.period || "";
  const pendingPublish = new Set(openTasks.filter((t) => t.status === "await_confirm" && t.item_id).map((t) => t.item_id));

  const activePlanIds = new Set([...activePlanByProject.values()].map((p: any) => p.id));
  const itemsByProject = new Map<number, any[]>();
  for (const it of items) { if (!activePlanIds.has(it.plan_id)) continue; const a = itemsByProject.get(it.project_id) || []; a.push(it); itemsByProject.set(it.project_id, a); }

  const projOut = projects.map((p) => {
    const its = itemsByProject.get(p.id) || [];
    const videos = its.filter((x) => x.type === "video").sort((a, b) => a.idx - b.idx);
    const graphics = its.filter((x) => x.type === "graphic");
    const video: Record<string, number> = {};
    for (const v of videos) video[v.stage] = (video[v.stage] || 0) + 1;
    return {
      id: p.id, key: p.key, name: p.name, sheet_url: planByProject.get(p.id)?.sheet_url || null,
      plans: plansByProject.get(p.id) || [],
      video, videoTotal: videos.length,
      graphicDone: graphics.filter((g) => g.stage === "done").length, graphicTotal: graphics.length,
      videos: videos.map((v) => ({ id: v.id, idx: v.idx, stage: v.stage, format: v.format, pending: pendingPublish.has(v.id) })),
    };
  });

  const memTasks = (mem: db.Member) => openTasks.filter((t) => {
    if (t.assignee_id && t.assignee_id === mem.telegram_id) return true;
    if (!t.assignee_id && t.assignee_name) return d2.resolveMemberSync(members, t.assignee_name)?.telegram_id === mem.telegram_id;
    return false;
  });

  const myTasks = memTasks(member!).filter((t) => t.status === "new" || t.status === "in_progress");
  const canConfirm = role === "admin" || role === "manager";
  const nameOf = (t: any) => {
    if (t.assignee_id) { const m = members.find((x) => x.telegram_id === t.assignee_id); return m?.name || t.assignee_name || "—"; }
    return t.assignee_name || "—";
  };
  const needsMine = (t: any) => role === "admin"
    ? ["await_admin", "await_manager", "await_confirm"].includes(t.status)
    : role === "manager" ? ["await_manager", "await_confirm"].includes(t.status) : false;
  const confirmable = canConfirm
    ? openTasks.filter(needsMine).map((t) => ({ id: t.id, title: t.title, status: t.status, who: nameOf(t), final: t.status === "await_admin" }))
    : [];

  // доска (kanban по статусам) — для админа/менеджера
  let board: any = null;
  if (canConfirm) {
    const mk = (t: any) => ({ title: t.title, who: nameOf(t) });
    board = {
      new: openTasks.filter((t) => t.status === "new" || t.status === "in_progress").map(mk),
      manager: openTasks.filter((t) => t.status === "await_manager").map(mk),
      admin: openTasks.filter((t) => t.status === "await_admin" || t.status === "await_confirm").map(mk),
      done: doneTasks.map(mk),
    };
  }

  // задачи команды «на выполнении» (для дашборда админа/менеджера)
  const teamTasks = canConfirm
    ? openTasks.filter((t) => t.status === "new" || t.status === "in_progress").map((t) => ({ title: t.title, who: nameOf(t) }))
    : [];

  // статистика прогресса по активному периоду
  const LANGS = ["ru", "uz", "en"];
  const statsProjects = projects.map((p) => {
    const its = itemsByProject.get(p.id) || [];
    const videos = its.filter((x) => x.type === "video");
    const graphics = its.filter((x) => x.type !== "video");
    let scripts = 0;
    const langs: any = { ru: 0, uz: 0, en: 0, none: 0 };
    for (const v of videos) {
      const d = parseItemData(v.title);
      if ((d.script || "").trim()) scripts++;
      const l = (d.lang || "").trim();
      if (LANGS.includes(l)) langs[l]++; else langs.none++;
    }
    const inAny = (sts: string[]) => videos.filter((v) => sts.includes(v.stage)).length;
    return {
      name: p.name, videoTotal: videos.length, scripts,
      shot: inAny(["shoot", "edit", "published"]),
      edited: inAny(["edit", "published"]),
      published: inAny(["published"]),
      graphicDone: graphics.filter((g) => g.stage === "done").length, graphicTotal: graphics.length,
      langs,
    };
  });
  const statsTotals = statsProjects.reduce((a: any, s: any) => ({
    videoTotal: a.videoTotal + s.videoTotal, scripts: a.scripts + s.scripts, shot: a.shot + s.shot,
    edited: a.edited + s.edited, published: a.published + s.published,
    graphicDone: a.graphicDone + s.graphicDone, graphicTotal: a.graphicTotal + s.graphicTotal,
    langs: { ru: a.langs.ru + s.langs.ru, uz: a.langs.uz + s.langs.uz, en: a.langs.en + s.langs.en, none: a.langs.none + s.langs.none },
  }), { videoTotal: 0, scripts: 0, shot: 0, edited: 0, published: 0, graphicDone: 0, graphicTotal: 0, langs: { ru: 0, uz: 0, en: 0, none: 0 } });
  const stats = { projects: statsProjects, totals: statsTotals };

  // ежедневник: задачи для этого пользователя + отметки за сегодня
  const doneSet = new Set(dailyDone);
  const myDaily = dailyTpl.filter((t) => {
    const who = (t.assignee_name || "").trim().toLowerCase();
    if (!who || who === "все" || who === "all") return true;
    return d2.resolveMemberSync(members, t.assignee_name!)?.telegram_id === userId;
  }).map((t) => ({ id: t.id, title: t.title, who: t.assignee_name || "все", done: doneSet.has(t.id) }));
  const daily = { items: myDaily, todayDone: myDaily.filter((x) => x.done).length, total: myDaily.length, allTime: dailyTotal, canEdit: isAdmin };

  let pub = 0, vt = 0, gd = 0, gt = 0;
  for (const p of projOut) { pub += p.video["published"] || 0; vt += p.videoTotal; gd += p.graphicDone; gt += p.graphicTotal; }

  let team: any[] = [];
  if (canConfirm) {
    for (const t of TEAM_ANCHORS) {
      const m = d2.resolveMemberSync(members, t.anchor);
      const tks = m ? memTasks(m).filter((x) => x.status === "new" || x.status === "in_progress" || x.status === "await_confirm") : [];
      team.push({ anchor: t.anchor, role: t.role, name: m?.name || t.anchor, registered: !!m, tasks: tks.map((x) => ({ id: x.id, title: x.title, status: x.status })) });
    }
  }

  let myWork: any[] = [];
  if (role === "videographer" || role === "editor" || role === "designer") {
    const stage = role === "videographer" ? "shoot" : role === "editor" ? "edit" : null;
    for (const p of projOut) {
      const its = itemsByProject.get(p.id) || [];
      if (stage) {
        for (const v of its.filter((x) => x.type === "video" && x.stage === stage)) myWork.push({ id: v.id, type: "video", projectId: p.id, projectName: p.name, idx: v.idx, stage: v.stage, pending: pendingPublish.has(v.id) });
      } else {
        const left = its.filter((x) => x.type === "graphic" && x.stage !== "done").length;
        if (left) myWork.push({ type: "graphic", projectId: p.id, projectName: p.name, left });
      }
    }
  }

  return {
    user: { id: userId, name: member?.name || "", role, is_admin: isAdmin },
    period, tabs, stages: VIDEO_STAGES, stageLabels: STAGE_LABEL,
    projects: projOut,
    myTasks: myTasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
    confirmable, team, myWork, board, teamTasks, stats, daily,
    subscriptions: subs.map((s) => ({ app: s.app, expires_on: s.expires_on })),
    totals: { published: pub, videoTotal: vt, graphicDone: gd, graphicTotal: gt, openTasks: openTasks.length },
  };
}

// ---------- действия ----------
export async function doAction(userId: number, action: any) {
  const member = await db.getMember(userId);
  const isAdmin = isAdminId(member, userId);
  const role = roleOf(member, isAdmin);

  switch (action.type) {
    case "vid_adv": {
      const item = await d2.getItem(+action.id);
      if (!item) break;
      const nx = nextStage(item.stage);
      if (!nx) break;
      // публикацию от не-админа отправляем на подтверждение, не двигаем сразу
      if (nx === "published" && role !== "admin") {
        const open = await d2.listOpenTasks();
        if (!open.some((t) => t.item_id === item.id && t.status === "await_confirm")) {
          const proj = await d2.getProject(item.project_id);
          const tid = await d2.createAdhocTask({ title: `Публикация: ${proj?.name} Видео #${item.idx}`, assignee_id: userId, item_id: item.id, status: "await_confirm" });
          const who = member?.name || "Сотрудник";
          const kb = new InlineKeyboard().text("✅ Подтвердить публикацию", `task_confirm:${tid}`);
          for (const cid of await confirmers()) {
            if (cid === userId) continue;
            try { await bot.api.sendMessage(cid, `🔔 ${who} отметил публикацию: ${proj?.name} Видео #${item.idx}. Подтвердить?`, { reply_markup: kb }); } catch {}
          }
        }
        break; // не двигаем статус до подтверждения
      }
      await d2.updateItem(item.id, { stage: nx, status: nx === "published" ? "done" : "in_progress" });
      await notifyStage(item.project_id, item.idx, nx);
      break;
    }
    case "vid_fmt": { await d2.updateItem(+action.id, { format: action.format }); break; }
    case "gfx_done": {
      const graphics = await d2.listItems(+action.projectId, "graphic");
      const next = graphics.find((g) => g.stage !== "done");
      if (next) await d2.updateItem(next.id, { stage: "done", status: "done" });
      break;
    }
    case "task_done": {
      const t = await d2.getTaskRow(+action.id);
      if (!t) break;
      const assignee = t.assignee_id ? await db.getMember(t.assignee_id) : (t.assignee_name ? await d2.resolveMember(t.assignee_name) : null);
      const aRole = assignee ? roleOf(assignee, isAdminId(assignee, assignee.telegram_id)) : "member";
      const next = aRole === "manager" || aRole === "admin" ? "await_admin" : "await_manager";
      await d2.setTaskStatus(t.id, next);
      const who = member?.name || "Исполнитель";
      const recips = next === "await_admin" ? await adminRecipients() : await managerRecipients();
      for (const cid of recips) {
        if (cid === userId) continue;
        try { await bot.api.sendMessage(cid, `🔔 ${who} выполнил задачу «${t.title}». Нужно твоё утверждение (в приложении → Задачи).`); } catch {}
      }
      break;
    }
    case "task_approve": {
      const t = await d2.getTaskRow(+action.id);
      if (!t) break;
      if (role === "admin") {
        await d2.setTaskStatus(t.id, "done", { confirmed_by: userId });
        if (t.item_id) await d2.updateItem(t.item_id, { stage: "published", status: "done" });
        if (t.assignee_id) { try { await bot.api.sendMessage(t.assignee_id, `✅ Задача «${t.title}» полностью утверждена. Отлично!`); } catch {} }
      } else if (role === "manager" && (t.status === "await_manager" || t.status === "await_confirm")) {
        await d2.setTaskStatus(t.id, "await_admin");
        for (const cid of await adminRecipients()) { try { await bot.api.sendMessage(cid, `🔔 Менеджер утвердил «${t.title}». Нужно твоё финальное утверждение.`); } catch {} }
        if (t.assignee_id) { try { await bot.api.sendMessage(t.assignee_id, `👍 Менеджер принял «${t.title}», ждём финального утверждения.`); } catch {} }
      }
      break;
    }
    case "task_reject": {
      if (role !== "admin" && role !== "manager") break;
      const t = await d2.getTaskRow(+action.id);
      if (!t) break;
      await d2.setTaskStatus(t.id, "in_progress");
      if (t.assignee_id) { try { await bot.api.sendMessage(t.assignee_id, `↩️ Задачу «${t.title}» вернули на доработку.`); } catch {} }
      break;
    }
    case "task_assign": {
      if (role !== "admin" && role !== "manager") break;
      const title = (action.title || "").trim();
      if (!title || !action.assignee) break;
      const ex = await d2.resolveMember(action.assignee);
      const dl = parseDeadline(action.deadline);
      await d2.createAdhocTask({ title, assignee_id: ex?.telegram_id ?? null, assignee_name: action.assignee, project_id: action.projectId ? +action.projectId : null, deadline: dl });
      const dlTxt = dl ? `\n⏰ Дедлайн: ${String(action.deadline).trim()}` : "";
      if (ex) { try { await bot.api.sendMessage(ex.telegram_id, `📌 Тебе назначена задача: ${title}${dlTxt}`); } catch {} }
      break;
    }
    case "daily_toggle": {
      const day = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
      await d2.toggleDaily(userId, +action.id, day);
      break;
    }
    case "daily_add": {
      if (role !== "admin") break;
      const title = (action.title || "").trim();
      if (title) await d2.createDailyTemplate(title, (action.who || "").trim());
      break;
    }
    case "daily_delete": {
      if (role !== "admin") break;
      await d2.deleteTask(+action.id);
      break;
    }
    case "daily_edit": {
      if (role !== "admin") break;
      const title = (action.title || "").trim();
      if (title) await d2.updateTaskTitle(+action.id, title);
      break;
    }
    case "task_submit_file": {
      const t = await d2.getTaskRow(+action.id);
      if (!t) break;
      await db.setSession(userId, { awaitFileTask: t.id } as any);
      try { await bot.api.sendMessage(userId, `📎 Пришли сюда файл готовой работы по задаче «${t.title}». Как получу — отправлю в группу проекта и передам на утверждение.`); } catch {}
      break;
    }
    case "task_confirm": {
      if (role !== "admin" && role !== "manager") break;
      const t = await d2.getTaskRow(+action.id);
      if (!t) break;
      await d2.setTaskStatus(t.id, "done", { confirmed_by: userId });
      if (t.item_id) await d2.updateItem(t.item_id, { stage: "published", status: "done" }); // подтверждённая публикация
      if (t.assignee_id) { try { await bot.api.sendMessage(t.assignee_id, `✅ Твоя задача «${t.title}» подтверждена.`); } catch {} }
      break;
    }
    case "tz": {
      if (role !== "admin" && role !== "manager") break;
      const sec = (SECTION as any)[action.section];
      const text = (action.text || "").trim();
      if (!sec || !text) break;
      const execAnchor = action.assignee || sec.anchor; // выбранный исполнитель (Самандар может делать и монтаж)
      const specialist = await d2.resolveMember(execAnchor);
      const projectId = action.projectId ? +action.projectId : null;
      const proj = projectId ? await d2.getProject(projectId) : null;
      const title = `ТЗ • ${sec.label}${proj ? " • " + proj.name : ""}: ${text.slice(0, 50)}`;
      await d2.createAdhocTask({ title, description: text, assignee_id: specialist?.telegram_id ?? null, assignee_name: execAnchor, project_id: projectId });
      const msg = `📋 Новое ТЗ (${sec.label})${proj ? " — " + proj.name : ""} от ${member?.name || "менеджера"}:\n\n${text}`;
      if (specialist) { try { await bot.api.sendMessage(specialist.telegram_id, msg); } catch {} }
      for (const b of await d2.bindingsFor(projectId, sec.specialty)) { try { await bot.api.sendMessage(b.chat_id, msg); } catch {} }
      break;
    }

    // ---- редактируемая таблица контент-плана ----
    case "plan_items": {
      const its = await d2.listItemsByPlan(+action.planId);
      return { items: its.map(serializeItem) };
    }
    case "item_add": {
      if (role !== "admin" && role !== "manager") return { items: [] };
      const its = await d2.listItemsByPlan(+action.planId);
      const nextIdx = its.reduce((m, i) => Math.max(m, i.idx), 0) + 1;
      await d2.addContentItem({ plan_id: +action.planId, project_id: +action.projectId, type: action.itemType || "video", idx: nextIdx });
      return { items: (await d2.listItemsByPlan(+action.planId)).map(serializeItem) };
    }
    case "item_update": {
      if (role !== "admin" && role !== "manager") return { items: [] };
      const f = action.fields || {};
      const data = { lang: f.lang || "", theme: f.theme || "", script: f.script || "", reference: f.reference || "", props: f.props || "", shoot_date: f.shoot_date || "", deadline: f.deadline || "" };
      const patch: any = { title: JSON.stringify(data) };
      if (f.type) patch.type = f.type;
      if (f.status) { patch.stage = f.status; patch.status = f.status === "published" || f.status === "done" ? "done" : "in_progress"; }
      await d2.updateItem(+action.id, patch);
      return { items: (await d2.listItemsByPlan(+action.planId)).map(serializeItem) };
    }
    case "item_patch": {
      if (role !== "admin" && role !== "manager") return { items: [] };
      const it = await d2.getItem(+action.id);
      if (!it) return { items: [] };
      const d = parseItemData((it as any).title);
      const p = action.patch || {};
      for (const k of ["theme", "script", "reference", "props", "shoot_date", "deadline"]) if (k in p) (d as any)[k] = p[k];
      const patch: any = { title: JSON.stringify(d) };
      if (p.type) patch.type = p.type;
      if (p.status) { patch.stage = p.status; patch.status = p.status === "published" || p.status === "done" ? "done" : "in_progress"; }
      await d2.updateItem(+action.id, patch);
      return { items: (await d2.listItemsByPlan(+action.planId)).map(serializeItem) };
    }
    case "item_delete": {
      if (role !== "admin" && role !== "manager") return { items: [] };
      await d2.deleteContentItem(+action.id);
      // после удаления — сквозная перенумерация
      const rest = (await d2.listItemsByPlan(+action.planId));
      for (let i = 0; i < rest.length; i++) if (rest[i].idx !== i + 1) await d2.updateItem(rest[i].id, { idx: i + 1 });
      return { items: (await d2.listItemsByPlan(+action.planId)).map(serializeItem) };
    }
    case "item_move": {
      if (role !== "admin" && role !== "manager") return { items: [] };
      const items = await d2.listItemsByPlan(+action.planId);
      const moving = items.find((x) => x.id === +action.id);
      if (moving) {
        const rest = items.filter((x) => x.id !== +action.id);
        const p = Math.max(1, Math.min(rest.length + 1, +action.toPos || moving.idx));
        rest.splice(p - 1, 0, moving);
        for (let i = 0; i < rest.length; i++) if (rest[i].idx !== i + 1) await d2.updateItem(rest[i].id, { idx: i + 1 });
      }
      return { items: (await d2.listItemsByPlan(+action.planId)).map(serializeItem) };
    }
    case "plan_create": {
      if (role !== "admin" && role !== "manager") break;
      const planId = await d2.createPlan(+action.projectId, (action.period || "Новый период").trim());
      if (planId) {
        const v = Math.max(0, Math.min(200, +action.videos || 0));
        const g = Math.max(0, Math.min(200, +action.graphics || 0));
        const specs: { type: string; idx: number }[] = [];
        let idx = 1;
        for (let i = 0; i < v; i++) specs.push({ type: "video", idx: idx++ });
        for (let i = 0; i < g; i++) specs.push({ type: "graphic", idx: idx++ });
        await d2.addContentItems(planId, +action.projectId, specs);
      }
      break;
    }
  }
  return getData(userId);
}

async function notifyStage(projectId: number, idx: number, stage: string) {
  const proj = await d2.getProject(projectId);
  const msg = `🎬 ${proj?.name} — Видео #${idx}\nЭтап: ${STAGE_LABEL[stage]}\nТвой шаг — приступай.`;
  for (const anchor of STAGE_OWNERS[stage] || []) {
    const m = await d2.resolveMember(anchor);
    if (m) { try { await bot.api.sendMessage(m.telegram_id, msg); } catch {} }
  }
  for (const b of await d2.bindingsFor(projectId, stage)) { try { await bot.api.sendMessage(b.chat_id, msg); } catch {} }
}

async function managerRecipients(): Promise<number[]> {
  const ids = new Set<number>();
  const m = await d2.resolveMember("Бобур");
  if (m) ids.add(m.telegram_id);
  return [...ids];
}
async function adminRecipients(): Promise<number[]> {
  const ids = new Set<number>(ENV_ADMINS);
  (await db.listAdmins()).forEach((a) => ids.add(a.telegram_id));
  return [...ids];
}

async function confirmers(): Promise<number[]> {
  const ids = new Set<number>(ENV_ADMINS);
  for (const anchor of ["Саид", "Бобур"]) { const m = await d2.resolveMember(anchor); if (m) ids.add(m.telegram_id); }
  (await db.listAdmins()).forEach((a) => ids.add(a.telegram_id));
  return [...ids];
}
