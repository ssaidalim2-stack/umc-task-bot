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
// личные активы + активы всех бизнес-портфолио (business_management)
export async function listAvailableAccounts(): Promise<{ igAccounts: any[]; adAccounts: any[]; businesses: any[] }> {
  const pageFields = "id,name,instagram_business_account{id,username}";
  const [myPages, myAds, bizList] = await Promise.all([
    gget("/me/accounts", { fields: pageFields, limit: "100" }).catch(() => ({ data: [] })),
    gget("/me/adaccounts", { fields: "id,name,account_status", limit: "100" }).catch(() => ({ data: [] })),
    gget("/me/businesses", { fields: "id,name", limit: "50" }).catch(() => ({ data: [] })),
  ]);
  const igAccounts: any[] = [];
  const adAccounts: any[] = [...(myAds.data || [])];
  const pushIg = (p: any, src: string) => { if (p.instagram_business_account) igAccounts.push({ page: p.name, ig_id: p.instagram_business_account.id, username: p.instagram_business_account.username, src }); };
  for (const p of myPages.data || []) pushIg(p, "личный");
  const businesses: any[] = [];
  await Promise.all((bizList.data || []).map(async (b: any) => {
    const [op, cp, oa, ca] = await Promise.all([
      gget(`/${b.id}/owned_pages`, { fields: pageFields, limit: "100" }).catch(() => ({ data: [] })),
      gget(`/${b.id}/client_pages`, { fields: pageFields, limit: "100" }).catch(() => ({ data: [] })),
      gget(`/${b.id}/owned_ad_accounts`, { fields: "id,name", limit: "100" }).catch(() => ({ data: [] })),
      gget(`/${b.id}/client_ad_accounts`, { fields: "id,name", limit: "100" }).catch(() => ({ data: [] })),
    ]);
    const pages = [...(op.data || []), ...(cp.data || [])];
    const ads = [...(oa.data || []), ...(ca.data || [])];
    for (const p of pages) pushIg(p, b.name);
    for (const a of ads) if (!adAccounts.some((x) => x.id === a.id)) adAccounts.push({ ...a, src: b.name });
    businesses.push({ id: b.id, name: b.name, pages: pages.map((p: any) => ({ id: p.id, name: p.name, ig: p.instagram_business_account || null })), adAccounts: ads });
  }));
  return { igAccounts, adAccounts, businesses };
}

// ---------- аналитика: кэш ----------
async function cached<T>(key: string, ttlMin: number, fn: () => Promise<T>): Promise<T> {
  try {
    const raw = await getSetting(`an:${key}`);
    if (raw) { const j = JSON.parse(raw); if (Date.now() - j.t < ttlMin * 60000) return j.data as T; }
  } catch {}
  const data = await fn();
  try { await setSetting(`an:${key}`, JSON.stringify({ t: Date.now(), data })); } catch {}
  return data;
}

// ---------- таргет: кампании с результатами (активные и нет) ----------
export interface CampaignStat { id: string; name: string; status: string; spend: number; impressions: number; clicks: number; results: number; resultType: string; currency: string; }
function parseResults(actions: any[]): { n: number; type: string } {
  const pick = ["lead", "onsite_conversion.messaging_conversation_started_7d", "purchase", "link_click"];
  for (const t of pick) { const a = (actions || []).find((x: any) => x.action_type === t); if (a && +a.value > 0) return { n: +a.value, type: t }; }
  return { n: 0, type: "" };
}
export async function campaignStats(adAccountId: string, since: string, until: string): Promise<CampaignStat[]> {
  return cached(`ads:${adAccountId}:${since}:${until}`, 180, async () => {
    const fields = `name,status,effective_status,insights.time_range({"since":"${since}","until":"${until}"}){spend,impressions,clicks,actions,account_currency}`;
    const j = await gget(`/${adAccountId}/campaigns`, { fields, limit: "100" });
    return (j.data || []).map((c: any) => {
      const ins = c.insights?.data?.[0] || {};
      const r = parseResults(ins.actions);
      return { id: c.id, name: c.name, status: c.effective_status || c.status, spend: +ins.spend || 0, impressions: +ins.impressions || 0, clicks: +ins.clicks || 0, results: r.n, resultType: r.type, currency: ins.account_currency || "USD" };
    });
  });
}

