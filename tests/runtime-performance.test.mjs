import assert from "node:assert/strict";
import { attachTestSession } from "./helpers/security-session.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { handleSecurityRequest } from "../worker/security.ts";
import { STRUCTURE_TABLES } from "../db/structure-schema.js";

const bootstrapUrl = new URL("../db/bootstrap.ts", import.meta.url).href;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === bootstrapUrl && specifier === ".") return {
      url: "data:text/javascript,export function getD1() { throw new Error('Pass the test D1 binding'); }",
      shortCircuit: true,
    };
    return nextResolve(specifier, context);
  },
});
const { ensureDatabase } = await import(bootstrapUrl);
hook.deregister();

const tables = [...STRUCTURE_TABLES,"customers", "work_logs", "work_log_properties", "listings", "listing_source_notes", "listing_events", "work_types", "property_buildings", "follow_ups", "trash_records"];

function database(t, migrated = true) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys = ON");
  if (migrated) {
    const directory = new URL("../drizzle/", import.meta.url);
    for (const name of readdirSync(directory).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) {
      sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
    }
  }
  function binding() {
    const calls = [];
    const batches = [];
    let failure = null;
    const execute = (sql, values, method) => {
      calls.push({ sql, values, method });
      if (failure?.(sql)) { failure = null; throw new Error("Temporary database failure"); }
      const query = sqlite.prepare(sql);
      if (method === "first") return query.get(...values) ?? null;
      if (method === "run") return { success: true, results: [], meta: query.run(...values) };
      return { success: true, results: query.all(...values) };
    };
    const db = {
      prepare(sql) {
        let values = [];
        return {
          bind(...bindings) { values = bindings; return this; },
          async first() { return execute(sql, values, "first"); },
          async run() { return execute(sql, values, "run"); },
          async all() { return execute(sql, values, "all"); },
          execute() { return execute(sql, values, "all"); },
        };
      },
      async batch(statements) {
        batches.push(statements.length);
        sqlite.exec("BEGIN");
        try {
          const results = statements.map((statement) => statement.execute());
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    };
    return { db, calls, batches, failWhen(predicate) { failure = predicate; } };
  }
  return { sqlite, binding, ...binding() };
}

function securityEnvironment(db, bucket = {}) {
  const writes = [];
  const env = {
    DB: db,
    APP_ADMIN_USERNAME: "test-admin",
    APP_SESSION_SECRET: "33".repeat(32),
    BACKUP_ENCRYPTION_KEY: "22".repeat(32),
    BACKUPS: {
      async put(key, value, options) { writes.push({ key, value, options }); },
      ...bucket,
    },
  };
  const token = attachTestSession(env);
  const request = (path, method = "GET") => new Request(`https://test.invalid${path}`, {
    method, headers: { Cookie: `jipjangbu_session=${token}` },
  });
  return { env, writes, request };
}

async function snapshot(write, secret) {
  assert.deepEqual([...write.value.slice(0, 4)], [0x4a, 0x4a, 0x42, 0x31]);
  const key = await crypto.subtle.importKey("raw", Buffer.from(secret, "hex"), "AES-GCM", false, ["decrypt"]);
  const value = await crypto.subtle.decrypt({ name: "AES-GCM", iv: write.value.slice(4, 16) }, key, write.value.slice(16));
  return JSON.parse(new TextDecoder().decode(value));
}

test("초기화 완료된 DB는 새 요청에서도 읽기 1회, 쓰기 0회로 준비되며 완료 여부만 공유한다", async (t) => {
  const { sqlite, db, binding } = database(t);
  await ensureDatabase(db);
  assert.equal(sqlite.prepare("SELECT value FROM app_runtime_state WHERE key = 'bootstrap_version'").get().value, "6");
  // User-maintained lookups must not be silently reinserted on each cold start.
  sqlite.prepare("DELETE FROM work_types WHERE name = '기타'").run();
  const cold = binding();
  const first = ensureDatabase(cold.db);
  const second = ensureDatabase(cold.db);
  assert.notEqual(first, second, "pending request-scoped I/O is never shared");
  await Promise.all([first, second]);
  await ensureDatabase(cold.db);
  assert.equal(cold.calls.length, 2, "each cold request reads once; warm calls read nothing");
  assert.match(cold.calls[0].sql, /^SELECT value FROM app_runtime_state/);
  assert.deepEqual(cold.batches, []);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM work_types WHERE name = '기타'").get().count, 0);
});

test("중단된 첫 요청의 초기화가 끝나지 않아도 새 요청은 독립적으로 준비해 화면을 연다", async (t) => {
  const { db, binding } = database(t);
  await ensureDatabase(db);
  const cold = binding();
  const prepare = cold.db.prepare.bind(cold.db);
  let firstRead = true;
  cold.db.prepare = (sql) => {
    const statement = prepare(sql);
    if (firstRead && /^SELECT value FROM app_runtime_state/.test(sql)) {
      firstRead = false;
      statement.first = () => new Promise(() => {});
    }
    return statement;
  };
  const abandoned = ensureDatabase(cold.db);
  const retry = ensureDatabase(cold.db);
  assert.notEqual(abandoned, retry);
  let timeout;
  try {
    await Promise.race([
      retry,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Retry waited on cancelled request")), 500); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  await ensureDatabase(cold.db);
  assert.equal(cold.calls.length, 1, "only the independent successful readiness read reaches the DB");
  assert.deepEqual(cold.batches, []);
});

test("이전 초기화 요청이 늦게 실패해도 후속 요청의 준비 완료 상태를 지우지 않는다", async (t) => {
  const { db, binding } = database(t);
  await ensureDatabase(db);
  const cold = binding();
  const prepare = cold.db.prepare.bind(cold.db);
  let rejectFirst;
  cold.db.prepare = (sql) => {
    const statement = prepare(sql);
    if (!rejectFirst && /^SELECT value FROM app_runtime_state/.test(sql)) {
      statement.first = () => new Promise((_, reject) => { rejectFirst = reject; });
    }
    return statement;
  };
  const abandoned = ensureDatabase(cold.db);
  const rejected = assert.rejects(abandoned, /originating request cancelled/);
  await ensureDatabase(cold.db);
  rejectFirst(new Error("originating request cancelled"));
  await rejected;
  await ensureDatabase(cold.db);
  assert.equal(cold.calls.length, 1);
});

test("첫 설치만 예시 데이터를 만들고 기존 DB가 비어도 예시를 다시 넣지 않는다", async (t) => {
  const fresh = database(t, false);
  await ensureDatabase(fresh.db);
  assert.equal(fresh.sqlite.prepare("SELECT COUNT(*) AS count FROM work_logs").get().count, 5);
  assert.equal(fresh.sqlite.prepare("SELECT COUNT(*) AS count FROM customers").get().count, 4);
  fresh.sqlite.exec("DELETE FROM follow_ups; DELETE FROM listing_events; DELETE FROM work_log_properties; DELETE FROM work_logs; DELETE FROM customers; DELETE FROM listings; DELETE FROM app_runtime_state;");
  await ensureDatabase(fresh.binding().db);
  assert.equal(fresh.sqlite.prepare("SELECT COUNT(*) AS count FROM work_logs").get().count, 0);
  assert.equal(fresh.sqlite.prepare("SELECT COUNT(*) AS count FROM customers").get().count, 0);
  const existing = database(t);
  existing.sqlite.prepare("INSERT INTO customers (id, name) VALUES ('real', '실제 고객')").run();
  await ensureDatabase(existing.db);
  assert.equal(existing.sqlite.prepare("SELECT COUNT(*) AS count FROM customers").get().count, 1);
  assert.equal(existing.sqlite.prepare("SELECT COUNT(*) AS count FROM work_logs").get().count, 0);
});

test("초기화 실패는 완료표식을 남기지 않고 같은 서버에서 재시도할 수 있다", async (t) => {
  const { sqlite, db, failWhen } = database(t);
  failWhen((sql) => sql.startsWith("INSERT OR IGNORE INTO work_types"));
  await assert.rejects(ensureDatabase(db), /Temporary database failure/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM app_runtime_state").get().count, 0);
  await ensureDatabase(db);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM work_types").get().count, 30);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM app_runtime_state").get().count, 1);
});

test("복원으로 인덱스나 새 기능 테이블이 누락되면 완료표식이 있어도 안전하게 복구한다", async (t) => {
  const { sqlite, db, binding } = database(t);
  await ensureDatabase(db);
  sqlite.exec("DROP INDEX idx_work_logs_date_updated_id; DROP TABLE follow_ups;");
  sqlite.prepare("INSERT INTO customers (id, name) VALUES ('preserved', '보존 고객')").run();
  const cold = binding();
  await ensureDatabase(cold.db);
  assert.ok(cold.batches.length > 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('idx_work_logs_date_updated_id', 'follow_ups')").get().count, 2);
  assert.equal(sqlite.prepare("SELECT name FROM customers WHERE id = 'preserved'").get().name, "보존 고객");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM work_logs").get().count, 0);
});

test("서로 다른 서버가 동시에 최초 준비해도 예시나 기본 설정이 중복되지 않는다", async (t) => {
  const { sqlite, db, binding } = database(t, false);
  await Promise.all([ensureDatabase(db), ensureDatabase(binding().db)]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM work_logs").get().count, 5);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM work_types").get().count, 30);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM app_runtime_state").get().count, 1);
});

test("전체 백업은 구조 도면과 휴지통을 포함한 모든 업무 테이블을 한 batch로 읽고 암호화한다", async (t) => {
  const { sqlite, db, batches, calls } = database(t, false);
  await ensureDatabase(db);
  sqlite.prepare("INSERT INTO follow_ups (id, title, customer_id) VALUES ('task', '연락 확인', 'DEMO-001')").run();
  const expected = Object.fromEntries(tables.map((name) => [name, sqlite.prepare(`SELECT * FROM ${name}`).all()]));
  batches.length = 0;
  calls.length = 0;
  const { env, writes, request } = securityEnvironment(db);
  const response = await handleSecurityRequest(request("/api/backups", "POST"), env, { waitUntil() {} });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(batches, [tables.length]);
  assert.equal(calls.length, tables.length);
  assert.equal(writes.length, 1);
  const backup = await snapshot(writes[0], env.BACKUP_ENCRYPTION_KEY);
  assert.equal(backup.format, "jipjangbu-backup-v1");
  assert.deepEqual(backup.tables, JSON.parse(JSON.stringify(expected)));
  assert.deepEqual(backup.counts, Object.fromEntries(tables.map((name) => [name, expected[name].length])));
});

test("이전 DB의 할 일 테이블이 없어도 다른 데이터는 빠짐없이 백업한다", async (t) => {
  const { sqlite, db, batches } = database(t);
  sqlite.exec("DROP TABLE follow_ups;");
  sqlite.prepare("INSERT INTO customers (id, name) VALUES ('real', '보존 고객')").run();
  const { env, writes, request } = securityEnvironment(db);
  assert.equal((await handleSecurityRequest(request("/api/backups", "POST"), env, { waitUntil() {} })).status, 201);
  assert.deepEqual(batches, [tables.length, tables.length-1]);
  const backup = await snapshot(writes[0], env.BACKUP_ENCRYPTION_KEY);
  assert.equal(backup.tables.customers[0].id, "real");
  assert.deepEqual(backup.tables.follow_ups, []);
  assert.equal(backup.counts.follow_ups, 0);
  assert.deepEqual(Object.keys(backup.tables), tables);
});

test("백업 읽기 실패나 잘못된 batch 결과는 변경을 차단하고 불완전한 백업을 저장하지 않는다", async (t) => {
  t.mock.method(console, "error", () => {});
  const { db, failWhen } = database(t);
  const { env, writes, request } = securityEnvironment(db);
  failWhen((sql) => sql === "SELECT * FROM listings");
  const response = await handleSecurityRequest(request("/api/customers", "POST"), env, { waitUntil() {} });
  assert.equal(response.status, 503);
  assert.equal(writes.length, 0);
  assert.equal(await handleSecurityRequest(request("/api/customers", "POST"), env, { waitUntil() {} }), null);
  assert.equal(writes.length, 1);
  const authPrepare = env.DB.prepare.bind(env.DB);
  env.DB = { prepare(sql) { return sql.startsWith("SELECT id FROM auth_sessions") ? authPrepare(sql) : {}; }, async batch() { return [{ success: false, results: [] }]; } };
  assert.equal((await handleSecurityRequest(request("/api/customers", "POST"), env, { waitUntil() {} })).status, 503);
  assert.equal(writes.length, 1);
});

test("일일 백업 동시 확인을 공유하고 완료 후 다시 확인하며 기존 90일 보관 정책을 유지한다", async (t) => {
  const { db, batches } = database(t);
  let release;
  let heads = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const deleted = [];
  const { env, writes, request } = securityEnvironment(db, {
    async head() { heads++; await gate; return writes.length ? {} : null; },
    async list() { return { truncated: false, objects: [
      { key: "daily/expired.json.enc", uploaded: new Date(Date.now() - 91 * 86400_000) },
      { key: "daily/retained.json.enc", uploaded: new Date() },
      { key: "structure-assets/old-plan.png", uploaded: new Date(Date.now() - 100 * 86400_000) },
    ] }; },
    async delete(keys) { deleted.push(...keys); },
  });
  const pending = [];
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  await Promise.all(Array.from({ length: 5 }, () => handleSecurityRequest(request("/api/bootstrap"), env, ctx)));
  assert.equal(heads, 1);
  release();
  await Promise.all(pending);
  assert.equal(writes.length, 1);
  assert.deepEqual(batches, [tables.length]);
  assert.deepEqual(deleted, ["daily/expired.json.enc"]);
  await handleSecurityRequest(request("/api/bootstrap"), env, ctx);
  await Promise.all(pending);
  assert.equal(heads, 2);
  assert.equal(writes.length, 1);
});

test("일일 백업 실패는 캐시하지 않고 다음 방문에서 재시도한다", async (t) => {
  t.mock.method(console, "error", () => {});
  const { db } = database(t);
  let heads = 0;
  const { env, writes, request } = securityEnvironment(db, {
    async head() { if (++heads === 1) throw new Error("Temporary storage failure"); return null; },
    async list() { return { truncated: false, objects: [] }; },
  });
  const pending = [];
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  await handleSecurityRequest(request("/api/bootstrap"), env, ctx);
  await Promise.all(pending);
  assert.equal(writes.length, 0);
  await handleSecurityRequest(request("/api/bootstrap"), env, ctx);
  await Promise.all(pending);
  assert.equal(heads, 2);
  assert.equal(writes.length, 1);
});
