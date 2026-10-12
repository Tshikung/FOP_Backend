// The database uses snake_case, the frontends use camelCase. Every JSON response is converted here.
const BOOLEAN_KEYS = new Set([
  "isFeatured", "isRead", "isPublished", "requirePostApproval", "allowComments",
  "liked", "bookmarked", "rsvped", "viewerFollows", "completed", "headAdmin", "mentor",
]);

const camelKey = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

export function camelize(value) {
  if (Array.isArray(value)) return value.map(camelize);
  if (value && typeof value === "object" && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const key = camelKey(k);
      out[key] = BOOLEAN_KEYS.has(key) && (typeof v === "number" || typeof v === "string") ? Boolean(Number(v)) : camelize(v);
    }
    return out;
  }
  return value;
}
