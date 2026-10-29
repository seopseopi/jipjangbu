import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { WorkSummaryProperties } from "./helpers/work-summary-properties.mjs";
import { getWorkProperties, workPropertyLabel } from "../app/work-property-summary.ts";
import { ListingHistorySummary } from "./helpers/listing-history-summary.mjs";
import { HistoryWorkTypeFilter } from "./helpers/history-work-type-filter.mjs";
import { formatHistoryTimestamp } from "../app/history-timestamps.ts";

const source = readFileSync(new URL("../app/work-manager.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("work-manager.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const settingsAst = ts.createSourceFile("settings-view.tsx", readFileSync(new URL("../app/settings-view.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function compile(name) {
  const selectedAst = name === "BackupPanel" ? settingsAst : ast;
  const node = selectedAst.statements.find((candidate) => ts.isFunctionDeclaration(candidate) && candidate.name?.text === name);
  assert.ok(node, `${name} exists`);
  return ts.transpileModule(node.getText(selectedAst), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
  }).outputText;
}
function descendants(element) {
  return [element, ...React.Children.toArray(element.props.children).flatMap((child) => React.isValidElement(child) ? descendants(child) : [])];
}
function findClass(tree, name) {
  return descendants(tree).find((element) => element.props.className?.split(/\s+/).includes(name));
}
const markup = (tree) => renderToStaticMarkup(tree);
function button(tree, label) {
  const result = descendants(tree).find((element) => element.type === "button" && markup(element).includes(label));
  assert.ok(result, `${label} button exists`);
  return result;
}

// Run the real hook state transitions and event handlers. The fixture is entirely
// synthetic; neither production data nor actual backup files are requested.
function backupHarness(jsonFetch, fetchImpl = async () => assert.fail("unexpected download")) {
  const hooks = [], effects = [], timers = [], savedLinks = [];
  let hookIndex = 0;
  const useState = (initial) => {
    const index = hookIndex++;
    if (!(index in hooks)) hooks[index] = initial;
    return [hooks[index], (value) => { hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }];
  };
  const useRef = (initial) => {
    const index = hookIndex++;
    if (!(index in hooks)) hooks[index] = { current: initial };
    return hooks[index];
  };
  const useEffect = (effect) => {
    const index = hookIndex++;
    if (!(index in hooks)) { hooks[index] = true; effects.push(effect); }
  };
  const document = {
    body: { appendChild: () => {} },
    createElement: () => ({ click() { savedLinks.push({ href: this.href, download: this.download }); }, remove() {} }),
  };
  const window = { setTimeout(callback) { timers.push(callback); return timers.length; }, clearTimeout() {} };
  const urls = { createObjectURL: () => "blob:synthetic-backup", revokeObjectURL: () => {} };
  const Panel = new Function("React", "useState", "useRef", "useEffect", "useCallback", "jsonFetch", "fetch", "Icon", "document", "window", "URL", `${compile("BackupPanel")}; return BackupPanel;`)(
    React, useState, useRef, useEffect, (callback) => callback, jsonFetch, fetchImpl, "span", document, window, urls,
  );
  const render = () => { hookIndex = 0; return Panel(); };
  return {
    render, savedLinks,
    async mount() {
      render();
      for (const effect of effects.splice(0)) effect();
      for (const timer of timers.splice(0)) timer();
      await new Promise((resolve) => setImmediate(resolve));
      return render();
    },
  };
}
const oldBackup = { key: "daily/synthetic-old.json.enc", kind: "daily", createdAt: "2026-09-10T01:02:00Z", size: 2048, reason: "daily" };
const newBackup = { key: "manual/synthetic-new.json.enc", kind: "manual", createdAt: "2026-09-13T03:04:00Z", size: 4096, reason: "manual" };

test("백업 목록 실패는 백업 없음과 구분하며 목록을 다시 불러올 수 있다", async () => {
  let fail = true;
  const harness = backupHarness(async () => { if (fail) throw new Error("예시 연결 오류"); return { backups: [oldBackup] }; });
  const failed = await harness.mount();
  assert.match(markup(failed), /백업 목록을 확인하지 못했습니다/);
  assert.doesNotMatch(markup(failed), /아직 만들어진 백업이 없습니다/);
  assert.equal(findClass(failed, "backup-load-error").props.role, "alert");
  fail = false;
  await button(failed, "다시 불러오기").props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  const recovered = markup(harness.render());
  assert.match(recovered, /가장 최근 백업/);
  assert.doesNotMatch(recovered, /예시 연결 오류|백업 목록을 확인하지 못했습니다/);
});

test("백업은 실제 접속일 실행을 설명하고 최신 날짜 우선으로 표시한다", async () => {
  const harness = backupHarness(async () => ({ backups: [oldBackup, newBackup] }));
  const tree = await harness.mount();
  const html = markup(tree);
  assert.match(html, /이용 시 일일 백업/);
  assert.match(html, /예약 실행은 배포 환경에 따라 적용/);
  assert.match(html, /일일 자동/);
  assert.match(html, /전체 데이터를 담는 복구용 파일/);
  assert.match(html, /고객 정보가 포함/);
  const latest = markup(findClass(tree, "backup-latest"));
  assert.match(latest, /2026\. 09\. 13/);
  const list = markup(findClass(tree, "backup-list"));
  assert.ok(list.indexOf("직접 저장") < list.indexOf("일일 자동"));
});

test("백업 생성 성공 뒤 목록 조회 실패를 성공으로 덮지 않고 중복 생성을 막는다", async () => {
  let created = false, posts = 0, finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const harness = backupHarness(async (_url, options) => {
    if (options?.method === "POST") { posts += 1; await pending; created = true; return { backup: newBackup }; }
    if (created) throw new Error("목록 일시 실패");
    return { backups: [oldBackup] };
  });
  const initial = await harness.mount();
  const create = button(initial, "지금 백업").props.onClick;
  const first = create();
  const second = create();
  assert.equal(posts, 1);
  assert.equal(button(harness.render(), "백업 중").props.disabled, true);
  finish();
  await Promise.all([first, second]);
  const html = markup(harness.render());
  assert.match(html, /새 백업은 만들어졌지만 목록을 확인하지 못했습니다/);
  assert.match(html, /목록 일시 실패/);
  assert.match(html, /마지막으로 확인한 백업/);
  assert.doesNotMatch(html, /아직 만들어진 백업이 없습니다/);
});

test("백업 생성 자체가 실패하면 성공 문구 없이 실패를 보여준다", async () => {
  const harness = backupHarness(async (_url, options) => {
    if (options?.method === "POST") throw new Error("수동 백업 실패");
    return { backups: [] };
  });
  const initial = await harness.mount();
  assert.match(markup(initial), /아직 만들어진 백업이 없습니다/);
  await button(initial, "지금 백업").props.onClick();
  const tree = harness.render();
  assert.equal(findClass(tree, "backup-action-error").props.role, "alert");
  assert.match(markup(tree), /수동 백업 실패/);
  assert.doesNotMatch(markup(tree), /새 백업을 만들었습니다|새 백업은 만들어졌지만/);
});

test("생성 후 실패한 백업 목록을 다시 읽으면 확인 안내로 바꾸되 다른 작업 안내는 덮지 않는다", async () => {
  for (const downloadBeforeRetry of [false, true]) {
    let created = false, canRead = false;
    const h = backupHarness(async (_url, options) => {
      if (options?.method === "POST") { created = true; return { backup: newBackup }; }
      if (created && !canRead) throw new Error("합성 목록 일시 실패");
      return { backups: created ? [newBackup, oldBackup] : [oldBackup] };
    }, async () => new Response("{\"synthetic\":true}", { headers: { "Content-Type": "application/json" } }));
    let tree = await h.mount();
    await button(tree, "지금 백업").props.onClick();
    tree = h.render();
    assert.match(markup(tree), /새 백업은 만들어졌지만 목록을 확인하지 못했습니다/);
    if (downloadBeforeRetry) {
      button(tree, "내려받기").props.onClick();
      await new Promise((resolve) => setImmediate(resolve));
      tree = h.render();
      assert.match(markup(tree), /다운로드 목록에서 저장 여부를 확인/);
    }
    canRead = true;
    button(tree, "다시 불러오기").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
    const html = markup(h.render());
    assert.doesNotMatch(html, /목록을 확인하지 못했습니다|다시 불러오기|합성 목록 일시 실패/);
    assert.match(html, downloadBeforeRetry ? /다운로드 목록에서 저장 여부를 확인/ : /새 백업 목록을 확인했습니다/);
    assert.equal(html.includes("새 백업 목록을 확인했습니다"), !downloadBeforeRetry);
  }
});

test("백업 다운로드 오류는 페이지를 이동하거나 오류 응답을 파일로 저장하지 않는다", async () => {
  let fail = true;
  const harness = backupHarness(async () => ({ backups: [newBackup] }), async () => fail
    ? new Response(JSON.stringify({ error: "예시 파일 다운로드 실패" }), { status: 500, headers: { "Content-Type": "application/json" } })
    : new Response("{\"synthetic\":true}", { headers: { "Content-Type": "application/json" } }));
  let tree = await harness.mount();
  await button(tree, "내려받기").props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.savedLinks.length, 0);
  tree = harness.render();
  assert.match(markup(tree), /예시 파일 다운로드 실패/);
  fail = false;
  await button(tree, "내려받기").props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.savedLinks, [{ href: "blob:synthetic-backup", download: "jipjangbu-backup-2026-09-13-manual.json" }]);
  assert.match(markup(harness.render()), /다운로드 목록에서 저장 여부를 확인/);
});

test("로그인 HTML 응답을 성공한 백업 파일로 저장하지 않는다", async () => {
  const harness = backupHarness(async () => ({ backups: [newBackup] }), async () => new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } }));
  const tree = await harness.mount();
  await button(tree, "내려받기").props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.savedLinks.length, 0);
  assert.match(markup(harness.render()), /로그인 상태를 확인/);
});

