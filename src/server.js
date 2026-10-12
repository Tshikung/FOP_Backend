import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { pool } from "./config/db.js";
import { loadPermissions } from "./services/permissions.js";
import { createApp } from "./app.js";

await loadPermissions();
const server = createApp().listen(env.PORT, () => logger.info(`Friends of Python API listening on http://localhost:${env.PORT}/api/v1`));

async function shutdown(signal) {
  logger.info(`${signal} received, shutting down`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
