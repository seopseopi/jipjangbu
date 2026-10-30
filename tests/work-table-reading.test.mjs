import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { createPropertyHistoryTarget } from "../app/history-query.ts";
import { getWorkProperties, workPropertyLabel } from "../app/work-property-summary.ts";
import { getPropertyDisplayGroups } from "../app/property-display.ts";
import { WorkSummaryProperties } from "./helpers/work-summary-properties.mjs";
import { ListingHistorySummary } from "./helpers/listing-history-summary.mjs";
import { HistoryWorkTypeFilter } from "./helpers/history-work-type-filter.mjs";
import { formatHistoryTimestamp } from "../app/history-timestamps.ts";

// Render and execute actual production reading components with synthetic work.
const source = readFileSync(new URL("../app/work-manager.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("work-manager.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function compile(names) {
  const declarations = names.map((name) => {
    const node = ast.statements.find((candidate) => ts.isFunctionDeclaration(candidate) && candidate.name?.text === name);
    assert.ok(node, `${name} exists`);
    return node.getText(ast);
  });
  const compiled = ts.transpileModule(declarations.join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
  }).outputText;
  return new Function("React", "Modal", "Icon", "workTypeIcon", "getWorkProperties", "workPropertyLabel", "getPropertyDisplayGroups", "WorkSummaryProperties", "ListingHistorySummary", "formatHistoryTimestamp", "HistoryWorkTypeFilter", `${compiled}; return ${names.at(-1)};`)(
    React, ({ children }) => children, () => null, () => "journal", getWorkProperties, workPropertyLabel, getPropertyDisplayGroups, WorkSummaryProperties, ListingHistorySummary, formatHistoryTimestamp, HistoryWorkTypeFilter,
  );
}
const helpers = ["displayDate", "targetText", "statusTone", "EmptyState"];
const WorkTable = compile([...helpers, "WorkTable"]);
const HistoryModal = compile([...helpers, "HistoryModal"]);
const markup = (element) => renderToStaticMarkup(element);
function descendants(element) {
  if (!React.isValidElement(element)) return [];
  return [element, ...React.Children.toArray(element.props.children).flatMap(descendants)];
}
const byClass = (tree, name) => descendants(tree).filter((element) => element.props.className?.split(/\s+/).includes(name));
const buttons = (tree, label) => descendants(tree).filter((element) => element.type === "button" && markup(element).includes(label));
const propertyRows = (tree) => byClass(tree, "work-property-list").flatMap((list) => React.Children.toArray(list.props.children));
function property(index) {
  return {
    id: `synthetic-property-${index}`, sequence: index + 1, property_type: "아파트", building_name: `합성단지${index + 1}`,
    building_dong: String(107 - index), unit_number: String(901 + index), size_type: "33A",
    sale_price: "35000", jeonse_price: "", monthly_rent: "", source: `합성업소${index + 1}`,
  };
}
const properties = Array.from({ length: 10 }, (_, index) => property(index));
const work = {
  id: "synthetic-work", work_date: "2026-09-13", work_type: "집방문", customer_id: "synthetic-customer",
  customer_name: "열 매물 함께 본 고객", content: "오전 방문 완료\n확인할 내용 전체", ...properties[0],
  property_count: properties.length, properties_json: JSON.stringify(properties),
};
// A summary's ID identifies its work, never its representative property.
work.id = "synthetic-work";
function table(items = [work], handlers = {}) {
  return WorkTable({ items, onOpen() {}, onCustomerHistory() {}, onListingHistory() {}, ...handlers });
}
function rows(items = [work], handlers = {}) {
  return table(items, { empty: "합성 업무 없음", ...handlers });
}
function history(data = {}, handlers = {}) {
  return HistoryModal({
    data: { title: "합성 이력", subtitle: "상세 읽기", items: [], ...data },
    onClose() {}, onRefresh() {}, onOpenWork() {}, onNewWork() {}, onFollowUp() {}, onCopy() {}, ...handlers,
  });
}
function assertAllAddresses(tree) {
  const html = markup(tree);
  let previous = -1;
  for (const property of properties) {
    const address = workPropertyLabel(property);
    const index = html.indexOf(address);
    assert.ok(index >= 0, `${address} is visible`);
    assert.ok(index > previous, "user-entered property order is preserved rather than sorted by address");
    previous = index;
  }
  assert.doesNotMatch(html, /외 \d+건|외 \d+개|<details\b|\shidden(?:=|\s|>)/);
  assert.doesNotMatch(html, /role="listitem"[^>]*aria-hidden="true"/, "only decorative repeated numbering may be hidden from assistive technology, never an address");
}

test("변경이력 없는 매물은 집방문·전화 업무를 바로 펼쳐 읽고 구분별 필터와 내용 보기를 유지한다", () => {
  const items = [work, { ...work, id: "call", work_type: "전화" }], opened = [];
  const data = { listingKey: "아파트|합성단지|105|401", workItems: items, items: [] };
  const tree = history(data, { onOpenWork: (id) => opened.push(id) });
  const html = markup(tree);
  assert.match(html, /매물 변경 이력은 없으며/);
  assert.match(html, /조회 2건/);
  assert.match(html, /이 매물이 포함된 전체 업무/);
  assert.doesNotMatch(html, /<details|현재 매물|가격 미기재|매물 수정 이력 추가|기록이 없습니다/);
  const recordButtons = descendants(tree).filter((item) => item.type === "button" && item.props.children?.some?.((child) => child?.props?.className === "history-entry-meta"));
  assert.equal(recordButtons.length, 2);
  recordButtons[0].props.onClick();
  assert.deepEqual(opened, [work.id]);
  for (const [type, count] of [["집방문", 1], ["잔금예정", 0]]) {
    const filtered = markup(history({ ...data, historyWorkType: type }));
    assert.match(filtered, new RegExp(`조회 ${count}건`));
    assert.doesNotMatch(filtered, /<details/);
    if (!count) assert.match(filtered, /잔금예정 업무 이력이 없습니다/);
  }
});

test("업무일지와 홈 업무 카드는 열 개 주소를 단지별 영역 안에 원래 순서로 모두 펼쳐 보여 준다", () => {
  const tree = table();
  assertAllAddresses(tree);
  assert.match(markup(tree), /함께 기록한 물건 10개/);
  assert.equal(propertyRows(tree).length, 10);
  assert.equal(byClass(tree, "work-property-building-group").length, 10);
});

test("각 물건 이력 버튼은 선택한 주소와 원래 업무 ID를 함께 전달한다", () => {
  const selected = [], opened = [];
  const tree = table([work], { onListingHistory: (item) => selected.push(item), onOpen: (id) => opened.push(id) });
  const listingButtons = descendants(tree).filter((element) => element.type === "button" && element.props["aria-label"]?.endsWith("매물 이력 보기"));
  assert.equal(listingButtons.length, 10);
  listingButtons.forEach((button) => button.props.onClick());
  assert.deepEqual(opened, [], "opening a property's history does not launch work editing or reading");
  for (const [index, item] of selected.entries()) {
    assert.equal(item.id, work.id);
    assert.equal(item.customer_id, work.customer_id);
    const target = createPropertyHistoryTarget({ propertyType: item.property_type, buildingName: item.building_name, buildingDong: item.building_dong, unitNumber: item.unit_number });
    assert.equal(target.key, ["아파트", properties[index].building_name, properties[index].building_dong, properties[index].unit_number].join("|"));
  }
});

test("업무일지·최근업무 및 고객·오늘·매물 개별 이력은 실제 물건지를 주소별 괄호로 표시한다", () => {
  const items = properties.slice(0, 3).map((property, index) => ({ ...property, source: [" 뉴현대 ", " \t ", "다른물건지"][index] }));
  const entry = { ...work, property_count: 3, properties_json: JSON.stringify(items) };
  const selected = [];
  const tableTree = table([entry], { onListingHistory: (item) => selected.push(item) });
  const labels = byClass(tableTree, "work-property-address");
  assert.deepEqual(labels.map((label) => label.props.children), ["107동 901호 (뉴현대)", "106동 902호", "105동 903호 (다른물건지)"]);
  for (const link of descendants(tableTree).filter((element) => element.type === "button" && element.props["aria-label"]?.endsWith("매물 이력 보기"))) link.props.onClick();
  assert.deepEqual(selected.map((row) => row.source), items.map((property) => property.source), "history actions use stored data, not display labels");
  for (const extra of [{ customer: { id: work.customer_id, name: work.customer_name } }, { date: work.work_date }, { listing: { identity_key: "synthetic-listing" }, workItems: [entry] }]) {
    const tree = history({ items: [entry], ...extra });
    const list = byClass(tree, "history-list")[0];
    assert.match(markup(list), /107동 901호 \(뉴현대\)/);
    assert.match(markup(list), /105동 903호 \(다른물건지\)/);
    assert.doesNotMatch(markup(list), /106동 902호 \(|\(\)/);
  }
});

test("검색에 일치한 두 번째 물건만 표시하되 첫 번째 물건을 위에서 숨기거나 재정렬하지 않는다", () => {
  const matched = { ...work, ...properties[1], id: work.id, search_property_match: 1 };
  const unrelated = { ...work, id: "synthetic-other-work", search_property_match: 0 };
  const tree = table([matched, unrelated]);
  const workRows = byClass(tree, "work-record-row");
  const entries = propertyRows(workRows[0]);
  assert.equal(byClass(workRows[0], "work-property-match").length, 1);
  assert.equal(byClass(workRows[1], "work-property-match").length, 0);
  assert.doesNotMatch(markup(entries[0]), /검색 일치 물건/);
  assert.match(markup(entries[1]), /검색 일치 물건/);
  assert.equal(entries[1].props.className, "is-search-match");
  assertAllAddresses(workRows[0]);
});

test("표의 일자·내용·전체 업무 버튼은 읽기 동작을 호출하고 고객 이력은 따로 열린다", () => {
  const opened = [], customers = [];
  const tree = table([work], { onOpen: (id) => opened.push(id), onCustomerHistory: (customer) => customers.push(customer) });
  assert.doesNotMatch(markup(tree), /업무 수정|업무 저장/);
  const record = byClass(tree, "work-record-row")[0];
  assert.equal(record.props.onClick, undefined, "the entire row is not an accidental edit or navigation target");
  const date = descendants(record).find((element) => element.props["data-label"] === "일자");
  const content = descendants(record).find((element) => element.props["data-label"] === "내용");
  buttons(date, "내용 보기")[0].props.onClick();
  buttons(content, "오전 방문 완료")[0].props.onClick();
  byClass(record, "work-record-open")[0].props.onClick();
  assert.deepEqual(opened, [work.id, work.id, work.id]);
  buttons(record, "고객 이력")[0].props.onClick();
  assert.deepEqual(customers, [{ id: work.customer_id, name: work.customer_name }]);
});

test("업무 카드는 반복 이력 안내 두 줄 없이 날짜·고객 머리말과 넓은 본문·물건 영역을 구분한다", () => {
  const tree = table();
  const [record] = byClass(tree, "work-record-row");
  assert.equal(record.type, "article");
  assert.equal(byClass(record, "work-record-meta").length, 1);
  const [body] = byClass(record, "work-record-body");
  assert.ok(body);
  assert.equal(byClass(body, "work-record-content").length, 1);
  assert.equal(byClass(body, "work-record-properties").length, 1);
  assert.equal(byClass(record, "work-record-note-text")[0].props.children, work.content, "the complete stored note remains available in the wide content region");
  assert.equal(byClass(record, "work-record-open").length, 1, "one clear whole-work action is enough");
  assert.equal(byClass(record, "table-head").length, 0, "the narrow five-column header is not retained inside the reading card");
  const listingButtons = descendants(record).filter((element) => element.type === "button" && element.props["aria-label"]?.endsWith("매물 이력 보기"));
  assert.equal(listingButtons.length, 10);
  for (const button of listingButtons) {
    assert.equal(descendants(button).filter((element) => element.type === "small").length, 0, "each address no longer has a repeated second-line history label");
    assert.equal(byClass(button, "work-property-address").length, 1);
  }
  assert.doesNotMatch(markup(record), /<details\b|\shidden(?:=|\s|>)|aria-expanded=|외 \d+건/);
});

test("연속된 같은 단지는 제목을 한 번만 보여주되 열 개 동·호수와 정확한 이력 연결을 모두 유지한다", () => {
  const sameBuilding = properties.map((property) => ({ ...property, building_name: "같은합성단지" }));
  const selected = [];
  const tree = table([{ ...work, properties_json: JSON.stringify(sameBuilding) }], { onListingHistory: (item) => selected.push(item) });
  assert.equal(byClass(tree, "work-property-building-group").length, 1);
  assert.deepEqual(byClass(tree, "work-property-building").map((heading) => heading.props.children), ["같은합성단지"]);
  assert.equal(propertyRows(tree).length, 10);
  const links = descendants(tree).filter((element) => element.type === "button" && element.props["aria-label"]?.endsWith("매물 이력 보기"));
  assert.deepEqual(links.map((link) => link.props["aria-label"]), sameBuilding.map((property) => `${workPropertyLabel(property, true)} 매물 이력 보기`));
  for (const [index, link] of links.entries()) {
    const [label] = byClass(link, "work-property-address");
    assert.equal(label.props.children, `${sameBuilding[index].building_dong}동 ${sameBuilding[index].unit_number}호 (${sameBuilding[index].source})`);
    assert.doesNotMatch(markup(label), /같은합성단지/);
    link.props.onClick();
  }
  assert.deepEqual(selected.map((item) => [item.id, item.building_name, item.building_dong, item.unit_number]), sameBuilding.map((property) => [work.id, property.building_name, property.building_dong, property.unit_number]));
  assert.doesNotMatch(markup(tree), /<details\b|\shidden(?:=|\s|>)|외 \d+건/);
});

test("단지를 다시 방문한 묶음도 합쳐 재정렬하지 않고 입력한 업무 순서를 유지한다", () => {
  const revisited = properties.slice(0, 4).map((property, index) => ({ ...property, building_name: index === 2 ? "중간합성단지" : "재방문합성단지" }));
  const tree = table([{ ...work, property_count: 4, properties_json: JSON.stringify(revisited) }]);
  assert.deepEqual(byClass(tree, "work-property-building").map((heading) => heading.props.children), ["재방문합성단지", "중간합성단지", "재방문합성단지"]);
  assert.deepEqual(byClass(tree, "work-property-list").map((list) => React.Children.count(list.props.children)), [2, 1, 1]);
  const links = descendants(tree).filter((element) => element.type === "button" && element.props["aria-label"]?.endsWith("매물 이력 보기"));
  assert.deepEqual(links.map((link) => link.props["aria-label"]), revisited.map((property) => `${workPropertyLabel(property, true)} 매물 이력 보기`));
});

test("불완전한 주소도 빠뜨리지 않으며 이력을 추측해 열지 않고 나머지 정상 매물은 연결한다", () => {
  const incomplete = { ...properties[0], building_name: "", building_dong: "", unit_number: "", property_type: "", source: "합성 업소만 기록" };
  const tree = table([{ ...work, property_count: 2, properties_json: JSON.stringify([incomplete, properties[1]]) }]);
  assert.equal(propertyRows(tree).length, 2);
  assert.match(markup(propertyRows(tree)[0]), /물건 정보 없음/);
  assert.equal(descendants(propertyRows(tree)[0]).filter((element) => element.type === "button").length, 0);
  const links = descendants(tree).filter((element) => element.type === "button" && element.props["aria-label"]?.endsWith("매물 이력 보기"));
  assert.equal(links.length, 1);
  assert.equal(links[0].props["aria-label"], `${workPropertyLabel(properties[1], true)} 매물 이력 보기`);
});

test("홈·예정 업무 요약에도 모든 주소와 고객 이름을 함께 표시하고 읽기 동작으로 연결한다", () => {
  const opened = [];
  const tree = rows([work], { onOpen: (id) => opened.push(id) });
  assertAllAddresses(tree);
  const html = markup(tree);
  assert.match(html, /열 매물 함께 본 고객/);
  assert.match(html, /함께 기록한 물건 10개/);
  assert.match(html, /2026\.09\.13/);
  assert.match(html, /오전 방문 완료/);
  assert.doesNotMatch(html, /업무 수정/);
  byClass(tree, "work-record-open")[0].props.onClick();
  assert.deepEqual(opened, [work.id]);
});

test("날짜·고객 이력에서 열 물건의 주소를 모두 읽은 뒤 업무 상세를 연다", () => {
  const opened = [];
  const tree = history({ items: [work] }, { onOpenWork: (id) => opened.push(id) });
  assertAllAddresses(tree);
  assert.match(markup(tree), /열 매물 함께 본 고객/);
  assert.match(markup(tree), /업무 내용을 먼저 읽을 수 있습니다/);
  assert.doesNotMatch(markup(tree), /업무 수정|<input|<form/);
  const entry = byClass(tree, "history-list")[0].props.children[0];
  entry.props.onClick();
  assert.deepEqual(opened, [work.id]);
});

test("대표 물건 주소가 비어 있어도 뒤에 함께 기록한 정상 물건들을 이력에서 누락하지 않는다", () => {
  const missingFirst = { ...work, property_type: "", building_name: "", building_dong: "", unit_number: "", source: "업소만 남은 원본" };
  const tree = history({ items: [missingFirst] });
  assertAllAddresses(tree);
  const noCustomer = history({ items: [{ ...missingFirst, customer_name: "" }] });
  assertAllAddresses(noCustomer);
});

const listing = {
  id: "synthetic-listing", identity_key: "아파트|합성단지|106|1503", status: "매물등록", property_type: "아파트",
  building_name: "합성단지", building_dong: "106", unit_number: "1503", sale_price: "35000", jeonse_price: "", monthly_rent: "", source_notes: "보존할 기존 매물 메모",
};
const event = (id, customerId, extra = {}) => ({ id, event_date: "2026-09-13", status: "매물수정", notes: "변경 기록", work_log_id: `work-${id}`, customer_id: customerId, customer_name: `고객 ${customerId}`, ...extra });

test("매물 팝업은 상태 이력과 전체 개별 업무를 분리하고 실제 고객 이름·ID·업무 읽기 연결을 보존한다", () => {
  const opened = [];
  const tree = history({ listing, items: [event("event-only", "owner")], workItems: [work] }, { onOpenWork: (id) => opened.push(id) });
  const individual = byClass(tree, "listing-work-details")[0];
  assert.match(markup(individual), /개별 업무 보기.*1건/);
  assert.ok(markup(individual).includes(work.customer_name));
  assert.ok(markup(individual).includes(work.customer_id));
  assertAllAddresses(byClass(individual, "history-list")[0]);
  assert.doesNotMatch(markup(individual), /고객 owner/);
  const entry = byClass(individual, "history-list")[0].props.children[0];
  entry.props.onClick();
  assert.deepEqual(opened, [work.id]);
});

test("매물 수정 이력 추가는 현재 매물과 가장 최근 이력의 고객을 전달하며 전체 이력 읽기와 개별 업무를 구분한다", () => {
  const modified = [], created = [];
  const items = [event("without-customer", ""), event("latest", "customer-latest"), event("older", "customer-older", { event_date: "2026-09-12" })];
  const tree = history({ listing, items }, {
    onModifyListing: (...args) => modified.push(args), onNewListingWork: (item) => created.push(item),
  });
  assert.deepEqual(modified, [], "reading listing history does not mutate or create work");
  const button = buttons(tree, "매물 수정 이력 추가")[0];
  assert.equal(button.props.type, "button");
  assert.equal(button.props.disabled, false);
  button.props.onClick();
  assert.deepEqual(modified, [[listing, "customer-latest"]]);
  buttons(tree, "이 매물로 업무 등록")[0].props.onClick();
  assert.deepEqual(created, [listing], "ordinary new work does not silently choose the modification action or previous customer");
  const html = markup(tree);
  assert.match(html, /전체 매물 이력/);
  assert.match(html, /업무일 최신순 · 3건/);
  const individual = byClass(tree, "listing-work-details")[0];
  assert.equal(individual.type, "details");
  assert.equal(Boolean(individual.props.open), false);
  assert.match(markup(individual), /개별 업무 보기/);
  assert.match(html, /보존할 기존 매물 메모/);
});

test("고객 없는 매물의 수정 이력은 고객을 임의 추정하지 않고 종료 매물에는 수정 버튼을 노출하지 않는다", () => {
  const modified = [];
  const handlers = { onModifyListing: (...args) => modified.push(args), onNewListingWork() {} };
  const initial = history({ listing, items: [] }, handlers);
  buttons(initial, "매물 수정 이력 추가")[0].props.onClick();
  assert.deepEqual(modified, [[listing, undefined]]);
  const closed = history({ listing: { ...listing, closed_at: "2026-09-13" }, items: [] }, handlers);
  assert.equal(buttons(closed, "매물 수정 이력 추가").length, 0);
  assert.equal(buttons(closed, "이 매물로 업무 등록").length, 1);
});

test("매물 이력을 읽는 중이거나 조회 실패하면 오래된 정보로 수정·새 업무를 시작하지 않는다", () => {
  for (const state of [{ loading: true }, { error: "합성 이력 실패" }]) {
    const tree = history({ listing, items: [], ...state }, { onModifyListing() {}, onNewListingWork() {} });
    assert.equal(buttons(tree, "매물 수정 이력 추가")[0].props.disabled, true);
    assert.equal(buttons(tree, "이 매물로 업무 등록")[0].props.disabled, true);
    assert.doesNotMatch(markup(tree), /기록이 없습니다/);
  }
});

test("연결 업무가 있는 매물 이력은 읽기 상세로 열며 원본 이력은 비활성 상태로 남는다", () => {
  const opened = [];
  const tree = history({ listing, items: [event("linked", "customer"), event("original", "customer", { work_log_id: "" })] }, { onOpenWork: (id) => opened.push(id) });
  const entries = byClass(tree, "history-list")[0].props.children;
  assert.equal(entries[0].props.disabled, false);
  assert.equal(entries[1].props.disabled, true);
  assert.match(markup(entries[0]), /내용 보기/);
  assert.match(markup(entries[1]), /원본 이력/);
  entries.forEach((entry) => entry.props.onClick());
  assert.deepEqual(opened, ["work-linked"]);
});

test("물건이 없는 업무는 주소를 만들어내지 않고 내용 보기와 빈 상태를 유지한다", () => {
  const without = { ...work, property_count: 0, properties_json: "[]", content: "" };
  const tree = table([without]);
  assert.match(markup(tree), /물건 없음/);
  assert.doesNotMatch(markup(tree), /합성단지|함께 기록한 물건|매물 이력 보기/);
  assert.match(markup(tree), /내용 보기/);
  assert.match(markup(table([])), /조건에 맞는 업무가 없습니다/);
  assert.match(markup(rows([])), /합성 업무 없음/);
});

test("업무 목록의 각 물건은 해당 기록의 가격을 주소 옆에 표시하고 빈 가격은 표시하지 않는다", () => {
  const priced = [property(0), { ...property(1), sale_price: "", jeonse_price: "2억", monthly_rent: "1000/50" }, { ...property(2), sale_price: "", jeonse_price: "", monthly_rent: "" }];
  const tree = table([{ ...work, property_count: 3, properties_json: JSON.stringify(priced) }]);
  const rows = propertyRows(tree);
  assert.match(markup(rows[0]), /매매 35000/);
  assert.match(markup(rows[1]), /전세 2억.*월세 1000\/50/);
  assert.doesNotMatch(markup(rows[2]), /매매|전세|월세/);
});

test("토지 전체 주소는 호수 없이도 이력을 열 수 있고 고객 비고는 고객 ID 다음에 보인다", () => {
  const land = { ...property(0), property_type: "토지", building_name: "인천 서구 검암동 123-45", building_dong: "", unit_number: "" };
  const selected = [];
  const tree = table([{ ...work, property_count: 1, properties_json: JSON.stringify([land]) }], { onListingHistory: (item) => selected.push(item) });
  const link = descendants(tree).find((item) => item.type === "button" && item.props["aria-label"]?.endsWith("매물 이력 보기"));
  assert.ok(link);
  link.props.onClick();
  assert.equal(createPropertyHistoryTarget({ propertyType: selected[0].property_type, buildingName: selected[0].building_name, buildingDong: "", unitNumber: "" }).key, "토지|인천 서구 검암동 123-45||");
  const page = markup(history({ customer: { id: "cust", name: "고객", notes: "첫 줄\n둘째 줄" } }, { page: true, onEditCustomer() {} }));
  assert.ok(page.indexOf("고객 ID") < page.indexOf("비고"));
  assert.match(page, /첫 줄\n둘째 줄/);
  assert.match(page, /고객 정보 수정/);
});

test("리뉴얼 업무일지는 같은 날짜를 묶고 날짜별 원래 업무·모든 매물 순서를 유지한다", () => {
  const records = [work, { ...work, id: "same-day", customer_name: "같은 날 두번째 고객" }, { ...work, id: "older-day", work_date: "2026-09-12", customer_name: "이전 날짜 고객" }];
  const tree = table(records, { groupByDate: true });
  const groups = byClass(tree, "journal-day-group");
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => byClass(group, "journal-day-date")[0].props.dateTime), ["2026-09-13", "2026-09-12"]);
  for (const [index, group] of groups.entries()) {
    const list = React.Children.toArray(group.props.children).find(element => element.type === WorkTable);
    assert.equal(list.props.hideDates, true);
    assert.deepEqual(list.props.items.map(item => item.id), index === 0 ? [work.id, "same-day"] : ["older-day"]);
  }
  const html = markup(tree);
  assert.ok(html.indexOf(work.customer_name) < html.indexOf("같은 날 두번째 고객"));
  assert.ok(html.indexOf("같은 날 두번째 고객") < html.indexOf("이전 날짜 고객"));
  for (const property of properties) assert.equal(html.split(workPropertyLabel(property)).length - 1 >= 3, true);
});
