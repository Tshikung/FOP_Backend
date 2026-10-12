import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: process.env.NODE_ENV === "test" ? ".env.test" : ".env" });

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DB_HOST: z.string().default("localhost"),
  DB_PORT: z.coerce.number().default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().default(""),
  DB_NAME: z.string().default("friends_of_python_club"),
  JWT_SECRET: z.string().min(32, "this_is_a_long_jwt:WUanw4rwUaSG44nvQ9qpk2Q5aje"),
  ACCESS_TTL_MIN: z.coerce.number().default(15),
  REFRESH_TTL_DAYS: z.coerce.number().default(14),
  CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:5174"),
  MEMBER_PORTAL_URL: z.string().default("http://localhost:5173"),
  MENTOR_PORTAL_URL: z.string().default("http://localhost:5174"),
  UPLOAD_DIR: z.string().default("./uploads"),
  SMTP_HOST: z.string().default("smtp.gmail.com"),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().default("munyikotshikung@gmail.com"),
  SMTP_PASS: z.string().default("xbzs anuf khgn qrir"),
  MAIL_FROM: z.string().default("Friends of Python <munyikotshikung@gmail.com>"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
};
