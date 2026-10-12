import crypto from "node:crypto";
import { query, one } from "../config/db.js";

export const newToken = () => crypto.randomBytes(32).toString("base64url");
export const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");

/** Create a one-time token. Only its hash is stored. */
export async function issueToken(userId, purpose, ttlMs) {
  const token = newToken();
  await query(
    "INSERT INTO auth_tokens (user_id, token_hash, purpose, expires_at) VALUES (?, ?, ?, ?)",
    [userId, hashToken(token), purpose, new Date(Date.now() + ttlMs)],
  );
  return token;
}

/** Look at a token without using it up */
export const peekToken = (purpose, token) =>
  one(
    "SELECT * FROM auth_tokens WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()",
    [hashToken(token), purpose],
  );

/** Use a token up. Returns the row, or null if it is invalid, expired or already used. */
export async function consumeToken(purpose, token) {
  const row = await peekToken(purpose, token);
  if (!row) return null;
  const r = await query("UPDATE auth_tokens SET used_at = UTC_TIMESTAMP() WHERE id = ? AND used_at IS NULL", [row.id]);
  return r.affectedRows === 1 ? row : null;
}
