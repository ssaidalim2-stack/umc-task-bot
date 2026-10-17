// Финансы агентства: оплаты клиентов, расходы, зарплаты команды.
//
// Всё лежит в одном журнале fin_entries (см. supabase/migration_v6_finance.sql):
//   income  — деньги от клиента (planned → ожидается, done → получено)
//   expense — прочий расход
//   accrual — начисление сотруднику (сколько ему должны за работу)
//   payout  — выплата сотруднику (сколько реально отдали, включая авансы)
//
// Прибыль цикла = доходы цикла − начисления цикла − расходы цикла. Выплаты в прибыль не
// идут: они только гасят долг перед человеком. Поэтому аванс, выданный раньше работы,
// и клиент, заплативший 50% вперёд, не искажают прибыль — это видно в блоке «Деньги».
import { supabase, listMembers, memberRoleList, Member } from "./db";
import * as d2 from "./db2";

const TZ = 5 * 3600 * 1000; // Asia/Tashkent
export const CURRENCIES = ["UZS", "USD"] as const;
const PIECE_KINDS = ["shoot", "edit", "graphic"] as const;
type PieceKind = (typeof PIECE_KINDS)[number];
// кто делает сдельную работу — по роли, как и уведомления по этапам
const PIECE_ROLE: Record<PieceKind, string> = { shoot: "videographer", edit: "editor", graphic: "designer" };
const PIECE_LABEL: Record<PieceKind, string> = { shoot: "Съёмка", edit: "Монтаж", graphic: "Графика" };
const VIDEO_ORDER = ["idea", "script", "shoot", "edit", "published"];

export interface FinEntry {
  id: number; kind: string; category: string | null; project_id: number | null; member_id: number | null;
  cycle: string; amount: number; currency: string; rate: number | null; status: string;
  due_on: string | null; paid_on: string | null; note: string | null; ref: string | null; item_id: number | null;
  created_at?: string;
}
export interface PayRule { id: number; member_id: number; kind: string; project_id: number | null; amount: number; currency: string; title: string | null; active: boolean; }
export interface ProjectTerms { project_id: number; fee: number; currency: string; schedule: string; start_cycle: string | null; active: boolean; }

// ---------- циклы 15→15 ----------
export function todayIso(): string { return new Date(Date.now() + TZ).toISOString().slice(0, 10); }
// дата → цикл 'YYYY-MM' (цикл начинается 15-го этого месяца)
export function cycleOf(dateIso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateIso || "");
  if (!m) return cycleOf(todayIso());
  let y = +m[1], mo = +m[2];
  if (+m[3] < 15) { mo--; if (mo < 1) { mo = 12; y--; } }
  return `${y}-${String(mo).padStart(2, "0")}`;
}
export function currentCycle(): string { return cycleOf(todayIso()); }
export function shiftCycle(c: string, n: number): string {
  const [y, m] = c.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
export function cycleBounds(c: string): { start: string; end: string } {
  const [y, m] = c.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 15)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(y, m, 14)).toISOString().slice(0, 10);
  return { start, end };
}
function isCycle(s: any): s is string { return typeof s === "string" && /^\d{4}-\d{2}$/.test(s); }
function isDate(s: any): s is string { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function cur(s: any): string { return s === "USD" ? "USD" : "UZS"; }
function num(s: any): number { const n = parseFloat(String(s ?? "").replace(/\s/g, "").replace(",", ".")); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; }

// ---------- курс ЦБ Узбекистана ----------
// Курс на дату кешируется в app_settings (fx:YYYY-MM-DD), чтобы не ходить в ЦБ на каждый запрос.
// Если ЦБ недоступен — последний известный курс, затем ручной (задаётся во вкладке).
async function fetchCbu(date: string): Promise<number | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(`https://cbu.uz/ru/arkhiv-kursov-valyut/json/USD/${date}/`, { signal: ctrl.signal });
    if (!r.ok) return null;
    const j: any = await r.json();
    const rate = parseFloat(Array.isArray(j) ? j[0]?.Rate : j?.Rate);
    return rate > 0 ? rate : null;
  } catch { return null; } finally { clearTimeout(timer); }
}
export async function getRate(date?: string): Promise<{ rate: number; date: string; source: string }> {
  const today = todayIso();
  const d = isDate(date) && date <= today ? date : today;
  const manual = await d2.getSetting(`fx_manual:${d}`);
  if (manual && +manual > 0) return { rate: +manual, date: d, source: "manual" };
  const cached = await d2.getSetting(`fx:${d}`);
  if (cached && +cached > 0) return { rate: +cached, date: d, source: "cbu" };
  const fresh = await fetchCbu(d);
  if (fresh) {
    await d2.setSetting(`fx:${d}`, String(fresh));
    if (d === today) await d2.setSetting("fx:last", JSON.stringify({ rate: fresh, date: d }));
    return { rate: fresh, date: d, source: "cbu" };
  }
  try {
    const last = JSON.parse((await d2.getSetting("fx:last")) || "null");
    if (last?.rate > 0) return { rate: +last.rate, date: last.date, source: "last" };
  } catch {}
  return { rate: 0, date: d, source: "none" };
}
export async function setManualRate(rate: number): Promise<void> {
  const d = todayIso();
  await d2.setSetting(`fx_manual:${d}`, rate > 0 ? String(rate) : "");
  if (rate > 0) await d2.setSetting("fx:last", JSON.stringify({ rate, date: d }));
}

