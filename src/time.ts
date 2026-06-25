// Работа со временем. Команда в часовом поясе Asia/Tashkent (UTC+5, без перехода).
// Дедлайны храним в БД в UTC (ISO), показываем и вводим в локальном времени.

const OFFSET_MS = 5 * 60 * 60 * 1000; // UTC+5

function pad(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

// Быстрые варианты дедлайна -> UTC Date | null
export function quickDeadline(code: string): Date | null {
  if (code === "none") return null;
  const nowLocal = new Date(Date.now() + OFFSET_MS); // «настенное» локальное время как UTC-числа
  const d = new Date(nowLocal);
  if (code === "tomorrow") d.setUTCDate(d.getUTCDate() + 1);
  else if (code === "3d") d.setUTCDate(d.getUTCDate() + 3);
  else if (code === "week") d.setUTCDate(d.getUTCDate() + 7);
  d.setUTCHours(18, 0, 0, 0); // 18:00 локального времени
  return new Date(d.getTime() - OFFSET_MS); // обратно в реальный UTC
}

// Парсинг "ДД.ММ.ГГГГ ЧЧ:ММ" в локальном времени -> UTC Date | null
export function parseCustomDeadline(text: string): Date | null {
  const m = text.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min] = m;
  const localMs = Date.UTC(+yyyy, +mm - 1, +dd, +hh, +min, 0, 0);
  if (Number.isNaN(localMs)) return null;
  return new Date(localMs - OFFSET_MS);
}

// Форматирование UTC ISO -> локальная строка "ДД.ММ.ГГГГ ЧЧ:ММ"
export function formatLocal(isoUtc: string | null): string {
  if (!isoUtc) return "";
  const local = new Date(new Date(isoUtc).getTime() + OFFSET_MS);
  return `${pad(local.getUTCDate())}.${pad(local.getUTCMonth() + 1)}.${local.getUTCFullYear()} ${pad(
    local.getUTCHours()
  )}:${pad(local.getUTCMinutes())}`;
}
