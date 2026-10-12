import { Router } from "express";
import { z } from "zod";
import { query } from "../config/db.js";
import { validate } from "../middleware/validate.js";
import { requirePermission } from "../middleware/auth.js";
import { getSettings } from "../services/settings.js";
import { audit } from "../services/audit.js";

export const publicSettingsRouter = Router(); // any signed-in user
export const adminSettingsRouter = Router(); // mounted at /admin/settings

publicSettingsRouter.get("/settings/public", async (_req, res) => {
  const s = await getSettings();
  res.json({ club_name: s.club_name, support_email: s.support_email, allow_comments: s.allow_comments, require_post_approval: s.require_post_approval });
});

adminSettingsRouter.get("/", async (_req, res) => res.json(await getSettings()));

adminSettingsRouter.patch(
  "/",
  requirePermission("settings.manage"),
  validate({
    body: z.object({
      clubName: z.string().trim().min(2).max(100).optional(),
      supportEmail: z.string().trim().email().max(190).optional(),
      requirePostApproval: z.boolean().optional(),
      allowComments: z.boolean().optional(),
    }),
  }),
  async (req, res) => {
    const b = req.valid.body;
    const columns = { clubName: "club_name", supportEmail: "support_email", requirePostApproval: "require_post_approval", allowComments: "allow_comments" };
    const sets = ["updated_by = ?"], vals = [req.user.id];
    for (const [key, col] of Object.entries(columns)) if (b[key] !== undefined) { sets.push(`${col} = ?`); vals.push(b[key]); }
    await query(`UPDATE club_settings SET ${sets.join(", ")} WHERE id = 1`, vals);
    await audit(req, "settings.update", "settings", 1, b);
    res.json(await getSettings());
  },
);

// The roles table on the Settings page
export const adminPermissionsRouter = Router();
adminPermissionsRouter.get("/", async (_req, res) => {
  const rows = await query(
    `SELECT p.permission_key AS \`key\`, p.description,
            COALESCE(MAX(rp.role = 'head_admin'), 0) AS head_admin, COALESCE(MAX(rp.role = 'mentor'), 0) AS mentor
       FROM permissions p LEFT JOIN role_permissions rp ON rp.permission_key = p.permission_key
      GROUP BY p.permission_key, p.description ORDER BY MIN(p.description)`,
  );
  res.json({ items: rows });
});
