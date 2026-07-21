// Константы предметной области: этапы видео, ответственные, спец-резолвер.

export const VIDEO_STAGES = ["idea", "script", "shoot", "edit", "published"] as const;
export type VideoStage = (typeof VIDEO_STAGES)[number];

export const STAGE_LABEL: Record<string, string> = {
  idea: "💡 Идея",
  script: "📝 Сценарий",
  shoot: "🎥 Съёмка",
  edit: "✂️ Монтаж",
  published: "✅ Опубликовано",
  todo: "⏳ В работе",
  done: "✅ Готово",
};

// Кто отвечает за этап — по РОЛИ (не по имени), чтобы смена состава команды не ломала уведомления
export const STAGE_OWNER_ROLES: Record<string, string[]> = {
  idea: ["admin", "manager"],
  script: ["admin", "manager"],
  shoot: ["videographer"],
  edit: ["editor"],
  published: ["admin", "manager"],
};

// Ключевые слова для сопоставления имени-якоря с участником в БД
export const PERSON_KEYWORDS: Record<string, string[]> = {
  Саид: ["said", "саид", "saidkarim", "саидкарим"],
  Бобур: ["bob", "боб", "bobur", "бобур", "бобр"],
  Самандар: ["saman", "саманд", "samandar", "самандар"],
  Асрор: ["asror", "асрор"],
  Владимир: ["vlad", "влад", "vladimir", "владимир"],
};

export function nextStage(stage: string): VideoStage | null {
  const i = VIDEO_STAGES.indexOf(stage as VideoStage);
  if (i < 0 || i >= VIDEO_STAGES.length - 1) return null;
  return VIDEO_STAGES[i + 1];
}

export const APPS = ["CapCut", "Kling AI", "Claude", "ElevenLabs", "Canva"];
