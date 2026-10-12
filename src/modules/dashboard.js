import { Router } from "express";
import { query, one } from "../config/db.js";
import { pathProgress } from "./learn.js";
import { activityStats } from "../services/progress.js";

export const dashboardRouter = Router();

dashboardRouter.get("/dashboard", async (req, res) => {
  const me = req.user.id;
  const [path, stats, continueWatching, recentActivity, nextEvent, xp] = await Promise.all([
    pathProgress(me),
    activityStats(me),
    query(
      `SELECT c.id, c.title, c.level, v.duration_seconds, u.display_name AS instructor, p.percent AS progress
         FROM video_progress p
         JOIN content_items c ON c.id = p.content_id AND c.status = 'published' AND c.deleted_at IS NULL
         JOIN videos v ON v.content_id = c.id
         JOIN users u ON u.id = c.author_id
        WHERE p.user_id = ? AND p.percent BETWEEN 1 AND 99
        ORDER BY p.updated_at DESC LIMIT 3`,
      [me],
    ),
    query(
      `(SELECT 'xp' AS kind, reason AS title, CONCAT('+', points, ' XP') AS detail, created_at FROM xp_ledger WHERE user_id = ?)
       UNION ALL
       (SELECT type, title, body, created_at FROM notifications WHERE user_id = ?)
       ORDER BY created_at DESC LIMIT 5`,
      [me, me],
    ),
    one(
      `SELECT e.id, e.title, e.kind, e.starts_at, e.location, u.display_name AS host_name,
              (SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id = e.id) AS going,
              EXISTS(SELECT 1 FROM event_rsvps r WHERE r.event_id = e.id AND r.user_id = ?) AS rsvped
         FROM events e JOIN users u ON u.id = e.host_id
        WHERE e.starts_at > UTC_TIMESTAMP() ORDER BY e.starts_at LIMIT 1`,
      [me],
    ),
    one("SELECT CAST(COALESCE(SUM(points), 0) AS SIGNED) AS total FROM xp_ledger WHERE user_id = ?", [me]),
  ]);
  res.json({
    path,
    streak: stats.streak,
    week: stats.week,
    xp: xp.total,
    continue_watching: continueWatching,
    recent_activity: recentActivity,
    next_event: nextEvent,
  });
});
