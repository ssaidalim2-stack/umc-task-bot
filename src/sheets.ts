import * as d2 from "./db2";

// gid вкладки контент-плана (июнь–июль) по проекту. Видео-формат со столбцом «статус».
const SHEET_TABS: Record<string, string> = {
  mystep: "214756604",
  entrium: "270345291",
  // ryan / sevencore / cargogpt — другой формат вкладок, подключим позже
};

const STAGE_ORDER = ["idea", "script", "shoot", "edit", "published"];
function stageIdx(s: string): number { return STAGE_ORDER.indexOf(s); }

function mapStatus(text: string): string | null {
  const t = (text || "").toLowerCase();
  if (/опублик|выложен|posted|postga|chiqdi/.test(t)) return "published";
  if (/монтаж|смонтир|montaj|edited/.test(t)) return "edit";
  if (/снят|снято|suratga|shot/.test(t)) return "shoot";
  return null;
}

// CSV-парсер с поддержкой кавычек и переносов строк внутри ячеек
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (c === "\r") { /* skip */ }
      else cur += c;
    }
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function extractSpreadsheetId(url: string): string | null {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// Синхронизация статусов видео из Google-таблиц. Только продвигает вперёд.
export async function syncFromSheets(): Promise<{ text: string; advanced: number }> {
  const projects = await d2.getProjects();
  const lines: string[] = [];
  let totalAdvanced = 0;

  for (const p of projects) {
    const gid = SHEET_TABS[p.key];
    if (!gid) continue;
    const plan = await d2.getActivePlan(p.id);
    if (!plan?.sheet_url) continue;
    const id = extractSpreadsheetId(plan.sheet_url);
    if (!id) continue;

    let csv: string;
    try {
      const r = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`);
      csv = await r.text();
    } catch (e) { lines.push(`${p.name}: ошибка загрузки таблицы`); continue; }

    const rows = parseCSV(csv);
    // найти строку-заголовок со столбцом «статус»
    let headerRow = -1, statusCol = -1;
    for (let i = 0; i < Math.min(rows.length, 6); i++) {
      const ci = rows[i].findIndex((c) => /статус|status/i.test(c || ""));
      if (ci >= 0) { headerRow = i; statusCol = ci; break; }
    }
    if (headerRow < 0) { lines.push(`${p.name}: столбец «статус» не найден`); continue; }

    const items = (await d2.listItems(p.id, "video")).sort((a, b) => a.idx - b.idx);
    let vi = 0, advanced = 0;
    for (let i = headerRow + 1; i < rows.length && vi < items.length; i++) {
      const row = rows[i];
      const isVideo = (row[0] || "").trim() || (row[1] || "").trim();
      if (!isVideo) continue;
      const item = items[vi]; vi++;
      const stage = mapStatus(row[statusCol] || "");
      if (stage && stageIdx(stage) > stageIdx(item.stage)) {
        await d2.updateItem(item.id, { stage, status: stage === "published" ? "done" : "in_progress" });
        advanced++;
      }
    }
    totalAdvanced += advanced;
    lines.push(`${p.name}: обработано ${vi} видео, обновлено ${advanced}`);
  }

  return { text: lines.length ? "🔄 Синхронизация из таблиц:\n" + lines.join("\n") : "Нет подключённых таблиц для синка.", advanced: totalAdvanced };
}
