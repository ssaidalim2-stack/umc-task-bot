import ru from "./locales/ru.json";
import uz from "./locales/uz.json";

export type Lang = "ru" | "uz";

const dict: Record<Lang, Record<string, string>> = { ru, uz };

export function t(lang: Lang | string | undefined, key: string, vars?: Record<string, string | number>): string {
  const l: Lang = lang === "uz" ? "uz" : "ru";
  let s = dict[l][key] ?? dict.ru[key] ?? key;
  if (vars) {
    for (const k of Object.keys(vars)) {
      s = s.split(`{${k}}`).join(String(vars[k]));
    }
  }
  return s;
}
