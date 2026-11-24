// Исследование соцсетей через ScrapeCreators (api.scrapecreators.com): что залетело у конкурентов,
// что в тренде по ключевым словам ниши и какую рекламу конкуренты крутят в Meta.
//
// Данные платные (1 запрос ≈ 1 кредит), поэтому:
// - конкуренты и тренды собираются раз в неделю на проект и хранятся в app_settings,
//   утренние идеи берут их оттуда, не тратя кредиты каждый день;
// - разбор рекламы — только по кнопке.
// Конкуренты и ключевые слова задаются в брифе проекта (вкладка «Проекты» → 🧠).
import * as d2 from "./db2";
import { aiConfigured, generate } from "./ai";

const BASE = "https://api.scrapecreators.com";
const ENV_KEY = (process.env.SCRAPECREATORS_API_KEY || "").trim();
const DAY = 86400000;
export const MAX_COMPETITORS = 3;
export const MAX_KEYWORDS = 2;

async function apiKey(): Promise<string> {
  try { const v = ((await d2.getSetting("sc_api_key")) || "").trim(); if (v) return v; } catch {}
  return ENV_KEY;
}
export async function researchConfigured(): Promise<boolean> { return !!(await apiKey()); }

async function scGet(path: string, params: Record<string, string | number | boolean>, key?: string): Promise<any> {
  const k = key ?? (await apiKey());
  if (!k) throw new Error("Нет ключа ScrapeCreators — вставь его во вкладке «Проекты»");
  const qs = new URLSearchParams(Object.entries(params).map(([a, b]) => [a, String(b)])).toString();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 40000);
  try {
    const res = await fetch(`${BASE}${path}${qs ? "?" + qs : ""}`, { headers: { "x-api-key": k }, signal: ctl.signal });
    const j: any = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) throw new Error("ScrapeCreators не принял ключ");
    if (res.status === 402 || /credit/i.test(String(j?.message || j?.error || "")) && !res.ok) throw new Error("Закончились кредиты ScrapeCreators");
    if (!res.ok || j?.success === false) throw new Error(String(j?.message || j?.error || `ScrapeCreators: ошибка ${res.status}`));
    if (typeof j?.credits_remaining === "number") { try { await d2.setSetting("sc_credits", JSON.stringify({ left: j.credits_remaining, at: Date.now() })); } catch {} }
    return j;
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error("ScrapeCreators не ответил за 40 секунд");
    throw e;
  } finally { clearTimeout(timer); }
}

export async function balance(key?: string): Promise<number> {
  const j = await scGet("/v1/account/credit-balance", {}, key);
  const n = Number(j?.creditCount ?? j?.credits_remaining);
  return Number.isFinite(n) ? n : 0;
}
export async function setKey(key: string): Promise<{ ok: boolean; credits?: number; error?: string }> {
  const k = key.trim();
  if (!k) return { ok: false, error: "Вставь ключ" };
  try { const credits = await balance(k); await d2.setSetting("sc_api_key", k); return { ok: true, credits }; }
  catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
}
export async function lastKnownCredits(): Promise<{ left: number; at: number } | null> {
  try { return JSON.parse((await d2.getSetting("sc_credits")) || "null"); } catch { return null; }
}

