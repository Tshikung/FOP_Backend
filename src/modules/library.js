import { Router } from "express";
import sanitizeHtml from "sanitize-html";
import { z } from "zod";
import { query, one, tx } from "../config/db.js";
import { validate, idParam } from "../middleware/validate.js";
import { isStaff } from "../middleware/auth.js";
import { env } from "../config/env.js";
import { uploadRoot } from "../middleware/upload.js";
import { notFound, forbidden } from "../utils/httpError.js";
import { pageQuery, pg, finish, like } from "../utils/paging.js";
import { addXp, recordActivity } from "../services/progress.js";
import { notify } from "../services/notify.js";
import { getSettings } from "../services/settings.js";

export const libraryRouter = Router();

// ---- Shared SQL for every card and detail view of videos, books and blogs -------------
// Placeholders: liked, bookmarked, video progress, reading progress (all the current user)
export const ITEM_SELECT = `SELECT c.id, c.type, c.title, c.description, c.level, c.is_featured, c.status, c.published_at, c.author_id,
    u.display_name AS author_name, u.username AS author_username, t.name AS topic,
    v.duration_seconds, b.author_name AS book_author, b.page_count, bp.excerpt, bp.read_minutes,
    (SELECT GROUP_CONCAT(g.name ORDER BY g.name SEPARATOR ',') FROM content_tags ct JOIN tags g ON g.id = ct.tag_id WHERE ct.content_id = c.id) AS tags,
    (SELECT COUNT(*) FROM content_likes l WHERE l.content_id = c.id) AS like_count,
    (SELECT COUNT(*) FROM comments m WHERE m.content_id = c.id AND m.status = 'visible') AS comment_count,
    EXISTS(SELECT 1 FROM content_likes l WHERE l.content_id = c.id AND l.user_id = ?) AS liked,
    EXISTS(SELECT 1 FROM bookmarks k WHERE k.content_id = c.id AND k.user_id = ?) AS bookmarked,
    COALESCE(vp.percent, 0) AS progress, f.mime_type AS file_mime, rp.last_page`;
export const ITEM_FROM = ` FROM content_items c
    JOIN users u ON u.id = c.author_id
    LEFT JOIN topics t ON t.id = c.topic_id
    LEFT JOIN videos v ON v.content_id = c.id
    LEFT JOIN books b ON b.content_id = c.id
    LEFT JOIN blog_posts bp ON bp.content_id = c.id
    LEFT JOIN video_progress vp ON vp.content_id = c.id AND vp.user_id = ?
    LEFT JOIN reading_progress rp ON rp.content_id = c.id AND rp.user_id = ?
    LEFT JOIN files f ON f.id = COALESCE(v.file_id, b.file_id)`;
export const itemParams = (me) => [me, me, me, me];
export const shape = (r) => ({ ...r, tags: r.tags ? r.tags.split(",") : [] });

async function getItem(user, id, type, withBody = false) {
  const row = await one(
    `${ITEM_SELECT}${withBody ? ", bp.body" : ""}${ITEM_FROM} WHERE c.id = ? AND c.deleted_at IS NULL${type ? " AND c.type = ?" : ""}`,
    [...itemParams(user.id), id, ...(type ? [type] : [])],
  );
  // Unpublished items are only visible to their author and to mentors
  if (!row || (row.status !== "published" && row.author_id !== user.id && !isStaff(user))) return null;
  return shape(row);
}

async function publishedItem(id) {
  const row = await one("SELECT id, title, author_id, status, type FROM content_items WHERE id = ? AND deleted_at IS NULL", [id]);
  if (!row || row.status !== "published") throw notFound("Item");
  return row;
}

// ---- Blog helpers (also used by the mentor portal) -----------------------------------
export const cleanHtml = (html) =>
  sanitizeHtml(html, {
    allowedTags: ["p", "br", "strong", "em", "b", "i", "code", "pre", "blockquote", "ul", "ol", "li", "h2", "h3", "a"],
    allowedAttributes: { a: ["href"] },
    allowedSchemes: ["http", "https", "mailto"],
  });
const plain = (html) => sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} });
const readMinutes = (text) => Math.max(1, Math.ceil(text.split(/\s+/).filter(Boolean).length / 200));

