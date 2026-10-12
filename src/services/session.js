import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { query } from "../config/db.js";
import { issueToken } from "./tokens.js";
import { recordActivity } from "./progress.js";

// Each portal gets its own cookies, so you can be signed in as a member in one tab
// and as a mentor in another without the two sessions overwriting each other.
export function portalOf(req) {
  let origin = req.headers.origin ?? "";
  if (!origin && req.headers.referer) {
    try { origin = new URL(req.headers.referer).origin; } catch { /* ignore */ }
  }
  return origin && origin === env.MENTOR_PORTAL_URL ? "mentor" : "member";
}

const base = { httpOnly: true, secure: env.NODE_ENV === "production", sameSite: "lax" };

export const signAccess = (user) =>
  jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: env.ACCESS_TTL_MIN * 60 });

export function setSessionCookies(req, res, user, refreshToken) {
  const p = portalOf(req);
  res.cookie(`access_${p}`, signAccess(user), { ...base, path: "/", maxAge: env.ACCESS_TTL_MIN * 60_000 });
  res.cookie(`refresh_${p}`, refreshToken, { ...base, path: "/api/v1/auth", maxAge: env.REFRESH_TTL_DAYS * 864e5 });
}

export function clearSessionCookies(req, res) {
  const p = portalOf(req);
  res.clearCookie(`access_${p}`, { ...base, path: "/" });
  res.clearCookie(`refresh_${p}`, { ...base, path: "/api/v1/auth" });
}

export async function startSession(req, res, user) {
  const refresh = await issueToken(user.id, "refresh", env.REFRESH_TTL_DAYS * 864e5);
  setSessionCookies(req, res, user, refresh);
  await query("UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?", [user.id]);
  await recordActivity(user.id);
}

/** Sign the user out everywhere (used after password reset and suspension) */
export const revokeRefreshTokens = (userId) =>
  query("UPDATE auth_tokens SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND purpose = 'refresh' AND used_at IS NULL", [userId]);