// ---------- видео/посты: медиа с обложкой и метриками ----------
export interface MediaStat { id: string; caption: string; type: string; thumb: string; link: string; date: string; likes: number; comments: number; views: number; reach: number; saved: number; }
export async function igMediaStats(igUserId: string, since: string, until: string): Promise<MediaStat[]> {
  return cached(`media:${igUserId}:${since}:${until}`, 180, async () => {
    const j = await gget(`/${igUserId}/media`, { fields: "id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp,like_count,comments_count", limit: "50" });
    const items = (j.data || []).filter((m: any) => { const d = (m.timestamp || "").slice(0, 10); return d >= since && d <= until; });
    const out: MediaStat[] = [];
    await Promise.all(items.map(async (m: any) => {
      let views = 0, reach = 0, saved = 0;
      try {
        const ins = await gget(`/${m.id}/insights`, { metric: "reach,views,saved" });
        for (const x of ins.data || []) { const v = x.values?.[0]?.value || 0; if (x.name === "views") views = v; if (x.name === "reach") reach = v; if (x.name === "saved") saved = v; }
      } catch {}
      const firstSentence = ((m.caption || "").split(/[\n.!?]/)[0] || "").trim().slice(0, 80);
      out.push({ id: m.id, caption: firstSentence || "(без описания)", type: m.media_product_type || m.media_type || "", thumb: m.thumbnail_url || m.media_url || "", link: m.permalink || "", date: (m.timestamp || "").slice(0, 10), likes: m.like_count || 0, comments: m.comments_count || 0, views, reach, saved });
    }));
    out.sort((a, b) => (a.date < b.date ? 1 : -1));
    return out;
  });
}

// ---------- аккаунт: охват / просмотры / прирост подписчиков за период ----------
export interface AccountStat { reach: number; views: number; interactions: number; followerGain: number; followers: number; }
function* windows(since: string, until: string): Generator<[string, string]> {
  let s = new Date(since + "T00:00:00Z");
  const end = new Date(until + "T00:00:00Z");
  while (s <= end) {
    const e = new Date(Math.min(end.getTime(), s.getTime() + 29 * 86400000));
    yield [s.toISOString().slice(0, 10), e.toISOString().slice(0, 10)];
    s = new Date(e.getTime() + 86400000);
  }
}
export async function igAccountStats(igUserId: string, since: string, until: string): Promise<AccountStat> {
  return cached(`acc:${igUserId}:${since}:${until}`, 180, async () => {
    const out: AccountStat = { reach: 0, views: 0, interactions: 0, followerGain: 0, followers: 0 };
    for (const [s, u] of windows(since, until)) {
      try {
        const j = await gget(`/${igUserId}/insights`, { metric: "reach,views,total_interactions", period: "day", metric_type: "total_value", since: s, until: u });
        for (const m of j.data || []) {
          const v = m.total_value?.value ?? 0;
          if (m.name === "reach") out.reach += v;
          if (m.name === "views") out.views += v;
          if (m.name === "total_interactions") out.interactions += v;
        }
      } catch {}
      try {
        const f = await gget(`/${igUserId}/insights`, { metric: "follower_count", period: "day", since: s, until: u });
        for (const m of f.data || []) for (const x of m.values || []) out.followerGain += x.value || 0;
      } catch {}
    }
    try { const acc = await gget(`/${igUserId}`, { fields: "followers_count" }); out.followers = acc.followers_count || 0; } catch {}
    return out;
  });
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
