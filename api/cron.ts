import type { VercelRequest, VercelResponse } from "@vercel/node";
import { runReminders } from "../src/cron";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Защита: либо заголовок Vercel Cron, либо наш секрет в query/заголовке
  // без заданного CRON_SECRET не пускаем никого (раньше проходил заголовок «Bearer undefined»)
  const secret = process.env.CRON_SECRET || "";
  const auth = (req.headers["authorization"] as string) || "";
  const querySecret = (req.query.secret as string) || "";
  const headerSecret = (req.headers["x-cron-secret"] as string) || "";
  const ok = !!secret && (auth === `Bearer ${secret}` || querySecret === secret || headerSecret === secret);

  if (!ok) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    const result = await runReminders();
    res.status(200).json({ ok: true, ...result });
  } catch (e: any) {
    console.error("cron error", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
