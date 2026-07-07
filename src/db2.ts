import { supabase, Member, listMembers } from "./db";
import { PERSON_KEYWORDS } from "./projects";

export interface Project { id: number; key: string; name: string; }
export interface ContentPlan { id: number; project_id: number; period: string; sheet_url: string | null; video_target: number; graphic_target: number; is_active: boolean; }
export interface ContentItem { id: number; plan_id: number; project_id: number; type: string; idx: number; title: string | null; format: string | null; stage: string; status: string; }
export interface Subscription { id: number; app: string; owner_id: number | null; purchased_on: string; period_days: number; expires_on: string; reminded_before: boolean; reminded_after: boolean; active: boolean; }
export interface GroupBinding { id: number; chat_id: number; project_id: number | null; specialty: string | null; }

// ---------- projects / plans ----------
export async function getProjects(): Promise<Project[]> {
  const { data } = await supabase.from("projects").select("*").order("id");
  return (data as Project[]) ?? [];
}
export async function getProject(id: number): Promise<Project | null> {
  const { data } = await supabase.from("projects").select("*").eq("id", id).maybeSingle();
  return (data as Project) ?? null;
}
export async function getAllActivePlans(): Promise<ContentPlan[]> {
  const { data } = await supabase.from("content_plans").select("*").eq("is_active", true);
  return (data as ContentPlan[]) ?? [];
}
export async function getAllPlans(): Promise<ContentPlan[]> {
  const { data } = await supabase.from("content_plans").select("*").order("id");
  return (data as ContentPlan[]) ?? [];
}
export async function listItemsByPlan(planId: number): Promise<ContentItem[]> {
  const { data } = await supabase.from("content_items").select("*").eq("plan_id", planId).order("idx");
  return (data as ContentItem[]) ?? [];
}
export async function createPlan(projectId: number, period: string): Promise<number | null> {
  const { data } = await supabase.from("content_plans").insert({ project_id: projectId, period, is_active: false, video_target: 0, graphic_target: 0 }).select("id").single();
  return data?.id ?? null;
}
export async function addContentItem(input: { plan_id: number; project_id: number; type: string; idx: number }): Promise<void> {
  const stage = input.type === "video" ? "idea" : "todo";
  await supabase.from("content_items").insert({ plan_id: input.plan_id, project_id: input.project_id, type: input.type, idx: input.idx, stage, status: "in_progress" });
}
export async function deleteContentItem(id: number): Promise<void> {
  await supabase.from("content_items").delete().eq("id", id);
}
export async function getAllItems(): Promise<ContentItem[]> {
  const { data } = await supabase.from("content_items").select("*").order("idx");
  return (data as ContentItem[]) ?? [];
}
export async function getActivePlan(projectId: number): Promise<ContentPlan | null> {
  const { data } = await supabase.from("content_plans").select("*").eq("project_id", projectId).eq("is_active", true).maybeSingle();
  return (data as ContentPlan) ?? null;
}
export async function setSheetUrl(projectId: number, url: string): Promise<void> {
  await supabase.from("content_plans").update({ sheet_url: url }).eq("project_id", projectId).eq("is_active", true);
}

// ---------- content items ----------
export async function listItems(projectId: number, type: string): Promise<ContentItem[]> {
  const { data } = await supabase.from("content_items").select("*").eq("project_id", projectId).eq("type", type).order("idx");
  return (data as ContentItem[]) ?? [];
}
export async function getItem(id: number): Promise<ContentItem | null> {
  const { data } = await supabase.from("content_items").select("*").eq("id", id).maybeSingle();
  return (data as ContentItem) ?? null;
}
export async function updateItem(id: number, patch: Partial<ContentItem>): Promise<void> {
  await supabase.from("content_items").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}
// сводка плана: видео по этапам, графика готово/всего
export async function planSummary(projectId: number): Promise<{ video: Record<string, number>; videoTotal: number; graphicDone: number; graphicTotal: number }> {
  const videos = await listItems(projectId, "video");
  const graphics = await listItems(projectId, "graphic");
  const video: Record<string, number> = {};
  for (const v of videos) video[v.stage] = (video[v.stage] || 0) + 1;
  return {
    video,
    videoTotal: videos.length,
    graphicDone: graphics.filter((g) => g.stage === "done").length,
    graphicTotal: graphics.length,
  };
}

// ---------- member resolver ----------
let _membersCache: Member[] | null = null;
export async function membersAll(): Promise<Member[]> {
  if (!_membersCache) _membersCache = await listMembers();
  return _membersCache;
}
export function resolveMemberSync(members: Member[], anchorName: string): Member | null {
  const kws = PERSON_KEYWORDS[anchorName] || [anchorName.toLowerCase()];
  for (const m of members) {
    const hay = ((m.name || "") + " " + (m.username || "")).toLowerCase();
    if (kws.some((k) => hay.includes(k))) return m;
  }
  return null;
}
export async function resolveMember(anchorName: string): Promise<Member | null> {
  return resolveMemberSync(await membersAll(), anchorName);
}

