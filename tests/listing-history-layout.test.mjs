import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { getWorkProperties, workPropertyLabel } from "../app/work-property-summary.ts";
import { WorkSummaryProperties } from "./helpers/work-summary-properties.mjs";
import { ListingHistorySummary } from "./helpers/listing-history-summary.mjs";
import { HistoryWorkTypeFilter } from "./helpers/history-work-type-filter.mjs";
import { formatHistoryTimestamp } from "../app/history-timestamps.ts";

// Exercise the actual modal markup without a browser or real customer records.
const source = readFileSync(new URL("../app/work-manager.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("work-manager.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "HistoryModal");
assert.ok(declaration, "HistoryModal exists");
const compiled = ts.transpileModule(declaration.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
}).outputText;
const HistoryModal = new Function("React", "Modal", "Icon", "EmptyState", "targetText", "displayDate", "statusTone", "getWorkProperties", "workPropertyLabel", "WorkSummaryProperties", "ListingHistorySummary", "formatHistoryTimestamp", "HistoryWorkTypeFilter", `${compiled}; return HistoryModal;`)(
  React, ({ children }) => children, "span", "aside", () => "예시 매물",
  (date) => `표시 날짜 ${date}`, (status) => `tone-${status}`, getWorkProperties, workPropertyLabel, WorkSummaryProperties, ListingHistorySummary, formatHistoryTimestamp, HistoryWorkTypeFilter,
);

function elements(children) {
  return React.Children.toArray(children).flatMap((child) => {
    if (!React.isValidElement(child)) return [];
    return child.type === React.Fragment ? elements(child.props.children) : [child];
  });
}

function descendants(element) {
  return [element, ...elements(element.props.children).flatMap(descendants)];
}

function hasClass(element, name) {
  return element.props.className?.split(/\s+/).includes(name);
}

function renderHistory(listing, onFollowUp, { items = [], customer, onOpenWork = () => {} } = {}) {
  return HistoryModal({
    data: { title: "예시 매물 이력", subtitle: "테스트", items, listing, customer },
    onClose: () => {}, onRefresh: () => {}, onOpenWork,
    onNewWork: () => {}, onCopy: () => {}, onFollowUp,
  });
}

test("전체 일정의 날짜·업무구분은 같은 글자 크기와 굵기를 사용하고 업무 읽기·원순서를 유지한다", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.history-list strong,\s*\.history-list \.history-entry-meta > time\s*\{\s*font-size:\s*var\(--text-base\);\s*font-weight:\s*600;/);
  assert.match(css, /html\[data-readable="true"\]\s*\{\s*--text-base:\s*18px;/);
  const items = [
    { id: "synthetic-next", work_date: "2026-09-16", work_type: "집방문예약", content: "합성 방문 일정", customer_name: "합성 고객" },
    { id: "synthetic-later", work_date: "2026-09-18", work_type: "잔금예정", content: "합성 확인 일정", customer_name: "합성 고객" },
  ];
  for (const scheduleDays of [7, 30]) {
    const opened = [];
    const tree = HistoryModal({
      data: { title: `앞으로 ${scheduleDays}일 전체 일정`, scheduleDays, items },
      onClose() {}, onRefresh() {}, onOpenWork: (id) => opened.push(id), onNewWork() {}, onCopy() {}, onFollowUp() {},
    });
    const list = descendants(tree).find((element) => hasClass(element, "history-list"));
    assert.equal(list.props["data-schedule-days"], scheduleDays);
    const rows = elements(list.props.children);
    for (const [index, row] of rows.entries()) {
      const meta = descendants(row).find((element) => hasClass(element, "history-entry-meta"));
      const date = elements(meta.props.children).find((element) => element.type === "time");
      const status = elements(meta.props.children).find((element) => element.type === "strong");
      assert.equal(date.props.dateTime, items[index].work_date);
      assert.equal(status.props.children, items[index].work_type);
      row.props.onClick();
    }
    assert.deepEqual(opened, items.map((item) => item.id));
  }
});

