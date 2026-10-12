import { Router } from "express";
import { query, one } from "../config/db.js";

export const adminOverviewRouter = Router(); // mounted at /admin/overview

adminOverviewRouter.get("/", async (_req, res) => {
  const [counts, week, avgReply, activity] = await Promise.all([
    one("SELECT * FROM v_admin_overview"),
    one("SELECT COUNT(*) AS n FROM users WHERE role = 'member' AND created_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY"),
    one("SELECT ROUND(AVG(TIMESTAMPDIFF(MINUTE, created_at, answered_at)) / 60, 1) AS hours FROM questions WHERE status = 'answered' AND answered_at IS NOT NULL"),
    query(
      "SELECT DATE(completed_at) AS day, COUNT(*) AS lessons FROM module_progress WHERE completed_at >= UTC_DATE() - INTERVAL 6 DAY GROUP BY DATE(completed_at)",
    ),
  ]);
  const byDay = new Map(activity.map((r) => [new Date(r.day).toISOString().slice(0, 10), r.lessons]));
  const weekly_activity = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(Date.now() - (6 - i) * 864e5).toISOString().slice(0, 10);
    return { date, lessons: byDay.get(date) ?? 0 };
  });
  res.json({
    ...counts,
    new_members_this_week: week.n,
    avg_reply_hours: avgReply.hours === null ? null : Number(avgReply.hours),
    weekly_activity,
  });
});
