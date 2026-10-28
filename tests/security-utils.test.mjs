import assert from "node:assert/strict";
import test from "node:test";

import { safeReturnTo } from "../worker/return-to.js";
import {
  addSecurityHeaders,
  handleSecurityRequest,
  isPublicAsset,
  listBackupSummaries,
  schedulePostMutationBackup,
} from "../worker/security.ts";

test("로컬 글꼴과 라이선스는 로그인 없이 읽되 API·다른 파일·쓰기 요청은 공개하지 않는다", async () => {
  const env = { DB: { prepare() { throw new Error("Font requests must not touch business data"); } } };
  for (const path of ["/fonts/pretendard/PretendardVariable.subset.0.woff2", "/fonts/pretendard/OFL.txt"]) {
    for (const method of ["GET", "HEAD"]) {
      assert.equal(isPublicAsset(path, method), true);
      assert.equal(await handleSecurityRequest(new Request(`https://test.invalid${path}`, { method }), env, { waitUntil() {} }), null);
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(isPublicAsset(path, method), false);
  }
  for (const path of ["/api/work-logs", "/fonts/private.json", "/fonts/pretendard/backup.sql", "/fonts/pretendard/PretendardVariable.subset.0.woff2/private", "/fonts/pretendard/../private.json"]) {
    assert.equal(isPublicAsset(path, "GET"), false);
  }
  const response = await handleSecurityRequest(new Request("https://test.invalid/api/work-logs"), env, { waitUntil() {} });
  assert.equal(response.status, 401);
});

test("공개 글꼴의 캐시는 보존하지만 업무 응답은 저장하지 않는다", () => {
  const response = new Response("font", { headers: { "Cache-Control": "public, max-age=31536000, immutable" } });
  const font = addSecurityHeaders(response, false);
  assert.equal(font.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.equal(font.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(addSecurityHeaders(response).headers.get("Cache-Control"), "no-store");
});

test("safeReturnTo는 같은 출처의 상대 경로만 허용한다", () => {
  for (const value of ["/", "/#customers", "/?q=hello#journal", "/customers?id=1", "/a/../settings"]) {
    const result = safeReturnTo(value);
    assert.equal(new URL(result, "https://jipjangbu.invalid").origin, "https://jipjangbu.invalid");
  }

  assert.equal(safeReturnTo("/a/../settings"), "/settings");
  assert.equal(safeReturnTo("/customers?next=https://example.com"), "/customers?next=https://example.com");
});

test("safeReturnTo는 외부 출처와 역슬래시 우회를 홈으로 보낸다", () => {
  const unsafe = [
    null,
    "https://example.com",
    "//example.com",
    "/\\example.com",
    "/%5cexample.com",
    "/%255cexample.com",
    "/%25255cexample.com",
    "/%2fexample.com",
    "/%252fexample.com",
    "/login",
    "/%6cogin",
    "/login/reset",
    "/api/auth/login",
    "/bad%zz",
  ];

  for (const value of unsafe) assert.equal(safeReturnTo(value), "/", String(value));
});

test("로그인 요청 전에 만료된 시도 기록을 정리한다", async () => {
  const queries = [];
  const db = {
    prepare(sql) {
      const query = { sql, values: [] };
      queries.push(query);
      const statement = {
        bind(...values) {
          query.values = values;
          return statement;
        },
        async first() { return sql.includes("RETURNING attempts") ? { attempts: 1, blocked_until: 0 } : null; },
        async run() { return { meta: { changes: 1 } }; },
      };
      return statement;
    },
  };

  const response = await handleSecurityRequest(new Request("https://jipjangbu.invalid/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
    body: JSON.stringify({ username: "wrong", password: "wrong" }),
  }), {
    DB: db,
    APP_ADMIN_USERNAME: "admin",
    APP_ADMIN_PASSWORD_HASH: "invalid",
    APP_SESSION_SECRET: "11".repeat(32),
  }, { waitUntil() {} });

  assert.equal(response?.status, 401);
  const cleanup = queries.find(({ sql }) => sql.includes("DELETE FROM auth_attempts WHERE updated_at"));
  assert.ok(cleanup);
  assert.equal(cleanup.values.length, 2);
  assert.ok(cleanup.values[0] < cleanup.values[1]);
});

test("백업 목록은 R2 cursor 끝까지 읽고 최신순으로 정렬한다", async () => {
  const cursors = [];
  const backup = (key, createdAt) => ({
    key,
    size: 10,
    uploaded: new Date(createdAt),
    customMetadata: { createdAt, reason: key },
  });
  const bucket = {
    async list(options) {
      cursors.push(options.cursor);
      if (!options.cursor) return {
        objects: [backup("daily/older.json.enc", "2026-01-01T00:00:00.000Z")],
        truncated: true,
        cursor: "page-2",
      };
      return {
        objects: [backup("manual/newer.json.enc", "2026-02-01T00:00:00.000Z")],
        truncated: false,
      };
    },
  };

  const summaries = await listBackupSummaries(bucket);
  assert.deepEqual(cursors, [undefined, "page-2"]);
  assert.deepEqual(summaries.map(({ key }) => key), ["manual/newer.json.enc", "daily/older.json.enc"]);
});

test("성공한 업무 데이터 변경 뒤에만 암호화 백업을 예약한다", async () => {
  const writes = [];
  const pending = [];
  const env = {
    DB: {
      prepare() {
        return { async all() { return { success: true, results: [] }; } };
      },
      async batch(statements) { return Promise.all(statements.map((statement) => statement.all())); },
    },
    BACKUPS: {
      async put(key, value, options) {
        writes.push({ key, value, options });
      },
    },
    BACKUP_ENCRYPTION_KEY: "22".repeat(32),
  };
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const request = new Request("https://jipjangbu.invalid/api/customers", { method: "POST" });

  schedulePostMutationBackup(request, new Response(null, { status: 409 }), env, ctx);
  assert.equal(pending.length, 0);

  schedulePostMutationBackup(request, new Response(null, { status: 201 }), env, ctx);
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  assert.equal(writes.length, 1);
  assert.match(writes[0].key, /^changes\//);
  assert.equal(writes[0].options.customMetadata.reason, "post-post-customers");
  assert.ok(writes[0].value instanceof Uint8Array);
  assert.deepEqual([...writes[0].value.slice(0, 4)], [0x4a, 0x4a, 0x42, 0x31]);
});
