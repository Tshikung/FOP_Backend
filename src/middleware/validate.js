import { z } from "zod";

/** validate({ params, query, body }) with zod schemas. Parsed values land in req.valid. */
export const validate = (schemas) => (req, _res, next) => {
  req.valid = {};
  for (const part of ["params", "query", "body"]) {
    if (schemas[part]) req.valid[part] = schemas[part].parse(req[part] ?? {});
  }
  next();
};

export const idParam = z.object({ id: z.coerce.number().int().positive() });

// Multipart forms send "" for empty fields, so empty means "not provided"
export const optInt = z.preprocess((v) => (v === "" || v == null ? undefined : v), z.coerce.number().int().positive().optional());
export const optStr = (max) => z.preprocess((v) => (v === "" ? undefined : v), z.string().trim().max(max).optional());
