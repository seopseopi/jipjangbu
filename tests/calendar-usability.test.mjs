import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { calendarWorkPresentation } from "./helpers/calendar-presentation.mjs";
import { CalendarSubjects } from "./helpers/calendar-subjects.mjs";

// Run the actual calendar markup and handlers with synthetic records only.
const source = readFileSync(new URL("../app/work-manager.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("work-manager.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = ["ListReadFeedback", "CalendarView", "targetText", "statusTone"].map((name) => {
  const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `${name} exists`);
  return declaration.getText(ast);
});
const compiled = ts.transpileModule(declarations.join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
}).outputText;
const CalendarView = new Function("React", "useMemo", "seoulDate", "Icon", "calendarWorkPresentation", "CalendarSubjects", `${compiled}; return CalendarView;`)(
  React, (callback) => callback(), () => "2026-09-12", "span", calendarWorkPresentation, CalendarSubjects,
);

function descendants(element) {
  if (element.type === CalendarSubjects) return descendants(CalendarSubjects(element.props));
  return [element, ...React.Children.toArray(element.props.children).flatMap((child) => React.isValidElement(child) ? descendants(child) : [])];
}

function hasClass(element, name) {
  return element.props.className?.split(/\s+/).includes(name);
}

function renderCalendar(overrides = {}) {
  return CalendarView({
    month: "2026-09", setMonth: () => {}, workType: "", setWorkType: () => {},
    items: [], lookups: { workTypes: ["상담", "계약예정"] }, onOpen: () => {}, onShowDay: () => {},
    ...overrides,
  });
}

function syntheticWork(id, workDate, extra = {}) {
  return {
    id, work_date: workDate, work_type: "상담", customer_id: `customer-${id}`, customer_name: "예시 고객",
    content: "확인할 내용", building_name: "예시 아파트", building_dong: "1", unit_number: "101", property_count: 1, is_demo: 1,
    ...extra,
  };
}

function findByClass(tree, name) {
  return descendants(tree).filter((element) => hasClass(element, name));
}

test("날짜별 목록은 날짜 오름차순이며 다른 달의 늦은 응답이나 잘못된 날짜를 섞지 않는다", () => {
  const items = [
    syntheticWork("last", "2026-09-30"), syntheticWork("first", "2026-09-01"), syntheticWork("today", "2026-09-12"),
    syntheticWork("previous", "2026-08-12"), syntheticWork("next", "2026-10-12"),
    syntheticWork("invalid-day", "2026-09-31"), syntheticWork("zero", "2026-09-00"),
  ];
  const tree = renderCalendar({ items });
  const days = findByClass(tree, "calendar-agenda-day");
  assert.deepEqual(days.map((day) => descendants(day).find((element) => element.type === "time").props.dateTime), ["2026-09-01", "2026-09-12", "2026-09-30"]);
  assert.deepEqual(days.map((day) => hasClass(day, "is-today")), [false, true, false]);
  assert.equal(findByClass(tree, "calendar-agenda-event").length, 3);
  assert.match(renderToStaticMarkup(days[0]), /9월 1일 \(화\)/);
});

