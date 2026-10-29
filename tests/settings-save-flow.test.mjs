import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

// Exercise the actual SettingsView hooks, handlers and rendered messages.
// Network calls below are synthetic: no actual classification data is changed.
const source = readFileSync(new URL("../app/settings-view.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("settings-view.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const node = ast.statements.find((candidate) => ts.isFunctionDeclaration(candidate) && candidate.name?.text === "SettingsView");
assert.ok(node);
const javascript = ts.transpileModule(node.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
}).outputText;
const lookups = { workTypes: ["전화", "매물등록"], propertyTypes: ["아파트"], buildings: [{ id: "synthetic-building", property_type: "아파트", building_name: "검증단지" }] };
function descendants(element) {
  return [element, ...React.Children.toArray(element.props.children).flatMap((child) => React.isValidElement(child) ? descendants(child) : [])];
}
const html = (tree) => renderToStaticMarkup(tree);
const form = (tree) => descendants(tree).find((element) => element.type === "form");
const input = (tree) => descendants(form(tree)).find((element) => element.type === "input");
function button(tree, text) {
  const found = descendants(tree).find((element) => element.type === "button" && html(element).includes(text));
  assert.ok(found, text);
  return found;
}
function harness(jsonFetch, onSaved) {
  const hooks = [];
  let cursor = 0;
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
    return [hooks[index], (value) => { hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }];
  };
  const useRef = (initial) => {
    const index = cursor++;
    if (!(index in hooks)) hooks[index] = { current: initial };
    return hooks[index];
  };
  const Settings = new Function("React", "useState", "useRef", "jsonFetch", "Icon", "BackupPanel", `${javascript}; return SettingsView;`)(
    React, useState, useRef, jsonFetch, () => React.createElement("span"), () => null,
  );
  const render = () => { cursor = 0; return Settings({ lookups, onSaved, onLogout: () => assert.fail("unexpected logout") }); };
  return {
    render,
    type(value) { input(render()).props.onChange({ target: { value } }); return render(); },
    submit() { return form(render()).props.onSubmit({ preventDefault() {} }); },
  };
}

test("classification POST failure retains its entered name and does not pretend the item was saved", async () => {
  let refreshed = 0;
  const testView = harness(async () => { throw new Error("합성 저장 연결 실패"); }, async () => { refreshed++; });
  testView.type("검증 새 분류");
  await testView.submit();
  const tree = testView.render();
  assert.equal(input(tree).props.value, "검증 새 분류");
  assert.equal(input(tree).props.disabled, false);
  assert.match(html(tree), /합성 저장 연결 실패/);
  assert.doesNotMatch(html(tree), /분류를 추가했습니다|목록만 다시/);
  assert.equal(descendants(tree).find((element) => element.props.role === "alert").props.className, "form-error");
  assert.equal(refreshed, 0);
});

test("successful classification POST clears the draft and reports success even when refreshing fails", async () => {
  let posts = 0;
  const testView = harness(async (url, init) => { posts++; assert.equal(url, "/api/lookups"); assert.equal(init.method, "POST"); return { ok: true }; }, async () => { throw new Error("합성 목록 실패"); });
  testView.type("검증 성공 분류");
  await testView.submit();
  const tree = testView.render();
  assert.equal(input(tree).props.value, "");
  assert.match(html(tree), /검증 성공 분류.*분류를 추가했습니다/);
  assert.match(html(tree), /분류는 추가되었지만 목록을 다시 불러오지 못했습니다/);
  assert.match(html(tree), /다시 추가할 필요는 없습니다/);
  assert.equal(button(tree, "목록 다시 불러오기").props.type, "button");
  assert.equal(posts, 1);
});

test("retrying classification refresh never repeats POST and retains a newly entered draft", async () => {
  let posts = 0, refreshes = 0;
  const testView = harness(async () => { posts++; return { ok: true }; }, async () => { if (++refreshes === 1) throw new Error("합성 목록 실패"); });
  testView.type("첫 검증 분류");
  await testView.submit();
  const tree = testView.type("이어서 작성 중인 분류");
  await button(tree, "목록 다시 불러오기").props.onClick();
  const recovered = testView.render();
  assert.equal(posts, 1);
  assert.equal(refreshes, 2);
  assert.equal(input(recovered).props.value, "이어서 작성 중인 분류");
  assert.doesNotMatch(html(recovered), /목록을 다시 불러오지 못했습니다|다시 추가할 필요/);
  assert.match(html(recovered), /첫 검증 분류.*분류를 추가했습니다/);
});

test("same-frame double submissions cannot duplicate a classification while a request is pending", async () => {
  let finish, posts = 0;
  const pending = new Promise((resolve) => { finish = resolve; });
  const testView = harness(async () => { posts++; await pending; return { ok: true }; }, async () => {});
  const tree = testView.type("검증 중복 방지");
  const submit = form(tree).props.onSubmit;
  const first = submit({ preventDefault() {} });
  await submit({ preventDefault() {} });
  assert.equal(posts, 1);
  assert.equal(input(testView.render()).props.disabled, true);
  finish();
  await first;
  assert.equal(input(testView.render()).props.disabled, false);
  assert.equal(input(testView.render()).props.value, "");
});

test("refresh retry failures remain retryable without changing saved success or claiming another addition", async () => {
  let posts = 0, finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  let refreshes = 0;
  const testView = harness(async () => { posts++; return { ok: true }; }, async () => { if (++refreshes > 1) await pending; throw new Error("합성 목록 실패"); });
  testView.type("검증 재조회 분류");
  await testView.submit();
  const task = button(testView.render(), "목록 다시 불러오기").props.onClick();
  assert.match(html(testView.render()), /목록 불러오는 중…/);
  assert.doesNotMatch(html(testView.render()), /추가 중…/);
  finish();
  await task;
  assert.equal(posts, 1);
  assert.match(html(testView.render()), /분류를 추가했습니다/);
  assert.equal(button(testView.render(), "목록 다시 불러오기").props.disabled, false);
});