// ---------- tasks (v2) ----------
export interface TaskRow {
  id: number; title: string; assignee_id: number | null; assignee_name: string | null;
  creator_id: number; project_id: number | null; deadline: string | null; priority: string;
  status: string; kind: string; recurrence: string | null; needs_confirmation: boolean;
  confirmed_by: number | null; item_id: number | null;
}
export async function listOpenTasks(): Promise<TaskRow[]> {
  const { data } = await supabase.from("tasks").select("*").not("status", "in", "(done,cancelled)").order("id");
  return (data as TaskRow[]) ?? [];
}
export async function recentDoneTasks(limit = 15): Promise<TaskRow[]> {
  const { data } = await supabase.from("tasks").select("*").eq("status", "done").order("updated_at", { ascending: false }).limit(limit);
  return (data as TaskRow[]) ?? [];
}
export async function getTaskRow(id: number): Promise<TaskRow | null> {
  const { data } = await supabase.from("tasks").select("*").eq("id", id).maybeSingle();
  return (data as TaskRow) ?? null;
}
export async function setTaskStatus(id: number, status: string, extra: Partial<TaskRow> = {}): Promise<void> {
  await supabase.from("tasks").update({ status, ...extra, updated_at: new Date().toISOString() }).eq("id", id);
}
// задачи, относящиеся к участнику (по id или по имени-якорю)
export async function tasksForMember(member: Member): Promise<TaskRow[]> {
  const all = await listOpenTasks();
  const members = await membersAll();
  return all.filter((t) => {
    if (t.assignee_id && t.assignee_id === member.telegram_id) return true;
    if (!t.assignee_id && t.assignee_name) {
      const resolved = resolveMemberSync(members, t.assignee_name);
      return resolved?.telegram_id === member.telegram_id;
    }
    return false;
  });
}

export async function createAdhocTask(input: { title: string; description?: string | null; assignee_id?: number | null; assignee_name?: string | null; project_id?: number | null; status?: string; item_id?: number | null }): Promise<number | null> {
  const { data } = await supabase.from("tasks").insert({
    title: input.title, description: input.description ?? null,
    assignee_id: input.assignee_id ?? null, assignee_name: input.assignee_name ?? null,
    creator_id: 0, project_id: input.project_id ?? null, kind: "adhoc",
    status: input.status ?? "new", needs_confirmation: true, item_id: input.item_id ?? null,
  }).select("id").single();
  return data?.id ?? null;
}

// ---------- subscriptions ----------
export async function addSubscription(app: string, ownerId: number, purchasedOn: string, periodDays: number): Promise<void> {
  const exp = new Date(new Date(purchasedOn).getTime() + periodDays * 86400000).toISOString().slice(0, 10);
  await supabase.from("subscriptions").insert({ app, owner_id: ownerId, purchased_on: purchasedOn, period_days: periodDays, expires_on: exp, active: true });
}
export async function listSubscriptions(): Promise<Subscription[]> {
  const { data } = await supabase.from("subscriptions").select("*").eq("active", true).order("expires_on");
  return (data as Subscription[]) ?? [];
}
export async function markSub(id: number, field: "reminded_before" | "reminded_after"): Promise<void> {
  await supabase.from("subscriptions").update({ [field]: true }).eq("id", id);
}

// ---------- group bindings ----------
export async function addBinding(chatId: number, projectId: number | null, specialty: string): Promise<void> {
  if (projectId == null) {
    const { data } = await supabase.from("group_bindings").select("id").eq("chat_id", chatId).is("project_id", null).eq("specialty", specialty).maybeSingle();
    if (!data) await supabase.from("group_bindings").insert({ chat_id: chatId, project_id: null, specialty });
  } else {
    await supabase.from("group_bindings").upsert({ chat_id: chatId, project_id: projectId, specialty }, { onConflict: "chat_id,project_id,specialty" });
  }
}
export async function bindingsFor(projectId: number | null, specialty: string): Promise<GroupBinding[]> {
  let q = supabase.from("group_bindings").select("*").in("specialty", [specialty, "all"]);
  q = projectId ? q.or(`project_id.eq.${projectId},project_id.is.null`) : q.is("project_id", null);
  const { data } = await q;
  return (data as GroupBinding[]) ?? [];
}

// ---------- settings & cron markers ----------
export async function getSetting(key: string): Promise<string | null> {
  const { data } = await supabase.from("app_settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}
export async function setSetting(key: string, value: string): Promise<void> {
  await supabase.from("app_settings").upsert({ key, value }, { onConflict: "key" });
}
// вернёт true, если маркер для сегодняшнего дня ещё не стоял (и поставит его)
export async function claimMarker(marker: string, day: string): Promise<boolean> {
  const { data } = await supabase.from("cron_markers").select("day").eq("marker", marker).maybeSingle();
  if (data && data.day === day) return false;
  await supabase.from("cron_markers").upsert({ marker, day }, { onConflict: "marker" });
  return true;
}