test("업무구분을 바꾼 직후 이전 응답의 다른 업무구분은 제외하고 일치한 업무 전부를 양쪽 달력에 표시한다", () => {
  const matching = Array.from({ length: 5 }, (_, index) => syntheticWork(`matching-${index}`, "2026-09-12", { work_type: "계약예정" }));
  const previous = [syntheticWork("old-type", "2026-09-12"), syntheticWork("old-day", "2026-09-13")];
  const items = [...previous, ...matching];
  const opened = [];
  const tree = renderCalendar({ workType: "계약예정", items, onOpen: (id) => opened.push(id) });
  assert.equal(findByClass(tree, "calendar-agenda-day").length, 1);
  assert.equal(findByClass(tree, "calendar-agenda-event").length, matching.length);
  const [desktop] = findByClass(tree, "calendar-desktop-panel");
  const desktopCards = descendants(desktop).filter((element) => element.type === "button" && !hasClass(element, "calendar-more"));
  assert.equal(desktopCards.length, matching.length);
  assert.ok(desktopCards.every((card) => renderToStaticMarkup(card).includes("계약예정")));
  for (const card of desktopCards) card.props.onClick();
  assert.deepEqual(opened, matching.map((item) => item.id));
  assert.equal(findByClass(tree, "calendar-agenda-more").length, 0);
  assert.equal(findByClass(tree, "calendar-more").length, 0);
  const onlyPrevious = renderCalendar({ workType: "계약예정", items: previous });
  assert.equal(findByClass(onlyPrevious, "calendar-agenda-event").length, 0);
  assert.match(renderToStaticMarkup(findByClass(onlyPrevious, "calendar-agenda")[0]), /해당 업무구분의 기록이 없습니다/);
  const unfiltered = renderCalendar({ items });
  assert.equal(findByClass(unfiltered, "calendar-agenda-day").length, 2);
});

