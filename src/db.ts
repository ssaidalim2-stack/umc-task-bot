import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL as string;
const key = process.env.SUPABASE_SERVICE_KEY as string;

export const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export interface Member {
  telegram_id: number;
  name: string | null;
  username: string | null;
  is_admin: boolean;
  specialization: string | null;
  lang: string;
}

export interface Task {
  id: number;
  title: string;
  description: string | null;
  assignee_id: number;
  creator_id: number;
  deadline: string | null;
  priority: string;
  status: string;
  reminded_24h: boolean;
  reminded_1h: boolean;
  reminded_overdue: boolean;
  chat_message_id: number | null;
}

// ---------- members ----------

export async function getMember(telegramId: number): Promise<Member | null> {
  const { data } = await supabase.from("members").select("*").eq("telegram_id", telegramId).maybeSingle();
  return (data as Member) ?? null;
}

export async function upsertMember(m: Partial<Member> & { telegram_id: number }): Promise<Member> {
  const { data } = await supabase
    .from("members")
    .upsert(m, { onConflict: "telegram_id" })
    .select("*")
    .single();
  return data as Member;
}

export async function setMemberLang(telegramId: number, lang: string): Promise<void> {
  await supabase.from("members").update({ lang }).eq("telegram_id", telegramId);
}

export async function setMemberRole(
  telegramId: number,
  isAdmin: boolean,
  specialization: string | null
): Promise<void> {
  await supabase.from("members").update({ is_admin: isAdmin, specialization }).eq("telegram_id", telegramId);
}

export async function listMembers(): Promise<Member[]> {
  const { data } = await supabase.from("members").select("*").order("created_at", { ascending: true });
  return (data as Member[]) ?? [];
}

export async function listAdmins(): Promise<Member[]> {
  const { data } = await supabase.from("members").select("*").eq("is_admin", true);
  return (data as Member[]) ?? [];
}

export async function deleteMember(telegramId: number): Promise<void> {
  await supabase.from("members").delete().eq("telegram_id", telegramId);
}

const KNOWN_ROLES = ["manager", "videographer", "editor", "designer", "member"];
// явная роль (specialization хранит канонический ключ) с фолбэком на старое сопоставление по имени
export function memberRole(m: Member | null): string {
  if (!m) return "member";
  const explicit = (m.specialization || "").trim().toLowerCase();
  if (KNOWN_ROLES.includes(explicit)) return explicit;
  const hay = ((m.specialization || "") + " " + (m.name || "") + " " + (m.username || "")).toLowerCase();
  if (/менедж|manager|smm|бобур|боб|bob/.test(hay)) return "manager";
  if (/монтаж|editor|монтаж[её]р|асрор|asror/.test(hay)) return "editor";
  if (/видеограф|съ[её]м|videograph|video|саманд|saman/.test(hay)) return "videographer";
  if (/дизайн|design|влад|vlad/.test(hay)) return "designer";
  return "member";
}

// ---------- tasks ----------

export async function createTask(input: {
  title: string;
  description: string | null;
  assignee_id: number;
  creator_id: number;
  deadline: string | null;
  priority: string;
}): Promise<Task> {
  const { data } = await supabase.from("tasks").insert(input).select("*").single();
  return data as Task;
}

export async function getTask(id: number): Promise<Task | null> {
  const { data } = await supabase.from("tasks").select("*").eq("id", id).maybeSingle();
  return (data as Task) ?? null;
}

export async function updateTaskStatus(id: number, status: string): Promise<void> {
  await supabase.from("tasks").update({ status, updated_at: new Date().toISOString() }).eq("id", id);
}

export async function setTaskMessageId(id: number, messageId: number): Promise<void> {
  await supabase.from("tasks").update({ chat_message_id: messageId }).eq("id", id);
}

export async function listMyActiveTasks(telegramId: number): Promise<Task[]> {
  const { data } = await supabase
    .from("tasks")
    .select("*")
    .eq("assignee_id", telegramId)
    .in("status", ["new", "in_progress", "paused"])
    .order("deadline", { ascending: true, nullsFirst: false });
  return (data as Task[]) ?? [];
}

export async function listAllTasks(): Promise<Task[]> {
  const { data } = await supabase
    .from("tasks")
    .select("*")
    .not("status", "in", "(done,cancelled)")
    .order("created_at", { ascending: false });
  return (data as Task[]) ?? [];
}

// задачи с дедлайном, требующие проверки напоминаний
export async function listTasksForReminders(): Promise<Task[]> {
  const { data } = await supabase
    .from("tasks")
    .select("*")
    .not("status", "in", "(done,cancelled)")
    .not("deadline", "is", null);
  return (data as Task[]) ?? [];
}

export async function markReminded(
  id: number,
  field: "reminded_24h" | "reminded_1h" | "reminded_overdue"
): Promise<void> {
  await supabase.from("tasks").update({ [field]: true }).eq("id", id);
}

export async function logAction(taskId: number, actorId: number, action: string): Promise<void> {
  await supabase.from("task_log").insert({ task_id: taskId, actor_id: actorId, action });
}

// ---------- sessions (мастер /newtask) ----------

export interface SessionState {
  step?: string;
  draft?: {
    title?: string;
    description?: string | null;
    assignee_id?: number;
    deadline?: string | null;
    priority?: string;
  };
}

export async function getSession(telegramId: number): Promise<SessionState> {
  const { data } = await supabase.from("sessions").select("state").eq("telegram_id", telegramId).maybeSingle();
  return ((data?.state as SessionState) ?? {}) as SessionState;
}

export async function setSession(telegramId: number, state: SessionState): Promise<void> {
  await supabase
    .from("sessions")
    .upsert({ telegram_id: telegramId, state, updated_at: new Date().toISOString() }, { onConflict: "telegram_id" });
}

export async function clearSession(telegramId: number): Promise<void> {
  await supabase.from("sessions").delete().eq("telegram_id", telegramId);
}
