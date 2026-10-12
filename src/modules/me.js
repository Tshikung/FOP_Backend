import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { query, one, tx } from "../config/db.js";
import { validate, idParam } from "../middleware/validate.js";
import { avatarUpload, storeFile } from "../middleware/upload.js";
import { badRequest, dupAs, notFound } from "../utils/httpError.js";
import { pathProgress } from "./learn.js";
import { activityStats } from "../services/progress.js";
import { permissionsFor } from "../services/permissions.js";
import { notify } from "../services/notify.js";

export const meRouter = Router();

/** A profile as shown on the profile page. Email only appears on your own. */
export async function loadProfile(id, viewerId) {
  const u = await one(
    `SELECT u.id, u.display_name, u.username, u.avatar_url, u.bio, u.experience_level, u.role, u.created_at, u.email,
            (SELECT COUNT(*) FROM follows WHERE following_id = u.id) AS followers,
            (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) AS following,
            (SELECT COUNT(*) FROM content_items c WHERE c.author_id = u.id AND c.type = 'blog' AND c.status = 'published' AND c.deleted_at IS NULL) AS posts,
            (SELECT CAST(COALESCE(SUM(points), 0) AS SIGNED) FROM xp_ledger WHERE user_id = u.id) AS xp,
            EXISTS(SELECT 1 FROM follows WHERE follower_id = ? AND following_id = u.id) AS viewer_follows
       FROM users u WHERE u.id = ? AND u.status = 'active'`,
    [viewerId, id],
  );
  if (!u) return null;
  const isSelf = id === viewerId;
  if (!isSelf) delete u.email;
  const [skills, achievements, recentPosts, stats, path] = await Promise.all([
    query("SELECT skill FROM user_skills WHERE user_id = ? ORDER BY skill", [id]),
    query(
      "SELECT a.code, a.title, a.description, ua.earned_at FROM user_achievements ua JOIN achievements a ON a.id = ua.achievement_id WHERE ua.user_id = ? ORDER BY ua.earned_at DESC",
      [id],
    ),
    query(
      `SELECT c.id, c.title, c.published_at,
              (SELECT COUNT(*) FROM content_likes l WHERE l.content_id = c.id) AS like_count,
              (SELECT COUNT(*) FROM comments m WHERE m.content_id = c.id AND m.status = 'visible') AS comment_count
         FROM content_items c WHERE c.author_id = ? AND c.type = 'blog' AND c.status = 'published' AND c.deleted_at IS NULL
        ORDER BY c.published_at DESC LIMIT 5`,
      [id],
    ),
    activityStats(id),
    u.role === "member" ? pathProgress(id) : null,
  ]);
  return { ...u, skills: skills.map((s) => s.skill), achievements, recent_posts: recentPosts, streak: stats.streak, path };
}

meRouter.get("/me", async (req, res) => {
  const profile = await loadProfile(req.user.id, req.user.id);
  res.json({ ...profile, permissions: permissionsFor(req.user.role) });
});

meRouter.patch(
  "/me",
  validate({
    body: z.object({
      displayName: z.string().trim().min(2).max(100).optional(),
      username: z.string().trim().regex(/^[A-Za-z0-9_]{3,30}$/, "Use 3 to 30 letters, numbers or underscores").optional(),
      bio: z.string().trim().max(500).nullable().optional(),
      experienceLevel: z.enum(["new", "basics", "experienced"]).optional(),
      skills: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
    }),
  }),
  async (req, res) => {
    const b = req.valid.body;
    const columns = { displayName: "display_name", username: "username", bio: "bio", experienceLevel: "experience_level" };
    const sets = [], vals = [];
    for (const [key, col] of Object.entries(columns)) {
      if (b[key] !== undefined) { sets.push(`${col} = ?`); vals.push(b[key]); }
    }
    await dupAs("That username is taken", () =>
      tx(async (t) => {
        if (sets.length) await t.query(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, [...vals, req.user.id]);
        if (b.skills) {
          await t.query("DELETE FROM user_skills WHERE user_id = ?", [req.user.id]);
          for (const skill of new Set(b.skills)) await t.query("INSERT INTO user_skills (user_id, skill) VALUES (?, ?)", [req.user.id, skill]);
        }
      }),
    );
    res.json(await loadProfile(req.user.id, req.user.id));
  },
);

meRouter.post("/me/avatar", avatarUpload, async (req, res) => {
  if (!req.file) throw badRequest("Choose an image");
  const url = await tx(async (t) => {
    const fileId = await storeFile(t, req.file, req.user.id);
    const avatarUrl = `/api/v1/files/${fileId}`;
    await t.query("UPDATE users SET avatar_url = ? WHERE id = ?", [avatarUrl, req.user.id]);
    return avatarUrl;
  });
  res.json({ avatar_url: url });
});

meRouter.post(
  "/me/password",
  validate({ body: z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(72) }) }),
  async (req, res) => {
    const row = await one("SELECT password_hash FROM users WHERE id = ?", [req.user.id]);
    if (!row?.password_hash || !(await bcrypt.compare(req.valid.body.currentPassword, row.password_hash))) {
      throw badRequest("Your current password is not right");
    }
    await query("UPDATE users SET password_hash = ? WHERE id = ?", [await bcrypt.hash(req.valid.body.newPassword, 12), req.user.id]);
    res.json({ ok: true });
  },
);

meRouter.get("/users/:username", async (req, res) => {
  const row = await one("SELECT id FROM users WHERE username = ? AND status = 'active'", [req.params.username]);
  const profile = row && (await loadProfile(row.id, req.user.id));
  if (!profile) throw notFound("Member");
  res.json(profile);
});

meRouter.post("/users/:id/follow", validate({ params: idParam }), async (req, res) => {
  const target = req.valid.params.id;
  if (target === req.user.id) throw badRequest("You cannot follow yourself");
  const exists = await one("SELECT id, display_name FROM users WHERE id = ? AND status = 'active'", [target]);
  if (!exists) throw notFound("Member");
  const r = await query("INSERT IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)", [req.user.id, target]);
  if (r.affectedRows === 1) {
    await notify(target, { type: "system", title: `${req.user.display_name} started following you`, refType: "user", refId: req.user.id });
  }
  res.json({ ok: true });
});

meRouter.delete("/users/:id/follow", validate({ params: idParam }), async (req, res) => {
  await query("DELETE FROM follows WHERE follower_id = ? AND following_id = ?", [req.user.id, req.valid.params.id]);
  res.json({ ok: true });
});
