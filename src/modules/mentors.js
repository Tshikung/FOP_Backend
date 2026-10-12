import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { query, one, tx } from "../config/db.js";
import { validate, idParam } from "../middleware/validate.js";
import { requirePermission } from "../middleware/auth.js";
import { badRequest, conflict, dupAs, notFound } from "../utils/httpError.js";
import { issueToken } from "../services/tokens.js";
import { revokeRefreshTokens } from "../services/session.js";
import { sendMail } from "../services/mailer.js";
import { audit } from "../services/audit.js";

export const adminMentorsRouter = Router(); // mounted at /admin/mentors

const INVITE_DAYS = 7;

async function sendInvite(mentor, invitedBy) {
  const token = await issueToken(mentor.id, "invite", INVITE_DAYS * 864e5);
  const link = `${env.MENTOR_PORTAL_URL}/accept-invite?token=${token}`;
  const sent = await sendMail({
    to: mentor.email,
    subject: "You are invited to mentor at Friends of Python",
    text: `Hi ${mentor.display_name},\n\n${invitedBy} invited you to join the Friends of Python mentor team.\nSet your password here (valid for ${INVITE_DAYS} days):\n${link}\n`,
  });
  // Without SMTP, show the link to the person who invited (development only)
  return { email_sent: sent, ...(env.NODE_ENV === "production" ? {} : { dev_invite_link: link }) };
}

const LIST_SQL = `SELECT u.id, u.display_name, u.email, u.avatar_url, u.role, u.status, mp.specialty, u.created_at, u.last_login_at,
    (SELECT COUNT(*) FROM questions q WHERE q.assigned_to = u.id AND q.status = 'open') AS open_questions
  FROM users u LEFT JOIN mentor_profiles mp ON mp.user_id = u.id WHERE u.role IN ('mentor', 'head_admin')`;

adminMentorsRouter.get("/", async (_req, res) => {
  res.json({ items: await query(`${LIST_SQL} ORDER BY FIELD(u.role, 'head_admin', 'mentor'), u.display_name`) });
});

adminMentorsRouter.post(
  "/",
  requirePermission("mentors.manage"),
  validate({
    body: z.object({
      name: z.string().trim().min(2).max(100),
      email: z.string().trim().toLowerCase().email(),
      specialty: z.string().trim().max(100).optional(),
    }),
  }),
  async (req, res) => {
    const b = req.valid.body;
    const mentor = await dupAs("A user with this email already exists", () =>
      tx(async (t) => {
        const r = await t.query("INSERT INTO users (email, display_name, role, status) VALUES (?, ?, 'mentor', 'invited')", [b.email, b.name]);
        await t.query("INSERT INTO mentor_profiles (user_id, specialty) VALUES (?, ?)", [r.insertId, b.specialty ?? null]);
        await audit(req, "mentor.invite", "user", r.insertId, { email: b.email }, t.query);
        return { id: r.insertId, email: b.email, display_name: b.name };
      }),
    );
    const invite = await sendInvite(mentor, req.user.display_name);
    res.status(201).json({ ...(await one(`${LIST_SQL} AND u.id = ?`, [mentor.id])), ...invite });
  },
);

adminMentorsRouter.post("/:id/resend-invite", requirePermission("mentors.manage"), validate({ params: idParam }), async (req, res) => {
  const m = await one("SELECT id, email, display_name FROM users WHERE id = ? AND role IN ('mentor', 'head_admin') AND status = 'invited'", [req.valid.params.id]);
  if (!m) throw notFound("Pending invite");
  res.json(await sendInvite(m, req.user.display_name));
});

adminMentorsRouter.patch(
  "/:id/role",
  requirePermission("mentors.roles"),
  validate({ params: idParam, body: z.object({ role: z.enum(["mentor", "head_admin"]) }) }),
  async (req, res) => {
    const { id } = req.valid.params;
    if (id === req.user.id) throw badRequest("You cannot change your own role"); // so there is always a Head admin
    const r = await query("UPDATE users SET role = ? WHERE id = ? AND role IN ('mentor', 'head_admin')", [req.valid.body.role, id]);
    if (r.affectedRows === 0) throw notFound("Mentor");
    await audit(req, "mentor.role_change", "user", id, { role: req.valid.body.role });
    res.json({ ok: true, role: req.valid.body.role });
  },
);

adminMentorsRouter.post("/:id/deactivate", requirePermission("mentors.manage"), validate({ params: idParam }), async (req, res) => {
  const { id } = req.valid.params;
  if (id === req.user.id) throw badRequest("You cannot deactivate yourself");
  // Marks them deactivated and returns their open questions to the unassigned queue (one transaction)
  await query("CALL sp_deactivate_mentor(?)", [id]);
  await revokeRefreshTokens(id);
  await audit(req, "mentor.deactivate", "user", id);
  res.json({ ok: true });
});

adminMentorsRouter.post("/:id/reactivate", requirePermission("mentors.manage"), validate({ params: idParam }), async (req, res) => {
  const m = await one("SELECT id, password_hash FROM users WHERE id = ? AND role IN ('mentor', 'head_admin') AND status = 'deactivated'", [req.valid.params.id]);
  if (!m) throw notFound("Deactivated mentor");
  const status = m.password_hash ? "active" : "invited"; // never accepted their invite? they go back to invited
  await query("UPDATE users SET status = ? WHERE id = ?", [status, m.id]);
  await audit(req, "mentor.reactivate", "user", m.id);
  res.json({ ok: true, status });
});
