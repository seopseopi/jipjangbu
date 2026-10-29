import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fetchCustomerDirectory } from "../app/customer-directory.ts";

// All writes below are synthetic fixture setup/concurrent-user simulation in
// memory. Production GET handlers are checked to issue read-only statements.
const dbKey = "jipjangbu-customer-directory-consistency-db";
const apiRoot = new URL("../app/api/", import.meta.url).href;
const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(apiRoot)) {
      if (specifier === "../../../db") return { url: moduleUrl(`export function getD1() { return globalThis[Symbol.for(${JSON.stringify(dbKey)})]; }`), shortCircuit: true };
      if (specifier === "../../db/bootstrap") return { url: moduleUrl("export async function ensureDatabase() {}"), shortCircuit: true };
      if (specifier.startsWith(".")) {
        const candidate = new URL(`${specifier}.ts`, context.parentURL);
        if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
const route = await import("../app/api/customers/route.ts");
hook.deregister();

function database(t, count = 2000, specialBoundary = false) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const directory = new URL("../drizzle/", import.meta.url);
  for (const name of readdirSync(directory).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
  const id = (index) => `synthetic-${String(index).padStart(4, "0")}${specialBoundary && index === 999 ? "'_%&+? 한글" : ""}`;
  const insert = sqlite.prepare("INSERT INTO customers (id,name,notes,created_at,updated_at,is_demo) VALUES (?,?,?,'2020-01-01 00:00:00','2020-01-01 00:00:00',0)");
  for (let index = 0; index < count; index++) insert.run(id(index), `예시 ${String(index).padStart(4, "0")}`, `합성 메모 ${index}`);
  const calls = [];
  const db = {
    prepare(sql) {
      assert.match(sql, /^\s*SELECT\b/i, "customer GET is read-only");
      const statement = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...bindings) { values = bindings; return this; },
        async all() { calls.push({ sql, values }); return { results: statement.all(...values) }; },
      };
    },
    async batch(statements) { return Promise.all(statements.map((statement) => statement.all())); },
  };
  globalThis[Symbol.for(dbKey)] = db;
  t.after(() => { sqlite.close(); delete globalThis[Symbol.for(dbKey)]; });
  return { sqlite, id, calls };
}
async function read(url) {
  const result = await route.GET(new Request(new URL(url, "https://synthetic.invalid")));
  assert.equal(result.status, 200);
  return result.json();
}

