import crypto from "node:crypto";
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
  admin: ["work", "plan", "video", "tz", "tasks", "report", "subs"],
  manager: ["work", "tz", "plan", "tasks", "report"],
  videographer: ["mywork", "tasks"],
  editor: ["mywork", "tasks"],
  designer: ["mywork", "tasks"],
  member: ["tasks"],
};

const SECTION = {
  video: { label: "Видео", anchor: "Самандар", specialty: "shoot" },
  design: { label: "Дизайн", anchor: "Владимир", specialty: "all" },
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

// ---------- сбор данных ----------
export async function getData(userId: number) {
  let member = await db.getMember(userId);
  if (!member) member = await db.upsertMember({ telegram_id: userId, is_admin: ENV_ADMINS.includes(userId), lang: "ru" });
  const isAdmin = isAdminId(member, userId);
  const role = roleOf(member, isAdmin);
  const tabs = TABS_BY_ROLE[role] || ["tasks"];

  const projects = await d2.getProjects();
  const period = (await d2.getActivePlan(projects[0]?.id))?.period || "";
  const projOut = [];
  for (const p of projects) {
    const plan = await d2.getActivePlan(p.id);
    const s = await d2.planSummary(p.id);
    const videos = await d2.listItems(p.id, "video");
    projOut.push({
      id: p.id, key: p.key, name: p.name, sheet_url: plan?.sheet_url || null,
      video: s.video, videoTotal: s.videoTotal, graphicDone: s.graphicDone, graphicTotal: s.graphicTotal,
      videos: videos.map((v) => ({ id: v.id, idx: v.idx, stage: v.stage, format: v.format })),
    });
  }

  const myTasks = (await d2.tasksForMember(member!)).filter((t) => t.status === "new" || t.status === "in_progress");
  const openTasks = await d2.listOpenTasks();
  const canConfirm = role === "admin" || role === "manager";
  const confirmable = canConfirm ? openTasks.filter((t) => t.status === "await_confirm").map((t) => ({ id: t.id, title: t.title })) : [];
  const subs = await d2.listSubscriptions();

  let pub = 0, vt = 0, gd = 0, gt = 0;
  for (const p of projOut) { pub += p.video["published"] || 0; vt += p.videoTotal; gd += p.graphicDone; gt += p.graphicTotal; }

  // вкладка «Работа» — сотрудники с задачами
  let team: any[] = [];
  if (role === "admin" || role === "manager") {
    for (const t of TEAM_ANCHORS) {
      const m = await d2.resolveMember(t.anchor);
      const tks = m ? (await d2.tasksForMember(m)).filter((x) => x.status === "new" || x.status === "in_progress" || x.status === "await_confirm") : [];
      team.push({ anchor: t.anchor, role: t.role, name: m?.name || t.anchor, registered: !!m, tasks: tks.map((x) => ({ id: x.id, title: x.title, status: x.status })) });
    }
  }

  // «Моя работа» — элементы конвейера для специалиста
  let myWork: any[] = [];
  if (role === "videographer" || role === "editor" || role === "designer") {
    const stage = role === "videographer" ? "shoot" : role === "editor" ? "edit" : null;
    for (const p of projects) {
      if (stage) {
        const items = (await d2.listItems(p.id, "video")).filter((v) => v.stage === stage);
        for (const v of items) myWork.push({ id: v.id, type: "video", projectId: p.id, projectName: p.name, idx: v.idx, stage: v.stage });
      } else {
        const g = (await d2.listItems(p.id, "graphic")).filter((x) => x.stage !== "done");
        if (g.length) myWork.push({ type: "graphic", projectId: p.id, projectName: p.name, left: g.length });
      }
    }
  }

  return {
    user: { id: userId, name: member?.name || "", role, is_admin: isAdmin },
    period, tabs, stages: VIDEO_STAGES, stageLabels: STAGE_LABEL,
    projects: projOut,
    myTasks: myTasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
    confirmable, team, myWork,
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
      await d2.setTaskStatus(t.id, "await_confirm");
      const who = member?.name || "Исполнитель";
      for (const cid of await confirmers()) {
        if (cid === userId) continue;
        try { await bot.api.sendMessage(cid, `🔔 ${who} выполнил задачу «${t.title}». Подтверди в приложении.`); } catch {}
      }
      break;
    }
    case "task_confirm": {
      if (role !== "admin" && role !== "manager") break;
      const t = await d2.getTaskRow(+action.id);
      if (!t) break;
      await d2.setTaskStatus(t.id, "done", { confirmed_by: userId });
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
      if (projectId) for (const b of await d2.bindingsFor(projectId, sec.specialty)) { try { await bot.api.sendMessage(b.chat_id, msg); } catch {} }
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

async function confirmers(): Promise<number[]> {
  const ids = new Set<number>(ENV_ADMINS);
  for (const anchor of ["Саид", "Бобур"]) { const m = await d2.resolveMember(anchor); if (m) ids.add(m.telegram_id); }
  (await db.listAdmins()).forEach((a) => ids.add(a.telegram_id));
  return [...ids];
}
