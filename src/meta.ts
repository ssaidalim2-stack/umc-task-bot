// Meta (Instagram Insights + Facebook Ads) — подтягивание цифр в отчёты.
// Требует env: META_TOKEN (long-lived user/system token).
// Привязка аккаунтов к проектам хранится в app_settings key "meta_map":
//   { "<projectKey>": { "ig": "<ig_user_id>", "ad": "act_<ad_account_id>" } }
// Дневные снэпшоты кэшируются в app_settings key "meta_stats:<YYYY-MM-DD>".
import { getSetting, setSetting } from "./db2";

const GRAPH = "https://graph.facebook.com/v21.0";
const TOKEN = process.env.META_TOKEN || "";

async function gget(path: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams({ ...params, access_token: TOKEN }).toString();
  const res = await fetch(`${GRAPH}${path}?${qs}`);
  const j: any = await res.json().catch(() => ({}));
  if (j.error) throw new Error(`Meta API: ${j.error.message || JSON.stringify(j.error)}`);
  return j;
}

export function metaConfigured(): boolean { return !!TOKEN; }

// ---------- привязка проектов ----------
export interface MetaMap { [projectKey: string]: { ig?: string; ad?: string } }
export async function getMetaMap(): Promise<MetaMap> {
  try { return JSON.parse((await getSetting("meta_map")) || "{}"); } catch { return {}; }
}
export async function setMetaBinding(projectKey: string, field: "ig" | "ad", value: string): Promise<void> {
  const map = await getMetaMap();
  map[projectKey] = { ...(map[projectKey] || {}), [field]: value };
  await setSetting("meta_map", JSON.stringify(map));
}

// ---------- проверка токена / список доступных аккаунтов ----------
export async function listAvailableAccounts(): Promise<{ pages: any[]; igAccounts: any[]; adAccounts: any[] }> {
  const me = await gget("/me", { fields: "id,name" });
  const pages = (await gget("/me/accounts", { fields: "id,name,instagram_business_account{id,username}" })).data || [];
  const igAccounts = pages.filter((p: any) => p.instagram_business_account)
    .map((p: any) => ({ page: p.name, ig_id: p.instagram_business_account.id, username: p.instagram_business_account.username }));
  const adAccounts = (await gget("/me/adaccounts", { fields: "id,name,account_status" })).data || [];
  return { pages: pages.map((p: any) => ({ id: p.id, name: p.name })), igAccounts, adAccounts };
}

// ---------- Instagram insights ----------
export interface IgDay { reach: number; views: number; interactions: number; followers: number; }
export async function igInsights(igUserId: string, since: string, until: string): Promise<IgDay> {
  // метрики за период (metric_type=total_value для v21)
  const j = await gget(`/${igUserId}/insights`, {
    metric: "reach,views,total_interactions",
    period: "day", metric_type: "total_value", since, until,
  });
  const out: IgDay = { reach: 0, views: 0, interactions: 0, followers: 0 };
  for (const m of j.data || []) {
    const v = m.total_value?.value ?? (m.values || []).reduce((a: number, x: any) => a + (x.value || 0), 0);
    if (m.name === "reach") out.reach = v;
    if (m.name === "views") out.views = v;
    if (m.name === "total_interactions") out.interactions = v;
  }
  const acc = await gget(`/${igUserId}`, { fields: "followers_count" });
  out.followers = acc.followers_count || 0;
  return out;
}

// ---------- Facebook Ads insights ----------
export interface AdsDay { spend: number; impressions: number; clicks: number; results: number; currency: string; }
export async function adsInsights(adAccountId: string, since: string, until: string): Promise<AdsDay> {
  const j = await gget(`/${adAccountId}/insights`, {
    fields: "spend,impressions,clicks,actions,account_currency",
    time_range: JSON.stringify({ since, until }),
  });
  const row = (j.data || [])[0] || {};
  const results = (row.actions || []).reduce((a: number, x: any) =>
    ["lead", "onsite_conversion.messaging_conversation_started_7d", "link_click"].includes(x.action_type) ? a + (+x.value || 0) : a, 0);
  return { spend: +row.spend || 0, impressions: +row.impressions || 0, clicks: +row.clicks || 0, results, currency: row.account_currency || "USD" };
}

// ---------- дневной снэпшот по всем проектам (для крона и отчёта) ----------
export interface MetaSnapshot { [projectKey: string]: { ig?: IgDay; ads?: AdsDay; error?: string } }
export async function pullSnapshot(day: string): Promise<MetaSnapshot> {
  const map = await getMetaMap();
  const snap: MetaSnapshot = {};
  for (const [key, b] of Object.entries(map)) {
    snap[key] = {};
    try {
      if (b.ig) snap[key].ig = await igInsights(b.ig, day, day);
      if (b.ad) snap[key].ads = await adsInsights(b.ad, day, day);
    } catch (e: any) { snap[key].error = String(e.message || e); }
  }
  await setSetting(`meta_stats:${day}`, JSON.stringify(snap));
  return snap;
}
export async function getSnapshot(day: string): Promise<MetaSnapshot | null> {
  try { const s = await getSetting(`meta_stats:${day}`); return s ? JSON.parse(s) : null; } catch { return null; }
}