export async function setTags(t, contentId, tags) {
  await t.query("DELETE FROM content_tags WHERE content_id = ?", [contentId]);
  for (const name of new Set(tags.map((x) => x.trim()).filter(Boolean))) {
    const r = await t.query("INSERT INTO tags (name) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)", [name]);
    await t.query("INSERT IGNORE INTO content_tags (content_id, tag_id) VALUES (?, ?)", [contentId, r.insertId]);
  }
}

export async function insertBlog(t, { authorId, status, title, excerpt, body, topicId, tags = [] }) {
  const clean = cleanHtml(body);
  const text = plain(clean);
  const summary = (excerpt ?? text).slice(0, 300);
  const r = await t.query(
    "INSERT INTO content_items (type, title, description, author_id, topic_id, status, published_at) VALUES ('blog', ?, ?, ?, ?, ?, ?)",
    [title, summary, authorId, topicId ?? null, status, status === "published" ? new Date() : null],
  );
  await t.query("INSERT INTO blog_posts (content_id, excerpt, body, read_minutes) VALUES (?, ?, ?, ?)", [
    r.insertId, summary, clean, readMinutes(text),
  ]);
  await setTags(t, r.insertId, tags);
  return r.insertId;
}

export async function updateBlog(t, id, p) {
  const sets = [], vals = [];
  const add = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };
  if (p.title !== undefined) add("title", p.title);
  if (p.topicId !== undefined) add("topic_id", p.topicId);
  if (p.status !== undefined) add("status", p.status);
  if (p.status === "published") sets.push("published_at = COALESCE(published_at, UTC_TIMESTAMP())");
  if (p.excerpt !== undefined) add("description", p.excerpt);
  if (sets.length) await t.query(`UPDATE content_items SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);

  const bs = [], bv = [];
  if (p.body !== undefined) {
    const clean = cleanHtml(p.body);
    bs.push("body = ?", "read_minutes = ?");
    bv.push(clean, readMinutes(plain(clean)));
  }
  if (p.excerpt !== undefined) { bs.push("excerpt = ?"); bv.push(p.excerpt.slice(0, 300)); }
  if (bs.length) await t.query(`UPDATE blog_posts SET ${bs.join(", ")} WHERE content_id = ?`, [...bv, id]);
  if (p.tags) await setTags(t, id, p.tags);
}

// ---- Lists and details: GET /videos, /books, /blogs ----------------------------------
const listQuery = z.object({
  level: z.enum(["beginner", "intermediate", "project", "all_levels"]).optional(),
  topic: z.string().max(80).optional(),
  tag: z.string().max(50).optional(),
  q: z.string().trim().max(100).optional(),
  ...pageQuery,
});

for (const [route, type] of [["videos", "video"], ["books", "book"], ["blogs", "blog"]]) {
  libraryRouter.get(`/${route}`, validate({ query: listQuery }), async (req, res) => {
    const f = req.valid.query;
    const p = pg(f);
    const where = ["c.type = ?", "c.status = 'published'", "c.deleted_at IS NULL"];
    const params = [...itemParams(req.user.id), type];
    if (f.level) { where.push("c.level = ?"); params.push(f.level); }
    if (f.topic) { where.push("t.slug = ?"); params.push(f.topic); }
    if (f.q) { where.push("(c.title LIKE ? OR c.description LIKE ?)"); params.push(like(f.q), like(f.q)); }
    if (f.tag) {
      where.push("EXISTS (SELECT 1 FROM content_tags ct JOIN tags g ON g.id = ct.tag_id WHERE ct.content_id = c.id AND g.name = ?)");
      params.push(f.tag);
    }
    const rows = await query(
      `${ITEM_SELECT}${ITEM_FROM} WHERE ${where.join(" AND ")} ORDER BY c.is_featured DESC, c.published_at DESC, c.id DESC LIMIT ? OFFSET ?`,
      [...params, p.limit, p.offset],
    );
    const out = finish(rows.map(shape), p);
    res.json(out);
  });

  libraryRouter.get(`/${route}/:id`, validate({ params: idParam }), async (req, res) => {
    const item = await getItem(req.user, req.valid.params.id, type, type === "blog");
    if (!item) throw notFound("Item");
    res.json(item);
  });
}

// ---- Watching and reading progress ----------------------------------------------------
libraryRouter.post(
  "/videos/:id/progress",
  validate({ params: idParam, body: z.object({ seconds: z.number().int().min(0), percent: z.number().int().min(0).max(100) }) }),
  async (req, res) => {
    const video = await publishedItem(req.valid.params.id);
    if (video.type !== "video") throw notFound("Video");
    const { seconds, percent } = req.valid.body;
    const before = await one("SELECT completed_at FROM video_progress WHERE user_id = ? AND content_id = ?", [req.user.id, video.id]);
    const done = percent >= 95;
    await query(
      `INSERT INTO video_progress (user_id, content_id, seconds_watched, percent, completed_at)
       VALUES (?, ?, ?, ?, ${done ? "UTC_TIMESTAMP()" : "NULL"}) AS new
       ON DUPLICATE KEY UPDATE seconds_watched = new.seconds_watched, percent = new.percent,
                               completed_at = COALESCE(video_progress.completed_at, new.completed_at)`,
      [req.user.id, video.id, seconds, percent],
    );
    if (done && !before?.completed_at) await addXp(req.user.id, 10, `Finished "${video.title}"`);
    await recordActivity(req.user.id);
    res.json({ ok: true });
  },
);

libraryRouter.post(
  "/books/:id/progress",
  validate({ params: idParam, body: z.object({ page: z.number().int().min(1) }) }),
  async (req, res) => {
    const book = await publishedItem(req.valid.params.id);
    if (book.type !== "book") throw notFound("Book");
    await query(
      "INSERT INTO reading_progress (user_id, content_id, last_page) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE last_page = VALUES(last_page)",
      [req.user.id, book.id, req.valid.body.page],
    );
    await recordActivity(req.user.id);
    res.json({ ok: true });
  },
);

libraryRouter.get("/reading-lists/current", async (_req, res) => {
  const list = await one("SELECT id, title, description, month_label FROM reading_lists WHERE is_published = 1 ORDER BY id DESC LIMIT 1");
  if (!list) return res.json({ list: null });
  const items = await query(
    `SELECT c.id, c.title, b.author_name AS book_author, b.page_count, rli.position, rli.reason, rli.chapter_note
       FROM reading_list_items rli
       JOIN content_items c ON c.id = rli.content_id AND c.status = 'published' AND c.deleted_at IS NULL
       JOIN books b ON b.content_id = c.id
      WHERE rli.list_id = ? ORDER BY rli.position`,
    [list.id],
  );
  res.json({ list: { ...list, items } });
});

// ---- Member blogs ---------------------------------------------------------------------
const blogFields = z.object({
  title: z.string().trim().min(3).max(200),
  excerpt: z.string().trim().max(300).optional(),
  body: z.string().trim().min(20, "Write a little more before submitting").max(50000),
  topicId: z.coerce.number().int().positive().optional(),
  tags: z.array(z.string().trim().min(1).max(30).regex(/^[^,]+$/, "Tags cannot contain commas")).max(5).default([]),
});

// Where a member's post goes: draft, waiting for a mentor, or live right away
const statusFor = (submit, settings) => (submit === false ? "draft" : settings.require_post_approval ? "pending" : "published");

libraryRouter.post("/blogs", validate({ body: blogFields.extend({ submit: z.boolean().default(true) }) }), async (req, res) => {
  const { submit, ...b } = req.valid.body;
  const status = statusFor(submit, await getSettings());
  const id = await tx((t) => insertBlog(t, { ...b, authorId: req.user.id, status }));
  res.status(201).json({ id, status });
});

libraryRouter.patch(
  "/blogs/:id",
  validate({ params: idParam, body: blogFields.partial().extend({ submit: z.boolean().optional() }) }),
  async (req, res) => {
    const own = await one("SELECT id FROM content_items WHERE id = ? AND type = 'blog' AND author_id = ? AND deleted_at IS NULL", [req.valid.params.id, req.user.id]);
    if (!own) throw notFound("Post");
    const { submit, ...patch } = req.valid.body;
    const status = statusFor(submit, await getSettings()); // edits go back through approval when it is switched on
    await tx((t) => updateBlog(t, own.id, { ...patch, status }));
    res.json({ id: own.id, status });
  },
);

libraryRouter.delete("/blogs/:id", validate({ params: idParam }), async (req, res) => {
  const r = await query(
    "UPDATE content_items SET deleted_at = UTC_TIMESTAMP() WHERE id = ? AND type = 'blog' AND author_id = ? AND deleted_at IS NULL",
    [req.valid.params.id, req.user.id],
  );
  if (r.affectedRows === 0) throw notFound("Post");
  res.json({ ok: true });
});

libraryRouter.get("/me/blogs", validate({ query: z.object(pageQuery) }), async (req, res) => {
  const p = pg(req.valid.query);
  const rows = await query(
    `${ITEM_SELECT}${ITEM_FROM} WHERE c.type = 'blog' AND c.author_id = ? AND c.deleted_at IS NULL ORDER BY c.updated_at DESC LIMIT ? OFFSET ?`,
    [...itemParams(req.user.id), req.user.id, p.limit, p.offset],
  );
  res.json(finish(rows.map(shape), p));
});

// ---- Likes and saved items ------------------------------------------------------------
libraryRouter.post("/content/:id/like", validate({ params: idParam }), async (req, res) => {
  const item = await publishedItem(req.valid.params.id);
  const r = await query("INSERT IGNORE INTO content_likes (user_id, content_id) VALUES (?, ?)", [req.user.id, item.id]);
  if (r.affectedRows === 1 && item.author_id !== req.user.id) {
    await notify(item.author_id, {
      type: "like", title: `${req.user.display_name} liked "${item.title}"`, refType: item.type, refId: item.id,
    });
  }
  res.json({ ok: true });
});
libraryRouter.delete("/content/:id/like", validate({ params: idParam }), async (req, res) => {
  await query("DELETE FROM content_likes WHERE user_id = ? AND content_id = ?", [req.user.id, req.valid.params.id]);
  res.json({ ok: true });
});

libraryRouter.post("/content/:id/bookmark", validate({ params: idParam }), async (req, res) => {
  const item = await publishedItem(req.valid.params.id);
  await query("INSERT IGNORE INTO bookmarks (user_id, content_id) VALUES (?, ?)", [req.user.id, item.id]);
  res.json({ ok: true });
});
libraryRouter.delete("/content/:id/bookmark", validate({ params: idParam }), async (req, res) => {
  await query("DELETE FROM bookmarks WHERE user_id = ? AND content_id = ?", [req.user.id, req.valid.params.id]);
  res.json({ ok: true });
});

libraryRouter.get("/me/bookmarks", validate({ query: z.object(pageQuery) }), async (req, res) => {
  const p = pg(req.valid.query);
  const rows = await query(
    `${ITEM_SELECT}${ITEM_FROM} JOIN bookmarks bk ON bk.content_id = c.id AND bk.user_id = ?
      WHERE c.status = 'published' AND c.deleted_at IS NULL ORDER BY bk.created_at DESC LIMIT ? OFFSET ?`,
    [...itemParams(req.user.id), req.user.id, p.limit, p.offset],
  );
  res.json(finish(rows.map(shape), p));
});

// ---- Secure file download / video streaming (supports Range requests for seeking) -----
libraryRouter.get("/content/:id/file", validate({ params: idParam }), async (req, res, next) => {
  const row = await one(
    `SELECT c.status, f.stored_path, f.mime_type, f.original_name
       FROM content_items c
       LEFT JOIN videos v ON v.content_id = c.id
       LEFT JOIN books b ON b.content_id = c.id
       JOIN files f ON f.id = COALESCE(v.file_id, b.file_id)
      WHERE c.id = ? AND c.deleted_at IS NULL`,
    [req.valid.params.id],
  );
  if (!row) throw notFound("File");
  if (row.status !== "published" && !isStaff(req.user)) throw forbidden();
  // Let the portals show this file inside an <iframe> (PDF reader), but nobody else
  res.removeHeader("X-Frame-Options");
  res.setHeader("Content-Security-Policy", `frame-ancestors ${env.corsOrigins.join(" ")}`);
  res.sendFile(
    row.stored_path,
    {
      root: uploadRoot(),
      dotfiles: "deny",
      headers: {
        "Content-Type": row.mime_type,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.original_name)}`,
      },
    },
    (err) => err && !res.headersSent && next(err),
  );
});
