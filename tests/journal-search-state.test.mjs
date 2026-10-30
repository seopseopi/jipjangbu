import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { canAppendPage } from "../app/client-paging.ts";
import { getWorkProperties, workPropertyLabel } from "../app/work-property-summary.ts";
import { getPropertyDisplayGroups } from "../app/property-display.ts";
import { initialResultPage, initialResultListRef, ResultPagination } from "./helpers/result-pagination.mjs";

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
const JournalView = compile(["displayDate", "targetText", "statusTone", "EmptyState", "Toolbar", "WorkTable", "ListReadFeedback", "JournalView"], {
  React,
  useContext: () => null, PageToolsSlot: null, createPortal: (node) => node,
  Icon: () => null, useResultPage: initialResultPage, useResultListRef: initialResultListRef, ResultPagination,
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
    items: [synthetic], total: 222, lookups: { workTypes: ["전화"] }, query: "106동 1503호", workType: "",
    setQuery() {}, setWorkType() {}, onReset() {}, onLoadMore() {}, loadingMore: false,
    status: "ready", error: "", onRetry() {}, canLoadMore: true, onOpen() {},
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

test("검색 중과 실패 화면은 이전 업무·건수를 숨기고 페이지 이동을 잠근다", () => {
  for (const searchStatus of ["loading", "error"]) {
    const html = renderToStaticMarkup(React.createElement(JournalView, props({ status: searchStatus, error: "합성 연결 실패" })));
    assert.doesNotMatch(html, /이전 검색에만 속한 내용|1 \/ 222|100건 더 보기/);
    assert.doesNotMatch(html, /조건에 맞는 업무가 없습니다/);
    assert.match(html, /aria-label="다음 페이지" disabled=""/);
    assert.doesNotMatch(html, /CSV|업무 기간 필터/);
    assert.match(html, searchStatus === "loading" ? /role="status"/ : /role="alert"/);
    assert.match(html, searchStatus === "loading" ? /aria-busy="true"/ : /다시 불러오기/);
  }
  const empty = renderToStaticMarkup(React.createElement(JournalView, props({ items: [], total: 0 })));
  assert.match(empty, /조건에 맞는 업무가 없습니다/);
  assert.match(empty, /0건/);
  assert.doesNotMatch(empty, /조회 실패|다시 불러오기/);
});

test("실패한 업무 검색은 입력 조건을 유지한 채 다시 시도한다", () => {
  let retries = 0;
  const tree = JournalView(props({ status: "error", error: "연결 실패", onRetry: () => { retries++; } }));
  const feedback = descendants(tree).find((element) => typeof element.type === "function" && element.type.name === "ListReadFeedback");
  assert.ok(feedback);
  const retry = descendants(feedback.type(feedback.props)).find((element) => element.type === "button" && renderToStaticMarkup(element).includes("다시 불러오기"));
  assert.equal(retry.props.type, "button");
  retry.props.onClick();
  assert.equal(retries, 1);
  assert.match(renderToStaticMarkup(tree), /106동 1503호/);
});

test("같은 조건의 갱신은 읽던 목록을 유지하되 갱신 상태와 잠긴 페이지 이동을 표시한다", () => {
  const html = renderToStaticMarkup(React.createElement(JournalView, props({ status: "refreshing", canLoadMore: false })));
  assert.match(html, /이전 검색에만 속한 내용/);
  assert.match(html, /222건/);
  assert.match(html, /같은 조건의 이전 결과/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /aria-label="다음 페이지" disabled=""/);
  assert.doesNotMatch(html, /CSV|업무 기간 필터/);
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
    journalSearch: query, workTypeFilter: "전화",
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
  assert.deepEqual(h.error.current, { queryKey: JSON.stringify(["106동 1503호", "전화"]), message: "합성 요청 실패" });
  assert.equal(status(h.loaded.current, h.error.current.queryKey, h.loading.current, false, h.error.current), "error");
  const retried = deferred();
  const retry = h.loader("106동 1503호", retried)(undefined, 200);
  assert.equal(h.error.current, null);
  assert.equal(h.calls.at(-1).count, 200, "refresh keeps the requested visible window");
  assert.equal(h.calls.at(-1).params.get("q"), "106동 1503호");
  assert.equal(h.calls.at(-1).params.has("from"), false);
  assert.equal(h.calls.at(-1).params.has("to"), false);
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

test("업무 추가 페이지는 최신 성공 조건에서만 읽고 중복 요청과 늦은 응답을 막는다", async () => {
  const rows = state(Array.from({ length: 100 }, (_, index) => ({ ...synthetic, id: `loaded-${index}` })));
  const total = state(222), pending = deferred(), requests = [], version = { current: { work: 0 } };
  const first = { current: null }, more = { current: false }, loading = state(false), notices = [];
  const environment = {
    journalStatus: "ready", workTotal: total.current, workLogs: rows.current,
    canAppendPage, loadedWorkQueryRef: { current: "current" }, workQueryKey: "current",
    workFirstRequest: first, workMorePending: more, requestVersion: version,
    queries: { journal: "106동 1503호" }, journalSearch: "106동 1503호", workTypeFilter: "전화",
    setLoadingMore: loading.set, setWorkLogs: rows.set, setWorkTotal: total.set,
    jsonFetch: (url) => { requests.push(new URL(url, "https://local.invalid").searchParams); return pending.promise; },
    showLoadError: (error) => notices.push(error.message),
  };
  const load = compile(["loadMoreWorkLogs"], environment);
  const started = load();
  assert.equal(loading.current, true);
  await load();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].get("offset"), "100");
  assert.equal(requests[0].get("limit"), "100");
  assert.equal(requests[0].get("q"), "106동 1503호");
  assert.equal(requests[0].get("workType"), "전화");
  pending.resolve({ workLogs: [{ ...synthetic, id: "next-work" }], total: 222 });
  assert.equal(await started, 101, "the pagination hook receives the usable loaded count");
  assert.equal(rows.current.length, 101);
  assert.equal(loading.current, false);
  for (const overrides of [{ journalStatus: "refreshing" }, { loadedWorkQueryRef: { current: "old" } }, { workFirstRequest: { current: 9 } }]) {
    await compile(["loadMoreWorkLogs"], { ...environment, ...overrides })();
  }
  assert.equal(requests.length, 1, "unconfirmed results cannot start another page read");
  const stale = deferred();
  const old = compile(["loadMoreWorkLogs"], { ...environment, jsonFetch: () => stale.promise })();
  version.current.work++;
  stale.resolve({ workLogs: [{ id: "stale-work" }], total: 223 });
  assert.equal(await old, undefined);
  assert.equal(rows.current.some((row) => row.id === "stale-work"), false);
  assert.deepEqual(notices, []);
});
