import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WORK_SUMMARY_SQL } from "../app/api/_queries.ts";

const dbKey = "jipjangbu-query-performance-db";
const apiRoot = new URL("../app/api/", import.meta.url).href;
const moduleUrl = (source) =>
  `data:text/javascript,${encodeURIComponent(source)}`;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(apiRoot)) {
      if (specifier === "../../../db")
        return {
          url: moduleUrl(
            `export function getD1() { return globalThis[Symbol.for(${JSON.stringify(dbKey)})]; }`,
          ),
          shortCircuit: true,
        };
      if (specifier === "../../db/bootstrap")
        return {
          url: moduleUrl("export async function ensureDatabase() {}"),
          shortCircuit: true,
        };
      if (["../_shared", "../_ordering", "../_queries"].includes(specifier))
        return {
          url: new URL(`${specifier}.ts`, context.parentURL).href,
          shortCircuit: true,
        };
      if (specifier === "./data")
        return {
          url: moduleUrl(
            "export class InputError extends Error {} export async function saveWorkLog() { throw new Error('Read-only query test'); }",
          ),
          shortCircuit: true,
        };
    }
    return nextResolve(specifier, context);
  },
});
const [workRoute, bootstrapRoute, insightsRoute, customerRoute, listingRoute, lookupRoute, searchRoute] = await Promise.all([
  import("../app/api/work-logs/route.ts"),
  import("../app/api/bootstrap/route.ts"),
  import("../app/api/insights/route.ts"),
  import("../app/api/customers/route.ts"),
  import("../app/api/listings/route.ts"),
  import("../app/api/lookups/route.ts"),
  import("../app/api/search/route.ts"),
]);
hook.deregister();

// This is the pre-optimization projection, retained solely to verify exact
// values and compare SQLite's plan, including rows with no property details.
const propertyColumns = [
  "property_type",
  "building_name",
  "building_dong",
  "unit_number",
  "size_type",
  "sale_price",
  "jeonse_price",
  "monthly_rent",
];
const LEGACY_SUMMARY_SQL = `SELECT w.id, w.work_date, w.customer_id, w.work_type, w.content, w.is_demo, w.updated_at,
  c.name AS customer_name,
  ${propertyColumns.map((column) => `(SELECT p.${column} FROM work_log_properties p WHERE p.work_log_id = w.id ORDER BY p.sequence LIMIT 1) AS ${column}`).join(",")},
  (SELECT COUNT(*) FROM work_log_properties p WHERE p.work_log_id = w.id) AS property_count
  FROM work_logs w JOIN customers c ON c.id = w.customer_id`;
const RECENT_ORDER = "ORDER BY w.work_date DESC, w.updated_at DESC, w.id DESC";

function database(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const directory = new URL("../drizzle/", import.meta.url);
  for (const name of readdirSync(directory)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort()) {
    sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
  }
  const statements = [];
  const calls = { batch: 0, direct: 0 };
  const db = {
    prepare(sql) {
      const statement = { sql, values: [] };
      statements.push(statement);
      const query = sqlite.prepare(sql);
      return {
        bind(...bindings) {
          statement.values = bindings;
          return this;
        },
        async first() {
          calls.direct++;
          return query.get(...statement.values) ?? null;
        },
        async all() {
          calls.direct++;
          return this.execute();
        },
        execute() {
          return { results: query.all(...statement.values) };
        },
      };
    },
    async batch(queries) {
      calls.batch++;
      return queries.map((query) => query.execute());
    },
  };
  globalThis[Symbol.for(dbKey)] = db;
  t.after(() => {
    sqlite.close();
    delete globalThis[Symbol.for(dbKey)];
  });
  const customer = (id = "customer", name = "고객") =>
    sqlite
      .prepare("INSERT INTO customers (id, name) VALUES (?, ?)")
      .run(id, name);
  const work = (
    id,
    date,
    customerId = "customer",
    type = "전화",
    updated = date,
    demo = 0,
  ) =>
    sqlite
      .prepare(
        "INSERT INTO work_logs (id,work_date,customer_id,work_type,updated_at,is_demo) VALUES (?,?,?,?,?,?)",
      )
      .run(id, date, customerId, type, updated, demo);
  const property = (id, workId, sequence, label = id) =>
    sqlite
      .prepare(
        "INSERT INTO work_log_properties (id,work_log_id,sequence,property_type,building_name,building_dong,unit_number,size_type,sale_price,jeonse_price,monthly_rent) VALUES (?,?,?,'아파트',?,'2','10','33','50000','30000','100')",
      )
      .run(id, workId, sequence, label);
  const plan = (sql, values = []) =>
    sqlite
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...values)
      .map((row) => row.detail);
  return { sqlite, statements, calls, customer, work, property, plan };
}

