import { Router } from "express";
import { z } from "zod";
import { query, one, tx } from "../config/db.js";
import { validate, idParam } from "../middleware/validate.js";
import { notFound } from "../utils/httpError.js";
import { addXp, recordActivity } from "../services/progress.js";

export const learnRouter = Router();

/** The published learning path with the member's progress on each module */
export async function pathProgress(userId) {
  const path = await one("SELECT id, title, slug, description FROM learning_paths WHERE is_published = 1 ORDER BY id LIMIT 1");
  if (!path) return null;
  const modules = await query(
    `SELECT m.id, m.position, m.title, m.description, m.video_id, (mp.user_id IS NOT NULL) AS completed
       FROM path_modules m
       LEFT JOIN module_progress mp ON mp.module_id = m.id AND mp.user_id = ?
      WHERE m.path_id = ? ORDER BY m.position`,
    [userId, path.id],
  );
  const done = modules.filter((m) => m.completed).length;
  const next = modules.find((m) => !m.completed) ?? null;
  return {
    ...path,
    modules: modules.map((m) => ({ ...m, current: next?.id === m.id })),
    completed_count: done,
    total_count: modules.length,
    percent: modules.length ? Math.round((done * 100) / modules.length) : 0,
    next_module: next && { id: next.id, position: next.position, title: next.title },
  };
}

learnRouter.get("/learn/path", async (req, res) => {
  res.json({ path: await pathProgress(req.user.id) });
});

learnRouter.post("/learn/modules/:id/complete", validate({ params: idParam }), async (req, res) => {
  const mod = await one(
    "SELECT m.id, m.title, m.path_id FROM path_modules m JOIN learning_paths p ON p.id = m.path_id WHERE m.id = ? AND p.is_published = 1",
    [req.valid.params.id],
  );
  if (!mod) throw notFound("Module");
  await tx(async (t) => {
    await t.query("INSERT IGNORE INTO path_enrollments (user_id, path_id) VALUES (?, ?)", [req.user.id, mod.path_id]);
    const r = await t.query("INSERT IGNORE INTO module_progress (user_id, module_id) VALUES (?, ?)", [req.user.id, mod.id]);
    if (r.affectedRows === 1) await addXp(req.user.id, 20, `Completed "${mod.title}"`, t.query);
  });
  await recordActivity(req.user.id);
  res.json({ path: await pathProgress(req.user.id) });
});
