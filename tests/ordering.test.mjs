import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getFollowUps } from "../app/api/follow-ups/_store.ts";

// Run the real route handlers and their bound SQL against SQLite. Only the
// Cloudflare binding and bootstrap boundary are replaced for these local tests.
const dbKey = "jipjangbu-ordering-test-db";
const apiRoot = new URL("../app/api/", import.meta.url).href;
const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(apiRoot)) {
      if (specifier === "../../../db") return {
        url: moduleUrl(`export function getD1() { return globalThis[Symbol.for(${JSON.stringify(dbKey)})]; }`),
        shortCircuit: true,
      };
      if (specifier === "../../db/bootstrap") return {
        url: moduleUrl("export async function ensureDatabase() {}"),
        shortCircuit: true,
      };
      if (["../_shared", "../_ordering", "../_queries"].includes(specifier)) return {
        url: new URL(`${specifier}.ts`, context.parentURL).href, shortCircuit: true,
      };
      if (specifier === "./data") return {
        url: moduleUrl("export class InputError extends Error {} export function saveWorkLog() { throw new Error('Ordering GET tests never write'); }"), shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
const [customersRoute, listingsRoute, bootstrapRoute, searchRoute, insightsRoute, workRoute] = await Promise.all([
  import("../app/api/customers/route.ts"), import("../app/api/listings/route.ts"),
  import("../app/api/bootstrap/route.ts"), import("../app/api/search/route.ts"),
  import("../app/api/insights/route.ts"),
  import("../app/api/work-logs/route.ts"),
]);
hook.deregister();

function database(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const directory = new URL("../drizzle/", import.meta.url);
  for (const name of readdirSync(directory).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
  }
  const db = {
    prepare(sql) {
      const query = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...bindings) { values = bindings; return this; },
        async first() { return query.get(...values) ?? null; },
        async all() { return { results: query.all(...values) }; },
      };
    },
    async batch(statements) { return Promise.all(statements.map((statement) => statement.all())); },
  };
  globalThis[Symbol.for(dbKey)] = db;
  t.after(() => { sqlite.close(); delete globalThis[Symbol.for(dbKey)]; });
  const date = (offset = 0) => sqlite.prepare("SELECT date('now','+9 hours', ?) AS value").get(`${offset} days`).value;
  const customer = (id, name, created = date(-100), updated = date()) =>
    sqlite.prepare("INSERT INTO customers (id,name,created_at,updated_at) VALUES (?,?,?,?)").run(id, name, created, updated);
  const work = (id, customerId, workDate, updated = workDate, created = updated, type = "전화") =>
    sqlite.prepare("INSERT INTO work_logs (id,customer_id,work_date,work_type,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run(id, customerId, workDate, type, created, updated);
  const listing = (id, { type = "아파트", building = "단지", dong = "2", unit = "2", closed = null, registered = date(-100), updated = date(-50), notes = "" } = {}) =>
    sqlite.prepare(`INSERT INTO listings (id,identity_key,status,property_type,building_name,building_dong,
      unit_number,closed_at,registered_at,updated_at,notes) VALUES (?,?,'매물등록',?,?,?,?,?,?,?,?)`)
      .run(id, id, type, building, dong, unit, closed, registered, updated, notes);
  return { sqlite, db, date, customer, work, listing };
}

const request = (path, params = {}) => new Request(`https://test.invalid/api/${path}?${new URLSearchParams(params)}`);
const ids = (items) => items.map((item) => item.id);

test("고객 최근 업무순은 미래 예약·일괄 수정일을 제외하고 동률은 이름과 ID로 고정한다", async (t) => {
  const { date, customer, work } = database(t);
  customer("tie-z", "가람"); customer("tie-a", "가람"); customer("new", "나래", date());
  customer("yesterday", "다인"); customer("old-future", "라온", date(-200), date(100));
  customer("future-only", "마루", date(-90), date(100));
  work("today-z", "tie-z", date()); work("today-a", "tie-a", date());
  work("yesterday", "yesterday", date(-1));
  work("old", "old-future", date(-30)); work("future", "old-future", date(30));
  work("only-future", "future-only", date(60));
  const recent = (await (await customersRoute.GET(request("customers"))).json()).customers;
  assert.deepEqual(ids(recent), ["tie-a", "tie-z", "new", "yesterday", "old-future", "future-only"]);
  assert.equal(recent.find((item) => item.id === "old-future").last_work_date, date(-30));
  assert.equal(recent.find((item) => item.id === "future-only").last_work_date, null);
  assert.equal(recent.find((item) => item.id === "old-future").history_count, 2);
  const history = (await (await customersRoute.GET(request("customers", { sort: "history" }))).json()).customers;
  assert.deepEqual(ids(history), ["old-future", "tie-a", "tie-z", "yesterday", "future-only", "new"]);
  const name = (await (await customersRoute.GET(request("customers", { sort: "name" }))).json()).customers;
  assert.deepEqual(ids(name), ["tie-a", "tie-z", "new", "yesterday", "old-future", "future-only"]);
  const unknown = (await (await customersRoute.GET(request("customers", { sort: "id; DROP TABLE customers" }))).json()).customers;
  assert.deepEqual(ids(unknown), ids(recent));
});

test("매물 기본순과 이름순은 상태가 앞서지 않고 동과 호의 숫자순·빈 값 마지막·ID 동률 기준을 적용한다", async (t) => {
  const { date, listing } = database(t);
  listing("dong-10", { dong: "10" }); listing("unit-10", { unit: "10" });
  listing("tie-z"); listing("tie-a"); listing("no-unit", { unit: "" });
  listing("no-dong", { dong: "" }); listing("closed", { building: "가", closed: date() });
  listing("suffix-10", { dong: "10동" }); listing("suffix-2", { dong: "2동" });
  const result = (await (await listingsRoute.GET(request("listings", { state: "all" }))).json()).listings;
  assert.deepEqual(ids(result), ["closed", "tie-a", "tie-z", "unit-10", "no-unit", "suffix-2", "dong-10", "suffix-10", "no-dong"]);
  const again = (await (await listingsRoute.GET(request("listings", { state: "all", sort: "building" }))).json()).listings;
  assert.deepEqual(ids(again), ids(result));
  assert.deepEqual(ids((await (await listingsRoute.GET(request("listings"))).json()).listings), ids(result), "default state includes closed listings");
  const active = (await (await listingsRoute.GET(request("listings", { state: "active" }))).json()).listings;
  assert.equal(active.some((item) => item.id === "closed"), false);
});

test("매물 기본순은 종류 가나다순 다음 이름순이며 종류 역순에서도 빈 종류는 마지막이다", async (t) => {
  const { date, listing } = database(t);
  listing("villa-late", { type: "빌라", building: "하단지" });
  listing("shop", { type: "상가", building: "가단지", closed: date() });
  listing("apartment", { type: "아파트", building: "가단지" });
  listing("office", { type: "오피스텔", building: "가단지" });
  listing("villa-closed", { type: "빌라", building: "가단지", closed: date() });
  listing("blank", { type: "", building: "가단지" });
  listing("spaces", { type: "  ", building: "나단지" });
  const load = async (sort) => ids((await (await listingsRoute.GET(request("listings", {
    state: "all", ...(sort === undefined ? {} : { sort }),
  }))).json()).listings);
  const expected = ["villa-closed", "villa-late", "shop", "apartment", "office", "blank", "spaces"];
  assert.deepEqual(await load(), expected);
  assert.deepEqual(await load("type"), expected);
  assert.deepEqual(await load("type-desc"), ["office", "apartment", "shop", "villa-closed", "villa-late", "blank", "spaces"]);
  for (const invalid of ["", "unknown", "constructor", "__proto__", "building_name; DROP TABLE listings --"]) {
    assert.deepEqual(await load(invalid), expected);
  }
});

test("매물 종류·이름 열의 역순은 선택한 열만 뒤집고 동·호수·ID 동률 순서는 유지한다", async (t) => {
  const { date, listing } = database(t);
  listing("shop-a", { type: "상가", building: "가단지" });
  listing("apartment-z", { building: "하단지" });
  listing("office-a", { type: "오피스텔", building: "가단지" });
  listing("shared-dong-10", { building: "공통단지", dong: "10" });
  listing("shared-unit-10", { building: "공통단지", unit: "10" });
  listing("shared-tie-z", { building: "공통단지" });
  listing("shared-tie-a", { building: "공통단지", closed: date() });
  listing("shared-no-dong", { building: "공통단지", dong: "" });
  listing("shared-shop", { type: "상가", building: "공통단지", dong: "1" });
  const load = async (sort, params = {}) => ids((await (await listingsRoute.GET(request("listings", {
    state: "all", sort, ...params,
  }))).json()).listings);
  const shared = ["shared-shop", "shared-tie-a", "shared-tie-z", "shared-unit-10", "shared-dong-10", "shared-no-dong"];
  assert.deepEqual(await load("building"), ["office-a", "shop-a", ...shared, "apartment-z"]);
  assert.deepEqual(await load("building-desc"), ["apartment-z", ...shared, "office-a", "shop-a"]);
  assert.deepEqual(await load("type"), ["shop-a", "shared-shop", ...shared.slice(1), "apartment-z", "office-a"]);
  assert.deepEqual(await load("type-desc"), ["office-a", ...shared.slice(1), "apartment-z", "shop-a", "shared-shop"]);
  assert.deepEqual(await load("building-desc", { q: "공통단지", type: "아파트" }), shared.slice(1));
  assert.deepEqual(await load("type-desc", { q: "공통단지", state: "closed" }), ["shared-tie-a"]);
  assert.deepEqual(await load("type", { q: "공통단지 2동", state: "active", type: "아파트" }), ["shared-tie-z", "shared-unit-10"]);
});

test("매물 열 정렬은 전체 검색 결과에서 적용한 뒤 1,000건을 제한한다", async (t) => {
  const { listing } = database(t);
  // Insert in reverse name order, with the first alphabetical category last.
  // Sorting a previously limited client subset would miss its first result.
  for (let index = 1001; index >= 1; index--) {
    listing(`apartment-${String(index).padStart(4, "0")}`, { building: `검증단지${String(index).padStart(4, "0")}` });
  }
  listing("shop-first", { type: "상가", building: "검증단지끝" });
  listing("unmatched", { type: "빌라", building: "별도단지" });
  const load = async (sort) => (await (await listingsRoute.GET(request("listings", {
    sort, q: "검증단지", state: "all",
  }))).json()).listings;
  const byType = await load("type");
  assert.equal(byType.length, 1000);
  assert.equal(byType[0].id, "shop-first");
  assert.equal(byType[1].id, "apartment-0001");
  assert.equal(byType.at(-1).id, "apartment-0999");
  const byName = await load("building-desc");
  assert.equal(byName.length, 1000);
  assert.equal(byName[0].id, "shop-first");
  assert.equal(byName[1].id, "apartment-1001");
  assert.equal(byName.at(-1).id, "apartment-0003");
  const next = (await (await listingsRoute.GET(request("listings", {
    sort: "building-desc", q: "검증단지", state: "all", offset: "1000",
  }))).json()).listings;
  assert.deepEqual(ids(next), ["apartment-0002", "apartment-0001"]);
});

test("매물 등록순·변경순·오래 미갱신순은 서로 구분되고 필터와 함께 동작한다", async (t) => {
  const { date, listing } = database(t);
  listing("new-registration", { registered: date(-1), updated: date(-60) });
  listing("new-update", { registered: date(-10), updated: date() });
  listing("oldest", { registered: date(-200), updated: date(-100) });
  listing("fallback", { registered: date(-150), updated: "" });
  listing("closed", { closed: date(), registered: date(), updated: date() });
  const load = async (sort, state = "all") => ids((await (await listingsRoute.GET(request("listings", { sort, state }))).json()).listings);
  assert.deepEqual(await load("recent"), ["new-registration", "new-update", "fallback", "oldest", "closed"]);
  assert.deepEqual(await load("updated"), ["new-update", "new-registration", "oldest", "fallback", "closed"]);
  assert.deepEqual(await load("oldest"), ["fallback", "oldest", "new-registration", "new-update", "closed"]);
  assert.deepEqual(await load("oldest", "stale"), ["fallback", "oldest"]);
  assert.deepEqual(await load("recent", "closed"), ["closed"]);
  assert.equal((await load("updated", "active")).length, 4);
});

test("우선 업무가 없으면 홈의 기존 오늘 최근 수정순·최근 업무·가까운 예정순을 유지한다", async (t) => {
  const { date, customer, work } = database(t);
  customer("customer", "고객");
  work("today-old", "customer", date(), `${date()} 01:00:00`);
  work("today-a", "customer", date(), `${date()} 02:00:00`);
  work("today-z", "customer", date(), `${date()} 02:00:00`);
  work("past", "customer", date(-1), `${date()} 10:00:00`);
  work("later", "customer", date(5), date(), date(-2), "방문예정");
  work("next-z", "customer", date(1), date(), date(-3), "방문예약");
  work("next-a", "customer", date(1), date(), date(-3), "방문예약");
  work("next-new", "customer", date(1), date(), date(-1), "방문예정");
  work("not-schedule", "customer", date(1));
  const result = await (await bootstrapRoute.GET()).json();
  assert.deepEqual(ids(result.today), ["today-z", "today-a", "today-old"]);
  assert.deepEqual(ids(result.recent), ["today-z", "today-a", "today-old", "past"]);
  assert.deepEqual(ids(result.upcoming), ["next-a", "next-z", "next-new", "later"]);
  assert.equal(result.metrics.today_count, 3);
  assert.equal(result.metrics.upcoming_count, 4);
});

test("오늘 업무는 업무구분보다 최근 수정순을 먼저 적용하며 최근 업무 정렬은 바꾸지 않는다", async (t) => {
  const { date, customer, work } = database(t);
  customer("customer", "합성 고객");
  const today = date();
  work("ordinary-new", "customer", today, `${today} 20:00:00`, today, "전화");
  work("other-appointment", "customer", today, `${today} 19:00:00`, today, "계약예정");
  work("completed-balance", "customer", today, `${today} 18:00:00`, today, "잔금");
  work("completed-visit", "customer", today, `${today} 17:00:00`, today, "집방문");
  work("balance-old", "customer", today, `${today} 01:00:00`, date(-10), "잔금예정");
  work("visit-booked", "customer", today, `${today} 02:00:00`, date(-10), "집방문예약");
  work("visit-planned", "customer", today, `${today} 03:00:00`, date(-10), "집방문예정");
  work("balance-tie", "customer", today, `${today} 03:00:00`, date(-10), "잔금예정");
  const result = await (await bootstrapRoute.GET()).json();
  assert.deepEqual(ids(result.today), ["ordinary-new", "other-appointment", "completed-balance", "completed-visit", "visit-planned", "balance-tie", "visit-booked", "balance-old"]);
  assert.deepEqual(ids(result.recent), ["ordinary-new", "other-appointment", "completed-balance", "completed-visit", "visit-planned", "balance-tie", "visit-booked", "balance-old"]);
  assert.equal(result.metrics.today_count, 8);
  assert.deepEqual(ids((await (await bootstrapRoute.GET()).json()).today), ids(result.today));
});

test("앞으로 7일은 우선 정렬 후 6건을 고르고 전체 보기·페이지·업무 현황도 같은 순서를 유지한다", async (t) => {
  const { date, customer, work } = database(t);
  customer("customer", "합성 고객");
  // Eight earlier ordinary appointments would hide all priorities if the
  // priority sort were applied only to the six already fetched preview rows.
  for (let index = 0; index < 8; index++) {
    work(`ordinary-${index}`, "customer", date(1), date(), date(), "계약예정");
  }
  work("visit-reserved", "customer", date(3), date(), date(-4), "집방문예약");
  work("visit-planned", "customer", date(4), date(), date(-4), "집방문예정");
  work("balance-soon", "customer", date(5), date(), date(-3), "잔금예정");
  // Same day: insertion order and the most recent edit must not disturb
  // original registration order, then stable ID order.
  work("balance-new", "customer", date(7), date(-10), date(-1), "잔금예정");
  work("balance-z", "customer", date(7), date(), date(-2), "잔금예정");
  work("balance-a", "customer", date(7), date(-9), date(-2), "잔금예정");
  work("today-priority", "customer", date(), date(), date(-2), "잔금예정");
  work("past-priority", "customer", date(-1), date(), date(-2), "잔금예정");
  work("outside-priority", "customer", date(31), date(), date(-2), "잔금예정");
  work("ordinary-work", "customer", date(1));
  work("cancelled-visit", "customer", date(2), date(), date(), "집방문예약취소");
  const expected = ["visit-reserved", "visit-planned", "balance-soon", "balance-a", "balance-z", "balance-new", ...Array.from({ length: 8 }, (_, index) => `ordinary-${index}`)];
  const home = await (await bootstrapRoute.GET()).json();
  assert.deepEqual(ids(home.upcoming), expected.slice(0, 6));
  assert.equal(home.metrics.upcoming_count, expected.length);
  const paged = [];
  for (const offset of [0, 4, 8, 12, 16]) {
    const response = await workRoute.GET(request("work-logs", { schedule: "1", from: date(1), to: date(7), limit: "4", offset: String(offset) }));
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.total, expected.length);
    paged.push(...ids(page.workLogs));
  }
  assert.deepEqual(paged, expected);
  assert.equal(new Set(paged).size, expected.length);
  const insights = await (await insightsRoute.GET()).json();
  assert.deepEqual(ids(insights.upcoming), expected.slice(0, 12));
});

