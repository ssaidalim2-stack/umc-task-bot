// Утренние AI-идеи по проектам: каждому менеджеру по его проектам (кнопка 📁 в «Команде»)
// приходит «доброе утро + задачи на сегодня» и по 4 идеи на проект, кроме воскресенья.
//
// Идеи делает Gemini с поиском в Google, поэтому новости и тренды свежие и со ссылками.
// Чтобы идеи не были общими и не повторялись, в запрос идут бриф проекта, темы текущего
// контент-плана и заголовки идей за последние дни. Под каждой идеей кнопка «➕ В план»:
// одним нажатием она становится пунктом контент-плана.
//
// Модуль не импортирует bot.ts (bot → v2 → ideas дало бы цикл): отправка — через переданный api.
import { InlineKeyboard } from "grammy";
import * as db from "./db";
import * as d2 from "./db2";
import { aiConfigured, generate, Source } from "./ai";

const TZ = 5 * 3600 * 1000;
const HIST_MAX = 40;

export const BRIEF_FIELDS: [string, string][] = [
  ["niche", "Ниша и продукт"],
  ["audience", "Целевая аудитория"],
  ["geo", "Город / регион"],
  ["lang", "Язык контента"],
  ["tone", "Тон бренда"],
  ["avoid", "Чего не предлагать"],
];

export type IdeaKind = "news" | "trend" | "video" | "hook" | "story" | "graphic";
export const KIND_LABEL: Record<IdeaKind, string> = {
  news: "📰 Новость ниши",
  trend: "🔥 Тренд",
  video: "🎬 Идея для видео",
  hook: "🪝 Хук для видео",
  story: "📱 Идея для сторис",
  graphic: "🖼 Идея для граф-поста",
};
export interface Idea { kind: IdeaKind; title: string; text: string; hook?: string; source?: string; added?: number }
export interface IdeasRecord { day: string; projectId: number; ideas: Idea[]; sources: Source[]; model: string; at: number }

export function localDay(now = Date.now()): string { return new Date(now + TZ).toISOString().slice(0, 10); }

// 4 идеи в день, набор меняется по дням, чтобы не приедалось:
// всегда 1 свежая новость или тренд + 1 видео с хуком + 2 из ротации
export function kindsFor(day: string): IdeaKind[] {
  const d = Math.floor(Date.parse(day + "T00:00:00Z") / 86400000);
  const first: IdeaKind = d % 2 ? "trend" : "news";
  const rot: [IdeaKind, IdeaKind][] = [["story", "graphic"], ["hook", "story"], ["graphic", "video"], ["story", "hook"]];
  return [first, "video", ...rot[d % rot.length]];
}

function briefText(p: { name: string; description?: string; brief?: Record<string, string> }): string {
  const lines = [`Проект: ${p.name}`];
  if (p.description) lines.push(`Описание: ${p.description}`);
  for (const [k, label] of BRIEF_FIELDS) { const v = (p.brief || {})[k]; if (v && v.trim()) lines.push(`${label}: ${v.trim()}`); }
  return lines.join("\n");
}

