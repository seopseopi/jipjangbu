import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { formatHistoryTimestamp } from "../app/history-timestamps.ts";
import { getWorkProperties, workPropertyLabel } from "../app/work-property-summary.ts";
import { WorkSummaryProperties } from "./helpers/work-summary-properties.mjs";
import { ListingHistorySummary } from "./helpers/listing-history-summary.mjs";
import { HistoryWorkTypeFilter } from "./helpers/history-work-type-filter.mjs";

// Exercise the real parent modal plus its real summary, with no requests and
// entirely synthetic notes. The main memo retains every event in business-date
// order; individual work controls are available in a separate disclosure.
const source = readFileSync(new URL("../app/work-manager.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("work-manager.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const node = ast.statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === "HistoryModal");
assert.ok(node);
const code = ts.transpileModule(node.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
}).outputText;
const environment = {
  React, Modal: ({ children }) => children, Icon: () => null, EmptyState: "aside",
  targetText: workPropertyLabel, displayDate: (value) => value.replaceAll("-", "."), statusTone: () => "normal",
  getWorkProperties, workPropertyLabel, WorkSummaryProperties, ListingHistorySummary, formatHistoryTimestamp, HistoryWorkTypeFilter,
};
const HistoryModal = new Function(...Object.keys(environment), `${code}; return HistoryModal;`)(...Object.values(environment));
const markup = (element) => renderToStaticMarkup(element);
function descendants(element) {
  if (!React.isValidElement(element)) return [];
  return [element, ...React.Children.toArray(element.props.children).flatMap(descendants)];
}
function initiallyVisibleText(element) {
  if (typeof element === "string" || typeof element === "number") return String(element);
  if (!React.isValidElement(element)) return "";
  if (element.type === ListingHistorySummary) return initiallyVisibleText(ListingHistorySummary(element.props));
  const children = React.Children.toArray(element.props.children);
  if (element.type === "details" && !element.props.open) {
    return initiallyVisibleText(children.find((child) => React.isValidElement(child) && child.type === "summary"));
  }
  return children.map(initiallyVisibleText).join("");
}
const hasClass = (element, name) => element.props.className?.split(/\s+/).includes(name);
const byClass = (tree, name) => descendants(tree).filter((element) => hasClass(element, name));
const listing = {
  identity_key: "아파트|합성단지|106|1503", status: "매물등록", property_type: "아파트", building_name: "합성단지",
  building_dong: "106", unit_number: "1503", sale_price: "35000", jeonse_price: "", monthly_rent: "",
  source_notes: "엑셀에 남아 있는 합성 원본 메모", updated_at: "2026-09-20T12:00:00Z",
};
const event = (id, values = {}) => ({
  id, event_date: "2026-09-01", status: "매물수정", customer_id: "synthetic-customer", customer_name: "합성 고객",
  notes: "합성 임차인 연락처 확인 메모", work_log_id: `work-${id}`, work_updated_at: "2026-09-13T04:05:06Z",
  created_at: "2026-09-01 01:00:00", ...values,
});
const future = event("future", { event_date: "2026-09-17", status: "잔금예정", notes: "미리 등록한 합성 미래 일정", work_updated_at: "2026-09-10T01:00:00Z" });
const edited = event("edited", { notes: "  합성 임차인 연락처 확인 방식 변경\n\n방문 전에 다시 확인하기  " });
function history(overrides = {}, callbacks = {}) {
  return HistoryModal({
    data: { title: "합성 매물 이력", subtitle: "업무일과 저장 시각 구분", listing, items: [future, edited], ...overrides },
    onClose() {}, onRefresh() {}, onOpenWork() {}, onNewWork() {}, onFollowUp() {}, onCopy() {}, ...callbacks,
  });
}
function summary(tree) {
  const element = descendants(tree).find((element) => element.type === ListingHistorySummary);
  assert.ok(element, "the actual summary is wired into the modal");
  return { element, tree: ListingHistorySummary(element.props) };
}
function timeline(tree) {
  const list = byClass(tree, "history-list")[0];
  assert.ok(list);
  return React.Children.toArray(list.props.children).filter(React.isValidElement);
}

