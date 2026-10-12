import { query } from "../config/db.js";
import { notify } from "./notify.js";

export const addXp = (userId, points, reason, run = query) =>
  run("INSERT INTO xp_ledger (user_id, points, reason) VALUES (?, ?, ?)", [userId, points, reason]);

const isoDay = (offset = 0) => new Date(Date.now() - offset * 864e5).toISOString().slice(0, 10);

/** Day streak and the last 7 days, calculated from activity_days (UTC days) */
export async function activityStats(userId) {
  const rows = await query(
    "SELECT activity_date FROM activity_days WHERE user_id = ? AND activity_date >= UTC_DATE() - INTERVAL 400 DAY ORDER BY activity_date DESC",
    [userId],
  );
  const days = new Set(rows.map((r) => new Date(r.activity_date).toISOString().slice(0, 10)));
  let start = days.has(isoDay(0)) ? 0 : days.has(isoDay(1)) ? 1 : null;
  let streak = 0;
  if (start !== null) while (days.has(isoDay(start + streak))) streak++;
  const week = Array.from({ length: 7 }, (_, i) => {
    const date = isoDay(6 - i);
    return { date, done: days.has(date) };
  });
  return { streak, week };
}

async function award(userId, code, title) {
  const r = await query(
    "INSERT IGNORE INTO user_achievements (user_id, achievement_id) SELECT ?, id FROM achievements WHERE code = ?",
    [userId, code],
  );
  if (r.affectedRows === 1) {
    await notify(userId, { type: "streak", title: `New achievement: ${title}`, body: "Keep it going!" });
  }
}

/** Mark today as an active day. Awards the 7 day streak badge when it is earned. */
export async function recordActivity(userId) {
  const r = await query("INSERT IGNORE INTO activity_days (user_id, activity_date) VALUES (?, UTC_DATE())", [userId]);
  if (r.affectedRows === 1) {
    const { streak } = await activityStats(userId);
    if (streak >= 7) await award(userId, "streak_7", "7 day streak");
  }
}