const HistoryModal = new Function("React", "Modal", "Icon", "EmptyState", "targetText", "displayDate", "statusTone", "getWorkProperties", "workPropertyLabel", "WorkSummaryProperties", "ListingHistorySummary", "formatHistoryTimestamp", "HistoryWorkTypeFilter", `${compile("HistoryModal")}; return HistoryModal;`)(
  React, ({ children }) => children, "span", "aside", (item) => `${item.building_name} ${item.building_dong}동 ${item.unit_number}호`, (value) => value, () => "normal", getWorkProperties, workPropertyLabel, WorkSummaryProperties, ListingHistorySummary, formatHistoryTimestamp, HistoryWorkTypeFilter,
);
function history(data, extra = {}) {
  return HistoryModal({ data, onClose() {}, onRefresh() {}, onOpenWork() {}, onNewWork() {}, onFollowUp() {}, onCopy() {}, ...extra });
}
const listing = { identity_key: "아파트|예시단지|106|1503", building_name: "예시단지", building_dong: "106", unit_number: "1503", status: "상담" };
test("날짜별 이력은 고객·모든 물건·함께 연결된 물건 수로 각 업무를 구별한다", () => {
  const calls = [];
  const properties = ["1503", "1504", "1505"].map((unit, index) => ({ ...listing, id: `property-${index}`, unit_number: unit }));
  const tree = history({ title: "하루 업무", subtitle: "2건", items: [
    { id: "one", work_date: "2026-09-13", work_type: "상담", customer_name: "가상 고객 A", content: "동일 메모", ...listing, property_count: 3, properties_json: JSON.stringify(properties) },
    { id: "two", work_date: "2026-09-13", work_type: "상담", customer_name: "가상 고객 B", content: "동일 메모", property_count: 0 },
  ] }, { onOpenWork: (id) => calls.push(id) });
  const list = findClass(tree, "history-list");
  const rows = React.Children.toArray(list.props.children);
  assert.match(markup(rows[0]), /가상 고객 A/);
  assert.match(markup(rows[0]), /예시단지 106동 1503호/);
  assert.match(markup(rows[0]), /함께 기록한 물건 3개/);
  assert.match(markup(rows[0]), /예시단지 106동 1504호/);
  assert.match(markup(rows[0]), /예시단지 106동 1505호/);
  assert.doesNotMatch(markup(rows[0]), /외 2건/);
  assert.match(markup(rows[1]), /가상 고객 B/);
  assert.doesNotMatch(markup(rows[1]), /undefined|물건 ·/);
  for (const row of rows) row.props.onClick();
  assert.deepEqual(calls, ["one", "two"]);
});

