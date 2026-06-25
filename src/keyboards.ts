import { InlineKeyboard } from "grammy";
import { t, Lang } from "./i18n";
import { Member } from "./db";

export function langKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🇷🇺 Русский", "lang:ru").text("🇺🇿 O'zbekcha", "lang:uz");
}

export function skipKeyboard(lang: Lang): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, "nt_skip"), "nt_skipdesc");
}

export function assigneeKeyboard(members: Member[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  members.forEach((m, i) => {
    const label = m.name || m.username || String(m.telegram_id);
    kb.text(label, `nt_assignee:${m.telegram_id}`);
    if (i % 2 === 1) kb.row();
  });
  return kb;
}

export function deadlineKeyboard(lang: Lang): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang, "nt_deadline_today"), "nt_dl:today")
    .text(t(lang, "nt_deadline_tomorrow"), "nt_dl:tomorrow")
    .row()
    .text(t(lang, "nt_deadline_3d"), "nt_dl:3d")
    .text(t(lang, "nt_deadline_week"), "nt_dl:week")
    .row()
    .text(t(lang, "nt_deadline_custom"), "nt_dl:custom")
    .text(t(lang, "nt_deadline_none"), "nt_dl:none");
}

export function priorityKeyboard(lang: Lang): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang, "prio_low"), "nt_prio:low")
    .text(t(lang, "prio_normal"), "nt_prio:normal")
    .text(t(lang, "prio_high"), "nt_prio:high");
}

export function taskCardKeyboard(taskId: number, lang: Lang, status: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (status === "new" || status === "paused") {
    kb.text(t(lang, "btn_take"), `ts:take:${taskId}`);
  }
  if (status !== "done" && status !== "cancelled") {
    kb.text(t(lang, "btn_done"), `ts:done:${taskId}`);
  }
  kb.text(t(lang, "btn_info"), `ts:info:${taskId}`);
  return kb;
}
