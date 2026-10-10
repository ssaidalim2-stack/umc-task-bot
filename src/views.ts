import { InlineKeyboard } from "grammy";
import * as d2 from "./db2";
import { VIDEO_STAGES, STAGE_LABEL, nextStage } from "./projects";
import * as meta from "./meta";

const APP_URL = process.env.APP_URL || "https://umc-task-bot.vercel.app";

// ---------- главное меню ----------
export function mainMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .webApp("🚀 Открыть приложение", APP_URL).row()
    .text("📋 Контент-план", "cp_menu").text("🎬 Видео", "vid_projects").row()
    .text("✅ Мои задачи", "tasks_my").text("📊 Отчёт", "report_now").row()
    .text("💳 Подписки", "subs");
}

// ---------- контент-план: список проектов ----------
export async function contentPlanMenu(): Promise<{ text: string; kb: InlineKeyboard }> {
  const projects = await d2.getActiveProjects();
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
  const projects = await d2.getActiveProjects();
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

// ---------- отчёт КЛИЕНТУ (в группу клиента, не внутренний) ----------
// Собирается из того, что бот знает сам: контент-план + съёмки + цифры Meta.
// Любой блок Meta может быть недоступен (токен протух / доступ закрыт) — отчёт
// всё равно должен уйти, просто без этих строк: цифры клиенту важны, но
// неработающая интеграция не повод не отчитаться о проделанной работе.
export async function buildClientReport(projectId: number, note: string): Promise<string> {
  const proj = await d2.getProject(projectId);
  if (!proj) return "";
  const plan = await d2.getActivePlan(projectId);
  const s = await d2.planSummary(projectId);
  const { parseItemData, parseShootDay } = await import("./webapp");

  const L: string[] = [];
  L.push(`📊 *Отчёт по проекту ${proj.name}*`);
  if (plan?.period) L.push(`_Период: ${plan.period}_`);
  L.push("");

  // --- контент ---
  const published = s.video.published || 0;
  const edited = s.video.edit || 0;
  const shot = s.video.shoot || 0;
  const scripted = s.video.script || 0;
  L.push("*Контент*");
  L.push(`🎬 Опубликовано видео: *${published}* из ${s.videoTotal}`);
  if (edited) L.push(`✂️ Смонтировано, готово к публикации: ${edited}`);
  if (shot) L.push(`🎥 Отснято, в монтаже: ${shot}`);
  if (scripted) L.push(`📝 Сценарии готовы, ждут съёмки: ${scripted}`);
  if (s.graphicTotal) L.push(`🖼 Графика: *${s.graphicDone}* из ${s.graphicTotal}`);

  // --- съёмки за период ---
  const items = (await d2.getAllItems()).filter((i) => i.project_id === projectId && i.type === "video");
  const shootDays = new Set<string>();
  for (const it of items) {
    const d = parseShootDay(parseItemData((it as any).title).shoot_date);
    if (d) shootDays.add(d);
  }
  if (shootDays.size) L.push(`📅 Съёмочных дней: ${shootDays.size}`);

  // --- реклама и Instagram ---
  const map = await meta.getMetaMap();
  const bind = map[proj.key] || {};
  const [since, until] = cycleRange();

  if (meta.metaConfigured() && bind.ad) {
    try {
      const camps = await meta.campaignStats(bind.ad, since, until);
      const active = camps.filter((c) => /ACTIVE/i.test(c.status));
      const spend = camps.reduce((a, c) => a + c.spend, 0);
      const impressions = camps.reduce((a, c) => a + c.impressions, 0);
      const clicks = camps.reduce((a, c) => a + c.clicks, 0);
      L.push("");
      L.push("*Реклама*");
      L.push(active.length ? `🟢 Таргет включён — активных кампаний: ${active.length}` : "🔴 Таргет сейчас выключен");
      if (spend) L.push(`💰 Потрачено: ${spend.toFixed(2)} ${camps[0]?.currency || "USD"}`);
      if (impressions) L.push(`👁 Показы: ${impressions.toLocaleString("ru-RU")}`);
      if (clicks) L.push(`🖱 Клики: ${clicks.toLocaleString("ru-RU")}`);
    } catch {
      L.push("");
      L.push("*Реклама*");
      L.push("⚠️ Данные по рекламе временно недоступны");
    }
  }

  if (meta.metaConfigured() && bind.ig) {
    try {
      const media = await meta.igMediaStats(bind.ig, since, until);
      const recent = media.slice(0, 5);
      if (recent.length) {
        L.push("");
        L.push("*Последние публикации*");
        for (const m of recent) {
          const cap = (m.caption || "").replace(/\s+/g, " ").slice(0, 40);
          const parts: string[] = [];
          if (m.views) parts.push(`👁 ${m.views.toLocaleString("ru-RU")}`);
          if (m.likes) parts.push(`❤️ ${m.likes.toLocaleString("ru-RU")}`);
          if (m.comments) parts.push(`💬 ${m.comments}`);
          L.push(`• ${cap || "публикация"} — ${parts.join(" · ") || "статистика собирается"}`);
        }
      }
    } catch { /* без блока публикаций */ }
  }

  if (note.trim()) {
    L.push("");
    L.push("*Комментарий менеджера*");
    L.push(note.trim());
  }
  return L.join("\n");
}

// текущий цикл 15→15 (как считает вся остальная отчётность)
function cycleRange(): [string, string] {
  const now = new Date(Date.now() + 5 * 3600 * 1000);
  let y = now.getUTCFullYear(), m = now.getUTCMonth();
  if (now.getUTCDate() < 15) { m--; if (m < 0) { m = 11; y--; } }
  const start = new Date(Date.UTC(y, m, 15));
  const today = now.toISOString().slice(0, 10);
  const end = new Date(Date.UTC(y, m + 1, 14)).toISOString().slice(0, 10);
  return [start.toISOString().slice(0, 10), end <= today ? end : today];
}
