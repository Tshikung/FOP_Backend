import { Router } from "express";
import { z } from "zod";
import { query, tx } from "../config/db.js";
import { validate } from "../middleware/validate.js";
import { requirePermission } from "../middleware/auth.js";
import { notFound } from "../utils/httpError.js";
import { pageQuery, pg, finish } from "../utils/paging.js";
import { audit } from "../services/audit.js";

export const adminFlagsRouter = Router(); // mounted at /admin/flags

const commentParam = z.object({ commentId: z.coerce.number().int().positive() });

// One row per reported comment, with every reason that was given
adminFlagsRouter.get("/", requirePermission("moderation.review"), validate({ query: z.object(pageQuery) }), async (req, res) => {
  const p = pg(req.valid.query);
  const rows = await query(
    `SELECT c.id AS comment_id, c.body, c.created_at AS comment_at, au.id AS author_id, au.display_name AS author_name,
            ci.id AS content_id, ci.title AS content_title, ci.type AS content_type,
            COUNT(f.id) AS reports, GROUP_CONCAT(DISTINCT f.reason ORDER BY f.reason) AS reasons, MAX(f.created_at) AS last_reported_at
       FROM flags f
       JOIN comments c ON c.id = f.comment_id
       JOIN users au ON au.id = c.user_id
       JOIN content_items ci ON ci.id = c.content_id
      WHERE f.status = 'open' AND c.status = 'visible'
      GROUP BY c.id, c.body, c.created_at, au.id, au.display_name, ci.id, ci.title, ci.type
      ORDER BY last_reported_at DESC LIMIT ? OFFSET ?`,
    [p.limit, p.offset],
  );
  res.json(finish(rows.map((r) => ({ ...r, reasons: r.reasons.split(",") })), p));
});

// Keep = the comment stays. Remove = the comment is hidden. Either way every open report on it is closed.
function resolve(verdict) {
  return async (req, res) => {
    const { commentId } = req.valid.params;
    await tx(async (t) => {
      const r = await t.query(
        "UPDATE flags SET status = ?, resolved_by = ?, resolved_at = UTC_TIMESTAMP() WHERE comment_id = ? AND status = 'open'",
        [verdict, req.user.id, commentId],
      );
      if (r.affectedRows === 0) throw notFound("Report");
      if (verdict === "removed") await t.query("UPDATE comments SET status = 'removed' WHERE id = ?", [commentId]);
      await audit(req, `moderation.${verdict}`, "comment", commentId, null, t.query);
    });
    res.json({ ok: true });
  };
}

adminFlagsRouter.post("/:commentId/keep", requirePermission("moderation.review"), validate({ params: commentParam }), resolve("kept"));
adminFlagsRouter.post("/:commentId/remove", requirePermission("moderation.review"), validate({ params: commentParam }), resolve("removed"));
