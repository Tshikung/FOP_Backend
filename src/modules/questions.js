import { Router } from "express";
import { z } from "zod";
import { query, one, tx } from "../config/db.js";
import { validate, idParam, optInt } from "../middleware/validate.js";
import { requirePermission, isStaff } from "../middleware/auth.js";
import { attachmentUpload, storeFile } from "../middleware/upload.js";
import { badRequest, conflict, forbidden, notFound } from "../utils/httpError.js";
import { pageQuery, pg, finish, like } from "../utils/paging.js";
import { notify } from "../services/notify.js";
import { audit } from "../services/audit.js";
import { recordActivity } from "../services/progress.js";

export const questionsRouter = Router(); // member side, mounted at /
export const adminQuestionsRouter = Router(); // mentor side, mounted at /admin/questions

async function loadQuestion(id) {
  const q = await one(
    `SELECT q.id, q.title, q.body, q.level, q.status, q.member_id, q.assigned_to, q.assigned_at, q.answered_at, q.created_at,
            m.display_name AS member_name, m.username AS member_username, m.avatar_url AS member_avatar,
            a.display_name AS assignee_name, t.name AS topic
       FROM questions q
       JOIN users m ON m.id = q.member_id
       LEFT JOIN users a ON a.id = q.assigned_to
       LEFT JOIN topics t ON t.id = q.topic_id
      WHERE q.id = ?`,
    [id],
  );
  if (!q) return null;
  q.replies = await query(
    `SELECT r.id, r.body, r.created_at, r.author_id, u.display_name AS author_name, u.role AS author_role
       FROM question_replies r JOIN users u ON u.id = r.author_id WHERE r.question_id = ? ORDER BY r.created_at, r.id`,
    [id],
  );
  const files = await query(
    "SELECT f.id, f.original_name, f.mime_type, f.size_bytes FROM question_attachments qa JOIN files f ON f.id = qa.file_id WHERE qa.question_id = ?",
    [id],
  );
  q.attachments = files.map((f) => ({ ...f, url: `/api/v1/files/${f.id}` }));
  return q;
}

// ---- Member: ask, list own, read, follow up --------------------------------------------
questionsRouter.post(
  "/questions",
  attachmentUpload,
  validate({
    body: z.object({
      title: z.string().trim().min(5, "Give your question a short title").max(200),
      body: z.string().trim().min(10, "Describe what you are stuck on").max(5000),
      topicId: optInt,
      level: z.enum(["beginner", "intermediate", "advanced"]).default("beginner"),
    }),
  }),
  async (req, res) => {
    const b = req.valid.body;
    const id = await tx(async (t) => {
      const r = await t.query("INSERT INTO questions (member_id, title, body, topic_id, level) VALUES (?, ?, ?, ?, ?)", [
        req.user.id, b.title, b.body, b.topicId ?? null, b.level,
      ]);
      for (const file of req.files ?? []) {
        const fileId = await storeFile(t, file, req.user.id);
        await t.query("INSERT INTO question_attachments (question_id, file_id) VALUES (?, ?)", [r.insertId, fileId]);
      }
      return r.insertId;
    });
    await recordActivity(req.user.id);
    res.status(201).json(await loadQuestion(id));
  },
);

questionsRouter.get("/me/questions", validate({ query: z.object(pageQuery) }), async (req, res) => {
  const p = pg(req.valid.query);
  const rows = await query(
    `SELECT q.id, q.title, q.status, q.level, q.created_at, q.answered_at, t.name AS topic, a.display_name AS assignee_name,
            (SELECT COUNT(*) FROM question_replies r WHERE r.question_id = q.id) AS reply_count
       FROM questions q LEFT JOIN topics t ON t.id = q.topic_id LEFT JOIN users a ON a.id = q.assigned_to
      WHERE q.member_id = ? ORDER BY q.created_at DESC LIMIT ? OFFSET ?`,
    [req.user.id, p.limit, p.offset],
  );
  res.json(finish(rows, p));
});

questionsRouter.get("/questions/:id", validate({ params: idParam }), async (req, res) => {
  const q = await loadQuestion(req.valid.params.id);
  if (!q || (q.member_id !== req.user.id && !isStaff(req.user))) throw notFound("Question");
  res.json(q);
});

// The member adds a follow-up. This reopens the question and tells the mentor.
questionsRouter.post(
  "/questions/:id/replies",
  validate({ params: idParam, body: z.object({ body: z.string().trim().min(1).max(5000) }) }),
  async (req, res) => {
    const q = await one("SELECT id, title, status, assigned_to FROM questions WHERE id = ? AND member_id = ?", [req.valid.params.id, req.user.id]);
    if (!q) throw notFound("Question");
    if (q.status === "closed") throw conflict("This question is closed");
    await tx(async (t) => {
      await t.query("INSERT INTO question_replies (question_id, author_id, body) VALUES (?, ?, ?)", [q.id, req.user.id, req.valid.body.body]);
      await t.query("UPDATE questions SET status = 'open', answered_at = NULL WHERE id = ?", [q.id]);
      if (q.assigned_to) {
        await notify(q.assigned_to, { type: "system", title: `${req.user.display_name} replied to "${q.title}"`, refType: "question", refId: q.id }, t.query);
      }
    });
    res.status(201).json({ ok: true });
  },
);