// ---------- конкуренты из брифа ----------
export interface Competitor { platform: "ig" | "tt"; handle: string }
// «@brand», «ig:brand», «tt:brand», «tiktok @brand», ссылки instagram.com/brand и tiktok.com/@brand — через запятую или с новой строки
export function parseCompetitors(text: string): Competitor[] {
  const out: Competitor[] = [];
  for (const raw of String(text || "").split(/[\n,;]+/)) {
    const s = raw.trim();
    if (!s) continue;
    let platform: "ig" | "tt" = "ig", handle = "";
    const tt = s.match(/tiktok\.com\/@([\w.]+)/i), ig = s.match(/instagram\.com\/([\w.]+)/i);
    if (tt) { platform = "tt"; handle = tt[1]; }
    else if (ig) { handle = ig[1]; }
    else {
      const m = s.match(/^(ig|insta|instagram|tt|tiktok)\s*[:\s]\s*@?([\w.]+)$/i) || s.match(/^@?([\w.]+)$/);
      if (!m) continue;
      if (m.length === 3) { platform = /^t/i.test(m[1]) ? "tt" : "ig"; handle = m[2]; } else handle = m[1];
    }
    handle = handle.replace(/^@/, "").replace(/\.+$/, "");
    if (handle && !out.some((c) => c.platform === platform && c.handle.toLowerCase() === handle.toLowerCase())) out.push({ platform, handle });
  }
  return out.slice(0, MAX_COMPETITORS);
}
export function parseKeywords(text: string): string[] {
  return String(text || "").split(/[\n,;]+/).map((s) => s.trim().replace(/^#/, "")).filter(Boolean).slice(0, MAX_KEYWORDS);
}

export interface Post { platform: "ig" | "tt"; handle: string; url: string; caption: string; views: number; likes: number; comments: number; at: number }
export interface Outlier extends Post { lift: number; baseline: number }
export interface Research { at: number; outliers: Outlier[]; trends: Post[]; errors: string[]; competitors: string[]; keywords: string[] }

const cap = (s: any) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 220);

async function competitorPosts(c: Competitor): Promise<Post[]> {
  if (c.platform === "ig") {
    const j = await scGet("/v1/instagram/user/reels", { handle: c.handle, trim: true });
    return ((j?.items as any[]) || []).map((x) => ({
      platform: "ig" as const, handle: c.handle, url: `https://www.instagram.com/reel/${x.code}/`,
      caption: cap(x.caption?.text ?? x.caption), views: Number(x.play_count ?? x.ig_play_count ?? 0), likes: Number(x.like_count || 0),
      comments: Number(x.comment_count || 0), at: Number(x.taken_at || 0) * 1000,
    })).filter((p) => p.url.includes("/reel/") && !p.url.includes("undefined"));
  }
  const j = await scGet("/v3/tiktok/profile/videos", { handle: c.handle, trim: true });
  return ((j?.aweme_list as any[]) || []).map((x) => ({
    platform: "tt" as const, handle: c.handle, url: `https://www.tiktok.com/@${x.author?.unique_id || c.handle}/video/${x.aweme_id}`,
    caption: cap(x.desc), views: Number(x.statistics?.play_count || 0), likes: Number(x.statistics?.digg_count || 0),
    comments: Number(x.statistics?.comment_count || 0), at: Number(x.create_time || 0) * 1000,
  }));
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
// «залетевшие» — в 2+ раза выше обычного уровня этого же аккаунта (медиана, чтобы один вирусный ролик не сбил базу)
export function findOutliers(posts: Post[], now = Date.now()): Outlier[] {
  const recent = posts.filter((p) => !p.at || now - p.at < 75 * DAY);
  if (recent.length < 5) return [];
  const metric = (p: Post) => p.views || p.likes;
  const base = median(recent.map(metric));
  if (!base) return [];
  return recent.map((p) => ({ ...p, baseline: base, lift: Math.round((metric(p) / base) * 10) / 10 }))
    .filter((p) => p.lift >= 2).sort((a, b) => b.lift - a.lift).slice(0, 3);
}

async function keywordTrends(q: string): Promise<Post[]> {
  const [tt, ig] = await Promise.allSettled([
    scGet("/v1/tiktok/search/keyword", { query: q, date_posted: "this-month", sort_by: "relevance", trim: true }),
    scGet("/v2/instagram/reels/search", { query: q, date_posted: "last-month" }),
  ]);
  const out: Post[] = [];
  if (tt.status === "fulfilled") for (const x of (tt.value?.search_item_list as any[]) || []) out.push({
    platform: "tt", handle: x.author?.unique_id || "", url: `https://www.tiktok.com/@${x.author?.unique_id || "_"}/video/${x.aweme_id}`,
    caption: cap(x.desc), views: Number(x.statistics?.play_count || 0), likes: Number(x.statistics?.digg_count || 0), comments: Number(x.statistics?.comment_count || 0), at: Number(x.create_time || 0) * 1000,
  });
  if (ig.status === "fulfilled") for (const x of (ig.value?.reels as any[]) || []) out.push({
    platform: "ig", handle: x.owner?.username || "", url: x.url || `https://www.instagram.com/reel/${x.shortcode}/`,
    caption: cap(x.caption), views: 0, likes: Number(x.like_count || 0), comments: Number(x.comment_count || 0), at: Number(x.taken_at || 0) * 1000,
  });
  if (tt.status === "rejected" && ig.status === "rejected") throw tt.reason;
  return out;
}

// примерная цена сбора по проекту в кредитах — показываем до нажатия
export function estimateCredits(brief: Record<string, string> | undefined): number {
  return parseCompetitors(brief?.competitors || "").length + parseKeywords(brief?.keywords || "").length * 2;
}

export async function runResearch(projectId: number): Promise<Research> {
  const p = (await d2.getProjectsWithMeta()).find((x) => x.id === projectId);
  if (!p) throw new Error("проект не найден");
  const comps = parseCompetitors(p.brief?.competitors || "");
  const kws = parseKeywords(p.brief?.keywords || "");
  if (!comps.length && !kws.length) throw new Error("В брифе проекта нет ни конкурентов, ни ключевых слов");
  const errors: string[] = [];
  const outliers: Outlier[] = [];
  const trends: Post[] = [];
  await Promise.all([
    ...comps.map(async (c) => {
      try { outliers.push(...findOutliers(await competitorPosts(c))); }
      catch (e: any) { errors.push(`${c.platform === "tt" ? "TikTok" : "Instagram"} @${c.handle}: ${e?.message || e}`); }
    }),
    ...kws.map(async (q) => {
      try {
        const list = (await keywordTrends(q)).sort((a, b) => (b.views || b.likes * 20) - (a.views || a.likes * 20));
        trends.push(...list.slice(0, 4));
      } catch (e: any) { errors.push(`«${q}»: ${e?.message || e}`); }
    }),
  ]);
  outliers.sort((a, b) => b.lift - a.lift);
  const rec: Research = { at: Date.now(), outliers: outliers.slice(0, 6), trends: trends.slice(0, 8), errors, competitors: comps.map((c) => `${c.platform}:${c.handle}`), keywords: kws };
  await d2.setSetting(`research:${projectId}`, JSON.stringify(rec));
  return rec;
}
export async function getResearch(projectId: number): Promise<Research | null> {
  try { return JSON.parse((await d2.getSetting(`research:${projectId}`)) || "null"); } catch { return null; }
}

// для утренних идей: короткая выжимка последних данных (не старше 10 дней)
export async function researchForPrompt(projectId: number): Promise<string> {
  const r = await getResearch(projectId);
  if (!r || Date.now() - r.at > 10 * DAY) return "";
  const L: string[] = [];
  if (r.outliers.length) {
    L.push("Что залетело у конкурентов (реальные данные, рост к их обычному уровню):");
    for (const o of r.outliers) L.push(`  • @${o.handle} ×${o.lift} — «${o.caption.slice(0, 140)}» ${o.url}`);
  }
  if (r.trends.length) {
    L.push(`Что сейчас набирает по запросам ${r.keywords.map((k) => "«" + k + "»").join(", ")}:`);
    for (const t of r.trends.slice(0, 5)) L.push(`  • ${t.platform === "tt" ? "TikTok" : "Reels"} — «${t.caption.slice(0, 120)}» ${t.url}`);
  }
  return L.join("\n");
}

// ---------- еженедельный сбор (крон) ----------
// по 3 проекта за заход крона, чтобы уложиться в лимит времени функции; проект считается свежим 6 дней
export async function runWeeklyTick(): Promise<number> {
  if (!(await researchConfigured())) return 0;
  const projects = (await d2.getActiveProjects()) as any[];
  const withMeta = (await d2.getProjectsWithMeta()).filter((p) => projects.some((x) => x.id === p.id));
  const due: number[] = [];
  for (const p of withMeta) {
    if (!estimateCredits(p.brief)) continue;
    const r = await getResearch(p.id);
    if (!r || Date.now() - r.at > 6 * DAY) due.push(p.id);
  }
  let n = 0;
  await Promise.all(due.slice(0, 3).map(async (id) => { try { await runResearch(id); n++; } catch (e) { console.error("research", id, e); } }));
  return n;
}

// ---------- реклама конкурентов в Meta (по кнопке) ----------
export interface AdsReport { at: number; text: string; ads: { page: string; title: string; body: string; cta: string; format: string; since: string; url: string }[]; errors: string[] }
export async function adsTeardown(projectId: number): Promise<AdsReport> {
  const p = (await d2.getProjectsWithMeta()).find((x) => x.id === projectId);
  if (!p) throw new Error("проект не найден");
  const comps = parseCompetitors(p.brief?.competitors || "");
  if (!comps.length) throw new Error("В брифе проекта нет конкурентов");
  const errors: string[] = [];
  const ads: AdsReport["ads"] = [];
  await Promise.all(comps.map(async (c) => {
    try {
      const found = await scGet("/v1/facebook/adLibrary/search/companies", { query: c.handle });
      const list: any[] = found?.searchResults || [];
      const page = list.find((x) => String(x.ig_username || x.page_alias || "").toLowerCase() === c.handle.toLowerCase()) || list[0];
      if (!page?.page_id) { errors.push(`@${c.handle}: страница в библиотеке рекламы не найдена`); return; }
      const res = await scGet("/v1/facebook/adLibrary/company/ads", { pageId: page.page_id, status: "ACTIVE", trim: true });
      const items: any[] = res?.results || [];
      if (!items.length) { errors.push(`@${c.handle}: активной рекламы нет`); return; }
      for (const a of items.slice(0, 8)) ads.push({
        page: a.page_name || page.name || c.handle, title: cap(a.snapshot?.title), body: String(a.snapshot?.body?.text || "").slice(0, 400),
        cta: a.snapshot?.cta_text || "", format: a.snapshot?.display_format || "", since: a.start_date_string || (a.start_date ? new Date(a.start_date * 1000).toISOString().slice(0, 10) : ""),
        url: a.url || `https://www.facebook.com/ads/library/?id=${a.ad_archive_id}`,
      });
    } catch (e: any) { errors.push(`@${c.handle}: ${e?.message || e}`); }
  }));
  let text = "";
  if (ads.length && aiConfigured()) {
    const prompt = `Ты — performance-маркетолог агентства в Узбекистане. Ниже активные объявления конкурентов проекта «${p.name}» из библиотеки рекламы Meta.
Разбери их по-русски, коротко, без воды:
1) Главные заходы (боли, выгоды, к кому обращаются) — 3–5 пунктов.
2) Хуки и заголовки, которые повторяются, — дословно.
3) Офферы и призывы к действию.
4) Что они, похоже, тестируют (по повторам и форматам). Не выдумывай бюджеты и результаты — их нет в данных.
5) 3 теста для нашего клиента.
Без markdown-таблиц, обычный текст со списками.

${ads.map((a, i) => `#${i + 1} ${a.page} · ${a.format} · с ${a.since}\nЗаголовок: ${a.title}\nТекст: ${a.body}\nКнопка: ${a.cta}`).join("\n\n")}`;
    try { text = (await generate({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4 } }, 45000)).text.trim(); }
    catch (e: any) { errors.push("AI-разбор: " + (e?.message || e)); }
  }
  const rep: AdsReport = { at: Date.now(), text, ads, errors };
  await d2.setSetting(`ads_research:${projectId}`, JSON.stringify(rep));
  return rep;
}
export async function getAds(projectId: number): Promise<AdsReport | null> {
  try { return JSON.parse((await d2.getSetting(`ads_research:${projectId}`)) || "null"); } catch { return null; }
}
