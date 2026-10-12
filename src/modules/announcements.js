import { Router } from "express";
import { z } from "zod";
import { query, tx } from "../config/db.js";
import { validate, } from "../middleware/validate.js";
import { requirePermission } from "../middleware/auth.js";
import { pageQuery, pg, finish } from "../utils/paging.js";
import { fanOut } from "../services/notify.js";
import { audit } from "../services/audit.js";

export const adminAnnouncementsRouter = Router(); // mounted at /admin/announcements

// Any mentor can read what was sent
adminAnnouncementsRouter.get("/", validate({ query: z.object(pageQuery) }), async (req, res) => {
  const p = pg(req.valid.query);
  const rows = await query(
    `SELECT a.id, a.title, a.body, a.audience, a.sent_at, u.display_name AS sent_by_name,
            (SELECT COUNT(*) FROM notifications n WHERE n.announcement_id = a.id) AS recipients
       FROM announcements a LEFT JOIN users u ON u.id = a.sent_by
      ORDER BY a.sent_at DESC, a.id DESC LIMIT ? OFFSET ?`,
    [p.limit, p.offset],
  );
  res.json(finish(rows, p));
});

// Only a Head admin can send. Each person in the audience gets a notification.
adminAnnouncementsRouter.post(
  "/",
  requirePermission("announcements.send"),
  validate({
    body: z.object({
      title: z.string().trim().min(3).max(200),
      body: z.string().trim().min(3).max(5000),
      audience: z.enum(["all", "beginners", "intermediate_up", "mentors"]).default("all"),
    }),
  }),
  async (req, res) => {
    const b = req.valid.body;
    const result = await tx(async (t) => {
      const r = await t.query("INSERT INTO announcements (title, body, audience, sent_by) VALUES (?, ?, ?, ?)", [b.title, b.body, b.audience, req.user.id]);
      const recipients = await fanOut(t.query, b.audience, {
        type: "announcement", title: b.title, body: b.body.slice(0, 500), refType: "announcement", refId: r.insertId, announcementId: r.insertId,
      });
      await audit(req, "announcement.send", "announcement", r.insertId, { audience: b.audience, recipients }, t.query);
      return { id: r.insertId, recipients };
    });
    res.status(201).json(result);
  },
);
