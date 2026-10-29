import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { WorkSummaryProperties } from "./helpers/work-summary-properties.mjs";
import { searchExcerpt } from "../app/search-excerpt.ts";
import { getPropertyDisplayGroups } from "../app/property-display.ts";
import { getWorkProperties } from "../app/work-property-summary.ts";

const properties = [
  { id: "p1", sequence: 1, property_type: "아파트", building_name: "첫번째합성단지", building_dong: "101", unit_number: "1001", sale_price: "35000", source: "" },
  { id: "p2", sequence: 2, property_type: "아파트", building_name: "두번째합성단지", building_dong: "202", unit_number: "2002", jeonse_price: "25000", source: "합성업소" },
];
const work = { id: "synthetic-work", customer_id: "synthetic-customer", customer_name: "합성 고객", work_type: "전화", work_date: "2026-09-13", content: "합성 고객의 저장된 내용", ...properties[0], property_count: 2, properties_json: JSON.stringify(properties) };
const html = (element) => renderToStaticMarkup(element);
function descendants(element) {
  if (!React.isValidElement(element)) return [];
  return [element, ...React.Children.toArray(element.props.children).flatMap(descendants)];
}
function compile(path, name, environment, names) {
  const source = readFileSync(new URL(`../app/${path}`, import.meta.url), "utf8");
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && (!names || names.includes(node.name?.text))).map((node) => node.getText(ast)).join("\n");
  const output = ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText.replace(/^export /gm, "");
  return new Function(...Object.keys(environment), `${output}; return ${name};`)(...Object.values(environment));
}
const base = { React, WorkSummaryProperties, Icon: "span", useEffect: () => {}, useMemo: (callback) => callback(), useCallback: (callback) => callback, useRef: (current) => ({ current }), useId: () => "synthetic-id" };

test("공통 요약은 모든 주소와 물건 개수를 개별 읽기 항목으로 표시하며 가격도 해당 물건에 맞춘다", () => {
  const tree = WorkSummaryProperties({ work, showPrices: true });
  const result = html(tree);
  assert.match(result, /함께 기록한 물건 2개/);
  const entries = descendants(tree).filter((element) => element.props.role === "listitem");
  assert.equal(entries.length, 2);
  assert.match(html(entries[0]), /첫번째합성단지 101동 1001호/);
  assert.match(html(entries[0]), /매매 35000/);
  assert.doesNotMatch(html(entries[0]), /전세 25000/);
  assert.match(html(entries[1]), /두번째합성단지 202동 2002호/);
  assert.match(html(entries[1]), /전세 25000/);
  assert.doesNotMatch(result, /외 \d+개|<button|<input|<form/);
});

test("연결 매물의 물건지는 단일·다중·같은단지·이전 응답에서 각 주소 옆 괄호로 표시하고 빈 값은 생략한다", () => {
  const sources = [" 뉴현대 ", "", " \n\t ", undefined, "<script>합성업소</script>", "긴 합성 물건지 ".repeat(30)];
  const items = sources.map((source, i) => ({ ...properties[0], id: `source-${i}`, unit_number: String(1001 + i), source }));
  const original = JSON.stringify(items);
  const tree = WorkSummaryProperties({ work: { properties_json: JSON.stringify(items), property_count: items.length }, showSingle: true });
  const entries = descendants(tree).filter((element) => element.props.role === "listitem");
  entries.forEach((entry, i) => {
    const label = descendants(entry).find((element) => element.props.className === "work-summary-property-label");
    const source = sources[i]?.trim();
    const expected = `101동 ${1001 + i}호${source ? ` (${source})` : ""}`;
    assert.equal(label.props.children, expected);
    assert.equal(label.props.title, `첫번째합성단지 ${expected}`);
    assert.ok(entry.props["aria-label"].endsWith(expected));
  });
  assert.doesNotMatch(html(tree), /<script>|\(\)/);
  assert.match(html(tree), /&lt;script&gt;합성업소&lt;\/script&gt;/);
  assert.equal(JSON.stringify(items), original, "display does not rewrite source records");
  for (const properties_json of [undefined, "not-json", JSON.stringify([items[0]])]) {
    const single = WorkSummaryProperties({ work: { ...items[0], properties_json, property_count: 1 }, showSingle: true });
    assert.match(html(single), /첫번째합성단지 101동 1001호 \(뉴현대\)/);
  }
});

