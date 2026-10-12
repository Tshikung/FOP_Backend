import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";

const make = (limit) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: () => env.NODE_ENV === "test",
    message: { error: { code: "rate_limited", message: "Too many attempts. Please try again in a few minutes." } },
  });

export const loginLimiter = make(10);
export const authLimiter = make(30);
