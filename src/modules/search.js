import { Router } from "express";
import { z } from "zod";
import { query } from "../config/db.js";
import { validate } from "../middleware/validate.js";
import { like } from "../utils/paging.js";
import { ITEM_SELECT, ITEM_FROM, itemParams, shape } from "./library.js";

export const searchRouter = Router();

searchRouter.get("/search", validate({ query: z.object({ q: z.string().trim().min(2, "Type at least 2 letters").max(100) }) }), async (req, res) => {
  const { q } = req.valid.query;
  const pattern = like(q);
  const find = (type) =>
    query(
      `${ITEM_SELECT}${ITEM_FROM}
        WHERE c.type = ? AND c.status = 'published' AND c.deleted_at IS NULL AND (c.title LIKE ? OR c.description LIKE ?)
        ORDER BY c.published_at DESC LIMIT 6`,
      [...itemParams(req.user.id), type, pattern, pattern],
    );
  const [videos, books, blogs, people] = await Promise.all([
    find("video"),
    find("book"),
    find("blog"),
    query(
      "SELECT id, display_name, username, avatar_url, role FROM users WHERE status = 'active' AND (display_name LIKE ? OR username LIKE ?) LIMIT 5",
      [pattern, pattern],
    ),
  ]);
  res.json({ videos: videos.map(shape), books: books.map(shape), blogs: blogs.map(shape), people });
});