// ---------- доступ к данным ----------
async function rules(): Promise<PayRule[]> {
  const { data, error } = await supabase.from("fin_pay_rules").select("*").eq("active", true).order("id");
  if (error) throw error;
  return ((data as any[]) ?? []).map((r) => ({ ...r, amount: Number(r.amount) }));
}
async function terms(): Promise<ProjectTerms[]> {
  const { data, error } = await supabase.from("fin_project_terms").select("*");
  if (error) throw error;
  return ((data as any[]) ?? []).map((t) => ({ ...t, fee: Number(t.fee) }));
}
function normEntry(e: any): FinEntry { return { ...e, amount: Number(e.amount), rate: e.rate == null ? null : Number(e.rate) }; }
async function insertAuto(rows: any[]): Promise<void> {
  if (!rows.length) return;
  // ref уникален: повторный запуск (крон, повторное открытие вкладки) ничего не задвоит,
  // а удалённая автозапись остаётся со status=void и тоже не пересоздаётся
  const { error } = await supabase.from("fin_entries").upsert(rows, { onConflict: "ref", ignoreDuplicates: true });
  if (error) throw error;
}

// ---------- автосоздание записей цикла ----------
// Ожидаемые оплаты клиентов по условиям проекта + оклады и фикс за проекты.
// Создаются только для текущего цикла: прошлые не трогаем, будущие появятся сами.
export async function ensureCycle(c: string = currentCycle()): Promise<void> {
  if (c !== currentCycle()) return;
  const [tms, rls, fx] = await Promise.all([terms(), rules(), getRate()]);
  const { start, end } = cycleBounds(c);
  const rows: any[] = [];
  for (const t of tms) {
    if (!t.active || t.fee <= 0 || t.schedule === "manual") continue;
    if (t.start_cycle && t.start_cycle > c) continue;
    const parts: [number, string][] = t.schedule === "split" ? [[0.5, start], [0.5, end]] : t.schedule === "post" ? [[1, end]] : [[1, start]];
    parts.forEach(([share, due], i) => rows.push({
      kind: "income", category: "fee", project_id: t.project_id, cycle: c, amount: Math.round(t.fee * share * 100) / 100,
      currency: t.currency, rate: fx.rate || null, status: "planned", due_on: due,
      note: parts.length > 1 ? `Часть ${i + 1} из ${parts.length}` : null, ref: `fee:${t.project_id}:${c}:${i + 1}`,
    }));
  }
  for (const r of rls) {
    if (r.kind !== "salary" && r.kind !== "project_fixed") continue;
    if (r.amount <= 0) continue;
    rows.push({
      kind: "accrual", category: r.kind, project_id: r.kind === "project_fixed" ? r.project_id : null, member_id: r.member_id,
      cycle: c, amount: r.amount, currency: r.currency, rate: fx.rate || null, status: "done",
      note: r.title || null, ref: `${r.kind === "salary" ? "sal" : "pfx"}:${r.id}:${c}`,
    });
  }
  await insertAuto(rows);
}