test("업무 현황의 예정 일정과 미갱신 매물은 홈·매물 관리와 같은 순서를 유지한다", async (t) => {
  const { date, customer, work, listing } = database(t);
  customer("customer", "고객");
  work("next-new", "customer", date(1), date(-4), date(-1), "방문예정");
  work("next-old-z", "customer", date(1), date(-1), date(-3), "방문예약");
  work("next-old-a", "customer", date(1), date(), date(-3), "방문예약");
  work("later", "customer", date(5), date(-5), date(-5), "방문예정");
  listing("later-in-day", { dong: "1", updated: `${date(-100)} 13:00:00` });
  listing("unit-10", { unit: "10", updated: `${date(-100)} 12:00:00` });
  listing("unit-2-z", { updated: `${date(-100)} 12:00:00` });
  listing("unit-2-a", { updated: `${date(-100)} 12:00:00` });
  listing("oldest", { updated: date(-200) });
  listing("fresh", { updated: date() });
  listing("closed", { closed: date(), updated: date(-300) });

  const insights = await (await insightsRoute.GET()).json();
  const home = await (await bootstrapRoute.GET()).json();
  const stale = (await (await listingsRoute.GET(request("listings", { state: "stale", sort: "oldest" }))).json()).listings;
  assert.deepEqual(ids(insights.upcoming), ["next-old-a", "next-old-z", "next-new", "later"]);
  assert.deepEqual(ids(insights.upcoming), ids(home.upcoming));
  assert.deepEqual(ids(insights.staleListings), ["oldest", "unit-2-a", "unit-2-z", "unit-10", "later-in-day"]);
  assert.deepEqual(ids(insights.staleListings), ids(stale));
});