test("고객 이력 날짜도 일정 여부와 무관하게 업무구분과 같은 크기·굵기로 표시한다", () => {
  const tree = renderHistory(undefined, () => {}, { customer: { id: "synthetic-customer", name: "합성 고객" } });
  const list = descendants(tree).find((element) => hasClass(element, "history-list"));
  assert.equal(list.props["data-schedule-days"], undefined);
  assert.doesNotMatch(renderToStaticMarkup(list), /data-schedule-days/);
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.history-list strong,\s*\.history-list \.history-entry-meta > time[^}]*font-weight:\s*600/);
  assert.match(css, /\.history-record-meta strong,\s*\.history-record-meta > time[^}]*font-weight:\s*600/);
});

test("전체 이력에 없는 이전 메모만 가격 아래 접힌 영역에 보존하고 할 일 버튼은 카드 밖에 연결된다", () => {
  const notes = `  첫 상담 메모\n\n<확인> & 추가 내용\n${"긴메모".repeat(120)}\n마지막 줄  `;
  for (const sourceNotes of [notes, ""]) {
    const listing = {
      identity_key: "아파트|예시||101", status: "상담", sale_price: "확인 필요",
      jeonse_price: "", monthly_rent: "", source_notes: sourceNotes,
    };
    const calls = [];
    const tree = renderHistory(listing, (draft) => calls.push(draft), { items: [{ id: "synthetic-event", event_date: "2026-09-13", status: "매물확인", notes: "별도 업무에 저장한 합성 이력", work_log_id: "synthetic-work" }] });
    const siblings = elements(tree.props.children);
    const contextIndex = siblings.findIndex((element) => hasClass(element, "listing-history-context"));
    assert.ok(contextIndex >= 0, "listing summary card exists");
    const context = siblings[contextIndex];
    assert.equal(hasClass(context, "editor-context"), false, "listing history must not inherit the editor's horizontal flex layout");
    const rows = elements(context.props.children);
    assert.equal(hasClass(rows[0], "listing-history-summary"), true);
    assert.match(renderToStaticMarkup(rows[0]), /상담/);
    assert.match(renderToStaticMarkup(rows[0]), /매매 확인 필요/);
    assert.match(renderToStaticMarkup(rows[0]), /현재 매물/);
    assert.equal(descendants(context).some((element) => element.type === "button"), false);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].type, ListingHistorySummary);
    assert.equal(rows[1].props.sourceNotes, sourceNotes, "the original notes reach the summary without trimming");
    const summary = ListingHistorySummary(rows[1].props);
    const sourceDetails = summary ? descendants(summary).find((element) => element.type === "details") : undefined;
    if (sourceNotes) {
      assert.ok(sourceDetails, "notes absent from the work events remain available in a native disclosure");
      assert.equal(Boolean(sourceDetails.props.open), false, "the long retained notes start collapsed rather than covering the complete work history");
      assert.match(renderToStaticMarkup(sourceDetails), /이전 보관 메모/);
      assert.doesNotMatch(renderToStaticMarkup(sourceDetails), /엑셀 원본 메모|별도 업무에 저장한 합성 이력/);
      const note = descendants(sourceDetails).find((element) => element.type === "p" && element.props.children === notes);
      assert.ok(note, "notes are not trimmed, shortened or split into narrow columns");
      const rendered = renderToStaticMarkup(sourceDetails);
      assert.ok(rendered.includes(notes.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")), "line breaks and long text survive rendering as escaped text");
    } else {
      assert.equal(sourceDetails, undefined, "empty original notes do not leave an empty disclosure");
    }
    const actions = siblings[contextIndex + 1];
    assert.ok(actions && hasClass(actions, "listing-history-actions"), "actions occupy a separate row after the summary card");
    const buttons = descendants(actions).filter((element) => element.type === "button");
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].props.type, "button");
    assert.ok(React.Children.toArray(buttons[0].props.children).some((child) => typeof child === "string" && child.includes("이 매물 확인할 일 추가")));
    assert.deepEqual(calls, [], "rendering history does not create a follow-up");
    buttons[0].props.onClick();
    assert.deepEqual(calls, [{ title: "예시 매물 매물 확인", listingKey: listing.identity_key, listingLabel: "예시 매물" }]);
    const workDetailsIndex = siblings.findIndex((element) => hasClass(element, "listing-work-details"));
    assert.ok(workDetailsIndex > contextIndex + 1);
    assert.equal(Boolean(siblings[workDetailsIndex].props.open), false);
    assert.ok(descendants(siblings[workDetailsIndex]).some((element) => hasClass(element, "history-list")));
  }
  assert.equal(descendants(renderHistory(undefined, assert.fail)).some((element) => hasClass(element, "listing-history-actions")), false);
});

