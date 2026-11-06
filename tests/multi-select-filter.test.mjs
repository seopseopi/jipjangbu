import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MultiSelectFilter } from "./helpers/multi-select-filter.mjs";
const nodes = element => !React.isValidElement(element) ? [] : [element, ...React.Children.toArray(element.props.children).flatMap(nodes)];
test("복수 선택은 기존 선택을 유지하고 체크 해제·전체 선택 해제를 지원한다", () => {
  let value = []; const render = () => MultiSelectFilter({label: "업무구분 필터", allLabel: "모든 업무구분", options: ["전화", "집방문", "계약"].map(value => ({value, label:value})), value, onChange: next => {value = next;}});
  const check = (index, checked) => nodes(render()).filter(node => node.type === "input")[index].props.onChange({target:{checked}});
  check(0,true); check(1,true); assert.deepEqual(value,["전화","집방문"]);
  let html = renderToStaticMarkup(render()); assert.match(html,/전화 외 1개/); assert.equal((html.match(/checked=""/g)||[]).length,2);
  check(0,false); assert.deepEqual(value,["집방문"]); assert.match(renderToStaticMarkup(render()),/title="집방문"/);
  nodes(render()).find(node => node.type === "button").props.onClick(); assert.deepEqual(value,[]);
  html=renderToStaticMarkup(render()); assert.match(html,/모든 업무구분/); assert.doesNotMatch(html,/checked=""/);
});
test("필터 후 결과에 없는 선택 항목도 유지하며 폼 제출 없이 동작한다", () => {
  const tree=MultiSelectFilter({label:"매물 상태 필터",allLabel:"전체 상태",options:[],value:["매물취소"],onChange(){}});
  assert.equal(nodes(tree).filter(node=>node.type==="input").length,1);
  assert.equal(nodes(tree).find(node=>node.type==="input").props.checked,true);
  assert.equal(nodes(tree).find(node=>node.type==="button").props.type,"button");
});
