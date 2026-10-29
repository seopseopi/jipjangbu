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

test("차단 중 반복 요청도 원래 차단 만료를 밀지 않으며 만료 시 새 집계를 시작한다", async (t) => {
  let instant = Date.UTC(2026, 9, 29, 12);
  const start = instant;
  t.mock.method(Date, "now", () => instant);
  const { sqlite, login } = fixture(t);
  for (let i = 0; i < 5; i++) assert.equal((await login("wrong")).status, i === 4 ? 429 : 401);
  for (const seconds of [60, 600, 899]) {
    instant = start + seconds * 1000;
    const response = await login("correct-password");
    assert.equal(response.status, 429);
    assert.equal(Number(response.headers.get("Retry-After")), 900 - seconds);
    assert.equal(sqlite.prepare("SELECT updated_at FROM auth_attempts").get().updated_at, start / 1000);
  }
  instant = start + 900000;
  assert.equal((await login("correct-password")).status, 200, "정확한 만료 시각에 올바른 암호를 허용한다");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM auth_attempts").get().count, 0);
});

test("만료 직후 실패는 새 창의 첫 실패이며 잘못된 JSON 형태는 400으로 응답한다", async (t) => {
  let instant = Date.UTC(2026, 9, 29, 12);
  t.mock.method(Date, "now", () => instant);
  const { sqlite, login, env, ctx } = fixture(t);
  for (let i = 0; i < 5; i++) await login("wrong");
  instant += 901000;
  assert.equal((await login("wrong")).status, 401);
  assert.deepEqual({ ...sqlite.prepare("SELECT attempts, blocked_until FROM auth_attempts").get() }, { attempts: 1, blocked_until: 0 });
  const response = await handleSecurityRequest(new Request("https://example.invalid/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.6" }, body: "null",
  }), env, ctx);
  assert.equal(response.status, 400);
});
