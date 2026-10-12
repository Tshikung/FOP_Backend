import { Router } from "express";
import { one } from "../config/db.js";
import { validate, idParam } from "../middleware/validate.js";
import { isStaff } from "../middleware/auth.js";
import { uploadRoot } from "../middleware/upload.js";
import { forbidden, notFound } from "../utils/httpError.js";

export const filesRouter = Router();

// Avatars and question attachments. Video and book files go through /content/:id/file instead.
filesRouter.get("/files/:id", validate({ params: idParam }), async (req, res, next) => {
  const file = await one("SELECT * FROM files WHERE id = ?", [req.valid.params.id]);
  if (!file) throw notFound("File");
  const isAvatar = !!(await one("SELECT 1 AS ok FROM users WHERE avatar_url = ?", [`/api/v1/files/${file.id}`]));
  if (!isAvatar && !isStaff(req.user) && file.uploaded_by !== req.user.id) throw forbidden();
  res.sendFile(
    file.stored_path,
    {
      root: uploadRoot(),
      dotfiles: "deny",
      headers: { "Content-Type": file.mime_type, "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}` },
    },
    (err) => err && !res.headersSent && next(err),
  );
});