test("공통 요약은 두번째 물건 검색 일치를 표시하되 원래 물건 순서를 유지한다", () => {
  const tree = WorkSummaryProperties({ work: { ...work, ...properties[1], search_property_match: 1 } });
  const entries = descendants(tree).filter((element) => element.props.role === "listitem");
  assert.doesNotMatch(entries[0].props.className, /is-search-match/);
  assert.match(entries[1].props.className, /is-search-match/);
  assert.match(html(entries[1]), /검색 일치/);
  assert.match(html(entries[0]), /첫번째합성단지/);
});

test("물건 없는 응답은 가짜 항목이 없으며 단일 물건과 이전 캐시 응답도 호환한다", () => {
  assert.equal(WorkSummaryProperties({ work: { properties_json: "[]", property_count: 0 } }), null);
  const single = { ...properties[0], property_count: 1 };
  assert.equal(WorkSummaryProperties({ work: single }), null);
  assert.match(html(WorkSummaryProperties({ work: single, showSingle: true })), /첫번째합성단지/);
  const cached = html(WorkSummaryProperties({ work: { ...single, property_count: 2, properties_json: "not-json" } }));
  assert.match(cached, /함께 기록한 물건 2개/);
  assert.match(cached, /전체 물건 주소는 업무 내용을 열어 확인/);
});

test("고객 보조 이력은 펼치기 전부터 두 주소·가격을 읽을 수 있고 펼침은 읽기 상태만 바꾼다", () => {
  const changes = [];
  const Row = compile("related-history.tsx", "HistoryRecordRow", { ...base, useState: () => [false, (value) => changes.push(typeof value === "function" ? value(false) : value)] }, ["HistoryRecordRow"]);
  const tree = Row({ record: { id: "history", workId: work.id, date: work.work_date, workType: work.work_type, customerName: work.customer_name, content: work.content, property: work, propertyCount: 2 }, current: false });
  const result = html(tree);
  assert.match(result, /첫번째합성단지 101동 1001호/);
  assert.match(result, /두번째합성단지 202동 2002호/);
  assert.match(result, /매매 35000/);
  assert.match(result, /전세 25000/);
  assert.doesNotMatch(result, /외 1개/);
  descendants(tree).find((element) => element.type === "button").props.onClick();
  assert.deepEqual(changes, [true]);
});

test("통합검색은 검색에 맞은 대표 주소와 모든 연결 주소를 유지하고 같은 업무 읽기 콜백을 호출한다", () => {
  const matchedWork = { ...work, ...properties[1], id: "synthetic-work", search_property_match: 1 };
  const states = ["2002", { workLogs: [matchedWork], customers: [], listings: [] }, "success", "", 0];
  let stateIndex = 0;
  const View = compile("global-search.tsx", "GlobalSearch", { ...base, searchExcerpt, emptyResults: () => ({ workLogs: [], customers: [], listings: [] }), useState: () => [states[stateIndex++], () => {}] });
  const calls = [];
  const tree = View({ open: true, onClose: () => calls.push("close"), onOpenWork: (id) => calls.push(id), onOpenCustomer: () => {}, onOpenListing: () => {} });
  const button = descendants(tree).find((element) => element.type === "button" && element.props.className?.includes("global-search-work"));
  const result = html(button);
  assert.match(result, /<strong>두번째합성단지 202동 2002호<\/strong>/);
  assert.match(result, /함께 기록한 물건 2개/);
  assert.match(result, /첫번째합성단지 101동 1001호/);
  assert.match(result, /is-search-match/);
  button.props.onClick();
  assert.deepEqual(calls, ["close", "synthetic-work"]);
});