test("통합 고객 검색은 정확한 이름·ID, 접두 일치, 포함 순이며 미래 예약에 밀리지 않는다", async (t) => {
  const { date, customer, work } = database(t);
  customer("exact", "민수"); customer("민수", "김고객"); customer("prefix", "민수네");
  customer("contains", "김민수"); customer("note", "최근고객");
  work("exact-old", "exact", date(-20)); work("exact-future", "exact", date(30));
  work("id-old", "민수", date(-10)); work("prefix-old", "prefix", date(-40));
  work("contains-today", "contains", date());
  const result = await (await searchRoute.GET(request("search", { q: "민수" }))).json();
  assert.deepEqual(ids(result.customers), ["민수", "exact", "prefix", "contains"]);
  assert.equal(result.customers.find((item) => item.id === "exact").last_work_date, date(-20));
});

test("통합 매물 검색은 정확한 주소와 호수 우선·같은 일치 수준에서는 진행중 우선이다", async (t) => {
  const { date, listing } = database(t);
  listing("contains", { building: "테스트", unit: "A2", updated: date() });
  listing("prefix", { building: "테스트", unit: "20", updated: date(-1) });
  listing("exact", { building: "테스트", unit: "2", updated: date(-10) });
  listing("closed", { building: "테스트", unit: "2", closed: date(), updated: date() });
  const load = async (q) => (await (await searchRoute.GET(request("search", { q }))).json()).listings;
  assert.deepEqual(ids(await load("2")), ["exact", "closed", "prefix", "contains"]);
  assert.deepEqual(ids(await load("테스트 2")), ["exact", "closed", "prefix", "contains"]);
  assert.deepEqual(ids(await load("테스트 2동 2호")), ["exact", "closed"]);
});