test("긴 주소·고객명과 업무 원문을 유지하고 해당 업무를 연다", () => {
  const content = `  첫 줄\n\n<확인> & ${"긴 업무 메모 ".repeat(80)}\n마지막 줄  `;
  const building = `예시 ${"아주긴건물명".repeat(12)}`;
  const customer = `예시 ${"긴고객이름".repeat(12)}`;
  const calls = [];
  const tree = renderCalendar({ items: [syntheticWork("long", "2026-09-12", { content, building_name: building, customer_name: customer })], onOpen: (id) => calls.push(id) });
  const [event] = findByClass(tree, "calendar-agenda-event");
  assert.equal(event.props.type, "button");
  assert.equal(findByClass(event, "calendar-agenda-notes")[0].props.children, content);
  const html = renderToStaticMarkup(event);
  assert.ok(html.includes(building));
  assert.ok(html.includes(customer));
  assert.ok(html.includes(content.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")));
  assert.deepEqual(calls, []);
  event.props.onClick();
  assert.deepEqual(calls, ["long"]);
});

test("매물·계약 달력 카드는 모든 물건을 각각 표시하며 desktop과 모바일에 같은 엑셀 규칙을 적용한다", () => {
  const properties = [
    { id: "first", sequence: 1, building_name: "첫번째단지", building_dong: "101", unit_number: "1001", source: "" },
    { id: "second", sequence: 2, building_name: "두번째단지", building_dong: "202", unit_number: "2002", source: "합성협력업소" },
    { id: "third", sequence: 3, building_name: "세번째단지", building_dong: "303", unit_number: "3003", source: "마전현대" },
  ];
  const item = syntheticWork("multi", "2026-09-12", { work_type: "가계약", property_count: 3, properties_json: JSON.stringify(properties) });
  const opened = [];
  const tree = renderCalendar({ items: [item], onOpen: (id) => opened.push(id) });
  const desktop = findByClass(tree, "calendar-desktop-panel")[0];
  const mobile = findByClass(tree, "calendar-agenda-event")[0];
  for (const element of [desktop, mobile]) {
    const html = renderToStaticMarkup(element);
    assert.match(html, /물건 3개/);
    assert.match(html, /첫번째단지 101동 1001호/);
    assert.doesNotMatch(html, /단독|\(\)/);
    assert.match(html, /두번째단지 202동 2002호 \(합성협력업소\)/);
    assert.match(html, /세번째단지 303동 3003호 \(마전현대\)/);
    assert.doesNotMatch(html, /외 2건|업무 수정/);
  }
  const desktopCard = descendants(desktop).find((element) => element.type === "button");
  assert.match(desktopCard.props["aria-label"], /내용 보기$/);
  assert.match(renderToStaticMarkup(mobile), /내용 보기/);
  desktopCard.props.onClick();
  mobile.props.onClick();
  assert.deepEqual(opened, ["multi", "multi"]);
});

test("전화·방문 달력 카드는 고객이 첫 정보이며 여러 관련 물건을 숨기지 않는다", () => {
  const properties = [{ id: "a", building_name: "첫번째단지", unit_number: "101" }, { id: "b", building_name: "두번째단지", unit_number: "202" }];
  const item = syntheticWork("call", "2026-09-12", { work_type: "전화", customer_id: "합성업소ID", customer_name: "합성부동산", property_count: 2, properties_json: JSON.stringify(properties) });
  const tree = renderCalendar({ items: [item] });
  const [subjects] = findByClass(tree, "calendar-subjects");
  const visible = descendants(subjects);
  const customer = visible.find((element) => hasClass(element, "calendar-subject-customer"));
  assert.equal(customer.props.children, "합성업소ID 합성부동산");
  assert.ok(visible.indexOf(customer) < visible.findIndex((element) => hasClass(element, "calendar-subject-properties")), "customer identity remains the first work context before related properties");
  const [mobile] = findByClass(tree, "calendar-agenda-event");
  assert.deepEqual(descendants(mobile).filter((element) => element.type === "strong").map((element) => element.props.children), ["합성업소ID 합성부동산"]);
  for (const element of [findByClass(tree, "calendar-desktop-panel")[0], mobile]) {
    const html = renderToStaticMarkup(element);
    assert.match(html, /첫번째단지 101호/);
    assert.match(html, /두번째단지 202호/);
  }
});

test("같은 단지의 묶음 물건은 달력 양쪽에서 제목 한 번과 각 호수·단독/업소 표기를 유지한다", () => {
  const properties = ["1503", "1504", "1505"].map((unit, index) => ({ id: `same-${index}`, sequence: index + 1, property_type: "아파트", building_name: "같은합성단지", building_dong: "106", unit_number: unit, source: index === 1 ? "합성협력업소" : "" }));
  const tree = renderCalendar({ items: [syntheticWork("same-building", "2026-09-12", { work_type: "가계약", property_count: 3, properties_json: JSON.stringify(properties) })] });
  const desktop = findByClass(tree, "calendar-desktop-panel")[0], mobile = findByClass(tree, "calendar-agenda-event")[0];
  for (const element of [desktop, mobile]) {
    assert.deepEqual(findByClass(element, "calendar-subject-building").map((heading) => heading.props.children), ["같은합성단지"]);
    assert.deepEqual(findByClass(element, "calendar-subject-label").map((label) => label.props.children), ["106동 1503호", "106동 1504호 (합성협력업소)", "106동 1505호"]);
    const addresses = findByClass(element, "calendar-subject-property");
    assert.equal(addresses.length, 3);
    assert.deepEqual(addresses.map((address) => address.props["aria-label"]), ["물건 1 · 같은합성단지 106동 1503호", "물건 2 · 같은합성단지 106동 1504호 (합성협력업소)", "물건 3 · 같은합성단지 106동 1505호"]);
    assert.ok(addresses.every((address) => address.props["aria-hidden"] !== true));
    assert.doesNotMatch(renderToStaticMarkup(element), /<details\b|\shidden(?:=|\s|>)|외 2건/);
  }
});

test("하루 4건을 넘겨도 모든 업무를 달력에 직접 표시하고 각각 원래 업무를 연다", () => {
  const items = Array.from({ length: 7 }, (_, index) => syntheticWork(`day-${index}`, "2026-09-12"));
  const opened = [], dayDialogs = [];
  const tree = renderCalendar({ items, onOpen: (id) => opened.push(id), onShowDay: (date, records) => dayDialogs.push({ date, records }) });
  const agendaCards = findByClass(tree, "calendar-agenda-event");
  assert.equal(agendaCards.length, items.length);
  assert.equal(findByClass(tree, "calendar-agenda-more").length, 0);
  const [desktop] = findByClass(tree, "calendar-desktop-panel");
  assert.equal(findByClass(desktop, "calendar-week").length, 1);
  assert.equal(findByClass(desktop, "calendar-more").length, 0);
  const desktopCards = descendants(desktop).filter((element) => element.type === "button");
  assert.equal(desktopCards.length, items.length);
  for (const cards of [agendaCards, desktopCards]) {
    const first = opened.length;
    for (const card of cards) card.props.onClick();
    assert.deepEqual(opened.slice(first), items.map((item) => item.id));
  }
  assert.deepEqual(dayDialogs, [], "all rows are directly available without a separate more dialog");
  assert.ok(descendants(tree).filter((element) => element.type === "button").every((button) => button.props.type === "button"));
});

test("월 입력을 지우거나 불완전하게 입력해도 유효한 월을 유지하며 필터는 기존 콜백을 사용한다", () => {
  const monthChanges = [], typeChanges = [];
  const tree = renderCalendar({ setMonth: (month) => monthChanges.push(month), setWorkType: (type) => typeChanges.push(type), workType: "상담" });
  const input = descendants(tree).find((element) => element.type === "input" && element.props.type === "month");
  assert.equal(input.props.value, "2026-09");
  for (const value of ["", "2026", "2026-00", "2026-13", "0000-01", "2026-9", "bad", "10000-01"]) input.props.onChange({ target: { value } });
  assert.deepEqual(monthChanges, []);
  input.props.onChange({ target: { value: "2026-10" } });
  assert.deepEqual(monthChanges, ["2026-10"]);
  const filter = descendants(tree).find((element) => element.type === "select");
  assert.equal(filter.props.value, "상담");
  filter.props.onChange({ target: { value: "계약예정" } });
  assert.deepEqual(typeChanges, ["계약예정"]);
});

test("유효하지 않은 초기 월은 현재 월로 안전하게 표시하고 윤년·낮은 연도도 정확히 계산한다", () => {
  for (const month of ["", "bad", "2026-13", "0000-01"]) {
    const tree = renderCalendar({ month });
    const input = descendants(tree).find((element) => element.type === "input");
    assert.equal(input.props.value, "2026-09");
    assert.equal(findByClass(tree, "calendar-cell").length, 32);
  }
  for (const [month, dayCount] of [["2024-02", 29], ["2025-02", 28], ["0004-02", 29]]) {
    const tree = renderCalendar({ month });
    const actualDays = findByClass(tree, "calendar-cell").filter((cell) => descendants(cell).some((element) => element.type === "b"));
    assert.equal(actualDays.length, dayCount);
  }
});

test("월 이동은 연말·작은 연도와 지원 연도 경계에서 안전하다", () => {
  for (const [month, direction, expected] of [["2026-12", "다음 달", "2027-01"], ["2026-01", "이전 달", "2025-12"], ["0099-12", "다음 달", "0100-01"], ["0100-01", "이전 달", "0099-12"]]) {
    const changes = [];
    const tree = renderCalendar({ month, setMonth: (value) => changes.push(value) });
    const button = descendants(tree).find((element) => element.props["aria-label"] === direction);
    button.props.onClick();
    assert.deepEqual(changes, [expected]);
  }
  for (const [month, direction] of [["0001-01", "이전 달"], ["9999-12", "다음 달"]]) {
    const changes = [];
    const tree = renderCalendar({ month, setMonth: (value) => changes.push(value) });
    const button = descendants(tree).find((element) => element.props["aria-label"] === direction);
    assert.equal(button.props.disabled, true);
    button.props.onClick();
    assert.deepEqual(changes, []);
  }
});

test("빈 날짜별 목록은 현재 업무구분 필터에 맞는 안내를 보여준다", () => {
  assert.match(renderToStaticMarkup(findByClass(renderCalendar(), "calendar-agenda")[0]), /선택한 달에 등록된 업무가 없습니다/);
  assert.match(renderToStaticMarkup(findByClass(renderCalendar({ workType: "상담" }), "calendar-agenda")[0]), /선택한 달에 해당 업무구분의 기록이 없습니다/);
});

test("모바일은 월 그리드 대신 전체 폭 일정 목록을 보여주고 큰 글씨와 긴 내용 줄바꿈을 지원한다", () => {
  const css = readFileSync(new URL("../app/calendar.css", import.meta.url), "utf8");
  const subjectsCss = readFileSync(new URL("../app/calendar-subjects.css", import.meta.url), "utf8");
  assert.match(css, /\.calendar-agenda\s*\{\s*display:\s*none/);
  assert.match(css, /@media\s*\(max-width:\s*1180px\)/);
  assert.match(css, /\.calendar-panel\.calendar-desktop-panel\s*\{\s*display:\s*none/);
  assert.match(css, /\.calendar-agenda\s*\{\s*display:\s*block/);
  assert.match(css, /\.calendar-agenda-notes\s*\{[^}]*font-size:\s*var\(--text-small\)[^}]*white-space:\s*pre-wrap[^}]*overflow-wrap:\s*anywhere/);
  assert.match(subjectsCss, /\.calendar-agenda-event \.calendar-subject-customer[^}]*font-size:\s*var\(--text-base\)/);
  assert.doesNotMatch(css, /min-width:\s*770px|text-overflow:\s*ellipsis/);
  assert.doesNotMatch(subjectsCss, /text-overflow:\s*ellipsis|line-clamp/);
  for (const selector of [".calendar-subject-customer", ".calendar-subject-building", ".calendar-subject-label"]) {
    const rule = subjectsCss.slice(subjectsCss.indexOf(selector)).split("}")[0];
    assert.doesNotMatch(rule, /line-clamp|overflow:\s*hidden/, "주소와 고객명은 전체 표시한다");
    assert.match(rule, /overflow-wrap:\s*anywhere/);
  }
  const renewal = readFileSync(new URL("../app/renewal.css", import.meta.url), "utf8");
  assert.match(renewal, /\.calendar-agenda-notes\s*\{[^}]*display:\s*block[^}]*-webkit-line-clamp:\s*unset[^}]*overflow:\s*visible/, "the renewal keeps long notes fully visible");
  const styles = readFileSync(new URL("../app/application.css", import.meta.url), "utf8");
  const calendarIndex = styles.indexOf('@import "./calendar.css"');
  assert.ok(calendarIndex >= 0 && calendarIndex < styles.indexOf('@import "./renewal.css"'), "server-loaded renewal rules override the original three-line preview");
});