// ---- Mentor portal: inbox, assign, reply ------------------------------------------------
const listFilter = z.object({
  status: z.enum(["open", "mine", "unassigned", "answered", "all"]).default("open"),
  q: z.string().trim().max(100).optional(),
  ...pageQuery,
});

adminQuestionsRouter.get("/", validate({ query: listFilter }), async (req, res) => {
  const f = req.valid.query;
  const p = pg(f);
  const where = { open: "q.status = 'open'", mine: "q.status = 'open' AND q.assigned_to = ?", unassigned: "q.status = 'open' AND q.assigned_to IS NULL", answered: "q.status = 'answered'", all: "1 = 1" };
  const params = f.status === "mine" ? [req.user.id] : [];
  let sql = where[f.status];
  if (f.q) { sql += " AND (q.title LIKE ? OR m.display_name LIKE ?)"; params.push(like(f.q), like(f.q)); }
  const rows = await query(
    `SELECT q.id, q.title, LEFT(q.body, 160) AS preview, q.status, q.level, q.created_at, q.answered_at, q.assigned_to,
            m.display_name AS member_name, a.display_name AS assignee_name, t.name AS topic,
            (SELECT COUNT(*) FROM question_replies r WHERE r.question_id = q.id) AS reply_count
       FROM questions q JOIN users m ON m.id = q.member_id LEFT JOIN users a ON a.id = q.assigned_to LEFT JOIN topics t ON t.id = q.topic_id
      WHERE ${sql} ORDER BY q.created_at DESC LIMIT ? OFFSET ?`,
    [...params, p.limit, p.offset],
  );
  res.json(finish(rows, p));
});

// Numbers for the tabs and the sidebar badge
adminQuestionsRouter.get("/counts", async (req, res) => {
  res.json(
    await one(
      `SELECT SUM(status = 'open') AS open,
              SUM(status = 'open' AND assigned_to = ?) AS mine,
              SUM(status = 'open' AND assigned_to IS NULL) AS unassigned,
              SUM(status = 'answered') AS answered
         FROM questions`,
      [req.user.id],
    ).then((r) => ({ open: Number(r.open ?? 0), mine: Number(r.mine ?? 0), unassigned: Number(r.unassigned ?? 0), answered: Number(r.answered ?? 0) })),
  );
});

adminQuestionsRouter.get("/:id", validate({ params: idParam }), async (req, res) => {
  const q = await loadQuestion(req.valid.params.id);
  if (!q) throw notFound("Question");
  res.json(q);
});

adminQuestionsRouter.patch(
  "/:id/assign",
  requirePermission("questions.answer"),
  validate({ params: idParam, body: z.object({ assignedTo: z.number().int().positive().nullable() }) }),
  async (req, res) => {
    const q = await one("SELECT id, title FROM questions WHERE id = ?", [req.valid.params.id]);
    if (!q) throw notFound("Question");
    const { assignedTo } = req.valid.body;
    if (assignedTo !== null) {
      const mentor = await one("SELECT id FROM users WHERE id = ? AND role IN ('mentor', 'head_admin') AND status = 'active'", [assignedTo]);
      if (!mentor) throw badRequest("Choose an active mentor");
    }
    await tx(async (t) => {
      await t.query("UPDATE questions SET assigned_to = ?, assigned_at = ? WHERE id = ?", [assignedTo, assignedTo ? new Date() : null, q.id]);
      if (assignedTo && assignedTo !== req.user.id) {
        await notify(assignedTo, { type: "question_assigned", title: `${req.user.display_name} assigned you a question`, body: q.title, refType: "question", refId: q.id }, t.query);
      }
      await audit(req, "question.assign", "question", q.id, { assignedTo }, t.query);
    });
    res.json({ ok: true, assigned_to: assignedTo });
  },
);

adminQuestionsRouter.post(
  "/:id/replies",
  requirePermission("questions.answer"),
  validate({ params: idParam, body: z.object({ body: z.string().trim().min(1, "Write a reply first").max(5000) }) }),
  async (req, res) => {
    const q = await one("SELECT id, member_id, title, status FROM questions WHERE id = ?", [req.valid.params.id]);
    if (!q) throw notFound("Question");
    if (q.status === "closed") throw conflict("This question is closed");
    const replyId = await tx(async (t) => {
      const r = await t.query("INSERT INTO question_replies (question_id, author_id, body) VALUES (?, ?, ?)", [q.id, req.user.id, req.valid.body.body]);
      // Whoever answers takes the question if nobody was assigned yet
      await t.query(
        `UPDATE questions SET status = 'answered', answered_at = UTC_TIMESTAMP(),
                assigned_to = COALESCE(assigned_to, ?), assigned_at = COALESCE(assigned_at, UTC_TIMESTAMP()) WHERE id = ?`,
        [req.user.id, q.id],
      );
      await notify(q.member_id, { type: "mentor_reply", title: `${req.user.display_name} replied to your question`, body: q.title, refType: "question", refId: q.id }, t.query);
      return r.insertId;
    });
    res.status(201).json({ id: replyId });
  },
);