// ---------- сдельные начисления из конвейера контента ----------
async function workerFor(itemId: number, kind: PieceKind, members: Member[], rls: PayRule[]): Promise<number | null> {
  const role = PIECE_ROLE[kind];
  const byId = new Map(members.map((m) => [m.telegram_id, m]));
  // 1) тот, кому по этому пункту ушло ТЗ (задача привязана к item_id)
  const { data } = await supabase.from("tasks").select("assignee_id, created_at").eq("item_id", itemId).not("assignee_id", "is", null).order("created_at", { ascending: false });
  for (const t of (data as any[]) ?? []) {
    const m = byId.get(t.assignee_id);
    if (m && memberRoleList(m).includes(role)) return m.telegram_id;
  }
  // 2) единственный человек с такой ролью и сдельной ставкой
  const paid = members.filter((m) => memberRoleList(m).includes(role) && rls.some((r) => r.member_id === m.telegram_id && r.kind === kind));
  return paid.length === 1 ? paid[0].telegram_id : null;
}
function rateFor(rls: PayRule[], memberId: number, kind: string, projectId: number | null): PayRule | null {
  const mine = rls.filter((r) => r.member_id === memberId && r.kind === kind);
  return mine.find((r) => r.project_id === projectId) || mine.find((r) => r.project_id == null) || null;
}
async function ensurePiece(item: { id: number; project_id: number; idx: number; type: string }, kind: PieceKind): Promise<void> {
  const ref = `pc:${item.id}:${kind}`;
  if (kind === "shoot") {
    // видео без съёмки (в т.ч. «только таргет») — видеографу за него не начисляем
    const fresh = await d2.getItem(item.id);
    try { if (JSON.parse((fresh as any)?.title || "{}").no_shoot) return; } catch {}
  }
  const { data: ex } = await supabase.from("fin_entries").select("id").eq("ref", ref).maybeSingle();
  if (ex) return;
  const [members, rls, fx] = await Promise.all([listMembers(), rules(), getRate()]);
  // никто из этой роли не на сдельной оплате (напр. графику делает менеджер в рамках фикса) — начислять нечего
  if (!rls.some((r) => r.kind === kind)) return;
  const worker = await workerFor(item.id, kind, members, rls);
  const rule = worker ? rateFor(rls, worker, kind, item.project_id) : null;
  if (worker && !rule) return; // исполнитель известен, но у него нет сдельной ставки
  const proj = await d2.getProject(item.project_id);
  const what = item.type === "video" ? `Видео #${item.idx}` : `${item.type === "photo" ? "Фото" : "Графика"} #${item.idx}`;
  await insertAuto([{
    kind: "accrual", category: kind, project_id: item.project_id, member_id: worker, item_id: item.id,
    cycle: currentCycle(), amount: rule ? rule.amount : 0, currency: rule ? rule.currency : "UZS", rate: fx.rate || null,
    status: "done", note: `${PIECE_LABEL[kind]}: ${proj?.name || ""} ${what}`.trim(), ref,
  }]);
}

