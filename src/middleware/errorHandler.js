import multer from "multer";
import { ZodError } from "zod";
import { HttpError } from "../utils/httpError.js";
import { discardUploads } from "./upload.js";

export const notFoundHandler = (_req, res) =>
  res.status(404).json({ error: { code: "not_found", message: "Route not found" } });

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  discardUploads(req).catch(() => {});
  const send = (status, code, message, extra = {}) => res.status(status).json({ error: { code, message, ...extra } });

  if (err instanceof ZodError) {
    const fields = err.flatten().fieldErrors;
    return send(400, "validation_error", Object.values(fields).flat()[0] ?? "Please check your input", { fields });
  }
  if (err instanceof HttpError) return send(err.status, err.code, err.message, err.fields ? { fields: err.fields } : {});
  if (err instanceof multer.MulterError) {
    return err.code === "LIMIT_FILE_SIZE"
      ? send(413, "file_too_large", "That file is too large")
      : send(400, "upload_error", `Upload failed: ${err.message}`);
  }
  if (err.code === "ER_DUP_ENTRY") return send(409, "duplicate", "That already exists");
  if (err.code === "ER_NO_REFERENCED_ROW_2") return send(400, "bad_reference", "One of the selected items does not exist");
  if (err.sqlState === "45000") return send(400, "rule_violation", err.sqlMessage); // raised by sp_deactivate_mentor
  if (err.type === "entity.parse.failed") return send(400, "bad_json", "Request body is not valid JSON");
  if (err.type === "entity.too.large") return send(413, "too_large", "Request is too large");

  const status = err.status ?? err.statusCode;
  if (status && status < 500) return send(status, "error", err.message);

  req.log?.error(err);
  return send(500, "server_error", "Something went wrong on our side");
}
