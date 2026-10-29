import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { createPropertyHistoryTarget } from "../app/history-query.ts";
import { workPropertyLabel } from "../app/work-property-summary.ts";

const source = readFileSync(new URL("../app/work-detail-view.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("work-detail-view.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = ast.statements.filter(ts.isFunctionDeclaration).map((node) => node.getText(ast)).join("\n").replaceAll("export function", "function");
const compiled = ts.transpileModule(functions, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
}).outputText;
const WorkDetailView = new Function("React", "Icon", "workTypeIcon", "createPropertyHistoryTarget", "workPropertyLabel", `${compiled}; return WorkDetailView;`)(
  React, "span", () => "journal", createPropertyHistoryTarget, workPropertyLabel,
);
const property = (index = 1) => ({
  id: `synthetic-property-${index}`, property_type: "아파트", building_name: `검증단지${index}`,
  building_dong: String(100 + index), unit_number: String(1000 + index), size_type: "33A",
  sale_price: "3억 5천", jeonse_price: "", monthly_rent: "", source: `검증업소${index}`,
});
const item = {
  id: "synthetic-work", work_date: "2026-09-13", work_type: "집방문", customer_id: "synthetic-customer",
  customer_name: "검증 고객", content: "첫 번째 방문 기록\n두 번째 줄도 모두 표시", details: [property()],
};
const render = (overrides = {}, callbacks = {}) => WorkDetailView({ item: { ...item, ...overrides }, onCopy() {}, onEdit() {}, onDelete() {}, onCustomerHistory() {}, onListingHistory() {}, ...callbacks });
const markup = (element) => renderToStaticMarkup(element);
function descendants(element) {
  return [element, ...React.Children.toArray(element.props.children).flatMap((child) => React.isValidElement(child) ? descendants(child) : [])];
}
function buttons(tree, label) {
  return descendants(tree).filter((element) => element.type === "button" && markup(element).includes(label));
}

test("읽기 화면은 입력란 없이 날짜·업무·고객과 원문 전체를 보여 준다", () => {
  const html = markup(render());
  assert.match(html, /2026\.09\.13/);
  assert.match(html, /집방문/);
  assert.match(html, /검증 고객/);
  assert.match(html, /고객 ID · synthetic-customer/);
  assert.match(html, /첫 번째 방문 기록\n두 번째 줄도 모두 표시/);
  assert.doesNotMatch(html, /<(?:input|select|textarea|form|h2)\b/);
  assert.doesNotMatch(html, /업무 저장|접기|더 보기/);
  assert.equal(buttons(render(), "업무 삭제").length, 1);
});

test("업무 복사는 읽기 화면의 명시적 버튼이며 수정·삭제와 다른 동작을 실행한다", () => {
  const calls = [], before = JSON.stringify(item);
  const tree = render({}, { onCopy: () => calls.push("copy"), onEdit: () => calls.push("edit"), onDelete: () => calls.push("delete") });
  const button = buttons(tree, "업무 복사")[0];
  assert.equal(button.props.type, "button");
  assert.equal(button.props.className, "primary-button");
  assert.deepEqual(calls, []);
  button.props.onClick();
  assert.deepEqual(calls, ["copy"]);
  assert.equal(JSON.stringify(item), before);
  const css = readFileSync(new URL("../app/work-detail-view.css", import.meta.url), "utf8");
  assert.match(css, /\.work-read-header\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.work-read-actions\s*\{[^}]*flex-basis:\s*100%/);
});

test("열 개의 물건을 등록 순서대로 기본 펼침 상태로 전부 표시한다", () => {
  const details = Array.from({ length: 10 }, (_, index) => property(index + 1));
  const tree = render({ details });
  const html = markup(tree);
  assert.equal(descendants(tree).filter((element) => element.type === "article").length, 10);
  assert.equal(buttons(tree, "매물 이력").length, 10);
  assert.match(html, /관련 물건 <span class="work-read-count">10개/);
  for (let index = 1; index <= 10; index += 1) {
    assert.match(html, new RegExp(`검증단지${index} ${100 + index}동 ${1000 + index}호`));
    assert.match(html, new RegExp(`검증업소${index}`));
  }
  assert.ok(html.indexOf("검증단지1 101동") < html.indexOf("검증단지2 102동"));
  assert.ok(html.indexOf("검증단지9 109동") < html.indexOf("검증단지10 110동"));
  assert.doesNotMatch(html, /외 \d+|더 보기|<details\b|\shidden=/);
  for (const element of descendants(tree).filter((element) => element.type === "article")) assert.notEqual(element.props["aria-hidden"], true);
});

test("숫자 0 가격을 누락하지 않고 매매·전세·월세와 물건지·업소를 구분한다", () => {
  const detail = { ...property(), sale_price: 0, jeonse_price: "0", monthly_rent: "1000/50", source: "A 업소\n소개자 안내", source_notes: "이력 메모는 합치지 않음", notes: "별도 매물 메모" };
  const html = markup(render({ details: [detail] }));
  assert.match(html, /<dt>매매<\/dt><dd>0<\/dd>/);
  assert.match(html, /<dt>전세<\/dt><dd>0<\/dd>/);
  assert.match(html, /<dt>월세<\/dt><dd>1000\/50<\/dd>/);
  assert.match(html, /물건지·업소/);
  assert.match(html, /A 업소\n소개자 안내/);
  assert.doesNotMatch(html, /이력 메모는 합치지 않음|별도 매물 메모/);
});

test("주소의 기존 접미사를 중복 표시하지 않되 이력 키는 저장된 식별 규칙을 유지한다", () => {
  const detail = { ...property(), building_name: " Mixed검증 ", building_dong: " 106동 ", unit_number: " 1503호 " };
  let openedKey;
  const tree = render({ details: [detail] }, { onListingHistory: (key) => { openedKey = key; } });
  assert.match(markup(tree), /Mixed검증 106동 1503호/);
  assert.doesNotMatch(markup(tree), /동동|호호/);
  buttons(tree, "매물 이력")[0].props.onClick();
  assert.equal(openedKey, "아파트|mixed검증|106동|1503호");
});

test("보기 자체는 수정하지 않으며 명시적 수정·고객·각 물건 이력 버튼만 해당 동작을 실행한다", () => {
  const actions = [];
  const tree = render({ details: [property(1), property(2)] }, {
    onEdit: () => actions.push("edit"), onCustomerHistory: () => actions.push("customer"), onListingHistory: (key) => actions.push(key),
  });
  assert.deepEqual(actions, []);
  for (const element of descendants(tree)) {
    if (element.props.onClick) assert.equal(element.type, "button", "reading text and property cards are not accidental edit targets");
    if (element.type === "button") assert.equal(element.props.type, "button");
  }
  buttons(tree, "매물 이력")[1].props.onClick();
  buttons(tree, "고객 이력")[0].props.onClick();
  assert.deepEqual(actions, ["아파트|검증단지2|102|1002", "customer"]);
  buttons(tree, "업무 수정")[0].props.onClick();
  assert.equal(actions.at(-1), "edit");
});

test("물건과 내용이 없는 업무도 빈 상태를 명확히 보여 주며 대표 물건을 임의로 만들지 않는다", () => {
  const tree = render({ details: [], content: "  ", building_name: "이전 대표 물건" });
  const html = markup(tree);
  assert.match(html, /기록된 내용이 없습니다/);
  assert.match(html, /관련 물건 <span class="work-read-count">0개/);
  assert.match(html, /이 업무에 연결된 물건이 없습니다/);
  assert.doesNotMatch(html, /이전 대표 물건|모든 물건을 펼쳐/);
  assert.equal(buttons(tree, "매물 이력").length, 0);
});

test("이력을 식별할 정보가 없으면 비활성 버튼과 이유를 표시하고 다른 이력으로 연결하지 않는다", () => {
  let opened = false;
  const tree = render({ customer_id: "", customer_name: "", details: [{ source: "물건지·업소만 있는 기록", sale_price: Number.NaN }] }, { onListingHistory: () => { opened = true; } });
  assert.equal(buttons(tree, "고객 이력")[0].props.disabled, true);
  const listingButton = buttons(tree, "매물 이력")[0];
  assert.equal(listingButton.props.disabled, true);
  listingButton.props.onClick();
  assert.equal(opened, false);
  const html = markup(tree);
  assert.match(html, /고객 정보 없음/);
  assert.match(html, /물건구분·건물명·호수가 있어야/);
  assert.match(html, /기록된 가격이 없습니다/);
  assert.doesNotMatch(html, /NaN/);
});

test("동이 없는 건물도 기존 식별 규칙에 맞으면 매물 이력을 열 수 있다", () => {
  let key;
  const tree = render({ details: [{ ...property(), building_dong: "" }] }, { onListingHistory: (value) => { key = value; } });
  assert.equal(buttons(tree, "매물 이력")[0].props.disabled, false);
  buttons(tree, "매물 이력")[0].props.onClick();
  assert.equal(key, "아파트|검증단지1||1001");
});

test("긴 원문과 특수문자를 자르거나 HTML로 해석하지 않는다", () => {
  const content = `첫 줄\n${"긴 내용 ".repeat(1200)}\n<script>합성문자</script>마지막 줄`;
  const html = markup(render({ content }));
  assert.match(html, /첫 줄\n/);
  assert.match(html, /마지막 줄/);
  assert.match(html, /&lt;script&gt;합성문자&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.equal(html.split("긴 내용 ").length - 1, 1200);
  const css = readFileSync(new URL("../app/work-detail-view.css", import.meta.url), "utf8");
  assert.match(css, /white-space: pre-wrap/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /\.work-read-columns, \.work-read-property[^}]*grid-template-columns:/);
  assert.match(css, /@media \(max-width: 780px\)/);
  assert.doesNotMatch(css, /line-clamp|text-overflow:\s*ellipsis|max-height|overflow:\s*hidden/);
});

test("읽기 헤더는 일자·업무·고객·수정을 한 영역에 모으고 반복 안내와 배경 박스를 없앤다", () => {
  const tree = render();
  const header = descendants(tree).find((element) => element.type === "header");
  assert.ok(header);
  const html = markup(header);
  assert.match(html, /2026\.09\.13/);
  assert.match(html, /집방문/);
  assert.match(html, /검증 고객/);
  assert.equal(buttons(header, "업무 수정").length, 1);
  assert.equal(buttons(header, "업무 삭제").length, 1);
  assert.equal(buttons(header, "고객 이력").length, 1);
  assert.doesNotMatch(markup(tree), /내용을 확인한 뒤|모든 물건을 펼쳐|work-read-overview|work-read-toolbar|work-read-property-tags/);
  const css = readFileSync(new URL("../app/work-detail-view.css", import.meta.url), "utf8");
  const headerRule = css.match(/\.work-read-header\s*\{([^}]+)\}/)[1];
  const noteRule = css.match(/\.work-read-note\s*\{([^}]+)\}/)[1];
  assert.doesNotMatch(headerRule, /background|border-radius|box-shadow/);
  assert.doesNotMatch(noteRule, /background|border|padding|box-shadow/);
  assert.match(noteRule, /color:\s*var\(--ink\)/);
});

