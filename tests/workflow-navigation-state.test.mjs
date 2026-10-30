import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { fetchCustomerDirectory } from "../app/customer-directory.ts";
import { collectOffsetPages } from "../app/client-paging.ts";
import { calendarWorkPresentation } from "./helpers/calendar-presentation.mjs";
import { CalendarSubjects } from "./helpers/calendar-subjects.mjs";
import { initialResultPage, ResultPagination } from "./helpers/result-pagination.mjs";

// Execute production UI callbacks and markup with synthetic data and controlled
// network responses, including cross-screen transitions rather than text checks.
const source = readFileSync(new URL("../app/work-manager.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("work-manager.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate) {
  let found;
  function visit(node) { if (predicate(node)) found = node; ts.forEachChild(node, visit); }
  visit(ast);
  assert.ok(found, "production declaration exists");
  return found;
}
function declaration(name) {
  return find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast);
}
function evaluate(code, environment = {}) {
  const output = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
  }).outputText;
  return new Function(...Object.keys(environment), `${output}; return result;`)(...Object.values(environment));
}
function compile(names, environment = {}) {
  return evaluate(`${names.map(declaration).join("\n")}\nconst result = ${names.at(-1)};`, environment);
}
function callback(component, prop, environment) {
  const componentNode = find((node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === component);
  const attribute = componentNode.attributes.properties.find((node) => ts.isJsxAttribute(node) && node.name.getText(ast) === prop);
  assert.ok(attribute?.initializer && ts.isJsxExpression(attribute.initializer));
  return evaluate(`const result = ${attribute.initializer.expression.getText(ast)};`, environment);
}
const noop = () => {};
function state(initial) {
  const box = { current: initial };
  box.set = (value) => { box.current = typeof value === "function" ? value(box.current) : value; };
  return box;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function descendants(element) {
  if (!React.isValidElement(element)) return [];
  return [element, ...React.Children.toArray(element.props.children).flatMap(descendants)];
}
function button(tree, label) {
  const element = descendants(tree).find((item) => item.type === "button" && renderToStaticMarkup(item).includes(label));
  assert.ok(element, `${label} exists`);
  return element;
}
const environment = { React, useResultPage: initialResultPage, ResultPagination, useContext: () => null, PageToolsSlot: null, createPortal: (node) => node, LISTING_WORK_TYPES: new Set(["매물등록", "매물수정", "가계약", "잔금"]), Icon: () => null, useMemo: (callback) => callback(), seoulDate: () => "2026-09-13", calendarWorkPresentation, CalendarSubjects };
const common = ["displayDate", "targetText", "statusTone", "EmptyState", "Toolbar", "ListReadFeedback"];
const Feedback = compile(["ListReadFeedback"], environment);
const Listings = compile([...common, "Price", "ListingsView"], environment);
const Customers = compile([...common, "CustomersView"], environment);
const Calendar = compile([...common, "CalendarView"], environment);
const lookups = { workTypes: ["계약예정", "전화"], propertyTypes: ["아파트"], buildings: [] };
const listing = { id: "listing", identity_key: "synthetic", property_type: "아파트", building_name: "이전결과 합성단지", building_dong: "106", unit_number: "1503", status: "매물등록" };
const customer = { id: "synthetic-customer", name: "이전결과 합성고객", notes: "확인 메모", history_count: 1 };
const work = { id: "work", work_date: "2026-09-13", work_type: "계약예정", content: "이전결과 합성업무", customer_name: "예시 고객", building_name: "예시단지", property_count: 1 };
const listingProps = { items: [listing], lookups, query: "새 검색", setQuery: noop, statuses: [], setStatuses: noop, prices: [], setPrices: noop, propertyType: "", setPropertyType: noop, sort: "building", setSort: noop, onReset: noop, onHistory: noop };
const customerProps = { items: [customer], query: "새 검색", setQuery: noop, sort: "recent", setSort: noop, onReset: noop, onEdit: noop, onNew: noop, onNewWork: noop, onCopy: noop, onHistory: noop };
const calendarProps = { month: "2026-09", setMonth: noop, workType: "", setWorkType: noop, items: [work], lookups, onOpen: noop, onShowDay: noop };

test("공통 조회 안내는 로딩·오류·갱신·준비를 구분하고 재시도한다", () => {
  assert.equal(Feedback({ status: "ready" }), null);
  const loading = Feedback({ status: "loading", label: "예시 목록" });
  assert.equal(loading.props.role, "status");
  assert.match(renderToStaticMarkup(loading), /현재 조건에 맞는 결과와 건수/);
  assert.equal(Feedback({ status: "refreshing" }).props.role, "status");
  let retried = 0;
  const error = Feedback({ status: "error", error: "합성 연결 오류", onRetry: () => retried++ });
  assert.equal(error.props.role, "alert");
  assert.match(renderToStaticMarkup(error), /기록이 없다는 뜻은 아닙니다/);
  button(error, "다시 불러오기").props.onClick();
  assert.equal(retried, 1);
});

test("매물·고객 목록은 다른 조건 조회 중과 오류에서 이전 행·건수를 숨기고 페이지 이동을 잠근다", () => {
  for (const [View, props, marker, empty] of [[Listings, listingProps, "이전결과 합성단지", "조건에 맞는 매물이 없습니다"], [Customers, customerProps, "이전결과 합성고객", "조건에 맞는 고객이 없습니다"]]) {
    for (const status of ["loading", "error"]) {
      const html = renderToStaticMarkup(React.createElement(View, { ...props, status, error: "합성 오류" }));
      assert.ok(!html.includes(marker));
      assert.ok(!html.includes(empty));
      assert.doesNotMatch(html, /CSV|export-button/);
      if (View === Listings) assert.match(html, /aria-label="다음 페이지" disabled=""/);
      assert.match(html, status === "loading" ? /조회 중…/ : /조회 실패/);
      assert.match(html, status === "loading" ? /role="status"/ : /role="alert"/);
      assert.doesNotMatch(html, /class="count-badge">1[건명]/);
    }
    const ready = renderToStaticMarkup(React.createElement(View, { ...props, status: "ready", items: [] }));
    assert.ok(ready.includes(empty));
    assert.match(ready, /class="count-badge">0[건명]/);
    assert.doesNotMatch(ready, /조회 실패|role="alert"/);
    const refreshing = renderToStaticMarkup(React.createElement(View, { ...props, status: "refreshing" }));
    assert.ok(refreshing.includes(marker));
    assert.match(refreshing, /같은 조건의 이전 결과/);
    assert.doesNotMatch(refreshing, /CSV|export-button/);
    if (View === Listings) assert.match(refreshing, /aria-label="다음 페이지" disabled=""/);
  }
});

test("매물 종류·이름 제목은 기본 정렬과 역순을 표시하고 클릭 시 해당 기준만 변경한다", () => {
  for (const [sort, column, next, direction] of [
    ["type", "매물종류", "type-desc", "↑"],
    ["type-desc", "매물종류", "type", "↓"],
    ["building", "이름", "building-desc", "↑"],
    ["building-desc", "이름", "building", "↓"],
    ["updated", "매물종류", "type", null],
    ["type", "이름", "building", null],
  ]) {
    const changed = [], opened = [];
    const tree = Listings({ ...listingProps, sort, setSort: (value) => changed.push(value), onHistory: (item) => opened.push(item) });
    const header = descendants(tree).find((item) => item.props.className === "table-head");
    const control = button(header, column);
    assert.equal(control.props.type, "button");
    assert.equal(control.props["aria-pressed"], direction !== null);
    if (direction) assert.ok(renderToStaticMarkup(control).includes(direction));
    assert.match(control.props["aria-label"], /으로 정렬$/);
    control.props.onClick();
    assert.deepEqual(changed, [next]);
    assert.deepEqual(opened, [], "sorting never opens a listing history or editor");
    const row = descendants(tree).find((item) => item.props.className === "table-row");
    row.props.onClick();
    assert.deepEqual(opened, [listing], "the original listing history flow is preserved");
  }
});

test("매물 정렬 선택·요약·모바일 제목 버튼은 같은 정렬 상태를 사용한다", () => {
  for (const sort of ["type", "type-desc", "building", "building-desc", "recent", "updated", "oldest"]) {
    const changed = [];
    const tree = Listings({ ...listingProps, sort, statuses: [], setSort: (value) => changed.push(value) });
    const select = descendants(tree).find((item) => item.type === "select" && item.props["aria-label"] === "매물 정렬");
    assert.equal(select.props.value, sort);
    assert.deepEqual(React.Children.toArray(select.props.children).map((item) => item.props.value), ["type", "type-desc", "building", "building-desc", "recent", "updated", "oldest"]);
    select.props.onChange({ target: { value: "updated" } });
    assert.deepEqual(changed, ["updated"]);
    const summary = descendants(tree).find((item) => item.props.className === "sort-summary");
    assert.equal(renderToStaticMarkup(summary).includes("진행 중 우선"), ["recent", "updated", "oldest"].includes(sort));
    const mobile = descendants(tree).find((item) => item.props.className === "listing-mobile-sort");
    assert.equal(mobile.props["aria-label"], "매물 정렬 기준");
    button(mobile, "이름").props.onClick();
    assert.equal(changed.at(-1), sort === "building" ? "building-desc" : "building");
  }
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.listing-sort-button\s*\{[^}]*min-height:\s*44px/);
  const mobileCss = css.slice(css.indexOf("@media (max-width: 920px)"));
  assert.match(mobileCss, /\.listing-mobile-sort\s*\{[^}]*display:\s*flex/);
});

test("매물관리 초기화는 상태·가격을 전체로 되돌리고 상태 변경은 정렬을 유지한다", () => {
  assert.match(source, /\[listingSort, setListingSort\] = useState\("type"\)/);
  const changes = [];
  callback("ListingsView", "onReset", Object.fromEntries(["setQuery", "setListingStatuses", "setListingPrices", "setPropertyTypeFilter", "setListingSort"].map((name) => [name, (value) => changes.push([name, value])])) )();
  assert.deepEqual(changes, [["setQuery", ""], ["setListingStatuses", []], ["setListingPrices", []], ["setPropertyTypeFilter", ""], ["setListingSort", "type"]]);
  assert.match(source, /\[listingStatuses, setListingStatuses\] = useState<string\[\]>\(\[\]\)/);
  const base = Listings({ ...listingProps, query: "", sort: "type", statuses: [] });
  assert.equal(descendants(base).some((item) => item.props.className === "filter-reset"), false);
  const sorted = [], states = [];
  const view = Listings({ ...listingProps, statuses: ["매물등록"], sort: "oldest", setStatuses: (value) => states.push(value), setSort: (value) => sorted.push(value) });
  const options = descendants(view).find((item) => item.props["aria-label"] === "매물 상태 필터");
  assert.doesNotMatch(renderToStaticMarkup(options), /active|closed|stale/);
  const extra = descendants(options).find((item) => item.type === "label" && renderToStaticMarkup(item).includes("잔금"));
  descendants(extra).find(item => item.type === "input").props.onChange({ target: { checked: true } });
  assert.deepEqual(states, [["매물등록", "잔금"]]);
  assert.deepEqual(sorted, []);
  const other = Listings({ ...listingProps, items: [{ ...listing, status: "잔금" }] });
  assert.ok(descendants(other).some(item => item.props.className === "table-row is-other-status"));
});

test("매물 목록은 CSV 없이 이름·종류·상태 셀과 원래 이력 연결을 유지한다", () => {
  const items = [
    { ...listing, id: "villa", property_type: "빌라", building_name: "가람", building_dong: "2", unit_number: "10" },
    { ...listing, id: "apartment", property_type: "아파트", building_name: "나래", building_dong: "10", unit_number: "2" },
  ];
  const opened = [];
  const tree = Listings({ ...listingProps, items, sort: "type", onHistory: (item) => opened.push(item) });
  assert.doesNotMatch(renderToStaticMarkup(tree), /CSV|export-button/);
  const rows = descendants(tree).filter((item) => item.props.className === "table-row");
  assert.deepEqual(React.Children.toArray(rows[0].props.children).map((item) => item.props["data-label"]), ["매물종류", "이름", "상태", "가격", "등록·말소"]);
  rows[1].props.onClick();
  assert.deepEqual(opened, [items[1]]);
});

test("달력은 불러오지 못한 달을 빈 달로 표시하지 않고 같은 조건 갱신에서만 이전 일정을 유지한다", () => {
  for (const status of ["loading", "error"]) {
    const html = renderToStaticMarkup(React.createElement(Calendar, { ...calendarProps, status, error: "합성 달력 오류" }));
    assert.doesNotMatch(html, /이전결과 합성업무|calendar-result-summary|등록된 업무가 없습니다/);
    assert.match(html, status === "loading" ? /role="status"/ : /role="alert"/);
  }
  const empty = renderToStaticMarkup(React.createElement(Calendar, { ...calendarProps, status: "ready", items: [] }));
  assert.match(empty, /선택한 달에 등록된 업무가 없습니다/);
  assert.match(empty, /모든 업무구분 · 0건/);
  const refreshing = renderToStaticMarkup(React.createElement(Calendar, { ...calendarProps, status: "refreshing" }));
  assert.match(refreshing, /같은 조건의 이전 결과/);
  assert.match(refreshing, /이전결과 합성업무/);
});

function navigationHarness(allow = true) {
  const queries = state({ listings: "매물검색", customers: "고객검색", journal: "업무검색" });
  const values = {};
  const changes = [];
  const props = {
    navigate: (next) => { changes.push(next); return allow; }, setQueries: queries.set,
    seoulDate: () => "2026-09-13",
    ...Object.fromEntries(["ListingStatuses", "ListingPrices", "PropertyTypeFilter", "ListingSort", "CustomerSort", "WorkTypeFilter", "CalendarMonth", "CalendarWorkType"].map((name) => [`set${name}`, (value) => { values[name] = value; }])),
  };
  return { queries, values, changes, navigate: compile(["navigateFromDashboard"], props) };
}
test("홈의 의미형 바로가기는 해당 화면 필터만 초기화하고 사용자가 이동을 취소하면 그대로 둔다", () => {
  const expected = {
    listings: { ListingStatuses: [], ListingPrices: [], PropertyTypeFilter: "", ListingSort: "type" },
    customers: { CustomerSort: "recent" },
    journal: { WorkTypeFilter: "" },
    calendar: { CalendarMonth: "2026-09", CalendarWorkType: "" },
  };
  for (const destination of Object.keys(expected)) {
    const h = navigationHarness();
    h.navigate(destination);
    assert.deepEqual(h.changes, [destination]);
    assert.deepEqual(h.values, expected[destination]);
    for (const [key, value] of Object.entries(h.queries.current)) assert.equal(value, key === destination ? "" : { listings: "매물검색", customers: "고객검색", journal: "업무검색" }[key]);
    const blocked = navigationHarness(false);
    blocked.navigate(destination);
    assert.deepEqual(blocked.values, {});
    assert.deepEqual(blocked.queries.current, { listings: "매물검색", customers: "고객검색", journal: "업무검색" });
  }
});

test("전체 검색 결과 이동은 검색어와 해당 유형 기본 필터를 적용하고 초안 이동 취소를 보존한다", () => {
  for (const allow of [true,false]) {
    const queries=state({listings:"old-listing",customers:"old-customer",journal:"old-work"}),changes=[];
    const env={navigate:()=>allow,setQueries:queries.set,...Object.fromEntries(["ListingStatuses","ListingPrices","PropertyTypeFilter","ListingSort","CustomerSort","WorkTypeFilter"].map(key=>["set"+key,value=>changes.push([key,value])]))};
    const show=compile(["showAllSearchResults"],env);
    assert.equal(show("journal","같은검색"),allow);
    assert.equal(queries.current.journal,allow?"같은검색":"old-work");
    assert.equal(queries.current.listings,"old-listing");
    assert.deepEqual(changes,allow?[["WorkTypeFilter",""]]:[]);
  }
});

test("일반 메뉴 이동은 목록 조건을 초기화하지 않고 기존 탐색과 뒤로가기 경로를 유지한다", () => {
  const views = [], paths = [], active = { current: "today" };
  const reader = state({ id: "previous-screen-work", loading: true }), reference = state({ kind: "customer", id: "previous" });
  const readVersion = { current: 0 };
  const navigate = compile(["navigate"], {
    view: "today", followUpBusy: { current: false }, followUpDirty: { current: false },
    workBusy: { current: false }, customerBusy: { current: false },
    workOpenVersion: { current: 0 }, currentView: active, setView: (value) => views.push(value),
    workReadVersion: readVersion, setWorkReader: reader.set, setReaderReference: reference.set,
    setWorkOpening: noop, historyModal: null, historyOpenVersion: { current: 0 }, setHistoryModal: noop, isRecordHistory: () => false,
    window: { scrollTo: noop, history: { pushState: (...args) => paths.push(args) }, location: { pathname: "/", search: "" }, confirm: () => true },
    refreshBase: async () => {}, showLoadError: assert.fail,
  });
  assert.equal(navigate("listings"), true);
  assert.deepEqual(views, ["listings"]);
  assert.equal(active.current, "listings");
  assert.deepEqual(paths, [[{ view: "listings" }, "", "/#listings"]]);
  assert.equal(reader.current, null);
  assert.equal(reference.current, null);
  assert.equal(readVersion.current, 1);
  // No setters for list filters are injected: a reset would fail this callback.
});

test("달력 날짜 전체보기에 선택한 업무구분을 저장하고 업무 수정 뒤에도 같은 조건으로 갱신한다", async () => {
  const history = state(null), version = { current: 0 }, requests = [];
  const openDay = callback("CalendarView", "onShowDay", { historyOpenVersion: version, setHistoryModal: history.set, displayDate: (v) => v, calendarWorkType: "계약예정" });
  openDay("2026-09-13", [work]);
  assert.equal(history.current.workType, "계약예정");
  const refresh = compile(["refreshHistory"], {
    historyOpenVersion: version, setHistoryModal: history.set,
    fetchAllWorkLogs: async (params) => { requests.push(Object.fromEntries(params)); return [{ ...work, content: "갱신 내용" }]; },
  });
  await refresh(history.current);
  assert.deepEqual(requests, [{ from: "2026-09-13", to: "2026-09-13", workType: "계약예정" }]);
  assert.equal(history.current.workType, "계약예정");
  assert.equal(history.current.items[0].content, "갱신 내용");
  assert.equal(history.current.loading, false);
});

test("7일·30일 전체 일정은 월경계를 넘는 범위와 예약·예정 필터를 유지한다", async () => {
  const opened = [];
  const open = compile(["shiftDate", "openSchedule"], { seoulDate: () => "2026-09-28", displayDate: (v) => v, showScheduleHistory: (data) => opened.push(data) });
  open(7); open(30);
  assert.deepEqual(opened.map(({ from, to }) => ({ from, to })), [{ from: "2026-09-29", to: "2026-10-05" }, { from: "2026-09-29", to: "2026-10-28" }]);
  const history = state(null), requests = [];
  const refresh = compile(["showScheduleHistory", "refreshHistory"], {
    historyOpenVersion: { current: 0 }, setHistoryModal: history.set, displayDate: (v) => v,
    fetchAllWorkLogs: async (params) => { requests.push(Object.fromEntries(params)); return [work]; },
  });
  await refresh(opened[0]);
  assert.deepEqual(requests, [{ from: "2026-09-29", to: "2026-10-05", schedule: "1" }]);
  assert.equal(history.current.scheduleDays, 7);
  assert.match(history.current.subtitle, /잔금·집방문 예정 우선 · 같은 우선순위는 날짜순/);
});

test("새 고객 저장은 목록 갱신 전에 명부에 즉시 반영하고 같은 업무 초안의 선택만 바꾼다", async () => {
  const existing = { id: "same-id", name: "이전 이름" }, saved = { id: "same-id", name: "새 이름" };
  const customers = state([existing, { id: "other", name: "다른 고객" }]);
  const modal = state({ mode: "new", initialCustomerId: "other", draftMarker: "작성 중 내용을 보존" });
  const customerModal = state({ mode: "new" }), pending = deferred();
  const handler = callback("CustomerModal", "onSaved", {
    setCustomerModal: customerModal.set, setCustomers: customers.set, setWorkModal: modal.set,
    setHistoryModal: () => {}, setWorkReader: () => {},
    afterMutation: () => pending.promise,
  });
  const result = handler("저장 완료", saved.id, saved);
  assert.equal(customerModal.current, null);
  assert.deepEqual(customers.current, [saved, { id: "other", name: "다른 고객" }]);
  assert.deepEqual(modal.current, { mode: "new", initialCustomerId: saved.id, draftMarker: "작성 중 내용을 보존" });
  pending.resolve();
  await result;
});

test("전체 고객 명부는 1,001번째 고객까지 ID 커서로 다음 페이지를 읽는다", async () => {
  const first = Array.from({ length: 1000 }, (_, index) => ({ id: `customer-${index}` }));
  const calls = [];
  const records = await fetchCustomerDirectory(async (url) => {
    calls.push(url);
    return { customers: calls.length === 1 ? first : [{ id: "customer-1000" }] };
  });
  assert.equal(records.length, 1001);
  assert.ok(records.some((record) => record.id === "customer-1000"));
  assert.deepEqual(calls, ["/api/customers?directory=1", "/api/customers?directory=1&after=customer-999"]);
});

test("고객 명부의 진행 없는 반복 응답과 중간 실패는 부분 명부를 정상 결과로 반환하지 않는다", async () => {
  const first = Array.from({ length: 1000 }, (_, index) => ({ id: `customer-${index}` }));
  let calls = 0;
  await assert.rejects(fetchCustomerDirectory(async () => { calls++; return { customers: first }; }), /고객 명부가 변경되었습니다/);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(fetchCustomerDirectory(async () => { if (++calls === 2) throw new Error("합성 두 번째 페이지 실패"); return { customers: first }; }), /두 번째 페이지 실패/);
  await assert.rejects(fetchCustomerDirectory(async () => ({ customers: null })), /고객 명부를 불러오지 못했습니다/);
  assert.deepEqual(await fetchCustomerDirectory(async () => ({ customers: [] })), []);
});

function managedLoadHarness(key) {
  const names = { listings: "loadListings", customers: "loadCustomers", calendar: "loadCalendar" };
  const managed = state(Object.fromEntries(Object.keys(names).map((name) => [name, { loadedQuery: "previous", loading: false, error: null }])));
  const rows = state([{ id: "previous" }]), version = { current: { listings: 0, customers: 0, calendar: 0 } };
  const node = find((candidate) => ts.isVariableDeclaration(candidate) && candidate.name.getText(ast) === names[key]);
  const expression = node.initializer.arguments[0].getText(ast);
  const loader = (pending, query = "current") => evaluate(`const result = ${expression};`, {
    MANAGEMENT_PAGE_SIZE: 100,
    managedFirstPending: { current: { listings: null, customers: null } },
    managedMoreControllers: { current: {} },
    setManagedPages: () => {},
    readManagedWindow: compile(["appendManagedRows", "readManagedWindow"], { MANAGEMENT_PAGE_SIZE: 100 }),
    requestVersion: version, setManagedReads: managed.set,
    listingsSearch: query, listingStatuses: [], listingPrices: [], propertyTypeFilter: "", listingSort: "building",
    customersSearch: query, customerSort: "recent", calendarMonth: "2026-09", calendarWorkType: query,
    jsonFetch: () => pending.promise, fetchAllWorkLogs: () => pending.promise, collectOffsetPages,
    setListings: rows.set, setCustomerResults: rows.set, setCalendarLogs: rows.set,
    isAborted: (error) => error?.name === "AbortError",
  });
  const response = (id) => key === "calendar" ? [{ id, work_date: "2026-09-13" }] : { [key]: [{ id }], total: 1, hasMore: false };
  return { managed, rows, loader, response };
}

test("매물·고객·달력의 내부 조회 중단은 무한 로딩 대신 재시도 오류가 되고 성공하면 해제된다", async () => {
  for (const key of ["listings", "customers", "calendar"]) {
    const h = managedLoadHarness(key), failed = deferred();
    const request = h.loader(failed)();
    assert.equal(h.managed.current[key].loading, true);
    const abort = new Error("synthetic internal abort"); abort.name = "AbortError";
    failed.reject(abort);
    await assert.rejects(request, { name: "AbortError" });
    assert.equal(h.managed.current[key].loading, false);
    assert.match(h.managed.current[key].error.message, /조회가 중단되었습니다/);
    const retried = deferred();
    const retry = h.loader(retried)();
    assert.equal(h.managed.current[key].error, null);
    retried.resolve(h.response("recovered"));
    await retry;
    assert.equal(h.managed.current[key].error, null);
    assert.equal(h.managed.current[key].loading, false);
    assert.equal(h.rows.current[0].id, "recovered");
  }
});

test("매물·고객·달력의 이전 요청이 늦게 실패해도 현재 성공한 결과와 건수를 바꾸지 않는다", async () => {
  for (const key of ["listings", "customers", "calendar"]) {
    const h = managedLoadHarness(key), first = deferred(), second = deferred();
    const old = h.loader(first, "old")();
    const current = h.loader(second, "current")();
    second.resolve(h.response("current"));
    await current;
    const loadedQuery = h.managed.current[key].loadedQuery;
    first.reject(new Error("synthetic old failure"));
    await assert.rejects(old, /synthetic old failure/);
    assert.equal(h.managed.current[key].error, null);
    assert.equal(h.managed.current[key].loading, false);
    assert.equal(h.managed.current[key].loadedQuery, loadedQuery);
    assert.equal(h.rows.current[0].id, "current");
  }
});

function dashboardHarness(initial = null) {
  const dashboard = state(initial), error = state(""), loading = state(true), requests = [];
  const version = { current: { dashboard: 0 } };
  const node = find((candidate) => ts.isVariableDeclaration(candidate) && candidate.name.getText(ast) === "refreshDashboard");
  const loader = (pending) => evaluate(`const result = ${node.initializer.arguments[0].getText(ast)};`, {
    requestVersion: version, setDashboard: dashboard.set, setDashboardError: error.set, setLoading: loading.set,
    jsonFetch: (url) => { requests.push(url); return pending.promise; },
    isAborted: (caught) => caught?.name === "AbortError",
  });
  return { dashboard, error, loading, requests, loader };
}

test("최신 홈 조회의 내부 취소는 빈 홈이나 성공처럼 보이지 않고 로딩을 끝내며 재시도 후 회복한다", async () => {
  for (const initial of [null, { marker: "previous-dashboard" }]) {
    const h = dashboardHarness(initial), failed = deferred();
    const request = h.loader(failed)();
    const abort = new Error("synthetic shared-read abort"); abort.name = "AbortError";
    failed.reject(abort);
    await assert.rejects(request, { name: "AbortError" });
    assert.equal(h.loading.current, false);
    assert.match(h.error.current, /홈 정보 조회를 완료하지 못했습니다.*다시 불러와/);
    assert.equal(h.dashboard.current, initial, "confirmed old home data is not discarded");
    const retried = deferred();
    const retry = h.loader(retried)();
    retried.resolve({ marker: "new-dashboard" });
    await retry;
    assert.equal(h.error.current, "");
    assert.equal(h.loading.current, false);
    assert.deepEqual(h.dashboard.current, { marker: "new-dashboard" });
    assert.deepEqual(h.requests, ["/api/bootstrap", "/api/bootstrap"]);
  }
});

test("이전 홈 조회의 늦은 내부 취소는 최신 조회의 로딩·성공 데이터·오류를 덮지 않는다", async () => {
  for (const resolveFirst of [false, true]) {
    const h = dashboardHarness(), oldResponse = deferred(), newResponse = deferred();
    const old = h.loader(oldResponse)();
    const current = h.loader(newResponse)();
    if (resolveFirst) {
      newResponse.resolve({ marker: "current-dashboard" });
      await current;
    }
    const abort = new Error("synthetic old abort"); abort.name = "AbortError";
    oldResponse.reject(abort);
    await assert.rejects(old, { name: "AbortError" });
    assert.equal(h.error.current, "");
    assert.equal(h.loading.current, !resolveFirst, "old finally must not end a newer pending request");
    if (!resolveFirst) {
      newResponse.resolve({ marker: "current-dashboard" });
      await current;
    }
    assert.deepEqual(h.dashboard.current, { marker: "current-dashboard" });
    assert.equal(h.error.current, "");
    assert.equal(h.loading.current, false);
  }
});