// фактический день съёмки — для отчёта клиенту: плановая дата, если она уже наступила, иначе день, когда отметили «Снято»
async function stampShot(id: number, clear = false) {
  const fresh = await d2.getItem(id);
  if (!fresh) return;
  let d: any = {};
  try { d = JSON.parse((fresh as any).title || "{}") || {}; } catch { return; }
  if (clear) { if (d.shot_at) { delete d.shot_at; await d2.updateItem(id, { title: JSON.stringify(d) }); } return; }
  if (d.no_shoot || d.shot_at) return;
  const today = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
  const { parseShootDay } = await import("./webapp");
  const plan = parseShootDay(d.shoot_date);
  d.shot_at = plan && plan <= today ? plan : today;
  await d2.updateItem(id, { title: JSON.stringify(d) });
}

// Вызывается при КАЖДОЙ смене этапа пункта контент-плана. Начисляет только при переходе
// вперёд через порог («Снято» → видеографу, «Смонтировано» → монтажёру, графика «Готово» →
// дизайнеру). Ошибки глотаем: финансы не должны ломать работу с контент-планом.
export async function onItemStage(item: { id: number; project_id: number; idx: number; type: string } | null, prevStage: string | null | undefined, newStage: string | null | undefined): Promise<void> {
  if (!item || !newStage || prevStage === newStage) return;
  try {
    if (item.type === "video") {
      const p = VIDEO_ORDER.indexOf(prevStage || "idea"), n = VIDEO_ORDER.indexOf(newStage);
      if (n < 0) return;
      if (p < 2 && n >= 2) { await stampShot(item.id); await ensurePiece(item, "shoot"); }
      if (p >= 2 && n < 2) await stampShot(item.id, true); // откатили «Снято» по ошибке — факт съёмки снимаем
      if (p < 3 && n >= 3) await ensurePiece(item, "edit");
    } else if (item.type === "graphic" || item.type === "photo") {
      if (prevStage !== "done" && newStage === "done") await ensurePiece(item, "graphic");
    }
  } catch (e) { console.error("finance onItemStage", e); }
}

// ---------- сериализация для вкладки ----------
function convert(e: FinEntry, nowRate: number): { uzs: number; usd: number } {
  // ожидаемые деньги ещё не пришли — считаем по сегодняшнему курсу, остальное — по курсу дня операции
  const r = e.status === "planned" ? nowRate : (e.rate || nowRate);
  const a = e.amount;
  if (e.currency === "USD") return { usd: a, uzs: r ? a * r : 0 };
  return { uzs: a, usd: r ? a / r : 0 };
}

export async function load(cycleIn?: string) {
  const c = isCycle(cycleIn) ? cycleIn : currentCycle();
  await ensureCycle(currentCycle());
  const [fx, members, projects, rls, tms, cycleRows, openIncome, ledger] = await Promise.all([
    getRate(), listMembers(), d2.getProjectsWithMeta(), rules(), terms(),
    supabase.from("fin_entries").select("*").eq("cycle", c).neq("status", "void").order("id"),
    supabase.from("fin_entries").select("*").eq("kind", "income").eq("status", "planned").order("due_on"),
    supabase.from("fin_entries").select("*").in("kind", ["accrual", "payout"]).neq("status", "void"),
  ]);
  for (const r of [cycleRows, openIncome, ledger]) if (r.error) throw r.error;
  const ser = (e: any) => { const n = normEntry(e); return { ...n, ...convert(n, fx.rate) }; };

  // баланс по каждому человеку в родной валюте: сумма к выплате минус уже выплаченное.
  // Отрицательный баланс = выдан аванс больше, чем начислено.
  const bal: Record<number, { UZS: number; USD: number }> = {};
  const unassigned: any[] = [];
  for (const raw of (ledger.data as any[]) ?? []) {
    const e = normEntry(raw);
    if (e.member_id == null) { if (e.kind === "accrual") unassigned.push(ser(raw)); continue; }
    const b = bal[e.member_id] || (bal[e.member_id] = { UZS: 0, USD: 0 });
    const k = e.currency === "USD" ? "USD" : "UZS";
    b[k] += e.kind === "accrual" ? e.amount : -e.amount;
  }
  const people = members.map((m) => ({
    id: m.telegram_id, name: m.name || m.username || String(m.telegram_id), roles: memberRoleList(m),
    balance: bal[m.telegram_id] || { UZS: 0, USD: 0 },
  }));
  return {
    cycle: c, current: currentCycle(), bounds: cycleBounds(c), rate: fx,
    projects: projects.map((p) => ({ id: p.id, name: p.name, archived: p.archived })),
    people, rules: rls, terms: tms,
    entries: ((cycleRows.data as any[]) ?? []).map(ser),
    openIncome: ((openIncome.data as any[]) ?? []).map(ser),
    unassigned,
  };
}