test("데스크톱 달력은 모든 업무 제목을 표시하며 리뉴얼의 기본·큰 글씨 토큰을 사용한다", () => {
  const css = readFileSync(new URL("../app/calendar.css", import.meta.url), "utf8");
  const renewal = readFileSync(new URL("../app/renewal.css", import.meta.url), "utf8");
  assert.match(css, /\.calendar-cell button \.calendar-card-heading > span,\s*\.calendar-cell button\.calendar-more\s*\{[^}]*font-size:\s*var\(--text-base\)/);
  assert.match(renewal, /\.calendar-desktop-panel\s*\{[^}]*--text-base:\s*16px/);
  assert.match(renewal, /html\[data-readable="true"\] \.calendar-desktop-panel\s*\{[^}]*--text-base:\s*18px/);
  const items = Array.from({ length: 5 }, (_, index) => syntheticWork(`synthetic-${index}`, "2026-09-12", { work_type: "매물수정" }));
  const [desktop] = findByClass(renderCalendar({ items }), "calendar-desktop-panel");
  assert.equal(findByClass(desktop, "calendar-card-heading").length, items.length);
  assert.match(renderToStaticMarkup(findByClass(desktop, "calendar-card-heading")[0]), /매물수정/);
  assert.equal(findByClass(desktop, "calendar-more").length, 0);
});
