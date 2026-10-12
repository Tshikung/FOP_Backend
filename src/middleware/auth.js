import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { one } from "../config/db.js";
import { can } from "../services/permissions.js";
import { portalOf } from "../services/session.js";
import { forbidden, unauthorized } from "../utils/httpError.js";

export const STAFF = ["mentor", "head_admin"];

/** Requires a valid session. The user is re-read from the database on every request,
 *  so suspending someone or changing a role takes effect immediately. */
export async function authenticate(req, _res, next) {
  const header = req.headers.authorization;
  const token = req.cookies?.[`access_${portalOf(req)}`] ?? (header?.startsWith("Bearer ") ? header.slice(7) : null);
  if (!token) throw unauthorized();

  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET);
  } catch {
    throw unauthorized("Your session expired", "token_expired");
  }

  const user = await one(
    "SELECT id, email, display_name, username, avatar_url, role, status, experience_level FROM users WHERE id = ?",
    [payload.sub],
  );
  if (!user || user.status !== "active") throw unauthorized("This account is not active", "inactive");
  req.user = user;
  next();
}

export function requireStaff(req, _res, next) {
  if (!STAFF.includes(req.user.role)) throw forbidden("Mentor access only");
  next();
}

export const requirePermission = (key) => (req, _res, next) => {
  if (!can(req.user.role, key)) throw forbidden();
  next();
};

export const isStaff = (user) => STAFF.includes(user.role);