test("고객 명부 키셋은 다른 기기의 업무 등록·이름 변경으로 정렬이 달라져도 기존 고객을 빠뜨리지 않는다", async (t) => {
  const { sqlite, id, calls } = database(t);
  let pages = 0;
  const result = await fetchCustomerDirectory(async (url) => {
    if (++pages === 2) {
      sqlite.prepare("INSERT INTO work_logs (id,customer_id,work_date,work_type) VALUES ('synthetic-concurrent-work',?,date('now','+9 hours'),'전화')").run(id(1500));
      sqlite.prepare("UPDATE customers SET name='가장 앞에 오는 합성 이름',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id(1700));
    }
    return read(url);
  });
  assert.equal(result.length, 2000);
  assert.equal(new Set(result.map((item) => item.id)).size, 2000);
  for (let index = 0; index < 2000; index++) assert.ok(result.some((item) => item.id === id(index)), id(index));
  assert.equal(result.find((item) => item.id === id(1500)).history_count, 1);
  assert.equal(result.find((item) => item.id === id(1700)).name, "가장 앞에 오는 합성 이름");
  assert.match(calls[0].sql, /ORDER BY c\.id COLLATE BINARY/);
  assert.doesNotMatch(calls[1].sql, /OFFSET/);
  assert.deepEqual(calls[1].values, [id(999)]);
});

test("기존 최근순 OFFSET은 동시 변경에서 누락됨을 재현하고 ID 커서는 같은 변경을 견딘다", async (t) => {
  const { sqlite, id } = database(t);
  const first = await read("/api/customers?sort=recent&offset=0");
  sqlite.prepare("INSERT INTO work_logs (id,customer_id,work_date,work_type) VALUES ('synthetic-move',?,date('now','+9 hours'),'전화')").run(id(1500));
  const second = await read("/api/customers?sort=recent&offset=1000");
  const unsafe = new Set([...first.customers, ...second.customers].map((item) => item.id));
  assert.equal(unsafe.size, 1999, "negative control reproduces the prior omission");
  assert.equal(unsafe.has(id(1500)), false);
  const fixed = await fetchCustomerDirectory(read);
  assert.equal(fixed.length, 2000);
  assert.ok(fixed.some((item) => item.id === id(1500)));
});

test("이미 읽은 영역에 고객이 추가·삭제되어도 커서 이후의 기존 고객은 모두 읽는다", async (t) => {
  const { sqlite, id } = database(t);
  let pages = 0;
  const result = await fetchCustomerDirectory(async (url) => {
    if (++pages === 2) {
      sqlite.prepare("DELETE FROM customers WHERE id=?").run(id(10));
      sqlite.prepare("INSERT INTO customers (id,name) VALUES ('a-new-synthetic','앞쪽 신규 합성 고객')").run();
    }
    return read(url);
  });
  const found = new Set(result.map((item) => item.id));
  for (let index = 1000; index < 2000; index++) assert.ok(found.has(id(index)));
  assert.equal(found.size, 2000);
  // This is a stable scan, not a multi-request database snapshot: the new ID
  // before an already-read cursor is intentionally picked up on the next scan.
  const refreshed = await fetchCustomerDirectory(read);
  assert.ok(refreshed.some((item) => item.id === "a-new-synthetic"));
  assert.equal(refreshed.some((item) => item.id === id(10)), false);
});

test("커서는 특수문자와 한글 ID를 정확히 인코딩·바인딩하고 기존 고객 필드를 유지한다", async (t) => {
  const { id, calls } = database(t, 1001, true);
  const urls = [];
  const result = await fetchCustomerDirectory((url) => { urls.push(url); return read(url); });
  assert.equal(result.length, 1001);
  assert.equal(new URL(urls[1], "https://synthetic.invalid").searchParams.get("after"), id(999));
  assert.deepEqual(calls[1].values, [id(999)]);
  assert.deepEqual(Object.keys(result[0]).sort(), ["id", "name", "notes", "created_at", "updated_at", "is_demo", "history_count", "last_work_date", "directory_sort_date"].sort());
  assert.equal(result[0].notes, "합성 메모 0");
});

test("관리 화면의 검색·정렬·OFFSET은 명부 커서와 분리되어 기존처럼 동작한다", async (t) => {
  database(t, 1002);
  const all = await read("/api/customers?sort=name");
  const remaining = await read("/api/customers?sort=name&offset=1000&after=ignored");
  assert.equal(all.customers.length, 1000);
  assert.ok(all.customers.every((item) => !("directory_sort_date" in item)), "the management response remains unchanged");
  assert.equal(remaining.customers.length, 2);
  const searched = await read("/api/customers?sort=name&q=합성 메모 1001");
  assert.equal(searched.customers.length, 1);
  assert.equal(searched.customers[0].id, "synthetic-1001");
});

test("일부 중복 또는 잘못된 ID 응답을 완전한 명부로 조용히 반환하지 않는다", async () => {
  const first = Array.from({ length: 1000 }, (_, index) => ({ id: `synthetic-${String(index).padStart(4, "0")}` }));
  let calls = 0;
  await assert.rejects(fetchCustomerDirectory(async () => ({ customers: ++calls === 1 ? first : [first.at(-1), { id: "synthetic-new" }] })), /고객 명부가 변경되었습니다/);
  await assert.rejects(fetchCustomerDirectory(async () => ({ customers: [{ id: null }] })), /고객 명부가 변경되었습니다/);
});

test("키셋으로 모은 고객은 SQL 최근 업무·등록순과 같은 순서로 추천한다", async (t) => {
  const { sqlite, id } = database(t, 12);
  const names = ["가람", "가람", "나래", "Alpha", "alpha", "라온", "마루", "홍길동", "힣", "😀", "힐", "beta"];
  names.forEach((name, index) => sqlite.prepare("UPDATE customers SET name=? WHERE id=?").run(name, id(index)));
  const work = sqlite.prepare("INSERT INTO work_logs (id,customer_id,work_date,work_type) VALUES (?,?,date('now','+9 hours',?),'전화')");
  work.run("synthetic-recent-a", id(0), "-1 day");
  work.run("synthetic-recent-b", id(1), "-1 day");
  work.run("synthetic-future", id(5), "+30 days");
  work.run("synthetic-old", id(5), "-10 days");
  // +9-hour date conversion moves this UTC creation into today's Seoul date.
  sqlite.prepare("UPDATE customers SET created_at=datetime(date('now','+9 hours','-1 day') || ' 16:00:00') WHERE id=?").run(id(2));
  const management = await read("/api/customers?sort=recent");
  const directory = await fetchCustomerDirectory(read);
  assert.deepEqual(directory.map((item) => item.id), management.customers.map((item) => item.id));
  assert.equal(directory[0].id, id(2), "new registration uses the same Seoul date as management");
  assert.deepEqual(directory.slice(1, 3).map((item) => item.id), [id(0), id(1)]);
  assert.ok(directory.findIndex((item) => item.id === id(5)) > 2, "future reservations do not move an old customer to the top");
  assert.ok(directory.findIndex((item) => item.id === id(3)) < directory.findIndex((item) => item.id === id(4)), "ASCII case-insensitive name ties use immutable ID");
  assert.ok(directory.findIndex((item) => item.id === id(8)) < directory.findIndex((item) => item.id === id(9)), "Korean and supplementary Unicode match SQLite order");
});

test("1,001번째 ID의 최근 고객도 수집 완료 뒤 추천 목록의 맨 앞에 나타난다", async (t) => {
  const { sqlite, id } = database(t, 1001);
  sqlite.prepare("INSERT INTO work_logs (id,customer_id,work_date,work_type) VALUES ('synthetic-last-recent',?,date('now','+9 hours'),'전화')").run(id(1000));
  const urls = [];
  const directory = await fetchCustomerDirectory((url) => { urls.push(url); return read(url); });
  assert.equal(directory.length, 1001);
  assert.equal(directory[0].id, id(1000));
  assert.equal(new URL(urls[1], "https://synthetic.invalid").searchParams.get("after"), id(999), "display sorting does not change the keyset cursor");
});
