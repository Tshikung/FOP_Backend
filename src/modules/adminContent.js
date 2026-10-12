import { Router } from "express";
import { z } from "zod";
import { query, one, tx } from "../config/db.js";
import { validate, idParam, optInt, optStr } from "../middleware/validate.js";
import { requirePermission } from "../middleware/auth.js";
import { videoUpload, bookUpload, storeFile, deleteStoredFile } from "../middleware/upload.js";
import { badRequest, notFound } from "../utils/httpError.js";
import { pageQuery, pg, finish, like } from "../utils/paging.js";
import { notify } from "../services/notify.js";
import { audit } from "../services/audit.js";
import { insertBlog, updateBlog } from "./library.js";

export const adminContentRouter = Router(); // mounted at /admin/content

const LEVELS = ["beginner", "intermediate", "project", "all_levels"];
const level = z.preprocess((v) => (v === "" ? undefined : v), z.enum(LEVELS).default("all_levels"));
const meta = z.object({ title: z.string().trim().min(3).max(200), description: optStr(2000), level, topicId: optInt, authorId: optInt });

async function resolveAuthor(req, authorId) {
  if (!authorId) return req.user.id;
  const a = await one("SELECT id FROM users WHERE id = ? AND role IN ('mentor', 'head_admin') AND status = 'active'", [authorId]);
  if (!a) throw badRequest("Choose an active mentor as the instructor");
  return a.id;
}

// ---- List and detail -------------------------------------------------------------------------
adminContentRouter.get(
  "/",
  validate({
    query: z.object({
      type: z.enum(["video", "book", "blog"]).optional(),
      status: z.enum(["draft", "pending", "published"]).optional(),
      q: z.string().trim().max(100).optional(),
      ...pageQuery,
    }),
  }),
  async (req, res) => {
    const f = req.valid.query;
    const p = pg(f);
    const where = ["1 = 1"], params = [];
    if (f.type) { where.push("type = ?"); params.push(f.type); }
    if (f.status) { where.push("status = ?"); params.push(f.status); }
    if (f.q) { where.push("title LIKE ?"); params.push(like(f.q)); }
    const rows = await query(
      `SELECT * FROM v_content_overview WHERE ${where.join(" AND ")}
        ORDER BY FIELD(status, 'pending', 'draft', 'published'), updated_at DESC LIMIT ? OFFSET ?`,
      [...params, p.limit, p.offset],
    );
    res.json(finish(rows, p));
  },
);

// Soft-deleted items (Head admin), so they can be restored
adminContentRouter.get("/deleted", requirePermission("content.delete"), async (_req, res) => {
  res.json({
    items: await query(
      `SELECT c.id, c.type, c.title, c.deleted_at, u.display_name AS author_name
         FROM content_items c JOIN users u ON u.id = c.author_id WHERE c.deleted_at IS NOT NULL ORDER BY c.deleted_at DESC LIMIT 100`,
    ),
  });
});

adminContentRouter.get("/:id", validate({ params: idParam }), async (req, res) => {
  const row = await one(
    `SELECT o.id, o.type, o.title, o.status, o.level, o.is_featured, o.author_id, o.author_name, o.published_at, o.updated_at,
            o.file_name, o.file_size, o.like_count, o.comment_count,
            c.description, c.topic_id, v.duration_seconds, b.author_name AS book_author, b.page_count,
            bp.excerpt, bp.body, bp.review_note
       FROM v_content_overview o
       JOIN content_items c ON c.id = o.id
       LEFT JOIN videos v ON v.content_id = o.id
       LEFT JOIN books b ON b.content_id = o.id
       LEFT JOIN blog_posts bp ON bp.content_id = o.id
      WHERE o.id = ?`,
    [req.valid.params.id],
  );
  if (!row) throw notFound("Item");
  res.json(row);
});

// ---- Create (one endpoint per type, because each has its own upload rules) -------------------
adminContentRouter.post(
  "/video",
  requirePermission("content.upload"),
  ...videoUpload,
  validate({ body: meta.extend({ durationSeconds: optInt }) }),
  async (req, res) => {
    if (!req.file) throw badRequest("Add a video file (MP4, WebM or MOV, up to 500 MB)");
    const b = req.valid.body;
    const authorId = await resolveAuthor(req, b.authorId);
    const id = await tx(async (t) => {
      const fileId = await storeFile(t, req.file, req.user.id);
      const r = await t.query("INSERT INTO content_items (type, title, description, author_id, topic_id, level) VALUES ('video', ?, ?, ?, ?, ?)", [
        b.title, b.description ?? null, authorId, b.topicId ?? null, b.level,
      ]);
      await t.query("INSERT INTO videos (content_id, file_id, duration_seconds) VALUES (?, ?, ?)", [r.insertId, fileId, b.durationSeconds ?? null]);
      await audit(req, "content.create", "content", r.insertId, { type: "video" }, t.query);
      return r.insertId;
    });
    res.status(201).json({ id, status: "draft" });
  },
);