test("고객 이력은 전체 데이터에서 정확한 업무구분만 추려 원순서·읽기 동작·건수를 유지한다", () => {
  const works = Array.from({ length: 1003 }, (_, index) => ({ id: `work-${index}`, work_date: "2026-09-16", work_type: index >= 1000 ? "집방문" : "집방문예약", content: `합성 내용 ${index}`, customer_name: "합성 고객", customer_id: "합성ID" }));
  const snapshot = JSON.stringify(works);
  const opened = [];
  const tree = history({ listing: undefined, customer: { id: "합성ID", name: "합성 고객" }, items: works, historyWorkType: "집방문" }, { onOpenWork: (id) => opened.push(id) });
  const rows = timeline(tree);
  assert.equal(rows.length, 3);
  rows.forEach((row) => row.props.onClick());
  assert.deepEqual(opened, ["work-1000", "work-1001", "work-1002"]);
  const filter = descendants(tree).find((item) => item.type === HistoryWorkTypeFilter);
  assert.equal(filter.props.count, 3);
  assert.equal(filter.props.value, "집방문");
  assert.equal(JSON.stringify(works), snapshot);
});

test("매물 이력에는 업무구분 선택을 두지 않고 남아 있는 필터값과 무관하게 전체 원본·개별 업무를 유지한다", () => {
  const works = [
    { id: "call", work_date: "2026-09-16", work_type: "전화", content: "합성 전화 내용", customer_name: "합성 고객" },
    { id: "registration", work_date: "2026-09-15", work_type: "매물등록", content: "다른 구분 내용", customer_name: "합성 고객" },
  ];
  const snapshot = JSON.stringify({ listing, works });
  for (const page of [false, true]) {
    const opened = [], changed = [];
    const tree = history({ workItems: works, historyWorkType: "전화" }, { page, onOpenWork: (id) => opened.push(id), onWorkTypeChange: (value) => changed.push(value) });
    const html = markup(tree);
    assert.equal(descendants(tree).some((item) => item.type === HistoryWorkTypeFilter), false);
    assert.doesNotMatch(html, /<select|history-work-type-filter|선택한 업무구분만/);
    assert.match(html, /합성 전화 내용/);
    assert.match(html, /다른 구분 내용/);
    assert.equal(html.split("합성 전화 내용").length - 1, 1, "each individual work retains one content entry");
    assert.match(html, /엑셀에 남아 있는 합성 원본 메모/);
    assert.match(html, /현재 매물.*매물등록.*매매 35000/);
    assert.equal(Boolean(byClass(tree, "listing-work-details")[0].props.open), page);
    const rows = timeline(tree);
    assert.equal(rows.length, 2);
    rows.forEach((row) => row.props.onClick());
    assert.deepEqual(opened, ["call", "registration"]);
    assert.deepEqual(changed, [], "opening the unfiltered history does not rewrite a previously saved selection");
    assert.equal(summary(tree).element.props.sourceNotes, listing.source_notes);
    assert.deepEqual(summary(tree).element.props.events, [future, edited]);
  }
  assert.equal(JSON.stringify({ listing, works }), snapshot);
});

test("고객 이력은 해당 구분 0건에서도 필터를 유지하고 전체 보기로 복귀할 수 있다", () => {
  const changes = [];
  const tree = history({ listing: undefined, customer: { id: "합성ID", name: "합성 고객" }, items: [], historyWorkType: "집방문" }, { onWorkTypeChange: (value) => changes.push(value) });
  const filter = descendants(tree).find((item) => item.type === HistoryWorkTypeFilter);
  assert.equal(filter.props.count, 0);
  assert.match(markup(tree), /집방문 업무 이력이 없습니다/);
  filter.props.onChange("");
  assert.deepEqual(changes, [""]);
});

