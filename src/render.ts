import { t, Lang } from "./i18n";
import { Task, Member } from "./db";
import { formatLocal } from "./time";

const STATUS_KEY: Record<string, string> = {
  new: "status_new",
  in_progress: "status_in_progress",
  done: "status_done",
  paused: "status_paused",
  cancelled: "status_cancelled",
};

const PRIO_KEY: Record<string, string> = {
  low: "prio_low",
  normal: "prio_normal",
  high: "prio_high",
};

export function statusLabel(lang: Lang, status: string): string {
  return t(lang, STATUS_KEY[status] || "status_new");
}

export function renderCard(lang: Lang, task: Task, assignee: Member | null): string {
  const assigneeName = assignee?.name || assignee?.username || String(task.assignee_id);
  const lines = [
    t(lang, "card_title", { id: task.id }),
    t(lang, "card_field_title", { title: task.title }),
  ];
  if (task.description) lines.push(t(lang, "card_field_desc", { desc: task.description }));
  lines.push(t(lang, "card_field_assignee", { assignee: assigneeName }));
  lines.push(
    task.deadline
      ? t(lang, "card_field_deadline", { deadline: formatLocal(task.deadline) })
      : t(lang, "card_field_no_deadline")
  );
  lines.push(t(lang, "card_field_priority", { priority: t(lang, PRIO_KEY[task.priority] || "prio_normal") }));
  lines.push(t(lang, "card_field_status", { status: statusLabel(lang, task.status) }));
  return lines.join("\n");
}

export function renderTaskLine(lang: Lang, task: Task, assignee: Member | null): string {
  const assigneeName = assignee?.name || assignee?.username || String(task.assignee_id);
  return t(lang, "task_line", {
    id: task.id,
    status: statusLabel(lang, task.status),
    title: task.title,
    assignee: assigneeName,
    deadline: task.deadline ? `(${formatLocal(task.deadline)})` : "",
  });
}
