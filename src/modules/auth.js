import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { env } from "../config/env.js";
import { query, one } from "../config/db.js";
import { validate } from "../middleware/validate.js";
import { loginLimiter, authLimiter } from "../middleware/rateLimit.js";
import { HttpError, conflict, dupAs, unauthorized } from "../utils/httpError.js";
import { publicUser } from "../utils/user.js";
import { issueToken, peekToken, consumeToken } from "../services/tokens.js";
import { startSession, setSessionCookies, clearSessionCookies, revokeRefreshTokens, portalOf } from "../services/session.js";
import { sendMail } from "../services/mailer.js";

export const authRouter = Router();

const password = z.string().min(8, "Use at least 8 characters").max(72, "Use at most 72 characters");
const email = z.string().trim().toLowerCase().email("Enter a valid email address");
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 12); // keeps login timing the same for unknown emails

authRouter.post(
  "/register",
  authLimiter,
  validate({
    body: z.object({
      email,
      password,
      displayName: z.string().trim().min(2, "Enter your name").max(100),
      experienceLevel: z.enum(["new", "basics", "experienced"]).default("new"),
    }),
  }),
  async (req, res) => {
    const b = req.valid.body;
    const hash = await bcrypt.hash(b.password, 12);
    const r = await dupAs("An account with this email already exists", () =>
      query("INSERT INTO users (email, password_hash, display_name, experience_level) VALUES (?, ?, ?, ?)", [
        b.email, hash, b.displayName, b.experienceLevel,
      ]),
    );
    const user = await one("SELECT * FROM users WHERE id = ?", [r.insertId]);
    await startSession(req, res, user);
    res.status(201).json({ user: publicUser(user) });
  },
);

authRouter.post(
  "/login",
  loginLimiter,
  validate({ body: z.object({ email, password: z.string().min(1, "Enter your password") }) }),
  async (req, res) => {
    const { email: addr, password: pw } = req.valid.body;
    const user = await one("SELECT * FROM users WHERE email = ?", [addr]);
    const ok = await bcrypt.compare(pw, user?.password_hash ?? DUMMY_HASH);
    if (!user || !user.password_hash || !ok) throw new HttpError(401, "Email or password is incorrect", "bad_credentials");
    if (user.status === "invited") throw new HttpError(403, "Open the invite email to set your password first", "invite_pending");
    if (user.status !== "active") throw new HttpError(403, `This account is ${user.status}. Please contact the club.`, "account_blocked");
    await startSession(req, res, user);
    res.json({ user: publicUser(user) });
  },
);

// Swap the refresh cookie for a new access token (the old refresh token is used up)
authRouter.post("/refresh", async (req, res) => {
  const token = req.cookies?.[`refresh_${portalOf(req)}`];
  const row = token ? await consumeToken("refresh", token) : null;
  if (!row) throw unauthorized("Please sign in again", "session_expired");
  const user = await one("SELECT * FROM users WHERE id = ?", [row.user_id]);
  if (!user || user.status !== "active") throw unauthorized("This account is not active", "inactive");
  const refresh = await issueToken(user.id, "refresh", env.REFRESH_TTL_DAYS * 864e5);
  setSessionCookies(req, res, user, refresh);
  res.json({ user: publicUser(user) });
});

authRouter.post("/logout", async (req, res) => {
  const token = req.cookies?.[`refresh_${portalOf(req)}`];
  if (token) await consumeToken("refresh", token);
  clearSessionCookies(req, res);
  res.json({ ok: true });
});

const portalUrl = (user) => (user.role === "member" ? env.MEMBER_PORTAL_URL : env.MENTOR_PORTAL_URL);

authRouter.post("/forgot-password", authLimiter, validate({ body: z.object({ email }) }), async (req, res) => {
  const user = await one("SELECT id, email, display_name, role, status FROM users WHERE email = ?", [req.valid.body.email]);
  if (user?.status === "active") {
    const token = await issueToken(user.id, "password_reset", 60 * 60 * 1000);
    await sendMail({
      to: user.email,
      subject: "Reset your Friends of Python password",
      text: `Hi ${user.display_name},\n\nUse this link within one hour to choose a new password:\n${portalUrl(user)}/reset-password?token=${token}\n\nIf you did not ask for this, you can ignore this email.`,
    });
  }
  // Same answer whether or not the email exists
  res.json({ message: "If that email has an account, a reset link is on its way." });
});

authRouter.post(
  "/reset-password",
  loginLimiter,
  validate({ body: z.object({ token: z.string().min(10), password }) }),
  async (req, res) => {
    const row = await consumeToken("password_reset", req.valid.body.token);
    if (!row) throw new HttpError(400, "This reset link is invalid or has expired", "bad_token");
    await query("UPDATE users SET password_hash = ? WHERE id = ?", [await bcrypt.hash(req.valid.body.password, 12), row.user_id]);
    await revokeRefreshTokens(row.user_id); // sign out every device
    res.json({ ok: true });
  },
);

// The accept-invite page calls this first to show who the invite is for
authRouter.get("/invite/:token", async (req, res) => {
  const row = await peekToken("invite", req.params.token);
  const user = row && (await one("SELECT email, display_name, status FROM users WHERE id = ?", [row.user_id]));
  if (!user || user.status !== "invited") throw new HttpError(404, "This invite is invalid or has expired", "bad_token");
  res.json({ email: user.email, display_name: user.display_name });
});

authRouter.post(
  "/accept-invite",
  loginLimiter,
  validate({ body: z.object({ token: z.string().min(10), password }) }),
  async (req, res) => {
    const row = await consumeToken("invite", req.valid.body.token);
    if (!row) throw new HttpError(400, "This invite is invalid or has expired", "bad_token");
    const user = await one("SELECT * FROM users WHERE id = ?", [row.user_id]);
    if (!user || user.status !== "invited") throw conflict("This invite has already been used");
    await query(
      "UPDATE users SET password_hash = ?, status = 'active', email_verified_at = UTC_TIMESTAMP() WHERE id = ?",
      [await bcrypt.hash(req.valid.body.password, 12), user.id],
    );
    const fresh = await one("SELECT * FROM users WHERE id = ?", [user.id]);
    await startSession(req, res, fresh);
    res.json({ user: publicUser(fresh) });
  },
);
