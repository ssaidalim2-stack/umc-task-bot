import type { VercelRequest, VercelResponse } from "@vercel/node";
import { validateInitData, getData, doAction } from "../src/webapp";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const initData = (req.headers["x-init-data"] as string) || (req.body && req.body.initData) || "";
  const v = validateInitData(initData);
  if (!v.ok || !v.user?.id) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const userId = Number(v.user.id);
  try {
    if (req.method === "POST") {
      const data = await doAction(userId, req.body || {});
      res.status(200).json(data);
    } else {
      const data = await getData(userId);
      res.status(200).json(data);
    }
  } catch (e: any) {
    console.error("app api error", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
}
