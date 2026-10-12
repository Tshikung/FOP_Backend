import mysql from "mysql2/promise";
import { env } from "./env.js";

export const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  timezone: "Z", // DATETIME columns are UTC
  charset: "utf8mb4",
});

// Every connection works in UTC so CURRENT_TIMESTAMP defaults are UTC too
pool.pool.on("connection", (conn) => conn.query("SET time_zone = '+00:00'"));

/** Run a query. SELECT returns rows; INSERT/UPDATE returns { insertId, affectedRows }. */
export const query = async (sql, params = []) => (await pool.query(sql, params))[0];
export const one = async (sql, params = []) => (await query(sql, params))[0] ?? null;

/** Run several statements atomically. `t.query` / `t.one` work like the helpers above. */
export async function tx(fn) {
  const conn = await pool.getConnection();
  const t = {
    query: async (sql, params = []) => (await conn.query(sql, params))[0],
  };
  t.one = async (sql, params = []) => (await t.query(sql, params))[0] ?? null;
  try {
    await conn.beginTransaction();
    const result = await fn(t);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