test("매물 키만 있는 이력과 업무가 없는 매물도 이전 업무구분을 적용하거나 선택창을 표시하지 않는다", () => {
  const works = [
    { id: "call", work_date: "2026-09-16", work_type: "전화", content: "합성 전화 내용" },
    { id: "visit", work_date: "2026-09-15", work_type: "집방문", content: "합성 방문 내용" },
  ];
  const opened = [];
  const tree = history({ listing: undefined, listingKey: listing.identity_key, workItems: works, historyWorkType: "잔금예정" }, { onOpenWork: (id) => opened.push(id) });
  assert.equal(descendants(tree).some((item) => item.type === HistoryWorkTypeFilter), false);
  const rows = timeline(tree);
  assert.equal(rows.length, 2);
  rows.forEach((row) => row.props.onClick());
  assert.deepEqual(opened, ["call", "visit"]);
  assert.match(markup(tree), /합성 전화 내용/);
  assert.match(markup(tree), /합성 방문 내용/);
  assert.doesNotMatch(markup(tree), /<select|잔금예정 업무 이력이 없습니다/);
  const empty = history({ workItems: [], historyWorkType: "집방문" });
  assert.equal(descendants(empty).some((item) => item.type === HistoryWorkTypeFilter), false);
  assert.doesNotMatch(markup(empty), /집방문 업무 이력이 없습니다|<select/);
  assert.equal(summary(empty).element.props.sourceNotes, listing.source_notes);
});

test("오늘 업무·날짜·예정 일정에는 고객·매물 전용 필터가 끼어들지 않는다", () => {
  for (const extra of [{ date: "2026-09-16" }, { scheduleDays: 7 }, { sort: "updated" }]) {
    const tree = history({ listing: undefined, items: [], ...extra });
    assert.equal(descendants(tree).some((item) => item.type === HistoryWorkTypeFilter), false);
  }
});

test("상단 전체 매물 이력은 미래 일정과 과거 업무 수정 내용을 모두 API 업무일 순서 그대로 한 본문에 표시한다", () => {
  const items = Object.freeze([Object.freeze({ ...future }), Object.freeze({ ...edited })]);
  const before = JSON.stringify(items);
  const tree = history({ items });
  const top = summary(tree).tree;
  const memo = byClass(top, "listing-history-memo")[0];
  const text = markup(top);
  assert.match(text, /전체 매물 이력/);
  assert.match(text, /업무일 최신순 · 2건/);
  assert.equal(memo.props.children, `${future.notes}\n(${future.status}) (${future.event_date})\n\n${edited.notes}\n(${edited.status}) (${edited.event_date})`);
  assert.doesNotMatch(text, /한국\s*시간/);
  assert.match(text, /합성 임차인 연락처 확인 방식 변경/);
  assert.match(text, /미리 등록한 합성 미래 일정/);
  assert.doesNotMatch(text, /최근 저장한 업무 내용|최근 업무 내용|2026\.09\.13 13:05|2026\.09\.20/);
  assert.equal(descendants(top).filter((element) => element.type === "button").length, 0);
  const initialText = initiallyVisibleText(tree);
  assert.equal(initialText.split(future.notes).length - 1, 1, "the future record is initially visible once in the single main memo");
  assert.equal(initialText.split(edited.notes).length - 1, 1, "the edited record is initially visible once; its individual control stays folded");
  assert.equal(JSON.stringify(items), before, "reading all notes does not rewrite, sort, or drop an event");
});

