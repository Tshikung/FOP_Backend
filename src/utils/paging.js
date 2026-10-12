import { z } from "zod";

export const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
};

/** Ask the database for one extra row so we know whether another page exists */
export const pg = ({ page, limit }) => ({ page, size: limit, limit: limit + 1, offset: (page - 1) * limit });

export function finish(rows, p) {
  const hasMore = rows.length > p.size;
  return { items: hasMore ? rows.slice(0, p.size) : rows, page: p.page, limit: p.size, hasMore };
}

export const like = (s) => `%${String(s).replace(/[\\%_]/g, "\\$&")}%`;