test("통합검색의 퍼센트·밑줄·따옴표는 검색 문자로 처리하고 각 결과는 8개로 제한한다", async (t) => {
  const { customer, listing } = database(t);
  customer("literal", "100%_확인"); customer("wildcard", "100AB확인");
  listing("literal", { building: "100%_확인" }); listing("wildcard", { building: "100AB확인" });
  let result = await (await searchRoute.GET(request("search", { q: "%_" }))).json();
  assert.deepEqual(ids(result.customers), ["literal"]);
  assert.deepEqual(ids(result.listings), ["literal"]);
  result = await (await searchRoute.GET(request("search", { q: "' OR 1=1 --" }))).json();
  assert.deepEqual(result, { workLogs: [], customers: [], listings: [] });
  for (let index = 0; index < 12; index++) {
    customer(`limit-${index}`, `조회고객${index}`); listing(`limit-${index}`, { building: `조회단지${index}` });
  }
  result = await (await searchRoute.GET(request("search", { q: "조회" }))).json();
  assert.equal(result.customers.length, 8);
  assert.equal(result.listings.length, 8);
  assert.deepEqual(await (await searchRoute.GET(request("search"))).json(), { workLogs: [], customers: [], listings: [] });
});

test("같은 기한의 할 일은 먼저 등록한 순서, 완료한 일은 최근 완료순과 ID로 안정적이다", async (t) => {
  const { sqlite, db, date } = database(t);
  const add = (id, due, created, completed = null) => sqlite.prepare(
    "INSERT INTO follow_ups (id,title,due_date,created_at,completed_at) VALUES (?,?,?,?,?)",
  ).run(id, id, due, created, completed);
  add("new", date(), date(-1)); add("old-z", date(), date(-3)); add("old-a", date(), date(-3));
  add("overdue", date(-1), date()); add("undated", null, date(-100));
  add("complete-old", date(-100), date(-100), date(-2));
  add("complete-z", date(100), date(-1), date(-1)); add("complete-a", date(90), date(-2), date(-1));
  const result = await getFollowUps(db, new URLSearchParams("status=all"));
  assert.deepEqual(ids(result.items), ["overdue", "old-a", "old-z", "new", "undated", "complete-a", "complete-z", "complete-old"]);
  assert.deepEqual(ids((await getFollowUps(db, new URLSearchParams("status=completed"))).items), ["complete-a", "complete-z", "complete-old"]);
});
