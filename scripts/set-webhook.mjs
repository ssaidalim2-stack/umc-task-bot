// Установка Telegram webhook.
// Запуск (если есть Node):  BOT_TOKEN=... APP_URL=https://xxx.vercel.app WEBHOOK_SECRET=... node scripts/set-webhook.mjs
// Без Node можно просто открыть в браузере ссылку из README (раздел 5).

const token = process.env.BOT_TOKEN;
const appUrl = process.env.APP_URL;
const secret = process.env.WEBHOOK_SECRET || "";

if (!token || !appUrl) {
  console.error("Нужны переменные BOT_TOKEN и APP_URL");
  process.exit(1);
}

const url = `${appUrl.replace(/\/$/, "")}/api/bot`;
const api = `https://api.telegram.org/bot${token}/setWebhook`;

const res = await fetch(api, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url, secret_token: secret, allowed_updates: ["message", "callback_query"] }),
});
const data = await res.json();
console.log(JSON.stringify(data, null, 2));
