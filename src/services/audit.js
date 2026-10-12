import { query } from "../config/db.js";

/** Record a sensitive action in audit_log. Pass t.query to run inside a transaction. */
export const audit = (req, action, entityType, entityId = null, details = null, run = query) =>
  run(
    "INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)",
    [req.user?.id ?? null, action, entityType, entityId, details ? JSON.stringify(details) : null],
  );