// ---------- действия вкладки (только админ — проверяется в webapp.ts) ----------
const ENTRY_KINDS = ["income", "expense", "accrual", "payout"];

export async function handle(userId: number, a: any): Promise<any> {
  switch (a.type) {
    case "fin_load": return load(a.cycle);

    case "fin_entry_save": {
      const f = a.fields || {};
      const kind = String(f.kind || "");
      if (!ENTRY_KINDS.includes(kind)) return { error: "неизвестный тип записи" };
      let amount = num(f.amount);
      if (!amount) return { error: "впиши сумму" };
      const status = kind === "income" && f.status === "planned" ? "planned" : "done";
      const paid_on = status === "done" ? (isDate(f.paid_on) ? f.paid_on : todayIso()) : null;
      const due_on = isDate(f.due_on) ? f.due_on : null;
      // цикл: у доходов и начислений — тот, к которому относится работа (выбирается явно);
      // у расходов и выплат — по дате денег
      const cycle = (kind === "income" || kind === "accrual") && isCycle(f.cycle) ? f.cycle : cycleOf(paid_on || due_on || todayIso());
      if (kind === "accrual" && f.category === "deduction") amount = -Math.abs(amount);
      const member_id = kind === "accrual" || kind === "payout" ? (f.member_id ? +f.member_id : null) : null;
      if ((kind === "accrual" || kind === "payout") && !member_id) return { error: "выбери сотрудника" };
      const fx = await getRate(paid_on || undefined);
      const row: any = {
        kind, category: String(f.category || "other"), project_id: f.project_id ? +f.project_id : null, member_id,
        cycle, amount, currency: cur(f.currency), rate: fx.rate || null, status, due_on, paid_on,
        note: String(f.note || "").trim() || null, updated_at: new Date().toISOString(),
      };
      if (a.id) {
        const { data: old } = await supabase.from("fin_entries").select("*").eq("id", +a.id).maybeSingle();
        if (!old) return { error: "запись не найдена" };
        // у автозаписей ключ и исполнитель сохраняются — правится только сумма/дата/комментарий
        const { error } = await supabase.from("fin_entries").update({ ...row, kind: old.kind, ref: old.ref, item_id: old.item_id, member_id: row.member_id ?? old.member_id }).eq("id", +a.id);
        if (error) return { error: "не удалось сохранить: " + error.message };
      } else {
        const { error } = await supabase.from("fin_entries").insert({ ...row, created_by: userId });
        if (error) return { error: "не удалось сохранить: " + error.message };
      }
      return load(a.cycle);
    }

    case "fin_entry_delete": {
      const { data: old } = await supabase.from("fin_entries").select("id, ref").eq("id", +a.id).maybeSingle();
      if (!old) return load(a.cycle);
      // автозапись не удаляем физически, иначе следующая синхронизация создаст её заново
      const q = old.ref
        ? supabase.from("fin_entries").update({ status: "void", updated_at: new Date().toISOString() }).eq("id", old.id)
        : supabase.from("fin_entries").delete().eq("id", old.id);
      const { error } = await q;
      if (error) return { error: "не удалось удалить: " + error.message };
      return load(a.cycle);
    }

    // клиент заплатил: целиком или частично. Недоплата остаётся отдельной ожидаемой
    // записью в той же валюте и в том же цикле — долг клиента не теряется.
    case "fin_income_pay": {
      const { data: raw } = await supabase.from("fin_entries").select("*").eq("id", +a.id).maybeSingle();
      if (!raw || raw.kind !== "income" || raw.status !== "planned") return { error: "оплата не найдена" };
      const e = normEntry(raw);
      const paid = num(a.amount);
      if (paid <= 0) return { error: "впиши полученную сумму" };
      const pc = cur(a.currency || e.currency);
      const paidOn = isDate(a.paid_on) ? a.paid_on : todayIso();
      const fx = await getRate(paidOn);
      // сколько закрыто в валюте ожидаемой оплаты
      let covered = paid;
      if (pc !== e.currency) {
        if (!fx.rate) return { error: "нет курса — не могу пересчитать валюту. Задай курс вручную на вкладке «Обзор»" };
        covered = pc === "USD" ? paid * fx.rate : paid / fx.rate;
      }
      const left = Math.round((e.amount - covered) * 100) / 100;
      const { error } = await supabase.from("fin_entries").update({
        status: "done", amount: paid, currency: pc, rate: fx.rate || null, paid_on: paidOn, updated_at: new Date().toISOString(),
        note: [e.note, String(a.note || "").trim()].filter(Boolean).join(" · ") || null,
      }).eq("id", e.id);
      if (error) return { error: "не удалось сохранить: " + error.message };
      // остаток меньше 1% — округление/курсовая разница, хвост не плодим
      if (left > Math.abs(e.amount) * 0.01) {
        await supabase.from("fin_entries").insert({
          kind: "income", category: e.category, project_id: e.project_id, cycle: e.cycle, amount: left, currency: e.currency,
          rate: fx.rate || null, status: "planned", due_on: e.due_on, note: "Остаток после частичной оплаты", created_by: userId,
        });
      }
      return load(a.cycle);
    }

    // сдельное начисление без исполнителя (бот не смог понять, кто снимал/монтировал)
    case "fin_assign": {
      const { data: raw } = await supabase.from("fin_entries").select("*").eq("id", +a.id).maybeSingle();
      if (!raw) return { error: "запись не найдена" };
      const memberId = +a.memberId;
      if (!memberId) return { error: "выбери сотрудника" };
      const patch: any = { member_id: memberId, updated_at: new Date().toISOString() };
      if (!Number(raw.amount)) {
        const rule = rateFor(await rules(), memberId, raw.category, raw.project_id);
        if (rule) { patch.amount = rule.amount; patch.currency = rule.currency; }
      }
      const { error } = await supabase.from("fin_entries").update(patch).eq("id", raw.id);
      if (error) return { error: "не удалось сохранить: " + error.message };
      return load(a.cycle);
    }

    case "fin_terms_save": {
      const pid = +a.projectId;
      if (!pid) return { error: "нет проекта" };
      const f = a.fields || {};
      const schedule = ["prepay", "split", "post", "manual"].includes(f.schedule) ? f.schedule : "prepay";
      const c = currentCycle();
      const { data: old } = await supabase.from("fin_project_terms").select("*").eq("project_id", pid).maybeSingle();
      const { error } = await supabase.from("fin_project_terms").upsert({
        project_id: pid, fee: num(f.fee), currency: cur(f.currency), schedule, active: f.active !== false,
        start_cycle: old?.start_cycle || c, updated_at: new Date().toISOString(),
      }, { onConflict: "project_id" });
      if (error) return { error: "не удалось сохранить: " + error.message };
      // условия поменялись — ещё не оплаченные автоплатежи текущего цикла пересоздаём,
      // уже полученные деньги не трогаем
      const { data: pend } = await supabase.from("fin_entries").select("id").eq("project_id", pid).eq("cycle", c).eq("status", "planned").like("ref", `fee:${pid}:${c}:%`);
      const { data: paidAuto } = await supabase.from("fin_entries").select("id").eq("project_id", pid).eq("cycle", c).neq("status", "planned").like("ref", `fee:${pid}:${c}:%`);
      if (pend && pend.length && !(paidAuto && paidAuto.length)) {
        await supabase.from("fin_entries").delete().in("id", pend.map((x: any) => x.id));
      }
      return load(a.cycle);
    }

    case "fin_rule_save": {
      const f = a.fields || {};
      const kind = String(f.kind || "");
      if (!["salary", "project_fixed", ...PIECE_KINDS].includes(kind)) return { error: "неизвестный тип оплаты" };
      const memberId = +f.member_id;
      if (!memberId) return { error: "нет сотрудника" };
      const amount = num(f.amount);
      if (amount <= 0) return { error: "впиши сумму" };
      const projectId = f.project_id ? +f.project_id : null;
      if (kind === "project_fixed" && !projectId) return { error: "выбери проект" };
      const row = { member_id: memberId, kind, project_id: kind === "salary" ? null : projectId, amount, currency: cur(f.currency), title: String(f.title || "").trim() || null, active: true };
      let id = a.id ? +a.id : 0;
      if (id) {
        const { error } = await supabase.from("fin_pay_rules").update(row).eq("id", id);
        if (error) return { error: "не удалось сохранить: " + error.message };
        // поменяли оклад/фикс — начисление текущего цикла тоже обновляем
        if (kind === "salary" || kind === "project_fixed") {
          const ref = `${kind === "salary" ? "sal" : "pfx"}:${id}:${currentCycle()}`;
          await supabase.from("fin_entries").update({ amount, currency: row.currency, project_id: row.project_id, note: row.title, updated_at: new Date().toISOString() }).eq("ref", ref).neq("status", "void");
        }
      } else {
        const { data, error } = await supabase.from("fin_pay_rules").insert(row).select("id").single();
        if (error) return { error: "не удалось сохранить: " + error.message };
        id = (data as any).id;
      }
      return load(a.cycle);
    }

    case "fin_rule_delete": {
      const { error } = await supabase.from("fin_pay_rules").update({ active: false }).eq("id", +a.id);
      if (error) return { error: "не удалось удалить: " + error.message };
      return load(a.cycle);
    }

    case "fin_set_rate": {
      await setManualRate(num(a.rate));
      return load(a.cycle);
    }
  }
  return { error: "неизвестное действие" };
}

