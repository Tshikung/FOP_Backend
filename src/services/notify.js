import { query } from "../config/db.js";

/** Notify one user. Pass t.query as `run` to do it inside a transaction. */
export const notify = (userId, n, run = query) =>
  run(
    "INSERT INTO notifications (user_id, type, title, body, ref_type, ref_id, announcement_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [userId, n.type, n.title, n.body ?? null, n.refType ?? null, n.refId ?? null, n.announcementId ?? null],
  );

// Audience names match announcements.audience in the database
const AUDIENCES = {
  all: "role = 'member'",
  beginners: "role = 'member' AND experience_level = 'new'",
  intermediate_up: "role = 'member' AND experience_level IN ('basics', 'experienced')",
  mentors: "role IN ('mentor', 'head_admin')",
};

/** One notification row per active user in the audience. Returns how many were created. */
export async function fanOut(run, audience, n) {
  const r = await run(
    `INSERT INTO notifications (user_id, type, title, body, ref_type, ref_id, announcement_id)
     SELECT id, ?, ?, ?, ?, ?, ? FROM users WHERE status = 'active' AND ${AUDIENCES[audience]}`,
    [n.type, n.title, n.body ?? null, n.refType ?? null, n.refId ?? null, n.announcementId ?? null],
  );
  return r.affectedRows;
}