function buildPrompt(p: { name: string; description?: string; brief?: Record<string, string> }, day: string, planThemes: string[], history: string[]): string {
  const kinds = kindsFor(day);
  const contentLang = (p.brief?.lang || "").trim() || "русский";
  return `Ты — креативный стратег маркетингового агентства в Узбекистане. Сегодня ${day.split("-").reverse().join(".")}.
Подготовь для менеджера проекта ровно 4 идеи — конкретные, применимые сегодня, а не общие советы.

${briefText(p)}

Типы идей строго в таком порядке:
${kinds.map((k, i) => `${i + 1}. ${k} — ${KIND_LABEL[k]}`).join("\n")}

Требования:
- news: реальная свежая новость этой ниши или рынка (последние недели) — найди в Google, укажи URL источника в поле source. Объясни, как её использовать в контенте.
- trend: что сейчас набирает популярность (Reels/TikTok/Pinterest/Google) в этой нише или визуально подходит ей; как адаптировать под проект. Если есть — URL примера в source.
- video: идея короткого видео (Reels): о чём, что в кадре; в поле hook — первая фраза-зацепка на 1–3 секунды.
- hook: 3 варианта хуков для видео этого проекта одной строкой через « / ».
- story: идея сторис (формат, механика: опрос, до/после, закулисье и т.п.).
- graphic: идея граф-поста: заголовок и суть визуала.
- Хуки и тексты, которые пойдут в контент, — на языке контента: ${contentLang}. Пояснения для менеджера — по-русски.
- Не повторяй темы, которые уже есть:
${[...planThemes, ...history].slice(0, 60).map((t) => "  • " + t).join("\n") || "  (пока ничего)"}
- Никаких выдуманных фактов, цифр и ссылок. Если свежей новости не нашлось — так и напиши в text и оставь source пустым.

Ответ — только JSON без пояснений и без markdown:
{"ideas":[{"kind":"...","title":"коротко, до 70 символов","text":"2–4 предложения","hook":"","source":""}]}`;
}