test("물건 행은 번호·주소와 타입·가격·업소·이력 순서가 고정된 비교 목록이다", () => {
  const tree = render({ details: [property(1), property(2)] });
  const fields = ["work-read-number", "work-read-address", "work-read-prices", "work-read-source", "work-read-property-actions"];
  for (const article of descendants(tree).filter((element) => element.type === "article")) {
    assert.deepEqual(React.Children.toArray(article.props.children).map((child) => child.props.className), fields);
    assert.match(markup(article), /아파트 · 타입 33A/);
    assert.equal(buttons(article, "매물 이력").length, 1);
  }
  const list = descendants(tree).find((element) => element.type === "ol");
  assert.equal(list.type, "ol");
  assert.equal(list.props.className, "work-read-property-list");
  const css = readFileSync(new URL("../app/work-detail-view.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /repeat\(2|work-read-property-grid/);
  const rowRule = css.match(/\n\.work-read-property\s*\{([^}]+)\}/)[1];
  assert.match(rowRule, /border-bottom:/);
  assert.doesNotMatch(rowRule, /background|border-radius|box-shadow|height:\s*100%/);
  assert.match(css, /\.work-read-property\s*\{[^}]*grid-template-columns:\s*22px minmax\(0, 1fr\) 83px/);
  assert.match(css, /\.work-read-prices, \.work-read-price-empty\s*\{[^}]*grid-column:\s*2 \/ -1/);
});

test("정보가 비어도 비교 열을 유지하고 이력 불가 안내는 물건마다 반복하지 않는다", () => {
  const tree = render({ details: [{}, { source: "업소만 있는 원본" }] });
  const articles = descendants(tree).filter((element) => element.type === "article");
  for (const article of articles) {
    const fields = React.Children.toArray(article.props.children).map((child) => child.props.className);
    assert.deepEqual(fields, ["work-read-number", "work-read-address", "work-read-price-empty", "work-read-source", "work-read-property-actions"]);
    assert.equal(buttons(article, "매물 이력")[0].props.disabled, true);
  }
  const html = markup(tree);
  assert.equal(html.split("물건구분·건물명·호수가 있어야 이력을 찾을 수 있습니다.").length - 1, 1);
  assert.match(markup(articles[0]), /미기재/);
  assert.match(markup(articles[1]), /업소만 있는 원본/);
});

test("업무 내용의 고객 정보 수정은 고객 ID 옆에서 별도 동작을 실행한다", () => {
  const actions = [];
  const tree = render({}, { onEditCustomer: () => actions.push("customer-edit"), onEdit: () => actions.push("work-edit") });
  const button = buttons(tree, "고객 정보 수정")[0];
  assert.ok(button);
  button.props.onClick();
  assert.deepEqual(actions, ["customer-edit"]);
});
