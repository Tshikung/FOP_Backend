import { Router } from "express";
import { query, one } from "../config/db.js";

// Home page numbers. No sign-in needed, so the landing page can show real figures.
export const publicRouter = Router();

publicRouter.get("/public/stats", async (_req, res) => {
  const r = await one(
    `SELECT
       (SELECT COUNT(*) FROM content_items WHERE type = 'video' AND status = 'published' AND deleted_at IS NULL) AS lessons,
       (SELECT COUNT(*) FROM users WHERE role IN ('mentor', 'head_admin') AND status = 'active') AS mentors,
       (SELECT COUNT(*) FROM content_items WHERE type = 'blog' AND status = 'published' AND deleted_at IS NULL) AS posts,
       (SELECT COUNT(*) FROM users WHERE role = 'member' AND status = 'active') AS members,
       (SELECT ROUND(AVG(TIMESTAMPDIFF(MINUTE, created_at, answered_at)) / 60, 1) FROM questions WHERE status = 'answered' AND answered_at IS NOT NULL) AS avg_reply_hours`,
  );
  res.set("Cache-Control", "public, max-age=60");
  res.json({ ...r, avg_reply_hours: r.avg_reply_hours === null ? null : Number(r.avg_reply_hours) });
});

// Signed-in members: who the mentors are, and the topics to pick from
export const directoryRouter = Router();

directoryRouter.get("/mentors", async (_req, res) => {
  res.json({
    items: await query(
      `SELECT u.id, u.display_name, u.username, u.avatar_url, mp.specialty
         FROM users u LEFT JOIN mentor_profiles mp ON mp.user_id = u.id
        WHERE u.role IN ('mentor', 'head_admin') AND u.status = 'active' ORDER BY u.display_name`,
    ),
  });
});

directoryRouter.get("/topics", async (_req, res) => {
  res.json({ items: await query("SELECT id, name, slug FROM topics ORDER BY sort_order, name") });
});