// расход по подписке: при покупке/продлении, если у подписки указана цена
export async function subscriptionExpense(sub: { id: number; app: string; price?: number | null; currency?: string | null }, paidOn: string, userId: number): Promise<void> {
  const price = Number(sub.price || 0);
  if (price <= 0) return;
  try {
    const fx = await getRate(paidOn);
    await insertAuto([{
      kind: "expense", category: "subs", cycle: cycleOf(paidOn), amount: price, currency: cur(sub.currency), rate: fx.rate || null,
      status: "done", paid_on: paidOn, note: `Подписка: ${sub.app}`, ref: `sub:${sub.id}:${paidOn}`, created_by: userId,
    }]);
  } catch (e) { console.error("finance subscriptionExpense", e); }
}

// для крона: ожидаемые оплаты клиентов, срок которых наступил
export async function dueClientPayments(today: string): Promise<{ project: string; amount: number; currency: string; due_on: string; overdue: boolean }[]> {
  const { data, error } = await supabase.from("fin_entries").select("*").eq("kind", "income").eq("status", "planned").lte("due_on", today).order("due_on");
  if (error) return [];
  const projects = await d2.getProjects();
  const name = new Map(projects.map((p) => [p.id, p.name]));
  return ((data as any[]) ?? []).map((e) => ({ project: (e.project_id && name.get(e.project_id)) || "Без проекта", amount: Number(e.amount), currency: e.currency, due_on: e.due_on, overdue: e.due_on < today }));
}
