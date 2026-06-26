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

// ---------- сбор данных для интерфейса ----------
export async function getData(userId: number) {
  let member = await db.getMember(userId);
  if (!member) {
    // авто-регистрация при первом входе в приложение
    member = await db.upsertMember({ telegram_id: userId, is_admin: ENV_ADMINS.includes(userId), lang: "ru" });
  }
  const isAdmin = Boolean(member?.is_admin) || ENV_ADMINS.includes(userId);

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
  const confirmable = isAdmin ? openTasks.filter((t) => t.status === "await_confirm").map((t) => ({ id: t.id, title: t.title })) : [];
  const subs = await d2.listSubscriptions();

  // сводка отчёта
  let pub = 0, vt = 0, gd = 0, gt = 0;
  for (const p of projOut) { pub += p.video["published"] || 0; vt += p.videoTotal; gd += p.graphicDone; gt += p.graphicTotal; }

  return {
    user: { id: userId, name: member?.name || "", is_admin: isAdmin },
    period,
    stages: VIDEO_STAGES,
    stageLabels: STAGE_LABEL,
    projects: projOut,
    myTasks: myTasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
    confirmable,
    subscriptions: subs.map((s) => ({ app: s.app, expires_on: s.expires_on })),
    totals: { published: pub, videoTotal: vt, graphicDone: gd, graphicTotal: gt, openTasks: openTasks.length },
  };
}

// ---------- действия ----------
export async function doAction(userId: number, action: any) {
  const member = await db.getMember(userId);
  const isAdmin = Boolean(member?.is_admin) || ENV_ADMINS.includes(userId);

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
    case "vid_fmt": {
      await d2.updateItem(+action.id, { format: action.format });
      break;
    }
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
      if (!isAdmin) break;
      const t = await d2.getTaskRow(+action.id);
      if (!t) break;
      await d2.setTaskStatus(t.id, "done", { confirmed_by: userId });
      if (t.assignee_id) { try { await bot.api.sendMessage(t.assignee_id, `✅ Твоя задача «${t.title}» подтверждена.`); } catch {} }
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