const request = (params = {}) =>
  new Request(
    `https://test.invalid/api/work-logs?${new URLSearchParams(params)}`,
  );
const ids = (rows) => rows.map((row) => row.id);

const legacyProjection = (rows) => rows.map(({ source, properties_json, ...row }) => {
  assert.equal(typeof source === "string" || source === null, true);
  assert.equal(typeof properties_json, "string");
  return row;
});

test("전체 물건을 포함한 업무 요약은 기존 대표 값을 보존하면서 반복 조회를 9회에서 3회로 줄인다", (t) => {
  const { sqlite, customer, work, property, plan } = database(t);
  customer();
  work("none", "2026-01-01");
  work("many", "2026-01-02");
  work("same-sequence", "2026-01-03");
  property("later", "many", 2);
  property("first", "many", 1);
  property("inserted-first", "same-sequence", 1);
  property("inserted-next", "same-sequence", 1);
  const legacy = `${LEGACY_SUMMARY_SQL} ${RECENT_ORDER}`;
  const current = `${WORK_SUMMARY_SQL} ${RECENT_ORDER}`;
  assert.deepEqual(legacyProjection(sqlite.prepare(current).all()), sqlite.prepare(legacy).all().map((row) => ({ ...row })));
  const counts = (query) =>
    plan(query).filter((detail) =>
      detail.includes("CORRELATED SCALAR SUBQUERY"),
    ).length;
  assert.equal(counts(legacy), 9);
  assert.equal(counts(current), 3);
  assert.ok(
    plan(current).some((detail) =>
      /first_property USING COVERING INDEX idx_work_log_properties_log/.test(
        detail,
      ),
    ),
  );
  assert.ok(
    plan(current).some((detail) => /p USING INTEGER PRIMARY KEY/.test(detail)),
  );
});

test("업무 목록의 월·고객·업무구분 필터는 실제 바인딩 SQL에서 복합 인덱스를 탐색하고 별도 정렬을 생략한다", async (t) => {
  const { customer, work, statements, calls, plan } = database(t);
  customer();
  work("leap-day", "2024-02-29");
  work("next-month", "2024-03-01");
  const cases = [
    [{ month: "2024-02" }, "idx_work_logs_date_updated_id"],
    [{ customerId: "customer" }, "idx_work_logs_customer_date_updated_id"],
    [{ workType: "전화" }, "idx_work_logs_type_date_updated_id"],
    [{ from: "2024-02-01", to: "2024-02-29" }, "idx_work_logs_date_updated_id"],
  ];
  for (const [params, index] of cases) {
    statements.length = 0;
    const result = await (await workRoute.GET(request(params))).json();
    assert.ok(result.workLogs.length > 0);
    const query = statements.find((item) =>
      item.sql.includes("LEFT JOIN work_log_properties"),
    );
    const details = plan(query.sql, query.values);
    assert.ok(
      details.some((detail) =>
        detail.includes(`SEARCH w USING INDEX ${index}`),
      ),
      details.join("\n"),
    );
    assert.equal(
      details.some((detail) => detail.includes("TEMP B-TREE FOR ORDER BY")),
      false,
      details.join("\n"),
    );
  }
  assert.equal(calls.batch, cases.length);
  assert.equal(calls.direct, 0);
  const legacyPlan = plan(
    `${LEGACY_SUMMARY_SQL}
    WHERE (? = '' OR w.work_type = ?) AND (? = '' OR w.customer_id = ?)
      AND (? = '' OR substr(w.work_date,1,7) = ?) ${RECENT_ORDER} LIMIT ?`,
    ["", "", "", "", "2024-02", "2024-02", 100],
  );
  assert.equal(
    legacyPlan.some((detail) => /SEARCH w USING INDEX/.test(detail)),
    false,
  );
});

