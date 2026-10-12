import { Router } from "express";
import { z } from "zod";
import { query } from "../config/db.js";
import { validate, idParam } from "../middleware/validate.js";
import { requirePermission } from "../middleware/auth.js";
import { notFound } from "../utils/httpError.js";
import { pageQuery, pg, finish, like } from "../utils/paging.js";
import { revokeRefreshTokens } from "../services/session.js";
import { audit } from "../services/audit.js";

export const adminMembersRouter = Router(); // mounted at /admin/members

adminMembersRouter.get(
  "/",
  validate({ query: z.object({ q: z.string().trim().max(100).optional(), status: z.enum(["active", "invited", "suspended"]).optional(), ...pageQuery }) }),
  async (req, res) => {
    const f = req.valid.query;
    const p = pg(f);
    const where = ["u.role = 'member'"], params = [];
    if (f.status) { where.push("u.status = ?"); params.push(f.status); }
    if (f.q) { where.push("(u.display_name LIKE ? OR u.email LIKE ?)"); params.push(like(f.q), like(f.q)); }
    const rows = await query(
      `SELECT u.id, u.display_name, u.email, u.username, u.avatar_url, u.experience_level, u.status, u.created_at, u.last_login_at,
              (SELECT lp.title FROM path_enrollments pe JOIN learning_paths lp ON lp.id = pe.path_id
                WHERE pe.user_id = u.id ORDER BY pe.started_at DESC LIMIT 1) AS path
         FROM users u WHERE ${where.join(" AND ")} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
      [...params, p.limit, p.offset],
    );
    res.json(finish(rows, p));
  },
);

adminMembersRouter.patch(
  "/:id/status",
  requirePermission("members.manage"),
  validate({ params: idParam, body: z.object({ status: z.enum(["active", "suspended"]) }) }),
  async (req, res) => {
    const { id } = req.valid.params;
    const { status } = req.valid.body;
    const r = await query("UPDATE users SET status = ? WHERE id = ? AND role = 'member' AND status IN ('active', 'suspended')", [status, id]);
    if (r.affectedRows === 0) throw notFound("Member");
    if (status === "suspended") await revokeRefreshTokens(id); // their access token stops working immediately too
    await audit(req, `member.${status}`, "user", id);
    res.json({ ok: true, status });
  },
);
