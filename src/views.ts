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
// пункты выбранного периода (по умолчанию — текущего) для отчёта клиенту: и для картинки, и для текста
export interface ReportItem { idx: number; num: number; type: string; theme: string; lang: string; stage: string; deadline: string; publishDay: string | null; shootDay: string | null }
export async function clientPlan(projectId: number, planId?: number | null): Promise<{ planId: number | null; period: string; plans: { id: number; period: string; is_active: boolean }[]; items: ReportItem[] }> {
  const { parseItemData, parseShootDay } = await import("./webapp");
  const plans = (await d2.getAllPlans()).filter((p) => p.project_id === projectId);
  const plan = (planId && plans.find((p) => p.id === planId)) || d2.currentPlanByProject(plans).get(projectId) || null;
  const raw = plan ? (await d2.listItemsByPlan(plan.id)).filter((x) => x.type !== "story") : [];
  // номер внутри своего типа: «Видео 3», «Граф-пост 1» — как в Таблице
  const counters: Record<string, number> = {};
  const items: ReportItem[] = raw.sort((a, b) => a.idx - b.idx).map((it) => {
    const d = parseItemData((it as any).title);
    const k = it.type === "video" ? "video" : it.type === "photo" ? "photo" : "graphic";
    counters[k] = (counters[k] || 0) + 1;
    return { idx: it.idx, num: counters[k], type: it.type, theme: String(d.theme || "").trim(), lang: String(d.lang || ""), stage: it.stage, deadline: String(d.deadline || ""), publishDay: parseShootDay(d.deadline), shootDay: parseShootDay(d.shoot_date) };
  });
  return { planId: plan?.id ?? null, period: plan?.period || "", plans: plans.map((p) => ({ id: p.id, period: p.period, is_active: p.is_active })), items };
}
export const CLIENT_STATUS: Record<string, string> = { idea: "🕒 В плане", script: "📝 Сценарий готов", shoot: "🎥 Снято", edit: "✂️ Смонтировано", published: "✅ Опубликовано", todo: "🕒 В работе", done: "✅ Готово" };
const LANG_RU: Record<string, string> = { ru: "РУС", uz: "УЗБ", en: "ENG" };
// темы пишут как угодно — звёздочки и подчёркивания сломали бы разметку Telegram
const clean = (t: string) => t.replace(/[*_`\[\]]/g, "").replace(/\s+/g, " ").trim();

export async function buildClientReport(projectId: number, note: string, planId?: number | null): Promise<string> {
  const proj = await d2.getProject(projectId);
  if (!proj) return "";
  const cp = await clientPlan(projectId, planId);
  const videos = cp.items.filter((x) => x.type === "video");
  const graphics = cp.items.filter((x) => x.type !== "video");
  const cnt = (st: string) => videos.filter((v) => v.stage === st).length;

  const L: string[] = [];
  const nowRu = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10).split("-").reverse().join(".");
  L.push(`📊 *Отчёт по проекту ${clean(proj.name)}*`);
  L.push(`${cp.period ? "Период: " + clean(cp.period) + " · " : ""}статус на ${nowRu}`);
  L.push("");

  // --- контент ---
  const published = cnt("published");
  L.push("*Контент*");
  L.push(`🎬 Опубликовано видео: *${published}* из ${videos.length}`);
  if (cnt("edit")) L.push(`✂️ Смонтировано, готово к публикации: ${cnt("edit")}`);
  if (cnt("shoot")) L.push(`🎥 Отснято, в монтаже: ${cnt("shoot")}`);
  if (cnt("script")) L.push(`📝 Сценарии готовы, ждут съёмки: ${cnt("script")}`);
  if (graphics.length) L.push(`🖼 Графика: *${graphics.filter((g) => g.stage === "done").length}* из ${graphics.length}`);

  // --- съёмки и ближайшая публикация ---
  const today = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
  const shootDays = new Set(videos.map((v) => v.shootDay).filter(Boolean) as string[]);
  const upcoming = videos.filter((v) => v.stage !== "published" && v.publishDay && v.publishDay >= today).sort((a, b) => (a.publishDay as string).localeCompare(b.publishDay as string));
  const past = [...shootDays].filter((d) => d <= today).sort();
  const future = [...shootDays].filter((d) => d > today).sort();
  const ru = (iso: string) => iso.split("-").reverse().join(".");
  if (shootDays.size) L.push(`📅 Съёмочных дней за период: ${shootDays.size}`);
  if (past.length) L.push(`🎥 Последняя съёмка: ${ru(past[past.length - 1])}`);
  if (future.length) L.push(`🗓 Ближайшая съёмка: ${ru(future[0])}`);
  if (upcoming.length) L.push(`⏭ Следующий выход: ${ru(upcoming[0].publishDay as string)}`);

  // --- статус каждого ролика: ради этого отчёт и открывают ---
  if (cp.items.length) {
    L.push("");
    L.push("*Статус по контенту*");
    cp.items.forEach((it, i) => {
      const kind = it.type === "video" ? "Видео" : it.type === "photo" ? "Фото" : "Граф-пост";
      const bits = [`${i + 1}: ${kind} ${it.num} — ${clean(it.theme) || "тема уточняется"}`];
      if (LANG_RU[it.lang]) bits.push(LANG_RU[it.lang]);
      bits.push(CLIENT_STATUS[it.stage] || it.stage);
      if (it.stage !== "published" && it.stage !== "done" && it.publishDay) bits.push(`выход ${ru(it.publishDay)}`);
      L.push(bits.join(" — "));
    });
  }

  // --- реклама и Instagram ---
  const map = await meta.getMetaMap();
  const bind = map[proj.key] || {};
  const [since, until] = cycleRange();

  if (bind.ad && (await meta.metaConfigured())) {
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
    } catch { /* нет данных — блока просто не будет, клиенту не показываем кухню */ }
  }

  if (bind.ig && (await meta.metaConfigured())) {
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

// ---------- сводки в группу команды (утро 10:00 и итоги дня 23:00) ----------
// Считаем по фактам из задач: дедлайн, статус и момент последнего изменения.
// "Сделано поздно" = закрыто позже дедлайна; "просрочено" = дедлайн прошёл, а задача открыта.
type TeamTask = { title: string; deadline: string | null; status: string; updated_at?: string; assignee_id: number | null; assignee_name: string | null };

function ruDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(new Date(iso).getTime() + 5 * 3600 * 1000);
  return d.toISOString().slice(0, 10).split("-").reverse().join(".");
}
function ruDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(new Date(iso).getTime() + 5 * 3600 * 1000).toISOString();
  return d.slice(8, 10) + "." + d.slice(5, 7) + " " + d.slice(11, 16);
}

async function teamTasksByPerson(): Promise<{ name: string; tasks: TeamTask[] }[]> {
  const [tasks, members] = await Promise.all([d2.allTasksBulk(), (await import("./db")).listMembers()]);
  const nameById = new Map(members.map((m) => [m.telegram_id, m.name || m.username || String(m.telegram_id)]));
  const groups = new Map<string, TeamTask[]>();
  for (const t of tasks as any[]) {
    const name = t.assignee_id ? nameById.get(t.assignee_id) || t.assignee_name || "Без исполнителя" : t.assignee_name || "Без исполнителя";
    const arr = groups.get(name) || [];
    arr.push(t as TeamTask);
    groups.set(name, arr);
  }
  return [...groups.entries()].map(([name, tasks]) => ({ name, tasks })).sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

// Утро: что у кого в работе на сегодня и что уже горит
export async function buildTeamMorning(): Promise<string> {
  const now = Date.now();
  const today = new Date(now + 5 * 3600 * 1000).toISOString().slice(0, 10);
  const people = await teamTasksByPerson();
  const L = [`☀️ *Задачи на сегодня — ${today.split("-").reverse().join(".")}*`, ""];
  let any = false;
  for (const p of people) {
    const open = p.tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
    if (!open.length) continue;
    any = true;
    const overdue = open.filter((t) => t.deadline && new Date(t.deadline).getTime() < now);
    const rest = open.filter((t) => !overdue.includes(t));
    L.push(`*${p.name}*`);
    for (const t of overdue) L.push(`  🔴 ${t.title} — просрочено с ${ruDate(t.deadline)}`);
    for (const t of rest) L.push(`  • ${t.title}${t.deadline ? ` — до ${ruDate(t.deadline)}` : ""}`);
    L.push("");
  }
  if (!any) L.push("Открытых задач нет 🎉");
  return L.join("\n").trim();
}

// Вечер: итоги дня по каждому — что закрыто, что закрыто с опозданием, что просрочено, что ещё в работе
export async function buildTeamEvening(): Promise<string> {
  const now = Date.now();
  const todayIso = new Date(now + 5 * 3600 * 1000).toISOString().slice(0, 10);
  const people = await teamTasksByPerson();
  const L = [`🌙 *Итоги дня — ${todayIso.split("-").reverse().join(".")}*`, ""];
  let any = false;
  for (const p of people) {
    const doneToday = p.tasks.filter((t) => t.status === "done" && t.updated_at && new Date(new Date(t.updated_at).getTime() + 5 * 3600 * 1000).toISOString().slice(0, 10) === todayIso);
    const onTime = doneToday.filter((t) => !t.deadline || new Date(t.updated_at!).getTime() <= new Date(t.deadline).getTime());
    const late = doneToday.filter((t) => t.deadline && new Date(t.updated_at!).getTime() > new Date(t.deadline).getTime());
    const open = p.tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
    const overdue = open.filter((t) => t.deadline && new Date(t.deadline).getTime() < now);
    const active = open.filter((t) => !overdue.includes(t));
    if (!doneToday.length && !open.length) continue;
    any = true;
    L.push(`*${p.name}*`);
    for (const t of onTime) L.push(`  ✅ ${t.title} — сдано ${ruDateTime(t.updated_at)}`);
    for (const t of late) L.push(`  ⚠️ ${t.title} — сдано ${ruDateTime(t.updated_at)}, дедлайн был ${ruDate(t.deadline)}`);
    for (const t of overdue) L.push(`  🔴 ${t.title} — не сдано, дедлайн ${ruDate(t.deadline)}`);
    for (const t of active) L.push(`  🕒 ${t.title}${t.deadline ? ` — срок до ${ruDate(t.deadline)}` : " — без срока"}`);
    L.push("");
  }
  if (!any) L.push("Сегодня задач не было.");
  return L.join("\n").trim();
}