test("매물 이력에서 같은 매물로 새 업무와 확인할 일을 시작한다", () => {
  const work = [], tasks = [];
  const tree = history({ title: "이력", subtitle: "아파트", listing, items: [] }, {
    onNewListingWork: (item) => work.push(item), onFollowUp: (draft) => tasks.push(draft),
  });
  button(tree, "이 매물로 업무 등록").props.onClick();
  button(tree, "이 매물 확인할 일 추가").props.onClick();
  assert.deepEqual(work, [listing]);
  assert.deepEqual(tasks, [{ title: "예시단지 106동 1503호 매물 확인", listingKey: listing.identity_key, listingLabel: "예시단지 106동 1503호" }]);
  const pending = history({ title: "이력", subtitle: "", listing, items: [], loading: true }, { onNewListingWork() {} });
  assert.equal(button(pending, "이 매물로 업무 등록").props.disabled, true);
});

test("고객 이력은 사용하지 않는 후속 연락 버튼 없이 새 업무와 연락처 복사를 유지한다", () => {
  const customer = { id: "synthetic-customer", name: "예시 고객" }, calls = [], copies = [];
  const tree = history({ title: "고객 이력", subtitle: "", customer, items: [] }, {
    onNewWork: (id) => calls.push(id), onCopy: (id) => copies.push(id),
    onFollowUp: () => assert.fail("unused customer follow-up control must not be reachable"),
  });
  button(tree, "이 고객 업무 등록").props.onClick();
  button(tree, "연락처·ID 복사").props.onClick();
  assert.deepEqual(calls, [customer.id]);
  assert.deepEqual(copies, [customer.id]);
  assert.doesNotMatch(markup(tree), /다시 연락할 일 추가/);
});