test("통합검색은 최대 8개 제한과 전체 목록 연결을 제공하고 취소된 이동에서는 검색창을 유지한다", () => {
  for (const allow of [true, false]) {
    const states = ["  합성  ", { workLogs: [work], customers: [{ id: "customer", name: "합성", notes: "", history_count: 1 }], listings: [{ id: "listing", building_name: "합성단지", status: "매물등록" }] }, "success", "", 0];
    let stateIndex = 0;
    const View = compile("global-search.tsx", "GlobalSearch", { ...base, searchExcerpt, emptyResults: () => ({ workLogs: [], customers: [], listings: [] }), useState: () => [states[stateIndex++], () => {}] });
    const calls = [];
    const tree = View({ open: true, onClose: () => calls.push("close"), onShowAll: (view, query) => { calls.push([view, query]); return allow; }, onOpenWork() {}, onOpenCustomer() {}, onOpenListing() {} });
    assert.match(html(tree), /유형별 최대 8개 표시/);
    for (const [label, target] of [["전체 업무", "journal"], ["전체 고객", "customers"], ["전체 매물", "listings"]]) {
      const link = descendants(tree).find((item) => item.type === "button" && item.props["aria-label"]?.includes(label));
      assert.ok(link);
      calls.length = 0; link.props.onClick();
      assert.deepEqual(calls, allow ? [[target, "합성"], "close"] : [[target, "합성"]]);
    }
  }
});

test("업무현황 일정은 여러 주소를 접거나 생략하지 않고 같은 업무 읽기 콜백으로 연결한다", () => {
  const data = { summary: { monthWorkCount: 1, monthCustomerCount: 1, activeListingCount: 1, staleListingCount: 0 }, monthly: [], workTypes: [], upcoming: [work], staleListings: [] };
  const states = [data, false, "", 0];
  let stateIndex = 0;
  const View = compile("insights-view.tsx", "InsightsView", { ...base, useState: () => [states[stateIndex++], () => {}] });
  const calls = [];
  const tree = View({ onOpenWork: (id) => calls.push(id), onOpenListing: () => {} });
  const button = descendants(tree).find((element) => element.type === "button" && element.props.className?.includes("insights-upcoming-item"));
  const result = html(button);
  assert.match(result, /함께 기록한 물건 2개/);
  assert.match(result, /첫번째합성단지 101동 1001호/);
  assert.match(result, /두번째합성단지 202동 2002호/);
  button.props.onClick();
  assert.deepEqual(calls, [work.id]);
});

