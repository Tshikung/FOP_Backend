import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

/** Last few emails, kept in memory when SMTP is not configured (used by the tests) */
export const outbox = [];

const transport = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    })
  : null;

/** Returns true if the email was handed to the SMTP server. Never throws. */
export async function sendMail({ to, subject, text }) {
  if (!transport) {
    logger.info({ to, subject, text }, "SMTP not configured: email printed instead of sent");
    outbox.push({ to, subject, text });
    if (outbox.length > 50) outbox.shift();
    return false;
  }
  try {
    await transport.sendMail({ from: env.MAIL_FROM, to, subject, text });
    return true;
  } catch (err) {
    logger.error({ err, to, subject }, "Email failed");
    return false;
  }
}
