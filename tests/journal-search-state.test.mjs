import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { canAppendPage } from "../app/client-paging.ts";
import { getWorkProperties, workPropertyLabel } from "../app/work-property-summary.ts";
import { getPropertyDisplayGroups } from "../app/property-display.ts";

// Execute the production handlers and markup with synthetic records and controlled I/O.
const source = readFileSync(new URL("../app/work-manager.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("work-manager.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name, callback = false) {
  let found;
  function visit(node) {
    if ((callback ? ts.isVariableDeclaration(node) : ts.isFunctionDeclaration(node)) && node.name?.getText(ast) === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, `${name} exists in production source`);
  return callback ? `const ${name} = ${found.initializer.arguments[0].getText(ast)};` : found.getText(ast);
}
function compile(names, environment = {}, callback = false) {
  const compiled = ts.transpileModule(names.map((name) => declaration(name, callback)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
  }).outputText;
  return new Function(...Object.keys(environment), `${compiled}; return ${names.at(-1)};`)(...Object.values(environment));
}
const status = compile(["journalSearchStatus"]);
const JournalView = compile(["displayDate", "targetText", "statusTone", "EmptyState", "Toolbar", "WorkTable", "JournalView"], {
  React,
  useContext: () => null, PageToolsSlot: null, createPortal: (node) => node,
  Icon: () => null,
  getWorkProperties,
  workPropertyLabel,
  getPropertyDisplayGroups,
});
const WorkTable = compile(["displayDate", "targetText", "statusTone", "EmptyState", "WorkTable"], { React, Icon: () => null, getWorkProperties, workPropertyLabel, getPropertyDisplayGroups });
const synthetic = {
  id: "work-example", work_date: "2026-09-13", work_type: "전화", customer_id: "customer-example", customer_name: "합성 고객",
  content: "이전 검색에만 속한 내용", property_type: "아파트", building_name: "예시단지", building_dong: "106", unit_number: "1503", property_count: 3,
};
function props(overrides = {}) {
  return {
    items: [synthetic], total: 222, lookups: { workTypes: ["전화"] }, query: "106동 1503호", workType: "", period: "",
    setQuery() {}, setWorkType() {}, setPeriod() {}, onReset() {}, onLoadMore() {}, loadingMore: false,
    status: "ready", error: "", onRetry() {}, exporting: false, canLoadMore: true, onExport() {}, onOpen() {},
    onCustomerHistory() {}, onListingHistory() {}, ...overrides,
  };
}
function descendants(element) {
  if (!React.isValidElement(element)) return [];
  const children = React.Children.toArray(element.props.children);
  return [element, ...children.flatMap(descendants)];
}
function state(initial) {
  const box = { current: initial };
  box.set = (next) => { box.current = typeof next === "function" ? next(box.current) : next; };
  return box;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("업무일지는 새 검색·필터 대기, 해당 조건의 오류, 성공 결과를 구분한다", () => {
  assert.equal(status("A", "B", false, true, null), "loading", "typing is pending before a request begins");
  assert.equal(status("A", "B", false, false, null), "loading", "new filters hide old rows before the request effect");
  assert.equal(status("A", "A", true, false, null), "refreshing", "same-query refresh preserves the existing reading position");
  assert.equal(status("A", "B", false, false, { queryKey: "B", message: "offline" }), "error");
  assert.equal(status("A", "C", false, false, { queryKey: "B", message: "offline" }), "loading", "old query errors do not poison the new query");
  assert.equal(status("B", "B", false, false, null), "ready");
});

test("검색 중과 실패 화면은 이전 업무·건수·더보기를 숨기고 CSV를 잠근다", () => {
  for (const searchStatus of ["loading", "error"]) {
    const html = renderToStaticMarkup(React.createElement(JournalView, props({ status: searchStatus, error: "합성 연결 실패" })));
    assert.doesNotMatch(html, /이전 검색에만 속한 내용|1 \/ 222|100건 더 보기/);
    assert.doesNotMatch(html, /조건에 맞는 업무가 없습니다/);
    assert.match(html, /class="export-button" disabled=""/);
    assert.match(html, searchStatus === "loading" ? /role="status"/ : /role="alert"/);
    assert.match(html, searchStatus === "loading" ? /aria-busy="true"/ : /다시 시도/);
  }
  const empty = renderToStaticMarkup(React.createElement(JournalView, props({ items: [], total: 0 })));
  assert.match(empty, /조건에 맞는 업무가 없습니다/);
  assert.match(empty, /0 \/ 0/);
  assert.doesNotMatch(empty, /조회 실패|다시 시도/);
});

test("실패한 업무 검색은 입력 조건을 유지한 채 다시 시도한다", () => {
  let retries = 0;
  const tree = JournalView(props({ status: "error", error: "연결 실패", onRetry: () => { retries++; } }));
  const retry = descendants(tree).find((element) => element.type === "button" && renderToStaticMarkup(element).includes("다시 시도"));
  assert.equal(retry.props.type, "button");
  retry.props.onClick();
  assert.equal(retries, 1);
  assert.match(renderToStaticMarkup(tree), /106동 1503호/);
});

test("같은 조건의 갱신은 긴 목록을 유지하되 갱신 상태와 잠긴 CSV를 표시한다", () => {
  const html = renderToStaticMarkup(React.createElement(JournalView, props({ status: "refreshing", canLoadMore: false })));
  assert.match(html, /이전 검색에만 속한 내용/);
  assert.match(html, /1 \/ 222/);
  assert.match(html, /같은 조건의 기존 결과를 표시 중/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /class="export-button" disabled=""/);
});

test("검색 일치 물건 표시와 매물 이력은 서버가 반환한 같은 물건을 가리킨다", () => {
  const properties = ["1503", "1504", "1505"].map((unit, index) => ({
    id: `property-${index}`, sequence: index + 1, property_type: synthetic.property_type,
    building_name: synthetic.building_name, building_dong: synthetic.building_dong, unit_number: unit,
  }));
  for (const match of [1, 0, undefined]) {
    const item = { ...synthetic, properties_json: JSON.stringify(properties), search_property_match: match };
    const opened = [];
    const tree = WorkTable({ items: [item], onOpen() {}, onCustomerHistory() {}, onListingHistory: (selected) => opened.push(selected) });
    const html = renderToStaticMarkup(tree);
    assert.equal(html.includes("검색 일치 물건"), match === 1);
    assert.match(html, /예시단지 106동 1503호/);
    assert.match(html, /함께 기록한 물건 3개/);
    assert.match(html, /예시단지 106동 1504호/);
    assert.match(html, /예시단지 106동 1505호/);
    assert.doesNotMatch(html, /외 2건/);
    const listing = descendants(tree).find((element) => element.type === "button" && element.props["aria-label"]?.endsWith("매물 이력 보기"));
    listing.props.onClick();
    assert.equal(opened[0].id, item.id);
    for (const key of ["property_type", "building_name", "building_dong", "unit_number"]) assert.equal(opened[0][key], item[key]);
  }
});

function loadHarness() {
  const error = state(null), loading = state(false), rows = state([synthetic]), total = state(222), loaded = state("old");
  const version = { current: { work: 0 } }, firstRequest = { current: null }, loadedRef = { current: "old" };
  const calls = [];
  const loader = (query, response) => compile(["loadWorkLogs"], {
    requestVersion: version, workFirstRequest: firstRequest,
    setWorkFirstPageLoading: loading.set, setWorkSearchError: error.set,
    journalSearch: query, workTypeFilter: "전화", workPeriod: "month",
    periodBounds: () => ["2026-09-01", "2026-09-30"],
    fetchWorkWindow: (_read, params, count, signal) => { calls.push({ params, count, signal }); return response.promise; },
    jsonFetch: assert.fail, loadedWorkQueryRef: loadedRef, setLoadedWorkQuery: loaded.set,
    setWorkLogs: rows.set, setWorkTotal: total.set,
    isAborted: (caught) => caught?.name === "AbortError",
  }, true);
  return { error, loading, rows, total, loaded, version, firstRequest, loadedRef, calls, loader };
}

test("실제 업무 로더는 실패를 조건 키에 묶고 재시도 성공 때 오류를 지운다", async () => {
  const h = loadHarness(), failed = deferred();
  const request = h.loader("106동 1503호", failed)();
  assert.equal(h.loading.current, true);
  failed.reject(new Error("합성 요청 실패"));
  await assert.rejects(request, /합성 요청 실패/);
  assert.equal(h.loading.current, false);
  assert.deepEqual(h.error.current, { queryKey: JSON.stringify(["106동 1503호", "전화", "2026-09-01", "2026-09-30"]), message: "합성 요청 실패" });
  assert.equal(status(h.loaded.current, h.error.current.queryKey, h.loading.current, false, h.error.current), "error");
  const retried = deferred();
  const retry = h.loader("106동 1503호", retried)(undefined, 200);
  assert.equal(h.error.current, null);
  assert.equal(h.calls.at(-1).count, 200, "refresh keeps the requested visible window");
  assert.equal(h.calls.at(-1).params.get("q"), "106동 1503호");
  assert.equal(h.calls.at(-1).params.get("from"), "2026-09-01");
  assert.equal(h.calls.at(-1).params.get("workType"), "전화");
  retried.resolve({ workLogs: [], total: 0 });
  await retry;
  assert.equal(h.error.current, null);
  assert.equal(h.total.current, 0);
  assert.equal(status(h.loaded.current, h.loaded.current, h.loading.current, false, h.error.current), "ready");
});

test("늦게 끝난 이전 검색의 실패가 현재 성공 결과를 오류로 바꾸지 않는다", async () => {
  const h = loadHarness(), first = deferred(), second = deferred();
  const old = h.loader("이전 검색", first)();
  const current = h.loader("현재 검색", second)();
  second.resolve({ workLogs: [{ id: "current-work" }], total: 1 });
  await current;
  first.reject(new Error("지연된 이전 요청 실패"));
  await old;
  assert.equal(h.error.current, null);
  assert.deepEqual(h.rows.current, [{ id: "current-work" }]);
  assert.equal(h.loading.current, false);
});

test("CSV는 최신 성공 조건에서만 실행되고 중복 실행을 막으며 대표 물건임을 알린다", async () => {
  for (const invalid of ["loading", "refreshing", "error"]) {
    const exportBlocked = compile(["exportWorkLogs"], { journalStatus: invalid });
    await exportBlocked();
  }
  const pending = deferred(), running = state(false), notices = [], downloads = [], requests = [];
  const environment = {
    journalStatus: "ready", workTotal: 2, workExportPending: { current: false },
    canAppendPage, loadedWorkQueryRef: { current: "current" }, workQueryKey: "current",
    workFirstRequest: { current: null }, workMorePending: { current: false },
    queries: { journal: "106동 1503호" }, journalSearch: "106동 1503호", workTypeFilter: "전화", workPeriod: "month",
    setExportingWork: running.set, setNotice: (message) => notices.push(message),
    periodBounds: () => ["2026-09-01", "2026-09-30"],
    fetchAllWorkLogs: (params) => { requests.push(params); return pending.promise; },
    downloadCsv: (...args) => downloads.push(args), seoulDate: () => "2026-09-13", targetText: () => "예시단지 106동 1503호",
  };
  const exportRows = compile(["exportWorkLogs"], environment);
  const started = exportRows();
  await exportRows();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].get("q"), "106동 1503호");
  assert.equal(requests[0].get("workType"), "전화");
  assert.equal(running.current, true);
  pending.resolve([synthetic]);
  await started;
  assert.equal(running.current, false);
  assert.equal(downloads[0][1][4], "대표 물건(업무당 1건)");
  assert.match(notices.at(-1), /현재 조건에 맞는 업무 1건/);
  assert.match(notices.at(-1), /대표 1건/);
  const stale = compile(["exportWorkLogs"], { ...environment, loadedWorkQueryRef: { current: "old" } });
  await stale();
  assert.equal(requests.length, 1, "stale results never trigger an export");
});
