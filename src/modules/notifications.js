import { Router } from "express";
import { z } from "zod";
import { query, one } from "../config/db.js";
import { validate, idParam } from "../middleware/validate.js";
import { pageQuery, pg, finish } from "../utils/paging.js";

export const notificationsRouter = Router(); // used by both portals

notificationsRouter.get(
  "/notifications",
  validate({ query: z.object({ unread: z.enum(["1", "0"]).optional(), ...pageQuery }) }),
  async (req, res) => {
    const p = pg(req.valid.query);
    const rows = await query(
      `SELECT id, type, title, body, ref_type, ref_id, is_read, created_at FROM notifications
        WHERE user_id = ? ${req.valid.query.unread === "1" ? "AND is_read = 0" : ""}
        ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [req.user.id, p.limit, p.offset],
    );
    res.json(finish(rows, p));
  },
);

notificationsRouter.get("/notifications/unread-count", async (req, res) => {
  const r = await one("SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0", [req.user.id]);
  res.json({ count: r.count });
});

notificationsRouter.post("/notifications/read-all", async (req, res) => {
  await query("UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0", [req.user.id]);
  res.json({ ok: true });
});

notificationsRouter.patch("/notifications/:id/read", validate({ params: idParam }), async (req, res) => {
  await query("UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?", [req.valid.params.id, req.user.id]);
  res.json({ ok: true });
});