test("7일·30일 전체 일정 조회 실패는 빈 기록 대신 오류와 다시 불러오기를 표시한다", () => {
  for (const days of [7, 30]) {
    let retries = 0;
    const tree = history({
      title: `앞으로 ${days}일 전체 일정`, subtitle: "예정·예약 업무", items: [],
      scheduleDays: days, from: "2026-09-29", to: days === 7 ? "2026-10-05" : "2026-10-28",
      loading: false, error: "합성 일정 조회 실패",
    }, { onRefresh: () => retries++ });
    const html = markup(tree);
    assert.match(html, /role="alert"/);
    assert.match(html, /합성 일정 조회 실패/);
    assert.doesNotMatch(html, /기록이 없습니다/);
    const retry = button(tree, "다시 불러오기");
    assert.equal(retry.props.type, "button");
    retry.props.onClick();
    assert.equal(retries, 1, `${days}일 일정도 부모의 기존 기간 재조회 경로를 사용한다`);
  }
});

test("이력 식별행과 백업 안내는 큰 글씨 및 긴 문구의 줄바꿈을 지원한다", () => {
  const css = readFileSync(new URL("../app/workflow-history-backup.css", import.meta.url), "utf8");
  assert.match(css, /\.history-entry-context[^}]*font-size:\s*var\(--text-small\)/);
  assert.match(css, /\.history-entry-context > span > span[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.backup-load-error[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.backup-download-help[^}]*font-size:\s*var\(--text-small\)/);
});

test("업무 현황은 제한된 일정 미리보기를 총건수처럼 표시하지 않고 30일 전체보기로 연결한다", () => {
  const insightsSource = readFileSync(new URL("../app/insights-view.tsx", import.meta.url), "utf8");
  const insightsAst = ts.createSourceFile("insights-view.tsx", insightsSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = insightsAst.statements.filter(ts.isFunctionDeclaration).map((node) => node.getText(insightsAst)).join("\n");
  const compiled = ts.transpileModule(declarations, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
  }).outputText.replace(/^export /gm, "");
  const data = {
    summary: { monthWorkCount: 1, monthCustomerCount: 1, activeListingCount: 1, staleListingCount: 0 },
    monthly: [], workTypes: [], staleListings: [],
    upcoming: Array.from({ length: 12 }, (_, index) => ({ id: `synthetic-${index}`, work_date: "2026-09-14", customer_name: "예시 고객", content: "예시 일정", work_type: "계약예정" })),
  };
  let index = 0;
  const states = [data, false, "", 0];
  const View = new Function("React", "useState", "useEffect", "useMemo", "Icon", "WorkSummaryProperties", `${compiled}; return InsightsView;`)(
    React, () => [states[index++], () => {}], () => {}, (callback) => callback(), "span", WorkSummaryProperties,
  );
  const scheduleCalls = [], workCalls = [];
  const tree = View({ onOpenSchedule: () => scheduleCalls.push("30-days"), onOpenWork: (id) => workCalls.push(id), onOpenListing() {} });
  const html = markup(tree);
  assert.match(html, /최대 12건 미리보기/);
  assert.match(html, /현재 12건 표시/);
  assert.match(html, /예정·예약 업무/);
  button(tree, "30일 일정 전체 보기").props.onClick();
  assert.deepEqual(scheduleCalls, ["30-days"]);
  findClass(tree, "insights-upcoming-item").props.onClick();
  assert.deepEqual(workCalls, ["synthetic-0"]);
});