adminContentRouter.post(
  "/book",
  requirePermission("content.upload"),
  ...bookUpload,
  validate({ body: meta.extend({ authorName: z.string().trim().min(2, "Enter the book's author").max(150), pageCount: optInt }) }),
  async (req, res) => {
    if (!req.file) throw badRequest("Add a book file (PDF or EPUB, up to 50 MB)");
    const b = req.valid.body;
    const authorId = await resolveAuthor(req, b.authorId);
    const id = await tx(async (t) => {
      const fileId = await storeFile(t, req.file, req.user.id);
      const r = await t.query("INSERT INTO content_items (type, title, description, author_id, topic_id, level) VALUES ('book', ?, ?, ?, ?, ?)", [
        b.title, b.description ?? null, authorId, b.topicId ?? null, b.level,
      ]);
      await t.query("INSERT INTO books (content_id, author_name, page_count, file_id) VALUES (?, ?, ?, ?)", [r.insertId, b.authorName, b.pageCount ?? null, fileId]);
      await audit(req, "content.create", "content", r.insertId, { type: "book" }, t.query);
      return r.insertId;
    });
    res.status(201).json({ id, status: "draft" });
  },
);

adminContentRouter.post(
  "/blog",
  requirePermission("content.edit"),
  validate({
    body: z.object({
      title: z.string().trim().min(3).max(200),
      excerpt: z.string().trim().max(300).optional(),
      body: z.string().trim().min(20).max(50000),
      topicId: z.number().int().positive().optional(),
      tags: z.array(z.string().trim().min(1).max(30).regex(/^[^,]+$/)).max(5).default([]),
      authorId: z.number().int().positive().optional(),
    }),
  }),
  async (req, res) => {
    const { authorId, ...b } = req.valid.body;
    const author = await resolveAuthor(req, authorId);
    const id = await tx(async (t) => {
      const newId = await insertBlog(t, { ...b, authorId: author, status: "draft" });
      await audit(req, "content.create", "content", newId, { type: "blog" }, t.query);
      return newId;
    });
    res.status(201).json({ id, status: "draft" });
  },
);

