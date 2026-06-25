import type { VercelRequest, VercelResponse } from "@vercel/node";
import { bot, ensureInit } from "../src/bot";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(200).send("Bot webhook is alive");
    return;
  }

  // Проверка секрета Telegram webhook
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).send("unauthorized");
    return;
  }

  try {
    await ensureInit();
    await bot.handleUpdate(req.body);
  } catch (e) {
    console.error("handleUpdate error", e);
  }
  // Telegram всегда ждёт 200, иначе будет повторять апдейт
  res.status(200).send("ok");
}