function parseIdeas(raw: string, kinds: IdeaKind[]): Idea[] {
  const s = raw.replace(/```(?:json)?/gi, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("AI вернул ответ не в формате JSON");
  const j = JSON.parse(s.slice(a, b + 1));
  const list: any[] = Array.isArray(j.ideas) ? j.ideas : [];
  const out: Idea[] = list.slice(0, 4).map((x, i) => ({
    kind: (Object.keys(KIND_LABEL).includes(x.kind) ? x.kind : kinds[i] || "video") as IdeaKind,
    title: String(x.title || "").trim().slice(0, 120),
    text: String(x.text || "").trim().slice(0, 900),
    hook: String(x.hook || "").trim().slice(0, 300) || undefined,
    source: /^https?:\/\//.test(String(x.source || "")) ? String(x.source) : undefined,
  })).filter((x) => x.title || x.text);
  if (!out.length) throw new Error("AI не прислал ни одной идеи");
  return out;
}

async function planThemes(projectId: number): Promise<string[]> {
  const plan = d2.currentPlanByProject(await d2.getAllPlans()).get(projectId);
  if (!plan) return [];
  const items = await d2.listItemsByPlan(plan.id);
  const out: string[] = [];
  for (const it of items) { try { const d = JSON.parse((it as any).title || "{}"); if (d.theme) out.push(String(d.theme)); } catch {} }
  return out;
}

// сгенерировать идеи проекта на день; store=false — пробный запуск из приложения (не пишем в историю)
export async function generateForProject(projectId: number, day = localDay(), store = true, timeoutMs = 45000): Promise<IdeasRecord> {
  const p = (await d2.getProjectsWithMeta()).find((x) => x.id === projectId);
  if (!p) throw new Error("проект не найден");
  let history: string[] = [];
  try { history = JSON.parse((await d2.getSetting(`ideas_hist:${projectId}`)) || "[]"); } catch {}
  const prompt = buildPrompt(p, day, await planThemes(projectId), history);
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.9 } };
  let res;
  try { res = await generate({ ...body, tools: [{ google_search: {} }] }, timeoutMs); }
  catch (e: any) {
    // поиск недоступен (лимит/модель без tools) — идеи без свежих новостей лучше, чем никаких
    if (/лимит|ключ|доступа/i.test(String(e?.message))) throw e;
    res = await generate(body, timeoutMs);
  }
  const rec: IdeasRecord = { day, projectId, ideas: parseIdeas(res.text, kindsFor(day)), sources: res.sources.slice(0, 3), model: res.model, at: Date.now() };
  if (store) {
    await d2.setSetting(`ideas:${day}:${projectId}`, JSON.stringify(rec));
    const hist = [...rec.ideas.map((x) => x.title).filter(Boolean), ...history].slice(0, HIST_MAX);
    await d2.setSetting(`ideas_hist:${projectId}`, JSON.stringify(hist));
  }
  return rec;
}
export async function getIdeas(day: string, projectId: number): Promise<IdeasRecord | null> {
  try { const raw = await d2.getSetting(`ideas:${day}:${projectId}`); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

// кто получает: менеджеры и проджект-менеджеры, у которых отмечены свои проекты
export async function recipients(): Promise<{ member: db.Member; projectIds: number[] }[]> {
  const members = (await db.listMembers()).filter((m) => { const r = db.memberRoleList(m); return r.includes("manager") || r.includes("pm"); });
  const bulk = await d2.getMemberProjectsBulk(members.map((m) => m.telegram_id));
  const active = new Set((await d2.getActiveProjects()).map((p) => p.id));
  return members.map((m) => ({ member: m, projectIds: (bulk[m.telegram_id] || []).filter((id) => active.has(id)) })).filter((x) => x.projectIds.length);
}

// идеи сегодня сработают: AI настроен и не воскресенье
export function ideasDay(now = Date.now()): boolean { return aiConfigured() && new Date(now + TZ).getUTCDay() !== 0; }

const esc = (s: string) => String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
const dayKey = (day: string) => day.replace(/-/g, "");

export function formatProject(name: string, rec: IdeasRecord): { html: string; kb: InlineKeyboard } {
  const L = [`💡 <b>${esc(name)}</b> — идеи на сегодня`, ""];
  const kb = new InlineKeyboard();
  rec.ideas.forEach((x, i) => {
    L.push(`<b>${i + 1}. ${KIND_LABEL[x.kind] || ""}</b>${x.title ? " — " + esc(x.title) : ""}`);
    if (x.hook) L.push(`🪝 <i>${esc(x.hook)}</i>`);
    if (x.text) L.push(esc(x.text));
    if (x.source) L.push(`🔗 <a href="${esc(x.source)}">источник</a>`);
    L.push("");
    kb.text(x.added ? `✅ ${i + 1} в плане` : `➕ ${i + 1} в план`, `idea:${rec.projectId}:${dayKey(rec.day)}:${i}`);
    if (i % 2 === 1 && i < rec.ideas.length - 1) kb.row();
  });
  if (rec.sources.length && !rec.ideas.some((x) => x.source)) {
    L.push("Источники: " + rec.sources.map((s, i) => `<a href="${esc(s.uri)}">${esc(s.title || "ссылка " + (i + 1))}</a>`).join(" · "));
  }
  return { html: L.join("\n").trim(), kb };
}

// «➕ В план»: идея становится пунктом активного периода проекта
export async function addToPlan(projectId: number, dayK: string, idx: number, who: string): Promise<{ ok: boolean; text: string; rec?: IdeasRecord }> {
  const day = `${dayK.slice(0, 4)}-${dayK.slice(4, 6)}-${dayK.slice(6, 8)}`;
  const rec = await getIdeas(day, projectId);
  const idea = rec?.ideas[idx];
  if (!rec || !idea) return { ok: false, text: "Идея устарела или не найдена" };
  if (idea.added) return { ok: true, text: "Уже в плане ✅", rec };
  const plan = d2.currentPlanByProject(await d2.getAllPlans()).get(projectId);
  if (!plan) return { ok: false, text: "У проекта нет периода в Таблице — создай его" };
  const type = idea.kind === "story" ? "story" : idea.kind === "graphic" ? "graphic" : "video";
  const items = await d2.listItemsByPlan(plan.id);
  const nextIdx = items.reduce((m, i) => Math.max(m, i.idx), 0) + 1;
  await d2.addContentItem({ plan_id: plan.id, project_id: projectId, type, idx: nextIdx });
  const fresh = (await d2.listItemsByPlan(plan.id)).filter((x) => x.idx === nextIdx).sort((a, b) => b.id - a.id)[0];
  if (fresh) {
    const body = [idea.hook ? `Хук: ${idea.hook}` : "", idea.text, idea.source ? `Источник: ${idea.source}` : ""].filter(Boolean).join("\n");
    if (type === "story") {
      const tomorrow = new Date(Date.parse(day + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
      const d = { day: tomorrow, media: "video", lang: "", theme: idea.title, shooter: "", speech: body, title: "", subtitle: "", material: "", matDeadline: "", last_edited_by: who };
      await d2.updateItem(fresh.id, { title: JSON.stringify(d), stage: "planned", status: "in_progress" });
    } else {
      await d2.updateItem(fresh.id, { title: JSON.stringify({ theme: idea.title, script: body, last_edited_by: who }) });
    }
  }
  idea.added = Date.now();
  await d2.setSetting(`ideas:${day}:${projectId}`, JSON.stringify(rec));
  const where = type === "story" ? "Сторис (на завтра)" : `Таблица, пункт #${nextIdx}`;
  return { ok: true, text: `Добавлено: ${where}`, rec };
}

type Api = { sendMessage: (chatId: number, text: string, extra?: any) => Promise<any> };

// Один заход крона. Крон приходит нерегулярно, поэтому: сначала дозаготовить идеи
// (параллельно, с бюджетом времени), потом разослать тем, у кого всё готово —
// а после 11:00 и тем, у кого готово не всё, чтобы задачи на день не ждали AI.
export async function runIdeasTick(api: Api, now = Date.now(), tasksFor?: (m: db.Member) => Promise<string[]>): Promise<number> {
  if (!ideasDay(now)) return 0;
  const local = new Date(now + TZ);
  const hour = local.getUTCHours();
  if (hour < 6 || hour >= 17) return 0;
  const day = localDay(now);
  const recs = await recipients();
  if (!recs.length) return 0;

  const needed = Array.from(new Set(recs.flatMap((r) => r.projectIds)));
  const ready = new Map<number, IdeasRecord>();
  for (const pid of needed) { const r = await getIdeas(day, pid); if (r) ready.set(pid, r); }
  const missing = needed.filter((pid) => !ready.has(pid)).slice(0, 4);
  await Promise.all(missing.map(async (pid) => {
    try { ready.set(pid, await generateForProject(pid, day, true, 40000)); }
    catch (e) { console.error("ideas generate", pid, e); }
  }));

  if (hour < 9) return 0;
  const projects = new Map((await d2.getProjects()).map((p) => [p.id, p.name]));
  let sent = 0;
  for (const { member, projectIds } of recs) {
    const allReady = projectIds.every((id) => ready.has(id));
    if (!allReady && hour < 11) continue;
    if (!(await d2.claimMarker(`ideas_sent:${member.telegram_id}`, day))) continue;
    const tasks = tasksFor ? await tasksFor(member) : [];
    const head = [`☀️ Доброе утро, ${member.name || ""}!`, ""];
    if (tasks.length) { head.push("📋 Задачи на сегодня:"); tasks.forEach((t) => head.push(`• ${t}`)); }
    else head.push("📋 Открытых задач нет.");
    head.push("", "Ниже — идеи по твоим проектам. Понравилась — жми «➕ в план», и она появится в Таблице.");
    try { await api.sendMessage(member.telegram_id, head.join("\n")); sent++; } catch {}
    for (const pid of projectIds) {
      const rec = ready.get(pid);
      if (!rec) continue;
      const { html, kb } = formatProject(projects.get(pid) || "", rec);
      try { await api.sendMessage(member.telegram_id, html, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } }); sent++; }
      catch { try { await api.sendMessage(member.telegram_id, html.replace(/<[^>]+>/g, ""), { reply_markup: kb }); sent++; } catch {} }
    }
  }
  return sent;
}