test("고객·매물의 각 이력은 날짜·상태 아래 전체 폭 본문을 보존하고 연결된 업무만 열 수 있다", () => {
  const content = `  첫 확인 내용\n\n<입력 원문> & 추가 메모\n${"상세기록".repeat(120)}\n마지막 줄  `;
  const examples = [
    {
      customer: { id: "customer-synthetic", name: "예시 고객" },
      items: [
        { id: "work-synthetic", work_date: "2026-09-12", work_type: "전화상담", content },
        { id: "work-empty", work_date: "2026-09-11", work_type: "방문", content: "" },
      ],
    },
    {
      listing: { identity_key: "아파트|예시||101", status: "상담", source_notes: "" },
      items: [
        { id: "event-synthetic", event_date: "2026-09-12", status: "매물확인", notes: content, work_log_id: "linked-work", customer_name: "연결 고객" },
        { id: "event-without-work", event_date: "2026-09-11", status: "이전기록", notes: "", work_log_id: null, customer_name: "예시 이름" },
      ],
    },
  ];
  for (const example of examples) {
    const opened = [];
    const tree = renderHistory(example.listing, assert.fail, { ...example, onOpenWork: (id) => opened.push(id) });
    assert.equal(tree.props.reading, true, "both history types use the reading-width modal");
    const list = descendants(tree).find((element) => hasClass(element, "history-list"));
    const disclosure = descendants(tree).find((element) => hasClass(element, "listing-work-details"));
    assert.equal(Boolean(disclosure), Boolean(example.listing), "only listing history folds the individual work controls");
    if (disclosure) assert.equal(Boolean(disclosure.props.open), false);
    const rows = elements(list.props.children);
    assert.equal(rows.length, example.items.length);
    for (const [index, row] of rows.entries()) {
      const raw = example.items[index];
      const isEvent = "event_date" in raw;
      const date = isEvent ? raw.event_date : raw.work_date;
      const status = isEvent ? raw.status : raw.work_type;
      const id = isEvent ? raw.work_log_id : raw.id;
      const expectedContent = (isEvent ? raw.notes : raw.content) || "기록된 내용 없음";
      assert.equal(row.type, "button");
      const [meta, body, unexpected] = elements(row.props.children);
      assert.equal(unexpected, undefined);
      assert.equal(hasClass(meta, "history-entry-meta"), true);
      assert.equal(hasClass(body, "history-entry-content"), true);
      assert.equal(body.type, "p");
      assert.equal(body.props.children, expectedContent, "the complete body is a sibling below metadata, not a narrow metadata column");
      const metadata = elements(meta.props.children);
      const time = metadata.find((element) => element.type === "time");
      assert.equal(time.props.dateTime, date);
      assert.equal(React.Children.toArray(time.props.children).join(""), `업무일 표시 날짜 ${date}`);
      assert.equal(metadata.find((element) => element.type === "strong").props.children, status);
      const customerName = metadata.find((element) => element.type === "small");
      assert.equal(customerName ? React.Children.toArray(customerName.props.children).join("") : undefined, isEvent ? raw.customer_name : undefined);
      assert.equal(row.props.disabled, !id);
      row.props.onClick();
    }
    assert.deepEqual(opened, example.items.map((raw) => "event_date" in raw ? raw.work_log_id : raw.id).filter(Boolean));
    assert.ok(renderToStaticMarkup(tree).includes(content.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")), "rendered customer and listing histories retain escaped text, spaces and line breaks");
  }
});

test("고객 이력의 같은 단지 묶음은 제목 한 번과 모든 호수를 표시하며 전체 메모를 별도 행에 보존한다", () => {
  const properties = ["1503", "1504", "1505"].map((unit, index) => ({ id: `synthetic-${index}`, sequence: index + 1, property_type: "아파트", building_name: "합성공통단지", building_dong: "106", unit_number: unit }));
  const content = "합성 업무 원문\n둘째 줄의 확인 내용";
  const tree = renderHistory(undefined, assert.fail, { items: [{ id: "synthetic-work", work_date: "2026-09-13", work_type: "집방문", customer_name: "합성 고객", content, property_count: 3, properties_json: JSON.stringify(properties) }] });
  const body = descendants(tree).find((element) => hasClass(element, "history-entry-content"));
  const context = descendants(tree).find((element) => hasClass(element, "history-entry-context"));
  assert.equal(body.props.children, content);
  assert.equal(body.type, "p");
  assert.ok(context);
  const html = renderToStaticMarkup(context);
  assert.equal((html.match(/class="work-summary-building"/g) || []).length, 1);
  assert.equal((html.match(/role="listitem"/g) || []).length, 3);
  for (const property of properties) {
    assert.ok(html.includes(`물건 ${property.sequence} · ${workPropertyLabel(property)}`));
    assert.ok(html.includes(`>106동 ${property.unit_number}호<`));
  }
  assert.doesNotMatch(html, /<details\b|\shidden(?:=|\s|>)|외 \d+건/);
  assert.doesNotMatch(html, /role="listitem"[^>]*aria-hidden="true"/);
});

test("이력의 고객 아이콘 행만 flex로 정렬하고 물건 요약의 세로 grid를 덮어쓰지 않는다", () => {
  const historyCss = readFileSync(new URL("../app/workflow-history-backup.css", import.meta.url), "utf8");
  const summaryCss = readFileSync(new URL("../app/work-summary-properties.css", import.meta.url), "utf8");
  assert.match(historyCss, /\.history-entry-context > span:not\(\.work-summary-properties\)\s*\{[^}]*display:\s*flex/);
  assert.doesNotMatch(historyCss, /\.history-entry-context > span\s*\{[^}]*display:\s*flex/);
  assert.match(summaryCss, /\.work-summary-properties\s*\{[^}]*display:\s*grid/);
  assert.match(summaryCss, /\.work-summary-property-list\s*\{[^}]*display:\s*grid/);
  const properties = ["101", "102"].map((unit, index) => ({ id: `synthetic-${index}`, property_type: "아파트", building_name: "합성단지", unit_number: unit }));
  const tree = renderHistory(undefined, assert.fail, { items: [{ id: "synthetic", work_date: "2026-09-13", work_type: "방문", customer_name: "합성 고객", content: "기록", property_count: 2, properties_json: JSON.stringify(properties) }] });
  const context = descendants(tree).find((element) => hasClass(element, "history-entry-context"));
  assert.match(renderToStaticMarkup(context), /class="work-summary-properties"/);
  assert.match(renderToStaticMarkup(context), /고객 · 합성 고객/);
});

test("매물 이력은 한 열 전체 폭을 쓰고 긴 메모와 버튼은 좁은 화면에서도 줄바꿈할 수 있다", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  function declarations(selector) {
    const rules = {};
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!match[1].split(",").some((value) => value.trim() === selector)) continue;
      for (const declaration of match[2].split(";")) {
        const colon = declaration.indexOf(":");
        if (colon >= 0) rules[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
      }
    }
    return rules;
  }
  const context = declarations(".listing-history-context");
  const notes = declarations(".listing-history-notes");
  const actions = declarations(".listing-history-actions");
  const button = declarations(".listing-history-actions > button");
  assert.equal(context.display, "grid");
  assert.match(context["grid-template-columns"], /^minmax\(0,\s*1fr\)$/);
  assert.equal(notes["white-space"], "pre-wrap");
  assert.equal(notes["overflow-wrap"], "anywhere");
  assert.ok(context["min-width"] === "0" || notes["min-width"] === "0");
  assert.equal(actions.display, "flex");
  assert.equal(actions["justify-content"], "flex-end");
  assert.equal(actions["flex-wrap"], "wrap");
  assert.equal(button["max-width"], "100%");
  assert.equal(button["white-space"], "normal");
  const entry = declarations(".history-list > button");
  const metadata = declarations(".history-entry-meta");
  const content = declarations(".history-list p");
  assert.equal(entry.display, "grid");
  assert.match(entry["grid-template-columns"], /^minmax\(0,\s*1fr\)$/);
  assert.equal(metadata["flex-wrap"], "wrap");
  assert.equal(content["white-space"], "pre-wrap");
  assert.equal(content["overflow-wrap"], "anywhere");
});