test("최적화한 업무 필터는 월 경계·복합조건·검색·페이지 및 전체 건수를 유지한다", async (t) => {
  const { customer, work, property } = database(t);
  customer();
  customer("other", "다른 고객");
  work("previous", "2024-01-31");
  work("a", "2024-02-01");
  work("b", "2024-02-29", "customer", "매물등록", "2024-03-01");
  work("c", "2024-02-29", "customer", "전화", "2024-03-02");
  work("other", "2024-02-29", "other");
  work("next", "2024-03-01");
  work("december", "2024-12-31");
  work("new-year", "2025-01-01");
  work("maximum", "9999-12-31");
  property("matching", "b", 1, "찾을단지");
  const load = async (params) => (await workRoute.GET(request(params))).json();
  let result = await load({
    month: "2024-02",
    customerId: "customer",
    limit: "1",
    offset: "1",
  });
  assert.deepEqual(ids(result.workLogs), ["b"]);
  assert.equal(result.total, 3);
  result = await load({
    month: "2024-02",
    from: "2024-02-10",
    to: "2024-02-29",
    customerId: "customer",
    workType: "매물등록",
  });
  assert.deepEqual(ids(result.workLogs), ["b"]);
  assert.equal(result.total, 1);
  result = await load({ q: "찾을단지" });
  assert.deepEqual(ids(result.workLogs), ["b"]);
  assert.equal(result.total, 1);
  for (const month of ["2024-13", "invalid", "2024-02' OR 1=1 --"]) {
    assert.deepEqual(await load({ month }), { workLogs: [], total: 0 });
  }
  result = await load({ month: "2024-02", offset: "999" });
  assert.deepEqual(result.workLogs, []);
  assert.equal(result.total, 4);
  assert.deepEqual(ids((await load({ month: "2024-12" })).workLogs), [
    "december",
  ]);
  assert.deepEqual(ids((await load({ month: "9999-12" })).workLogs), [
    "maximum",
  ]);
});

test("홈은 한 DB 왕복으로 데이터를 읽고 실제 업무 유무만 검사해 예시모드를 결정한다", async (t) => {
  const { sqlite, customer, work, calls, statements } = database(t);
  customer();
  work("demo", "2026-01-01", "customer", "전화", "2026-01-01", 1);
  let result = await (await bootstrapRoute.GET()).json();
  assert.equal(result.demoMode, true);
  sqlite.prepare("UPDATE work_logs SET is_demo = 0 WHERE id = 'demo'").run();
  result = await (await bootstrapRoute.GET()).json();
  assert.equal(result.demoMode, false);
  assert.deepEqual(Object.keys(result.metrics).sort(), [
    "active_listing_count",
    "customer_count",
    "today_count",
    "upcoming_count",
  ]);
  assert.equal(calls.batch, 2);
  assert.equal(calls.direct, 0);
  assert.equal(statements.length, 8);
});

test("분류와 통합검색은 각각 한 DB 왕복으로 읽고 검색·전체 물건 값을 보존한다", async (t) => {
  const { sqlite, customer, work, property, calls } = database(t);
  sqlite.exec("INSERT INTO work_types(name,sort_order) VALUES ('전화',2),('매물등록',1)");
  sqlite.exec("INSERT INTO property_buildings(id,property_type,building_name,sort_order) VALUES ('synthetic-building','아파트','검증단지',1)");
  customer("customer", "검증 고객");
  work("many", "2026-09-01");
  property("first", "many", 1, "다른단지");
  property("matching", "many", 2, "검증단지");
  const lookups = await (await lookupRoute.GET()).json();
  assert.deepEqual(lookups.workTypes, ["매물등록", "전화"]);
  assert.deepEqual(lookups.propertyTypes, ["아파트"]);
  assert.deepEqual(lookups.buildings, [{ id: "synthetic-building", property_type: "아파트", building_name: "검증단지" }]);
  const search = await (await searchRoute.GET(new Request("https://test.invalid/api/search?q=검증단지"))).json();
  assert.deepEqual(ids(search.workLogs), ["many"]);
  assert.equal(search.workLogs[0].building_name, "검증단지");
  assert.equal(search.workLogs[0].property_count, 2);
  assert.deepEqual(JSON.parse(search.workLogs[0].properties_json).map((row) => row.id), ["first", "matching"]);
  assert.equal(calls.batch, 2);
  assert.equal(calls.direct, 0);
});

test("매물 종류를 지정하면 기존 종류 인덱스로 탐색하며 전체·빈 조건도 그대로 처리한다", async (t) => {
  const { sqlite, statements, plan } = database(t);
  sqlite.exec(`INSERT INTO listings(id,identity_key,status,property_type,building_name,closed_at)
    VALUES ('apartment','아파트|가단지||','매물등록','아파트','가단지',NULL),
      ('villa','빌라|나단지||','매물등록','빌라','나단지',NULL),
      ('closed','빌라|다단지||','타계약확인','빌라','다단지','2026-09-01')`);
  const read = async (query) => (await listingRoute.GET(new Request(`https://test.invalid/api/listings?${query}`))).json();
  assert.deepEqual(ids((await read("state=all&type=빌라")).listings), ["villa", "closed"]);
  const query = statements.at(-1);
  assert.deepEqual(query.values, ["빌라", 0]);
  assert.ok(plan(query.sql, query.values).some((detail) => /SEARCH listings USING INDEX idx_listings_building \(property_type=\?\)/.test(detail)));
  assert.deepEqual(ids((await read("state=all")).listings), ["villa", "closed", "apartment"]);
  assert.deepEqual(ids((await read("type=빌라")).listings), ["villa", "closed"]);
  assert.deepEqual(ids((await read("state=active&type=빌라")).listings), ["villa"]);
  assert.deepEqual(ids((await read("state=closed&type=빌라")).listings), ["closed"]);
  assert.deepEqual((await read("state=all&type=없음")).listings, []);
});