// ---- Edit details, replace file ----------------------------------------------------------------
adminContentRouter.patch(
  "/:id",
  requirePermission("content.edit"),
  validate({
    params: idParam,
    body: z.object({
      title: z.string().trim().min(3).max(200).optional(),
      description: z.string().trim().max(2000).nullable().optional(),
      level: z.enum(LEVELS).optional(),
      topicId: z.number().int().positive().nullable().optional(),
      isFeatured: z.boolean().optional(),
      authorName: z.string().trim().min(2).max(150).optional(), // books
      pageCount: z.number().int().positive().nullable().optional(), // books
      excerpt: z.string().trim().max(300).optional(), // blogs
      body: z.string().trim().min(20).max(50000).optional(), // blogs
      tags: z.array(z.string().trim().min(1).max(30).regex(/^[^,]+$/)).max(5).optional(), // blogs
    }),
  }),
  async (req, res) => {
    const { id } = req.valid.params;
    const b = req.valid.body;
    const item = await one("SELECT id, type FROM content_items WHERE id = ? AND deleted_at IS NULL", [id]);
    if (!item) throw notFound("Item");
    await tx(async (t) => {
      const map = { title: "title", description: "description", level: "level", topicId: "topic_id", isFeatured: "is_featured" };
      const sets = [], vals = [];
      for (const [key, col] of Object.entries(map)) if (b[key] !== undefined) { sets.push(`${col} = ?`); vals.push(b[key]); }
      if (sets.length) await t.query(`UPDATE content_items SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
      if (item.type === "book" && (b.authorName !== undefined || b.pageCount !== undefined)) {
        await t.query("UPDATE books SET author_name = COALESCE(?, author_name), page_count = COALESCE(?, page_count) WHERE content_id = ?", [b.authorName ?? null, b.pageCount ?? null, id]);
      }
      if (item.type === "blog") await updateBlog(t, id, { body: b.body, excerpt: b.excerpt, tags: b.tags });
      await audit(req, "content.update", "content", id, null, t.query);
    });
    res.json({ ok: true });
  },
);

const uploaders = { video: videoUpload, book: bookUpload };

adminContentRouter.put(
  "/:id/file",
  requirePermission("content.upload"),
  validate({ params: idParam }),
  async (req, _res, next) => {
    req.item = await one("SELECT id, type FROM content_items WHERE id = ? AND deleted_at IS NULL", [req.valid.params.id]);
    if (!req.item || req.item.type === "blog") throw notFound("Video or book");
    next();
  },
  // Pick the upload rules (size limit, allowed types) after we know whether this is a video or a book
  (req, res, next) => { const r = Router(); r.use(uploaders[req.item.type]); r(req, res, next); },
  async (req, res) => {
    if (!req.file) throw badRequest("Choose a file");
    const table = req.item.type === "video" ? "videos" : "books";
    const oldFileId = await tx(async (t) => {
      const old = await t.one(`SELECT file_id FROM ${table} WHERE content_id = ?`, [req.item.id]);
      const fileId = await storeFile(t, req.file, req.user.id);
      await t.query(`UPDATE ${table} SET file_id = ? WHERE content_id = ?`, [fileId, req.item.id]);
      await audit(req, "content.replace_file", "content", req.item.id, null, t.query);
      return old?.file_id;
    });
    if (oldFileId) await deleteStoredFile(oldFileId, query).catch(() => {}); // never let cleanup fail the request
    res.json({ ok: true });
  },
);

// ---- Publishing workflow -------------------------------------------------------------------------
const loadForReview = (id) =>
  one(
    `SELECT c.id, c.type, c.title, c.author_id, c.status, COALESCE(v.file_id, b.file_id) AS file_id, bp.body
       FROM content_items c
       LEFT JOIN videos v ON v.content_id = c.id
       LEFT JOIN books b ON b.content_id = c.id
       LEFT JOIN blog_posts bp ON bp.content_id = c.id
      WHERE c.id = ? AND c.deleted_at IS NULL`,
    [id],
  );

async function publish(req, res) {
  const item = await loadForReview(req.valid.params.id);
  if (!item) throw notFound("Item");
  if (item.type !== "blog" && !item.file_id) throw badRequest("Upload a file before publishing");
  if (item.type === "blog" && !item.body?.trim()) throw badRequest("This post has no content yet");
  await tx(async (t) => {
    await t.query(
      "UPDATE content_items SET status = 'published', published_at = COALESCE(published_at, UTC_TIMESTAMP()), reviewed_by = ?, reviewed_at = UTC_TIMESTAMP() WHERE id = ?",
      [req.user.id, item.id],
    );
    if (item.type === "blog") await t.query("UPDATE blog_posts SET review_note = NULL WHERE content_id = ?", [item.id]);
    if (item.status === "pending" && item.author_id !== req.user.id) {
      await notify(item.author_id, { type: "system", title: `Your post "${item.title}" is now live`, refType: item.type, refId: item.id }, t.query);
    }
    await audit(req, "content.publish", "content", item.id, null, t.query);
  });
  res.json({ ok: true, status: "published" });
}
const forPublish = [requirePermission("content.edit"), validate({ params: idParam }), publish];
adminContentRouter.post("/:id/publish", ...forPublish);
adminContentRouter.post("/:id/approve", ...forPublish); // same thing, the button says "Approve" for pending posts

adminContentRouter.post("/:id/unpublish", requirePermission("content.edit"), validate({ params: idParam }), async (req, res) => {
  const r = await query("UPDATE content_items SET status = 'draft' WHERE id = ? AND deleted_at IS NULL", [req.valid.params.id]);
  if (r.affectedRows === 0) throw notFound("Item");
  await audit(req, "content.unpublish", "content", req.valid.params.id);
  res.json({ ok: true, status: "draft" });
});

// Send a member's post back with a note on what to change
adminContentRouter.post(
  "/:id/reject",
  requirePermission("content.edit"),
  validate({ params: idParam, body: z.object({ note: z.string().trim().min(3, "Tell the author what to change").max(500) }) }),
  async (req, res) => {
    const item = await loadForReview(req.valid.params.id);
    if (!item || item.type !== "blog") throw notFound("Post");
    await tx(async (t) => {
      await t.query("UPDATE content_items SET status = 'draft', reviewed_by = ?, reviewed_at = UTC_TIMESTAMP() WHERE id = ?", [req.user.id, item.id]);
      await t.query("UPDATE blog_posts SET review_note = ? WHERE content_id = ?", [req.valid.body.note, item.id]);
      if (item.author_id !== req.user.id) {
        await notify(item.author_id, { type: "system", title: `A mentor left feedback on "${item.title}"`, body: req.valid.body.note, refType: item.type, refId: item.id }, t.query);
      }
      await audit(req, "content.reject", "content", item.id, null, t.query);
    });
    res.json({ ok: true, status: "draft" });
  },
);

// ---- Delete (Head admin). Soft delete, so it can be restored. -------------------------------------
adminContentRouter.delete("/:id", requirePermission("content.delete"), validate({ params: idParam }), async (req, res) => {
  const r = await query("UPDATE content_items SET deleted_at = UTC_TIMESTAMP() WHERE id = ? AND deleted_at IS NULL", [req.valid.params.id]);
  if (r.affectedRows === 0) throw notFound("Item");
  await audit(req, "content.delete", "content", req.valid.params.id);
  res.json({ ok: true });
});

adminContentRouter.post("/:id/restore", requirePermission("content.delete"), validate({ params: idParam }), async (req, res) => {
  const r = await query("UPDATE content_items SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL", [req.valid.params.id]);
  if (r.affectedRows === 0) throw notFound("Deleted item");
  await audit(req, "content.restore", "content", req.valid.params.id);
  res.json({ ok: true });
});