test("고객·매물 이력은 페이지로 열 때 기본 정보·작업 버튼과 전체 업무 이력을 나눠 보여준다", () => {
  const items = [
    { id: "synthetic-old", work_date: "2026-09-02", work_type: "전화", content: "합성 첫 상담", customer_name: "합성 고객", customer_id: "synthetic-customer" },
    { id: "synthetic-new", work_date: "2026-09-12", work_type: "집방문예약", content: "합성 방문", customer_name: "합성 고객", customer_id: "synthetic-customer" },
  ];
  const opened = [], added = [];
  const page = HistoryModal({
    page: true,
    data: { title: "합성 고객 업무 이력", subtitle: "synthetic-customer", items, customer: { id: "synthetic-customer", name: "합성 고객" } },
    onClose() {}, onRefresh() {}, onOpenWork: (id) => opened.push(id), onNewWork: (id) => added.push(id), onCopy() {}, onFollowUp() {}, onWorkTypeChange() {},
  });
  assert.equal(page.type, "div", "a page is not wrapped in the dialog");
  assert.ok(hasClass(page, "record-page"));
  const summary = descendants(page).find((element) => hasClass(element, "record-page-summary"));
  const facts = renderToStaticMarkup(summary);
  assert.match(facts, /synthetic-customer/);
  assert.match(facts, /2건/);
  assert.match(facts, /표시 날짜 2026-09-12/, "the latest work date is shown, not the first in the list");
  descendants(summary).find((element) => element.type === "button" && renderToStaticMarkup(element).includes("이 고객 업무 등록")).props.onClick();
  assert.deepEqual(added, ["synthetic-customer"]);
  const history = descendants(page).find((element) => hasClass(element, "record-page-history"));
  for (const row of elements(descendants(history).find((element) => hasClass(element, "history-list")).props.children)) row.props.onClick();
  assert.deepEqual(opened, ["synthetic-old", "synthetic-new"]);
  const dialog = HistoryModal({
    data: { title: "합성 고객 업무 이력", subtitle: "synthetic-customer", items, customer: { id: "synthetic-customer", name: "합성 고객" } },
    onClose() {}, onRefresh() {}, onOpenWork() {}, onNewWork() {}, onCopy() {}, onFollowUp() {}, onWorkTypeChange() {},
  });
  assert.equal(dialog.props.reading, true, "without page the same history still opens as the reading dialog");
});