test("매물 상태와 가격 입력 여부는 AND로 조합하고 복수 가격은 OR로 조회한다", async (t) => {
  const { sqlite } = database(t);
  const insert = sqlite.prepare("INSERT INTO listings(id,identity_key,status,property_type,building_name,sale_price,jeonse_price,monthly_rent) VALUES (?,?,?,?,?,?,?,?)");
  insert.run("sale","sale","매물등록","아파트","합성가","3억","","");
  insert.run("jeonse","jeonse","매물수정","아파트","합성나","","2억","");
  insert.run("monthly","monthly","매물수정","아파트","합성다","","","1000/50");
  insert.run("both","both","가계약","빌라","합성라","4억","3억","");
  insert.run("blank","blank","잔금","빌라","합성마"," ","\t","");
  const read = async query => listingRoute.GET(new Request(`https://test.invalid/api/listings?${query}`));
  const found = async query => ids((await (await read(query)).json()).listings).sort();
  assert.equal((await found("")).length,5);
  assert.deepEqual(await found("status=매물수정"),["jeonse","monthly"]);
  assert.deepEqual(await found("status=매물등록&status=매물수정"),["jeonse","monthly","sale"]);
  assert.deepEqual(await found("status=매물등록&status=가계약&price=jeonse"),["both"]);
  assert.deepEqual(await found("price=jeonse"),["both","jeonse"]);
  assert.deepEqual(await found("price=jeonse&price=monthly"),["both","jeonse","monthly"]);
  assert.deepEqual(await found("status=매물수정&price=jeonse&price=monthly&type=아파트&q=합성나"),["jeonse"]);
  assert.deepEqual(await found("price=sale&price=jeonse&price=monthly"),["both","jeonse","monthly","sale"]);
  assert.deepEqual(await found("status=' OR 1=1 --"),[]);
  assert.equal((await read("price=__proto__")).status,400);
  assert.equal((await read("price=sale_price")).status,400);
  assert.deepEqual(await found("status=매물등록&status=잔금"),["blank","sale"]);
  assert.equal((await read("status=%20")).status,400);
});

test("고객 명부 4,000명·업무 160,000건은 반환할 1,000명만 집계하고 기존 결과·ID 커서를 보존한다", async (t) => {
  const { sqlite, statements, plan } = database(t);
  const customer = sqlite.prepare("INSERT INTO customers(id,name,notes,created_at) VALUES (?,?,?,'2020-01-01 00:00:00')");
  const work = sqlite.prepare("INSERT INTO work_logs(id,customer_id,work_date,work_type) VALUES (?,?,?,'전화')");
  sqlite.exec("BEGIN");
  for (let index = 0; index < 4000; index++) {
    const id = `synthetic-${String(index).padStart(4, "0")}`;
    customer.run(id, `합성 고객 ${index}`, `메모 ${index}`);
    for (let entry = 0; entry < 40; entry++) work.run(`${id}-${entry}`, id, `2026-09-${String(entry % 30 + 1).padStart(2, "0")}`);
  }
  sqlite.exec("COMMIT; PRAGMA optimize");
  const result = await (await customerRoute.GET(new Request("https://test.invalid/api/customers?directory=1&after=synthetic-0009"))).json();
  const query = statements.at(-1);
  const oldLast = "MAX(CASE WHEN w.work_date <= date('now','+9 hours') THEN w.work_date END)";
  const legacy = sqlite.prepare(`SELECT c.id,c.name,c.notes,c.created_at,c.updated_at,c.is_demo,
    COUNT(w.id) AS history_count,${oldLast} AS last_work_date,
    COALESCE(${oldLast}, date(c.created_at,'+9 hours'), '1900-01-01') AS directory_sort_date
    FROM customers c LEFT JOIN work_logs w ON w.customer_id=c.id
    WHERE (1) AND c.id > ? COLLATE BINARY GROUP BY c.id ORDER BY c.id COLLATE BINARY LIMIT 1000`);
  assert.deepEqual(result.customers, legacy.all(...query.values).map((row) => ({ ...row })));
  const details = plan(query.sql, query.values);
  assert.equal(details.some((detail) => /TEMP B-TREE/.test(detail)), false, details.join("\n"));
  assert.ok(details.some((detail) => /SEARCH c USING INDEX sqlite_autoindex_customers_1 \(id>\?\)/.test(detail)), details.join("\n"));
  assert.ok(details.some((detail) => /SEARCH w USING COVERING INDEX idx_work_logs_customer_date_updated_id \(customer_id=\? AND work_date<\?\)/.test(detail)), details.join("\n"));
  const optimized = sqlite.prepare(query.sql);
  const median = (statement) => {
    const samples = [];
    for (let i = 0; i < 9; i++) {
      const start = performance.now();
      statement.all(...query.values);
      samples.push(performance.now() - start);
    }
    return samples.sort((a, b) => a - b)[4];
  };
  const before = median(legacy);
  const after = median(optimized);
  t.diagnostic(`Synthetic directory 4,000 customers / 160,000 works: median before ${before.toFixed(2)} ms, after ${after.toFixed(2)} ms (${(before / after).toFixed(2)}x).`);
});

