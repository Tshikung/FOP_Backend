import { Router } from "express";
import { z } from "zod";
import { query, one } from "../config/db.js";
import { validate, idParam } from "../middleware/validate.js";
import { isStaff } from "../middleware/auth.js";
import { badRequest, dupAs, forbidden, notFound } from "../utils/httpError.js";
import { getSettings } from "../services/settings.js";
import { recordActivity } from "../services/progress.js";

export const commentsRouter = Router();

async function visibleContent(user, id) {
  const c = await one("SELECT id, status FROM content_items WHERE id = ? AND deleted_at IS NULL", [id]);
  if (!c || (c.status !== "published" && !isStaff(user))) throw notFound("Item");
  return c;
}

commentsRouter.get("/content/:id/comments", validate({ params: idParam }), async (req, res) => {
  await visibleContent(req.user, req.valid.params.id);
  const rows = await query(
    `SELECT c.id, c.parent_id, c.body, c.created_at, c.user_id,
            u.display_name AS author_name, u.username AS author_username, u.avatar_url AS author_avatar, u.role AS author_role,
            (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id) AS like_count,
            EXISTS(SELECT 1 FROM comment_likes cl WHERE cl.comment_id = c.id AND cl.user_id = ?) AS liked
       FROM comments c JOIN users u ON u.id = c.user_id
      WHERE c.content_id = ? AND c.status = 'visible' ORDER BY c.created_at, c.id`,
    [req.user.id, req.valid.params.id],
  );
  res.json({ items: rows });
});

commentsRouter.post(
  "/content/:id/comments",
  validate({ params: idParam, body: z.object({ body: z.string().trim().min(1, "Write a comment first").max(2000), parentId: z.number().int().positive().optional() }) }),
  async (req, res) => {
    const content = await visibleContent(req.user, req.valid.params.id);
    if (!(await getSettings()).allow_comments) throw forbidden("Comments are turned off right now");
    const { body, parentId } = req.valid.body;
    if (parentId) {
      const parent = await one("SELECT id FROM comments WHERE id = ? AND content_id = ? AND status = 'visible'", [parentId, content.id]);
      if (!parent) throw badRequest("The comment you are replying to no longer exists");
    }
    const r = await query("INSERT INTO comments (content_id, user_id, parent_id, body) VALUES (?, ?, ?, ?)", [
      content.id, req.user.id, parentId ?? null, body,
    ]);
    await recordActivity(req.user.id);
    res.status(201).json({ id: r.insertId });
  },
);

commentsRouter.post("/comments/:id/like", validate({ params: idParam }), async (req, res) => {
  const c = await one("SELECT id FROM comments WHERE id = ? AND status = 'visible'", [req.valid.params.id]);
  if (!c) throw notFound("Comment");
  await query("INSERT IGNORE INTO comment_likes (user_id, comment_id) VALUES (?, ?)", [req.user.id, c.id]);
  res.json({ ok: true });
});
commentsRouter.delete("/comments/:id/like", validate({ params: idParam }), async (req, res) => {
  await query("DELETE FROM comment_likes WHERE user_id = ? AND comment_id = ?", [req.user.id, req.valid.params.id]);
  res.json({ ok: true });
});

commentsRouter.post(
  "/comments/:id/flag",
  validate({
    params: idParam,
    body: z.object({ reason: z.enum(["spam", "unkind", "inappropriate", "other"]), details: z.string().trim().max(500).optional() }),
  }),
  async (req, res) => {
    const c = await one("SELECT id, user_id FROM comments WHERE id = ? AND status = 'visible'", [req.valid.params.id]);
    if (!c) throw notFound("Comment");
    if (c.user_id === req.user.id) throw badRequest("You cannot report your own comment");
    await dupAs("You already reported this comment", () =>
      query("INSERT INTO flags (comment_id, reporter_id, reason, details) VALUES (?, ?, ?, ?)", [
        c.id, req.user.id, req.valid.body.reason, req.valid.body.details ?? null,
      ]),
    );
    res.status(201).json({ ok: true });
  },
);
