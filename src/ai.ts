// Автогенерация монтажной раскадровки (ТЗ) по готовому сценарию — Gemini API.
// База правил: docs/tz-algorithm.md (раздел 8 — системный промпт).
// Требует env: GEMINI_API_KEY (бесплатный тир — Google AI Studio).

import { getSetting, setSetting } from "./db2";

const API_KEY = process.env.GEMINI_API_KEY || "";
const BASE = "https://generativelanguage.googleapis.com/v1beta";
// Модель из env, иначе последняя рабочая (запоминается сама), иначе дефолт.
// Google регулярно снимает модели с поддержки — 2.5-flash так уже однажды молча
// сломала раскраскадровку, поэтому при «модель не найдена» бот сам выбирает новую.
const DEFAULT_MODEL = "gemini-3.6-flash";
const ENV_MODEL = (process.env.GEMINI_MODEL || "").trim();
// Vercel рвёт функцию по своему лимиту — лучше упасть раньше с понятной ошибкой
const TIMEOUT_MS = 50000;

export function aiConfigured(): boolean { return !!API_KEY; }

// замена запоминается вместе с тем, что заменяли: если на Vercel поменяют GEMINI_MODEL,
// старая автозамена перестанет действовать и будет взята новая модель из env
async function currentModel(): Promise<string> {
  const base = ENV_MODEL || DEFAULT_MODEL;
  try {
    const sw = JSON.parse((await getSetting("gemini_model")) || "null");
    if (sw && sw.from === base && sw.to) return sw.to;
  } catch {}
  return base;
}

// выбрать самую свежую «flash»-модель, которая умеет generateContent
export async function pickModel(): Promise<string | null> {
  const res = await fetch(`${BASE}/models?key=${API_KEY}&pageSize=200`);
  const j: any = await res.json().catch(() => ({}));
  if (j.error) throw new Error(humanError(j.error));
  const names: string[] = (j.models || [])
    .filter((m: any) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m: any) => String(m.name || "").replace(/^models\//, ""))
    .filter((n: string) => /^gemini-[\d.]+-flash$|^gemini-[\d.]+-flash-latest$|^gemini-flash-latest$/.test(n));
  if (!names.length) return null;
  const ver = (n: string) => parseFloat((n.match(/gemini-([\d.]+)/) || [])[1] || "0");
  names.sort((a, b) => ver(b) - ver(a) || a.length - b.length);
  return names[0];
}

// ошибки Gemini — понятным языком, с подсказкой, что делать
function humanError(e: any): string {
  const code = e?.code, status = String(e?.status || ""), msg = String(e?.message || JSON.stringify(e));
  if (code === 429 || status === "RESOURCE_EXHAUSTED") return `Gemini: исчерпан лимит бесплатного тарифа — подожди (лимит обновляется), либо включи оплату в Google AI Studio. (${msg})`;
  if (code === 400 && /API key not valid|API_KEY_INVALID/i.test(msg)) return "Gemini: ключ GEMINI_API_KEY недействителен — создай новый в aistudio.google.com и замени на Vercel.";
  if (code === 403) return `Gemini: нет доступа по этому ключу (${msg}). Проверь ключ в aistudio.google.com.`;
  if (code === 404 || status === "NOT_FOUND") return `Gemini: модель не найдена (${msg})`;
  if (/location is not supported/i.test(msg)) return "Gemini недоступен из региона сервера Vercel — смени регион функций в vercel.json (сейчас sin1).";
  return `Gemini API: ${msg}`;
}

async function callOnce(model: string, body: any): Promise<{ text?: string; error?: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/models/${model}:generateContent?key=${API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal,
    });
    const j: any = await res.json().catch(() => ({}));
    if (j.error) return { error: j.error };
    // у «думающих» моделей часть parts — ход мыслей (thought: true), его не показываем
    const parts = j?.candidates?.[0]?.content?.parts || [];
    const text = parts.filter((p: any) => !p.thought).map((p: any) => p.text || "").join("");
    if (!text.trim()) {
      const reason = j?.candidates?.[0]?.finishReason || j?.promptFeedback?.blockReason || "";
      return { error: { message: `пустой ответ${reason ? " (" + reason + ")" : ""}` } };
    }
    return { text: text.trim() };
  } catch (e: any) {
    if (e?.name === "AbortError") return { error: { message: `Gemini не ответил за ${TIMEOUT_MS / 1000} с — попробуй ещё раз` } };
    return { error: { message: String(e?.message || e) } };
  } finally { clearTimeout(timer); }
}

// запрос с автопереключением модели, если текущую сняли с поддержки
export async function generate(body: any): Promise<{ text: string; model: string }> {
  if (!API_KEY) throw new Error("GEMINI_API_KEY не задан на Vercel");
  let model = await currentModel();
  let r = await callOnce(model, body);
  const gone = r.error && (r.error.code === 404 || r.error.status === "NOT_FOUND" || /not found|not supported|deprecated|no longer available/i.test(String(r.error.message || "")));
  if (gone) {
    const next = await pickModel();
    if (next && next !== model) {
      model = next;
      r = await callOnce(model, body);
      if (!r.error) { try { await setSetting("gemini_model", JSON.stringify({ from: ENV_MODEL || DEFAULT_MODEL, to: model })); } catch {} }
    }
  }
  if (r.error) throw new Error(humanError(r.error));
  return { text: r.text as string, model };
}