test("개별 업무는 처음 접혀 있지만 모든 행의 업무일·저장시각·정확한 읽기 콜백을 유지한다", () => {
  const opened = [];
  const tree = history({}, { onOpenWork: (id) => opened.push(id) });
  const disclosure = byClass(tree, "listing-work-details")[0];
  assert.equal(disclosure.type, "details");
  assert.equal(Boolean(disclosure.props.open), false);
  const heading = descendants(disclosure).find((element) => element.type === "summary");
  assert.match(markup(heading), /개별 업무 보기.*2건/);
  assert.equal(disclosure.props.onToggle, undefined, "the native disclosure does not trigger network or mutation callbacks");
  const rows = timeline(tree);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => descendants(row).find((element) => element.type === "time" && element.props.dateTime).props.dateTime), ["2026-09-17", "2026-09-01"]);
  assert.match(markup(rows[0]), /업무일 2026\.09\.17/);
  assert.match(markup(rows[0]), /최근 저장.*2026\.09\.10 10:00/);
  assert.match(markup(rows[1]), /업무일 2026\.09\.01/);
  assert.match(markup(rows[1]), /최근 저장.*2026\.09\.13 13:05/);
  assert.doesNotMatch(markup(tree), /한국\s*시간/);
  rows.forEach((row) => row.props.onClick());
  assert.deepEqual(opened, [future.work_log_id, edited.work_log_id]);
  assert.equal(summary(tree).element.props.onOpenWork, undefined, "the all-notes summary is read-only; opening a work belongs to its own row");
});

test("현재 상태·가격과 전체 이력은 구분하고 이미 포함된 엑셀 원본은 별도 영역으로 중복하지 않는다", () => {
  const sourceNotes = [future, edited].map((item) => `${item.notes}\n(${item.status}) (${item.event_date})`).join("\n\n");
  const tree = history({ listing: { ...listing, source_notes: sourceNotes } });
  const current = byClass(tree, "listing-history-context")[0];
  const price = React.Children.toArray(current.props.children).find((element) => element.type === "p");
  assert.match(markup(price), /현재 매물.*매물등록.*매매 35000/);
  const top = summary(tree).tree;
  assert.equal(descendants(top).some((element) => element.type === "details"), false);
  assert.doesNotMatch(markup(top), /엑셀 원본 메모|listing-source-notes/);
  const memo = byClass(top, "listing-history-memo")[0];
  assert.equal(memo.props.children, sourceNotes);
  for (const item of [future, edited]) assert.equal(markup(top).split(item.notes).length - 1, 1);
});

test("같은 업무를 수정해 다시 읽어도 다른 기록은 빠지지 않고 과거 업무일 위치에서 변경 내용만 갱신한다", () => {
  const initial = history({ items: [future, { ...edited, notes: "수정 전 합성 연락 메모", work_updated_at: "2026-09-09T01:00:00Z" }] });
  assert.match(markup(summary(initial).tree), /미리 등록한 합성 미래 일정/);
  assert.match(markup(summary(initial).tree), /수정 전 합성 연락 메모/);
  const updated = history({ items: [future, edited] });
  const top = byClass(summary(updated).tree, "listing-history-memo")[0];
  assert.match(markup(top), /합성 임차인 연락처 확인 방식 변경/);
  assert.match(markup(top), /미리 등록한 합성 미래 일정/);
  assert.doesNotMatch(markup(top), /수정 전 합성 연락 메모/);
  assert.match(markup(top), /2026-09-01/);
  assert.ok(top.props.children.indexOf(future.notes) < top.props.children.indexOf(edited.notes));
  assert.deepEqual(timeline(initial).map((row) => row.key), timeline(updated).map((row) => row.key));
});

test("상단은 정상·조회 중·오류 상태 모두 개별 업무를 여는 버튼 없이 전체 메모를 읽는 영역이다", () => {
  for (const state of [{}, { loading: true }, { error: "합성 일시 조회 실패" }]) {
    const tree = history(state, { onOpenWork: () => assert.fail("reading the memo must not open a work") });
    const top = summary(tree);
    assert.equal(top.element.props.onOpenWork, undefined);
    assert.equal(descendants(top.tree).filter((element) => element.type === "button").length, 0);
    const memo = byClass(top.tree, "listing-history-memo")[0];
    assert.ok(memo.props.children.includes(future.notes));
    assert.ok(memo.props.children.includes(edited.notes));
  }
});

