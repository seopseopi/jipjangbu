import { createHmac } from "node:crypto";

// Synthetic authenticated session for tests concerned with backup behavior.
export function attachTestSession(env) {
  const sid = "12345678-1234-4123-8123-123456789012";
  env.APP_ADMIN_PASSWORD_HASH = "synthetic-password-hash";
  const original = env.DB;
  env.DB = {
    ...original,
    prepare(sql) {
      if (sql.startsWith("SELECT id FROM auth_sessions")) return { bind() { return this; }, async first() { return { id: sid }; } };
      return original.prepare(sql);
    },
    batch: original.batch?.bind(original),
  };
  const encoded = Buffer.from(JSON.stringify({ u: env.APP_ADMIN_USERNAME, sid, exp: Date.now() + 60_000 })).toString("base64url");
  const signature = createHmac("sha256", Buffer.from(env.APP_SESSION_SECRET, "hex")).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}