test("공통 요약 주소는 모바일 큰 글씨·긴 문구에서 모두 줄바꿈하며 자체 조회나 수정 기능을 만들지 않는다", () => {
  const css = readFileSync(new URL("../app/work-summary-properties.css", import.meta.url), "utf8");
  assert.match(css, /\.work-summary-property-label\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
  assert.doesNotMatch(css, /line-clamp|text-overflow:\s*ellipsis|overflow:\s*hidden/);
  const source = readFileSync(new URL("../app/work-summary-properties.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fetch\(|clientJsonFetch|\/api\/|onClick|onChange/);
});

test("동일 단지 그룹은 연속한 같은 물건구분만 묶으며 원래 물건 순서와 객체를 보존한다", () => {
  const items = getWorkProperties({ properties_json: JSON.stringify([
    { ...properties[0], id: "first-a", building_name: "공통단지" },
    { ...properties[0], id: "first-b", building_name: "공통단지", unit_number: "1002" },
    { ...properties[0], id: "other-type", building_name: "공통단지", property_type: "상가" },
    { ...properties[0], id: "second-building", building_name: "다른단지" },
    { ...properties[0], id: "return-building", building_name: "공통단지", unit_number: "1003" },
    { ...properties[0], id: "missing-a", building_name: "" },
    { ...properties[0], id: "missing-b", building_name: "" },
  ]) });
  const original = JSON.stringify(items);
  const groups = getPropertyDisplayGroups(items);
  assert.deepEqual(groups.map((group) => group.items.length), [2, 1, 1, 1, 1, 1]);
  assert.deepEqual(groups.flatMap((group) => group.items.map((item) => item.index)), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(groups.flatMap((group) => group.items.map((item) => item.property.id)), items.map((item) => item.id));
  groups.flatMap((group) => group.items).forEach((item) => assert.equal(item.property, items[item.index]));
  assert.equal(new Set(groups.map((group) => group.key)).size, groups.length);
  assert.notEqual(groups[0].key, groups[1].key);
  assert.equal(JSON.stringify(items), original);
});

test("짧은 주소는 동·호수 접미사를 중복하지 않고 불완전한 주소의 식별정보를 유지한다", () => {
  const items = getWorkProperties({ properties_json: JSON.stringify([
    { ...properties[0], building_dong: "101동", unit_number: "1001호" },
    { ...properties[0], building_dong: "", unit_number: "1002" },
    { ...properties[0], building_dong: "102", unit_number: "" },
    { ...properties[0], building_dong: "", unit_number: "" },
    { ...properties[0], building_name: "", building_dong: "", unit_number: "", property_type: "상가" },
    { building_name: "", building_dong: "", unit_number: "", property_type: "" },
  ]) });
  assert.deepEqual(getPropertyDisplayGroups(items).flatMap((group) => group.items.map((item) => item.shortLabel)), ["101동 1001호", "1002호", "102동", "첫번째합성단지", "상가", "물건 정보 없음"]);
});

test("같은 단지 물건 10개는 건물명 소제목 하나와 10개 동·호수로 표시하고 모든 전체 주소를 접근 가능하게 유지한다", () => {
  const items = Array.from({ length: 10 }, (_, index) => ({ ...properties[0], id: `ten-${index}`, sequence: index + 1, building_name: "한번만표시할합성단지", building_dong: "106", unit_number: String(1501 + index) }));
  const tree = WorkSummaryProperties({ work: { ...work, properties_json: JSON.stringify(items), property_count: 10 } });
  const elements = descendants(tree);
  const headings = elements.filter((element) => element.props.className === "work-summary-building");
  assert.equal(headings.length, 1);
  assert.equal(headings[0].props.children, "한번만표시할합성단지");
  const entries = elements.filter((element) => element.props.role === "listitem");
  assert.equal(entries.length, 10);
  entries.forEach((entry, index) => {
    const label = descendants(entry).find((element) => element.props.className === "work-summary-property-label");
    assert.equal(label.props.children, `106동 ${1501 + index}호`);
    assert.equal(label.props.title, `한번만표시할합성단지 106동 ${1501 + index}호`);
    assert.equal(entry.props["aria-label"], `물건 ${index + 1} · 한번만표시할합성단지 106동 ${1501 + index}호`);
  });
  assert.match(html(tree), /함께 기록한 물건 10개/);
  assert.doesNotMatch(html(tree), /외 \d|더 보기|접기|펼치기|<button/);
});

test("같은 단지의 검색 일치 및 숫자 0 가격은 간결한 목록에서도 사라지지 않는다", () => {
  const items = [
    { ...properties[0], id: "zero-first", sale_price: 0, jeonse_price: 0, monthly_rent: 0 },
    { ...properties[0], id: "zero-second", unit_number: "1002", sale_price: "0" },
  ];
  const tree = WorkSummaryProperties({ work: { ...work, ...items[1], properties_json: JSON.stringify(items), property_count: 2, search_property_match: 1 }, showPrices: true });
  const entries = descendants(tree).filter((element) => element.props.role === "listitem");
  assert.match(html(entries[0]), /매매 0 · 전세 0 · 월세 0/);
  assert.match(html(entries[1]), /매매 0/);
  assert.doesNotMatch(entries[0].props.className, /is-search-match/);
  assert.match(entries[1].props.className, /is-search-match/);
  assert.match(html(entries[1]), /검색 일치/);
  assert.match(entries[1].props["aria-label"], /첫번째합성단지 101동 1002호/);
});

test("목록은 개별 카드와 녹색 번호 장식 없이 충분한 컨테이너 폭에서만 2열을 사용한다", () => {
  const css = readFileSync(new URL("../app/work-summary-properties.css", import.meta.url), "utf8");
  const rule = (selector) => css.slice(css.indexOf(`${selector} {`)).split("}")[0];
  assert.match(rule(".work-summary-property"), /border:\s*0/);
  assert.match(rule(".work-summary-property"), /background:\s*transparent/);
  assert.doesNotMatch(rule(".work-summary-property-number"), /background|border-radius|green/);
  assert.match(rule(".work-summary-property-number"), /white-space:\s*nowrap/);
  assert.match(rule(".work-summary-property-number"), /flex:\s*0 0 28px/);
  assert.match(rule(".work-summary-property-count"), /color:\s*var\(--ink\)/);
  assert.match(css, /container-type:\s*inline-size/);
  assert.match(css, /@container work-property-summary \(min-width:\s*520px\)\s*\{\s*\.work-summary-property-list\s*\{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width:\s*720px\)\s*\{\s*\.work-summary-property-list\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(rule(".work-summary-building"), /grid-column:\s*1 \/ -1/);
  assert.doesNotMatch(css, /(?:^|[;{\s])(?:grid-auto-flow|order)\s*:/);
});
