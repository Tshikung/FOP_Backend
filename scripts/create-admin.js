// Creates the first Head admin (invites need an existing admin, so this one is made by hand).
// Usage: npm run create-admin -- you@example.com "Your Name" "a-strong-password"
import bcrypt from "bcryptjs";
import { pool, one, tx } from "../src/config/db.js";

const [email, name, password] = process.argv.slice(2);
if (!email || !name || !password) {
  console.error('Usage: npm run create-admin -- you@example.com "Your Name" "a-strong-password"');
  process.exit(1);
}
if (password.length < 8) {
  console.error("Use a password of at least 8 characters.");
  process.exit(1);
}

try {
  if (await one("SELECT id FROM users WHERE email = ?", [email.toLowerCase()])) {
    console.error(`A user with ${email} already exists.`);
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 12);
  const id = await tx(async (t) => {
    const r = await t.query(
      "INSERT INTO users (email, password_hash, display_name, role, status, email_verified_at) VALUES (?, ?, ?, 'head_admin', 'active', UTC_TIMESTAMP())",
      [email.toLowerCase(), hash, name],
    );
    await t.query("INSERT INTO mentor_profiles (user_id, specialty) VALUES (?, 'Club lead')", [r.insertId]);
    return r.insertId;
  });
  console.log(`Head admin created (id ${id}). Sign in to the mentor portal with ${email}.`);
} finally {
  await pool.end();
}