test("고객·날짜별 업무 이력은 listing 전용 상단을 만들지 않고 각 업무의 updated_at을 한국 시각으로 표시한다", () => {
  const tree = history({ listing: undefined, customer: { id: "synthetic-customer", name: "합성 고객" }, items: [{
    id: "saved-work", work_date: "2026-09-01", work_type: "전화", customer_name: "합성 고객", content: "합성 연락 방식 변경", updated_at: "2026-09-13 04:05:06", property_count: 0,
  }] });
  assert.equal(descendants(tree).filter((element) => element.type === ListingHistorySummary).length, 0);
  assert.equal(byClass(tree, "listing-work-details").length, 0, "customer and date histories stay visible rather than inheriting the listing disclosure");
  const row = timeline(tree)[0];
  assert.match(markup(row), /업무일 2026\.09\.01/);
  assert.match(markup(row), /최근 저장.*2026\.09\.13 13:05/);
  assert.doesNotMatch(markup(row), /한국\s*시간/);
  assert.match(markup(row), /합성 연락 방식 변경/);
  const css = readFileSync(new URL("../app/workflow-history-backup.css", import.meta.url), "utf8");
  const savedStyle = css.match(/\.history-list \.history-entry-saved\s*\{([^}]*)\}/)?.[1];
  assert.ok(savedStyle, "save-time styling is more specific than the global .history-list p body rule");
  assert.match(savedStyle, /color:\s*var\(--ink\)/);
  assert.match(savedStyle, /font-size:\s*var\(--text-base\)/);
  assert.match(savedStyle, /font-weight:\s*600/);
  assert.match(savedStyle, /white-space:\s*normal/);
});

test("이벤트가 없는 매물은 엑셀 원문을 바로 읽게 하며 연결 업무 없는 원본 이벤트도 전체 메모에서 생략하지 않는다", () => {
  const sourceNotes = "  합성 임차인 연락처: 000-0000-0000 (검증용)\n\n원본 문장과 공백 보존  ";
  const sourceOnlyModal = history({ items: [], listing: { ...listing, source_notes: sourceNotes } });
  const sourceOnly = summary(sourceOnlyModal).tree;
  const originalMemo = byClass(sourceOnly, "listing-history-memo")[0];
  assert.equal(originalMemo.props.children, sourceNotes);
  assert.equal(descendants(sourceOnly).filter((element) => element.type === "details").length, 0, "source-only history is the primary readable memo, not hidden in a disclosure");
  assert.ok(initiallyVisibleText(sourceOnlyModal).includes(sourceNotes), "the original memo is immediately readable in the complete modal");
  assert.equal(byClass(sourceOnlyModal, "listing-work-details").length, 0, "zero individual work records do not create an empty disclosure");
  assert.equal(byClass(sourceOnlyModal, "history-list").length, 0);
  assert.doesNotMatch(markup(sourceOnlyModal), /개별 업무 보기|0건/);
  assert.equal(byClass(history({ listing: undefined, items: [] }), "history-list").length, 1, "non-listing histories retain their normal empty-state container");
  const legacy = event("original", { work_log_id: "", work_updated_at: undefined, created_at: undefined, notes: "합성 과거 원본 내용" });
  const tree = history({ items: [legacy] });
  const row = timeline(tree)[0];
  assert.equal(byClass(row, "history-entry-saved").length, 0);
  assert.equal(row.props.disabled, true);
  const top = summary(tree).tree;
  assert.match(markup(top), /합성 과거 원본 내용/);
  assert.match(markup(top), /\(매물수정\) \(2026-09-01\)/);
  assert.doesNotMatch(markup(top), /최근 저장 ·|최근 저장한 업무 내용/);
  assert.equal(descendants(top).filter((element) => element.type === "button").length, 0);
});