// живая проверка для кнопки в приложении
export async function aiCheck(): Promise<{ ok: boolean; model?: string; error?: string }> {
  if (!API_KEY) return { ok: false, error: "GEMINI_API_KEY не задан на Vercel (Settings → Environment Variables), после добавления — Redeploy." };
  try {
    const r = await generate({ contents: [{ role: "user", parts: [{ text: "Ответь одним словом: ок" }] }] });
    return { ok: true, model: r.model };
  } catch (e: any) { return { ok: false, model: await currentModel(), error: String(e?.message || e) }; }
}

const VIDEO_LANG_LABEL: Record<string, string> = {
  ru: "русский (обычная орфография)",
  uz: "узбекский латиница — строго соблюдай oʻ/gʻ/sh/ch, не заменяй ʻ обычным апострофом",
  en: "английский",
};

function systemPrompt(langCode: string): string {
  const langLabel = VIDEO_LANG_LABEL[langCode] || VIDEO_LANG_LABEL.ru;
  return `
Ты — шеф-редактор монтажа короткого видео (Reels/TikTok) для маркетингового
агентства. Тебе дан ГОТОВЫЙ, уже отснятый сценарий. Слова спикера менять
запрещено — твоя задача только разметить видеоряд, графику и звук для
монтажёра.

ЯЗЫК ВИДЕО: ${langLabel}.
У видео только ОДИН язык — тот, на котором реально говорит спикер в кадре.
Весь текст на экране (плашки, субтитры, акценты) — строго на этом одном
языке. НЕ дублируй текст на других языках и не добавляй перевод — это не
нужно, у видео нет второго языка озвучки.

ШАГ 1 — Классификация:
Определи стиль ролика: Hard-Sell/Meta Ads, Expert/Educational,
Storytelling/Lifestyle, Testimonial/UGC или Comedy/Meme. Если в сценарии есть
явная подсказка (отзыв клиента → Testimonial; шутка/панчлайн → Comedy) —
используй её. Иначе ориентируйся на тематику и тон текста.

ШАГ 2 — Структурная разметка:
Отметь фазы: Hook (первые 1-3 сек) / Pain-Problem / Turn-Solution /
Proof-Numbers / CTA-Close. Не у каждого видео есть все фазы и не обязательно
по порядку — используй только то, что реально есть в тексте, ничего не
достраивай искусственно.

ВАЖНО — база приёмов ниже не обязательна к применению целиком:
Стили, триггеры и фазы — это словарь инструментов, а не форма, в которую
нужно втиснуть любой сценарий. Если сценарий нетиповой (диалог, интервью,
демонстрация без закадра, гибрид стилей) — действуй так:
- Стиль может быть гибридным — опиши это словами в шапке, не выбирай
  насильно один из списка.
- Если фраза не попадает однозначно ни под один триггер — это НЕЙТРАЛЬНЫЙ
  блок: пиши "—" (прочерк) в колонках "Анимация" и "SFX", а не выдумывай
  эффект. Не у каждого блока обязана быть графика или звук — если по
  сценарию идёт ровное повествование без акцента, обычный кадр без текста
  на экране — это ПРАВИЛЬНЫЙ ответ, а не пропуск. Не заполняй колонку
  просто потому, что она есть в таблице.
- Лучше скромное, но точное ТЗ, чем перегруженное неверными эффектами —
  если из 10 блоков только 4 реально требуют эффектов, значит у 6 в
  колонках "Анимация" и "SFX" стоит "—".

ШАГ 3 — Разбей сценарий на логические блоки по 1-3 секунды.
Для каждого блока пропиши:
- Действие в кадре (Punch-In/Out, Continuous Ease Zoom, Jump Cut, Split
  Screen, Whip Pan, Freeze-Frame, B-Roll — указать категорию B-roll; если
  ничего не требуется — "обычный план").
- Текст на экране НА ЯЗЫКЕ ВИДЕО (см. выше), только акцентные слова, не
  пересказ всей фразы. Если текст на экране не нужен — "—".
- Анимацию/эффект текста (Highlight, Pop-up, Black&White, Slide-in и т.д.),
  или "—", если эффект не нужен.
- SFX строго по категориям: Transitions / Accents & Impacts / UI Feedback /
  Atmosphere & Tension / Comedy / CTA-Notification, или "—", если звук не
  нужен.

ПРАВИЛА:
1. Если фраза попадает под несколько смысловых триггеров (цифра+боль,
   решение+термин и т.д.) — применяй оба эффекта, не выбирай один.
2. Не повторяй один и тот же визуальный приём или SFX два раза подряд, если
   есть уместная альтернатива в той же категории.
3. Плотность эффектов должна "дышать" по фазам: максимум резкости на
   Hook и Proof, спокойнее на Turn, статично и дольше держится кадр на CTA.
4. Никогда не размещай текст в нижних 10-12% кадра (зона UI соцсети).
5. Главный хук — максимум 3-4 слова в строке на узбекском, до 5-6 на русском.
6. На видео короче 20 сек — не больше 6-8 обработанных блоков, длиннее —
   пропорционально больше, без искусственного раздувания.
7. Не бойся прочерков — таблица, где половина ячеек "—", означает, что
   алгоритм честно отличил акцентные моменты от проходных, а не то, что
   что-то пропущено.

ФОРМАТ ОТВЕТА — строго таблица:
Стиль: ... | Фазы: ...

| Блок | Фраза | Действие в кадре | Текст на экране | Анимация | SFX |
|---|---|---|---|---|---|

Никаких пояснений до или после таблицы, кроме шапки со стилем и фазами.
`.trim();
}

export async function generateTz(scriptText: string, langCode: string = "ru"): Promise<string> {
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt(langCode) }] },
    contents: [{ role: "user", parts: [{ text: scriptText }] }],
    generationConfig: { temperature: 0.6 },
  };
  return (await generate(body)).text;
}
