import { InlineKeyboard } from "grammy";
import * as d2 from "./db2";
import { VIDEO_STAGES, STAGE_LABEL, nextStage } from "./projects";

// ---------- главное меню ----------
export function mainMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📋 Контент-план", "cp_menu").text("🎬 Видео", "vid_projects").row()
    .text("✅ Мои задачи", "tasks_my").text("📊 Отчёт", "report_now").row()
    .text("💳 Подписки", "subs");
}

// ---------- контент-план: список проектов ----------
export async function contentPlanMenu(): Promise<{ text: string; kb: InlineKeyboard }> {
  const projects = await d2.getProjects();
  const kb = new InlineKeyboard();
  for (const p of projects) {
    const plan = await d2.getActivePlan(p.id);
    const s = await d2.planSummary(p.id);
    const pub = s.video.published || 0;
    kb.text(`${p.name} • 🎬${pub}/${s.videoTotal} 🖼${s.graphicDone}/${s.graphicTotal}`, `cp_proj:${p.id}`).row();
  }
  const period = (await d2.getActivePlan(projects[0]?.id))?.period || "";
  return { text: `📋 *Контент-план* — ${period}\nВыбери проект:`, kb };
}

// ---------- контент-план одного проекта ----------
export async function projectView(projectId: number): Promise<{ text: string; kb: InlineKeyboard }> {
  const p = await d2.getProject(projectId);
  const plan = await d2.getActivePlan(projectId);
  const s = await d2.planSummary(projectId);
  const lines: string[] = [`📋 *${p?.name}* — ${plan?.period || ""}`, ""];
  lines.push("🎬 *Видео по этапам:*");
  for (const st of VIDEO_STAGES) lines.push(`  ${STAGE_LABEL[st]}: ${s.video[st] || 0}`);
  lines.push(`  Всего: ${s.videoTotal}`);
  lines.push("");
  lines.push(`🖼 *Графика:* ${s.graphicDone}/${s.graphicTotal} готово`);
  const kb = new InlineKeyboard().text("🎬 Открыть видео", `vid_proj:${projectId}`).row();
  kb.text("🖼 +1 графика готова", `gfx_done:${projectId}`).row();
  if (plan?.sheet_url) kb.url("📊 Контент-план (Google)", plan.sheet_url).row();
  kb.text("⬅️ Назад", "cp_menu");
  return { text: lines.join("\n"), kb };
}

// ---------- список видео проекта ----------
export async function videoList(projectId: number): Promise<{ text: string; kb: InlineKeyboard }> {
  const p = await d2.getProject(projectId);
  const videos = await d2.listItems(projectId, "video");
  const kb = new InlineKeyboard();
  videos.forEach((v, i) => {
    kb.text(`#${v.idx} ${STAGE_LABEL[v.stage] || v.stage}`, `vid_item:${v.id}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().text("⬅️ Назад", `cp_proj:${projectId}`);
  return { text: `🎬 *${p?.name}* — видео (${videos.length}). Нажми, чтобы двигать по этапам:`, kb };
}

// ---------- карточка видео ----------
export async function videoCard(itemId: number): Promise<{ text: string; kb: InlineKeyboard } | null> {
  const v = await d2.getItem(itemId);
  if (!v) return null;
  const p = await d2.getProject(v.project_id);
  const lines = [
    `🎬 *${p?.name} — Видео #${v.idx}*`,
    `Этап: ${STAGE_LABEL[v.stage] || v.stage}`,
  ];
  if (v.title) lines.push(`Название: ${v.title}`);
  if (v.format) lines.push(`Формат: ${v.format === "fun" ? "развлекательный" : "продающий"}`);
  const kb = new InlineKeyboard();
  const nx = nextStage(v.stage);
  if (v.stage === "idea") {
    kb.text("🎭 Развлекательный", `vid_fmt:${itemId}:fun`).text("💰 Продающий", `vid_fmt:${itemId}:sell`).row();
  }
  if (nx) kb.text(`▶️ В этап: ${STAGE_LABEL[nx]}`, `vid_adv:${itemId}`).row();
  kb.text("⬅️ Назад", `vid_proj:${v.project_id}`);
  return { text: lines.join("\n"), kb };
}

// ---------- сводный отчёт ----------
export async function buildReport(title: string): Promise<{ text: string; chartUrl: string }> {
  const projects = await d2.getProjects();
  const lines = [`📊 *${title}*`, ""];
  let pubTotal = 0, vidTotal = 0, gfxDone = 0, gfxTotal = 0;
  const labels: string[] = [], pubData: number[] = [], totData: number[] = [];
  for (const p of projects) {
    const s = await d2.planSummary(p.id);
    const pub = s.video.published || 0;
    pubTotal += pub; vidTotal += s.videoTotal; gfxDone += s.graphicDone; gfxTotal += s.graphicTotal;
    lines.push(`*${p.name}*: 🎬 ${pub}/${s.videoTotal} опубл. · 🖼 ${s.graphicDone}/${s.graphicTotal}`);
    labels.push(p.name.split(" ")[0]); pubData.push(pub); totData.push(s.videoTotal);
  }
  lines.push("");
  lines.push(`*Итого видео:* ${pubTotal}/${vidTotal} опубликовано`);
  lines.push(`*Итого графика:* ${gfxDone}/${gfxTotal} готово`);

  // задачи
  const tasks = await d2.listOpenTasks();
  const pending = tasks.filter((t) => t.status !== "done").length;
  lines.push(`*Открытых задач:* ${pending}`);

  const chart = {
    type: "bar",
    data: { labels, datasets: [
      { label: "Опубликовано", data: pubData, backgroundColor: "#22c55e" },
      { label: "План", data: totData, backgroundColor: "#94a3b8" },
    ] },
    options: { plugins: { title: { display: true, text: title } } },
  };
  const chartUrl = "https://quickchart.io/chart?w=600&h=350&c=" + encodeURIComponent(JSON.stringify(chart));
  return { text: lines.join("\n"), chartUrl };
}
