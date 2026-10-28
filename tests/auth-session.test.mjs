import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { pbkdf2Sync } from "node:crypto";
import { handleSecurityRequest } from "../worker/security.ts";

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const db = { prepare(sql) { let values = []; return {
    bind(...args) { values = args; return this; },
    async first() { return sqlite.prepare(sql).get(...values) ?? null; },
    async run() { const result = sqlite.prepare(sql).run(...values); return { meta: { changes: Number(result.changes) } }; },
  }; } };
  const salt = Buffer.from("12".repeat(16), "hex");
  const hash = pbkdf2Sync("correct-password", salt, 100000, 32, "sha256").toString("hex");
  const env = { DB: db, APP_ADMIN_USERNAME: "admin", APP_ADMIN_PASSWORD_HASH: `pbkdf2_sha256$100000$${salt.toString("hex")}$${hash}`, APP_SESSION_SECRET: "33".repeat(32) };
  const ctx = { waitUntil() {} };
  const login = (password) => handleSecurityRequest(new Request("https://example.invalid/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.5" }, body: JSON.stringify({ username: "admin", password }) }), env, ctx);
  return { sqlite, env, ctx, login };
}

test("동시 로그인 실패도 원자적으로 누적해 추가 시도를 차단한다", async (t) => {
  const { sqlite, login } = fixture(t);
  const responses = await Promise.all(Array.from({ length: 10 }, () => login("wrong")));
  assert.equal(responses.filter((response) => response.status === 401).length, 4);
  assert.equal(responses.filter((response) => response.status === 429).length, 6);
  assert.equal(sqlite.prepare("SELECT attempts FROM auth_attempts").get().attempts, 10);
});

test("로그아웃과 암호 변경은 복사된 쿠키도 무효화한다", async (t) => {
  const { env, ctx, login } = fixture(t);
  const signedIn = await login("correct-password");
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers.get("set-cookie").split(";")[0];
  const request = (path, method = "GET") => new Request(`https://example.invalid${path}`, { method, headers: { Cookie: cookie } });
  assert.equal(await handleSecurityRequest(request("/api/search"), env, ctx), null);
  assert.equal((await handleSecurityRequest(request("/api/auth/logout", "POST"), env, ctx)).status, 200);
  assert.equal((await handleSecurityRequest(request("/api/search"), env, ctx)).status, 401);
  const second = await login("correct-password");
  const secondCookie = second.headers.get("set-cookie").split(";")[0];
  env.APP_ADMIN_PASSWORD_HASH += "changed";
  assert.equal((await handleSecurityRequest(new Request("https://example.invalid/api/search", { headers: { Cookie: secondCookie } }), env, ctx)).status, 401);
});