test("월간 분석은 달별 날짜범위 탐색을 사용하며 경계 날짜·고객 수·빈 달을 정확히 집계한다", async (t) => {
  const { sqlite, customer, work, statements, plan } = database(t);
  const dates = sqlite
    .prepare(
      `SELECT date('now','+9 hours','start of month') AS current,
    date('now','+9 hours','start of month','-1 day') AS previous,
    date('now','+9 hours','start of month','+1 month') AS next`,
    )
    .get();
  customer();
  customer("other");
  work("current-a", dates.current);
  work("current-b", dates.current, "other", "매물등록");
  work("previous", dates.previous);
  work("next", dates.next);
  const result = await (await insightsRoute.GET()).json();
  assert.equal(result.summary.monthWorkCount, 2);
  assert.equal(result.summary.monthCustomerCount, 2);
  assert.deepEqual(
    result.monthly.map((row) => row.count),
    [0, 0, 0, 0, 1, 2],
  );
  assert.equal(
    result.workTypes.reduce((sum, row) => sum + row.count, 0),
    2,
  );
  const monthly = statements.find((item) =>
    item.sql.includes("WITH RECURSIVE month_range"),
  );
  assert.ok(
    plan(monthly.sql).some((detail) =>
      /SEARCH work_logs USING COVERING INDEX idx_work_logs_date_updated_id \(work_date>\? AND work_date<\?\)/.test(
        detail,
      ),
    ),
  );
});

test("확장 fixture 12,000건에서 이전 요약과 결과가 같고 조회 계획의 반복 작업이 줄어든다", (t) => {
  const { sqlite, customer, work, property, plan } = database(t);
  customer();
  sqlite.exec("BEGIN");
  for (let index = 0; index < 12000; index++) {
    const id = `work-${index}`;
    const date = `2024-${String((index % 12) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`;
    work(id, date);
    property(`property-${index}-1`, id, 1);
    property(`property-${index}-2`, id, 2);
  }
  sqlite.exec("COMMIT; PRAGMA optimize");
  const legacy = sqlite.prepare(
    `${LEGACY_SUMMARY_SQL} ${RECENT_ORDER} LIMIT 1000`,
  );
  const optimized = sqlite.prepare(
    `${WORK_SUMMARY_SQL} ${RECENT_ORDER} LIMIT 1000`,
  );
  assert.deepEqual(legacyProjection(optimized.all()), legacy.all().map((row) => ({ ...row })));
  const timed = (query) => {
    const samples = [];
    for (let iteration = 0; iteration < 7; iteration++) {
      const start = performance.now();
      query.all();
      samples.push(performance.now() - start);
    }
    return samples.sort((a, b) => a - b)[3];
  };
  const before = timed(legacy);
  const after = timed(optimized);
  // Timing is reported, not asserted: noisy CI hosts must not fail correctness.
  t.diagnostic(
    `12,000 works / 24,000 properties, latest 1,000: median before ${before.toFixed(2)} ms, after ${after.toFixed(2)} ms (${(before / after).toFixed(2)}x).`,
  );
  assert.equal(
    plan(`${WORK_SUMMARY_SQL} ${RECENT_ORDER} LIMIT 1000`).some((detail) =>
      detail.includes("TEMP B-TREE FOR ORDER BY"),
    ),
    false,
  );
});
