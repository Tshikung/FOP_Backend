import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { query } from "./config/db.js";
import { camelize } from "./utils/camel.js";
import routes from "./routes/index.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";

export function createApp() {
  const app = express();
  if (env.NODE_ENV === "production") app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(pinoHttp({ logger }));
  // Videos and images are loaded by the portals from another origin, so allow cross-origin resource use
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(cors({ origin: (origin, cb) => cb(null, !origin || env.corsOrigins.includes(origin)), credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  // The database speaks snake_case, the portals speak camelCase
  app.use((_req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body) => json(camelize(body));
    next();
  });

  app.get("/api/v1/health", async (_req, res) => {
    await query("SELECT 1");
    res.json({ ok: true });
  });
  app.use("/api/v1", routes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
