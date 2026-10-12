import { query } from "../config/db.js";

// role -> Set of permission keys. Loaded at startup from the role_permissions table.
const cache = new Map();

export async function loadPermissions() {
  const rows = await query("SELECT role, permission_key FROM role_permissions");
  cache.clear();
  for (const { role, permission_key } of rows) {
    if (!cache.has(role)) cache.set(role, new Set());
    cache.get(role).add(permission_key);
  }
}

export const can = (role, key) => cache.get(role)?.has(key) ?? false;
export const permissionsFor = (role) => [...(cache.get(role) ?? [])];
