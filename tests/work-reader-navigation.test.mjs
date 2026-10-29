import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Exercise production callbacks with controlled promises. All records are
// synthetic and no API, browser, or persistence binding is contacted.
const source = readFileSync(new URL("../app/work-manager.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("work-manager.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findAll(predicate) {
  const found = [];
  function visit(node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(ast);
  return found;
}
function declaration(name) {
  const node = findAll((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)[0];
  assert.ok(node, `Production handler ${name} exists`);
  return node.getText(ast);
}
function evaluate(code, environment) {
  const output = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText;
  return new Function(...Object.keys(environment), `${output}; return result;`)(...Object.values(environment));
}
function callbacks(component, prop, environment) {
  const nodes = findAll((node) => (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(ast) === component);
  const expressions = nodes.flatMap((node) => node.attributes.properties.filter((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === prop).map((attribute) => attribute.initializer?.expression));
  assert.ok(expressions.length, `${component}.${prop} exists`);
  return expressions.map((expression) => evaluate(`const result = ${expression.getText(ast)};`, environment));
}
function state(current = null) {
  const result = { current };
  result.set = (value) => { result.current = typeof value === "function" ? value(result.current) : value; };
  return result;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const noop = () => {};

test("마지막 업무를 삭제한 매물 이력은 주소 오류 대신 빈 상태와 휴지통 복구 안내를 보여준다", async () => {
  const history = state({ title: "합성 매물 이력", items: [{ id: "removed" }], listing: { identity_key: "synthetic" } });
  const show = evaluate(`${declaration("showListingByKey")}\nconst result = showListingByKey;`, {
    historyOpenVersion: { current: 0 }, setGlobalSearchOpen: noop, setHistoryModal: history.set,
    jsonFetch: async () => { throw new Error("매물을 찾을 수 없습니다."); }, targetText: () => "합성 매물",
  });
  await show("synthetic", true);
  assert.equal(history.current.error, undefined);
  assert.equal(history.current.listing, undefined);
  assert.deepEqual(history.current.items, []);
  assert.match(history.current.emptyMessage, /휴지통에서 복구/);
  await show("never-existed", false);
  assert.match(history.current.error, /물건구분·건물명·동·호수/);
});
function harness(fetch, extra = {}) {
  const reader = state(), editor = state(), opening = state(), reference = state({ kind: "customer", id: "previous" }), search = state(true);
  const workReadVersion = { current: 0 }, workOpenVersion = { current: 0 };
  const environment = {
    workReadVersion, workOpenVersion,
    setWorkReader: reader.set, setWorkModal: editor.set,
    setWorkOpening: opening.set,
    setReaderReference: reference.set, setGlobalSearchOpen: search.set,
    jsonFetch: fetch, loadReferenceData: async () => {},
    isAborted: (error) => error?.name === "AbortError", showLoadError: assert.fail,
    ...extra,
  };
  const handlers = evaluate(`${["openWork", "closeWorkOpening", "readWork", "closeWorkReader"].map(declaration).join("\n")}\nconst result = { openWork, closeWorkOpening, readWork, closeWorkReader };`, environment);
  return { reader, editor, opening, reference, search, workReadVersion, workOpenVersion, ...handlers };
}

test("새 업무·수정 버튼은 명부 조회가 늦어도 즉시 취소 가능한 대기창을 띄운다", async () => {
  for (const id of [undefined, "synthetic edit/1"]) {
    const reference = deferred(), detail = deferred(), urls = [];
    const h = harness((url) => { urls.push(url); return detail.promise; }, { loadReferenceData: () => reference.promise });
    const task = h.openWork(id, "synthetic-customer", "매물수정", { identity_key: "synthetic-listing" });
    assert.deepEqual(h.opening.current, { id, initialCustomerId: "synthetic-customer", initialWorkType: "매물수정", initialListing: { identity_key: "synthetic-listing" } });
    assert.equal(h.editor.current, null, "incomplete customer data must not enable a form");
    if (id) assert.deepEqual(urls, ["/api/work-logs/synthetic%20edit%2F1"]);
    reference.resolve();
    detail.resolve({ workLog: { id, details: [] } });
    await task;
    assert.equal(h.opening.current, null);
    assert.equal(h.editor.current.mode, id ? "edit" : "new");
  }
});

test("대기창 취소 후 늦은 성공·실패가 창을 다시 띄우거나 기존 초안을 바꾸지 않는다", async () => {
  for (const reject of [false, true]) {
    const pending = deferred(), h = harness(async () => ({ workLog: { id: "requested" } }), { loadReferenceData: () => pending.promise });
    const draft = { mode: "new", initialCustomerId: "preserved" };
    h.editor.set(draft);
    const task = h.openWork("requested");
    h.closeWorkOpening();
    assert.equal(h.opening.current, null);
    if (reject) pending.reject(new Error("late synthetic failure")); else pending.resolve();
    await task;
    assert.equal(h.opening.current, null);
    assert.equal(h.editor.current, draft);
  }
});

test("입력창 준비 실패는 재시도할 고객·매물 조건과 오류를 대기창에 보존한다", async () => {
  let attempts = 0;
  const h = harness(async () => ({ workLog: { id: "retry", details: [] } }), {
    loadReferenceData: async () => { if (++attempts === 1) throw new Error("합성 연결 오류"); },
  });
  await h.openWork("retry", "customer", "매물수정", { identity_key: "listing" });
  assert.match(h.opening.current.error, /합성 연결 오류/);
  assert.equal(h.opening.current.initialCustomerId, "customer");
  assert.equal(h.editor.current, null);
  const request = h.opening.current;
  await h.openWork(request.id, request.initialCustomerId, request.initialWorkType, request.initialListing);
  assert.equal(h.opening.current, null);
  assert.equal(h.editor.current.item.id, "retry");
});

test("계속 중단되는 입력창 조회는 한 번만 재시도하고 무한 대기 없이 오류를 보여준다", async () => {
  let attempts = 0;
  const h = harness(async () => ({ workLog: { id: "aborted" } }), {
    loadReferenceData: async () => { attempts += 1; throw new DOMException("Cancelled", "AbortError"); },
  });
  await h.openWork("aborted");
  assert.equal(attempts, 2);
  assert.match(h.opening.current.error, /중단.*다시/);
  assert.equal(h.editor.current, null);
});

test("기존 업무는 수정창 대신 읽기 대기를 즉시 열고 해당 업무의 모든 물건을 읽는다", async () => {
  const pending = deferred(), requests = [];
  const h = harness((url) => { requests.push(url); return pending.promise; });
  const task = h.readWork("synthetic work/1");
  assert.deepEqual(h.reader.current, { id: "synthetic work/1", loading: true });
  assert.equal(h.editor.current, null);
  assert.equal(h.reference.current, null);
  assert.equal(h.search.current, false);
  assert.deepEqual(requests, ["/api/work-logs/synthetic%20work%2F1"]);
  const item = { id: "synthetic work/1", content: "합성 업무 원문", details: [{ unit_number: "101" }, { unit_number: "202" }, { unit_number: "303" }] };
  pending.resolve({ workLog: item });
  await task;
  assert.deepEqual(h.reader.current, { id: item.id, item, loading: false });
  assert.equal(h.editor.current, null);
});

test("업무 A를 읽다가 B를 열면 A의 늦은 성공·오류가 B 화면을 덮어쓰지 않는다", async () => {
  for (const lateError of [false, true]) {
    const a = deferred(), b = deferred();
    const h = harness((url) => url.endsWith("/a") ? a.promise : b.promise);
    const first = h.readWork("a"), second = h.readWork("b");
    const item = { id: "b", content: "합성 B", details: [] };
    b.resolve({ workLog: item });
    await second;
    if (lateError) a.reject(new Error("합성 A 조회 실패")); else a.resolve({ workLog: { id: "a" } });
    await first;
    assert.deepEqual(h.reader.current, { id: "b", item, loading: false });
  }
});

test("읽기 실패는 대상과 재시도 오류를 유지하며 성공한 재조회는 오류를 해제한다", async () => {
  let requests = 0;
  const item = { id: "retry", content: "합성 재조회 성공", details: [] };
  const h = harness(async () => { if (++requests === 1) throw new Error("합성 연결 오류"); return { workLog: item }; });
  await h.readWork("retry");
  assert.deepEqual(h.reader.current, { id: "retry", loading: false, error: "합성 연결 오류" });
  assert.equal(h.editor.current, null);
  await h.readWork(h.reader.current.id);
  assert.deepEqual(h.reader.current, { id: "retry", item, loading: false });
});

test("내부 취소도 무한 읽기 대기 대신 명시적인 재시도 안내가 된다", async () => {
  const h = harness(async () => { throw new DOMException("Synthetic cancelled read", "AbortError"); });
  await h.readWork("cancelled");
  assert.equal(h.reader.current.loading, false);
  assert.equal(h.reader.current.id, "cancelled");
  assert.match(h.reader.current.error, /중단.*다시/);
  assert.equal(h.reader.current.item, undefined);
});

test("읽기창을 닫은 뒤 늦은 성공이나 오류가 창을 다시 열지 않는다", async () => {
  for (const lateError of [false, true]) {
    const pending = deferred(), h = harness(() => pending.promise);
    const task = h.readWork("closed");
    h.reference.set({ kind: "listing", key: "synthetic" });
    const readVersion = h.workReadVersion.current, editVersion = h.workOpenVersion.current;
    h.closeWorkReader();
    assert.equal(h.reader.current, null);
    assert.equal(h.reference.current, null);
    assert.ok(h.workReadVersion.current > readVersion);
    assert.ok(h.workOpenVersion.current > editVersion);
    if (lateError) pending.reject(new Error("합성 늦은 오류")); else pending.resolve({ workLog: { id: "closed" } });
    await task;
    assert.equal(h.reader.current, null);
  }
});

test("다른 업무 읽기를 시작하면 앞서 대기하던 수정창 열기가 새 읽기 화면을 가리지 않는다", async () => {
  const oldEdit = deferred(), nextRead = deferred();
  const h = harness((url) => url.endsWith("/edit-a") ? oldEdit.promise : nextRead.promise);
  const editing = h.openWork("edit-a");
  const reading = h.readWork("read-b");
  nextRead.resolve({ workLog: { id: "read-b", details: [] } });
  await reading;
  oldEdit.resolve({ workLog: { id: "edit-a", details: [] } });
  await editing;
  assert.equal(h.reader.current.id, "read-b");
  assert.equal(h.editor.current, null);
});

test("새 업무 등록은 기존 업무 읽기 API를 요청하지 않고 빈 수정 폼으로 시작한다", async () => {
  const h = harness(() => assert.fail("new work must not fetch an existing record"));
  await h.readWork();
  assert.equal(h.reader.current, null);
  assert.equal(h.editor.current.mode, "new");
  assert.equal(h.editor.current.item, undefined);
});

test("읽기 화면의 업무 복사는 읽은 원본을 새 등록 모드에 넘기며 명부 준비 전 저장·원본 재조회를 하지 않는다", async () => {
  const pending = deferred(), original = { id: "original", content: "읽던 합성 원문", details: [{ unit_number: "101" }] };
  const h = harness(() => assert.fail("copy should not read or write the original again"), { loadReferenceData: () => pending.promise });
  h.reader.set({ id: original.id, item: original, loading: false });
  let task;
  callbacks("WorkDetailView", "onCopy", { workReader: h.reader.current, openWork: (...args) => { task = h.openWork(...args); } })[0]();
  assert.equal(h.opening.current.copySource, original);
  assert.equal(h.editor.current, null);
  pending.resolve();
  await task;
  assert.equal(h.editor.current.mode, "copy");
  assert.equal(h.editor.current.item, original);
  callbacks("WorkModal", "onClose", { workOpenVersion: h.workOpenVersion, setWorkModal: h.editor.set })[0]();
  assert.equal(h.editor.current, null);
  assert.equal(h.reader.current.item, original);
});

test("업무 복사 준비 실패·재시도는 같은 원본을 유지하고 취소 뒤 늦은 응답은 무시한다", async () => {
  const original = { id: "original", details: [] };
  let fail = true;
  const h = harness(() => assert.fail("no duplicate source read"), { loadReferenceData: async () => { if (fail) throw new Error("명부 조회 실패"); } });
  await h.openWork(undefined, undefined, undefined, undefined, original);
  assert.equal(h.opening.current.copySource, original);
  assert.match(h.opening.current.error, /명부 조회 실패/);
  fail = false;
  const request = h.opening.current;
  await h.openWork(request.id, request.initialCustomerId, request.initialWorkType, request.initialListing, request.copySource);
  assert.equal(h.editor.current.mode, "copy");
  assert.equal(h.editor.current.item, original);
  const pending = deferred(), cancelled = harness(() => assert.fail(), { loadReferenceData: () => pending.promise });
  const task = cancelled.openWork(undefined, undefined, undefined, undefined, original);
  cancelled.closeWorkOpening();
  pending.resolve();
  await task;
  assert.equal(cancelled.editor.current, null);
});

test("복사 저장 성공은 새 업무를 즉시 보여주고 원래 이력·필터는 갱신하며 원본을 다시 읽지 않는다", async () => {
  const original = { id: "original", item: { id: "original" } }, created = { id: "new", content: "신규 저장 결과", details: [] };
  const previous = { title: "합성 고객 이력", historyWorkType: "전화", items: [] };
  const reader = state(original), editor = state({ mode: "copy" }), reference = state({ kind: "customer" }), calls = [];
  const onSaved = callbacks("WorkModal", "onSaved", {
    workOpenVersion: { current: 0 }, workReadVersion: { current: 0 }, setWorkModal: editor.set,
    workReader: original, historyModal: previous, setWorkReader: reader.set, setReaderReference: reference.set,
    afterMutation: async (message) => calls.push(["list", message]), refreshHistory: async (history) => calls.push(["history", history]),
    readWork: () => assert.fail("the returned new work already contains its saved content"),
  })[0];
  await onSaved("새 업무 저장 완료", created);
  assert.equal(editor.current, null);
  assert.deepEqual(reader.current, { id: "new", item: created, loading: false });
  assert.equal(reference.current, null);
  assert.deepEqual(calls, [["list", "새 업무 저장 완료"], ["history", previous]]);
  assert.equal(previous.historyWorkType, "전화");
});

test("홈·업무일지·달력·현황·통합검색·이력의 기존 업무 진입은 읽기 콜백으로 연결된다", async () => {
  const calls = [];
  for (const [component, prop] of [["DashboardView", "onOpen"], ["JournalView", "onOpen"], ["CalendarView", "onOpen"], ["InsightsView", "onOpenWork"], ["GlobalSearch", "onOpenWork"], ["HistoryModal", "onOpenWork"]]) {
    const handlers = callbacks(component, prop, { readWork: (id) => calls.push([component, id]), openWork: () => assert.fail(`${component} must not edit existing work directly`) });
    for (const handler of handlers) await handler("synthetic-existing");
    assert.ok(calls.some(([name, id]) => name === component && id === "synthetic-existing"));
  }
});

test("고객·매물에서 새 업무를 만들거나 매물을 수정할 때는 새 이력용 폼을 연다", () => {
  const calls = [];
  const environment = { openWork: (...args) => calls.push(args), readWork: () => assert.fail("new work must not open a historical reader") };
  callbacks("HistoryModal", "onNewWork", environment)[0]("synthetic-customer");
  const listing = { identity_key: "synthetic-listing", building_name: "합성단지" };
  callbacks("HistoryModal", "onNewListingWork", environment)[0](listing);
  callbacks("HistoryModal", "onModifyListing", environment)[0](listing, "synthetic-customer");
  assert.deepEqual(calls, [[undefined, "synthetic-customer"], [undefined, undefined, undefined, listing], [undefined, "synthetic-customer", "매물수정", listing]]);
});

test("읽기에서 명시적으로 수정한 뒤 취소하면 읽던 업무·원래 이력을 그대로 유지한다", async () => {
  const item = { id: "synthetic-work", content: "저장된 합성 내용", details: [{ unit_number: "101" }] };
  const reader = state({ id: item.id, item, loading: false }), editor = state({ mode: "edit", item }), version = { current: 0 };
  const edits = [];
  await callbacks("WorkDetailView", "onEdit", { workReader: reader.current, openWork: (id) => edits.push(id) })[0]();
  assert.deepEqual(edits, [item.id]);
  callbacks("WorkModal", "onClose", { workOpenVersion: version, setWorkModal: editor.set })[0]();
  assert.equal(editor.current, null);
  assert.equal(reader.current.item, item);
  assert.match(source, /historyModal\s*&&\s*!workReader/);
  assert.match(source, /workReader\s*&&\s*!workModal/);
});

test("수정 저장은 폼을 닫고 읽던 업무와 원래 이력을 새로 조회한다", async () => {
  const reader = { id: "synthetic-work", item: { id: "synthetic-work" }, loading: false };
  const previous = { title: "합성 고객 이력", items: [{ id: "synthetic-work" }] };
  const editor = state({ mode: "edit" }), calls = [], version = { current: 0 };
  await callbacks("WorkModal", "onSaved", {
    workOpenVersion: version, setWorkModal: editor.set, workReader: reader, historyModal: previous,
    afterMutation: async (message) => calls.push(["list", message]),
    refreshHistory: async (history) => calls.push(["history", history]),
    readWork: async (id) => calls.push(["reader", id]),
    closeWorkReader: () => assert.fail("saved work should retain its reader"),
  })[0]("업무를 수정했습니다.");
  assert.equal(editor.current, null);
  assert.equal(version.current, 1);
  assert.deepEqual(calls, [["list", "업무를 수정했습니다."], ["history", previous], ["reader", reader.id]]);
});

test("업무 삭제 후에는 없는 업무를 다시 읽지 않고 원래 목록·이력만 갱신한다", async () => {
  const editor = state({ mode: "edit" }), calls = [];
  const target = state({ type: "work", id: "deleted" });
  const deleted = evaluate(`${declaration("afterDeletion")}\nconst result = afterDeletion;`, {
    deletionTarget: target.current, setDeletionTarget: target.set,
    workOpenVersion: { current: 0 }, setWorkModal: editor.set, workReader: { id: "deleted" }, historyModal: { title: "합성 이력" },
    afterMutation: async () => calls.push("list"), refreshHistory: async () => calls.push("history"),
    readWork: async () => assert.fail("deleted work must not be reloaded"), closeWorkReader: () => calls.push("close-reader"),
  });
  await deleted();
  assert.equal(target.current, null);
  assert.equal(editor.current, null);
  assert.deepEqual(calls, ["close-reader", "list", "history"]);
});

test("승인된 메뉴 이동은 읽기 대기를 무효화하고 새 화면에 이전 업무를 다시 띄우지 않는다", async () => {
  const pending = deferred(), h = harness(() => pending.promise);
  const task = h.readWork("old-view-work");
  const changed = [];
  const navigate = evaluate(`${declaration("navigate")}\nconst result = navigate;`, {
    view: "journal", followUpBusy: { current: false }, workBusy: { current: false }, customerBusy: { current: false }, followUpDirty: { current: false },
    workOpenVersion: h.workOpenVersion, workReadVersion: h.workReadVersion,
    closeWorkReader: h.closeWorkReader, setWorkReader: h.reader.set, setReaderReference: h.reference.set,
    setWorkOpening: h.opening.set, historyModal: null, historyOpenVersion: { current: 0 }, setHistoryModal: noop, isRecordHistory: () => false,
    currentView: { current: "journal" }, setView: (next) => changed.push(next),
    window: { scrollTo: noop, confirm: () => true, location: { pathname: "/", search: "" }, history: { pushState: noop } },
    refreshBase: async () => {}, showLoadError: assert.fail,
  });
  assert.equal(navigate("calendar"), true);
  assert.deepEqual(changed, ["calendar"]);
  pending.resolve({ workLog: { id: "old-view-work" } });
  await task;
  assert.equal(h.reader.current, null);
});

test("이동을 취소하거나 저장 중이면 읽던 업무와 대기 요청을 그대로 보존한다", () => {
  for (const saving of [false, true]) {
    const h = harness(async () => ({ workLog: { id: "current" } }));
    h.reader.set({ id: "current", loading: false, item: { id: "current" } });
    const original = h.reader.current;
    const navigate = evaluate(`${declaration("navigate")}\nconst result = navigate;`, {
      view: "journal", followUpBusy: { current: false }, workBusy: { current: saving }, customerBusy: { current: false }, followUpDirty: { current: !saving },
      workOpenVersion: h.workOpenVersion, workReadVersion: h.workReadVersion,
      closeWorkReader: h.closeWorkReader, setWorkReader: h.reader.set, setReaderReference: h.reference.set,
      setWorkOpening: h.opening.set, historyModal: null, historyOpenVersion: { current: 0 }, setHistoryModal: noop, isRecordHistory: () => false,
      currentView: { current: "journal" }, setView: () => assert.fail("cancelled navigation must not change the view"), setNotice: noop,
      window: { scrollTo: noop, confirm: () => false, location: { pathname: "/", search: "" }, history: { pushState: () => assert.fail("cancelled navigation must not add browser history") } },
      refreshBase: async () => {}, showLoadError: assert.fail,
    });
    assert.equal(navigate("calendar"), false);
    assert.equal(h.reader.current, original);
    assert.equal(h.workReadVersion.current, 0);
  }
});

test("브라우저 뒤로가기도 읽기 대기를 닫고 늦은 응답이 이전 화면으로 덮지 못하게 한다", async () => {
  const pending = deferred(), h = harness(() => pending.promise);
  const task = h.readWork("previous-work");
  const node = findAll((node) => ts.isVariableDeclaration(node) && node.name.getText(ast) === "syncView")[0];
  assert.ok(node?.initializer, "production popstate callback exists");
  const currentView = { current: "journal" }, views = [];
  const sync = evaluate(`const result = ${node.initializer.getText(ast)};`, {
    navItems: [["today"], ["journal"], ["calendar"]], currentView,
    followUpBusy: { current: false }, workBusy: { current: false }, customerBusy: { current: false }, followUpDirty: { current: false },
    workOpenVersion: h.workOpenVersion, workReadVersion: h.workReadVersion,
    setWorkReader: h.reader.set, setReaderReference: h.reference.set,
    setWorkOpening: h.opening.set, historyModal: null, historyOpenVersion: { current: 0 }, setHistoryModal: noop, isRecordHistory: () => false,
    setView: (view) => views.push(view), setNotice: noop,
    window: { location: { hash: "#calendar", pathname: "/" }, history: { pushState: noop }, confirm: () => true },
  });
  sync();
  assert.equal(currentView.current, "calendar");
  assert.deepEqual(views, ["calendar"]);
  pending.resolve({ workLog: { id: "previous-work" } });
  await task;
  assert.equal(h.reader.current, null);
  assert.equal(h.reference.current, null);
});

test("메뉴를 누르거나 뒤로가기를 하면 고객·매물 페이지를 닫고 목록으로 돌아간다", () => {
  const recordState = () => { const box = { current: { title: "합성 고객 업무 이력", customer: { id: "synthetic", name: "합성" }, items: [] } }; box.set = (next) => { box.current = typeof next === "function" ? next(box.current) : next; }; return box; };
  const isRecordHistory = (data) => Boolean(data.customer || data.listing || data.listingKey);
  const base = {
    followUpBusy: { current: false }, workBusy: { current: false }, customerBusy: { current: false }, followUpDirty: { current: false },
    workOpenVersion: { current: 0 }, workReadVersion: { current: 0 }, setWorkReader: noop, setReaderReference: noop, setWorkOpening: noop,
    refreshBase: async () => {}, showLoadError: assert.fail, setNotice: noop, isRecordHistory,
  };
  // Same menu as the page came from: the page closes and the view stays.
  const same = recordState(), sameViews = [];
  const navigate = (record) => evaluate(`${declaration("navigate")}\nconst result = navigate;`, {
    ...base, view: "customers", currentView: { current: "customers" }, historyModal: record.current, historyOpenVersion: { current: 0 }, setHistoryModal: record.set,
    setView: (next) => sameViews.push(next),
    window: { scrollTo: noop, confirm: () => true, location: { pathname: "/", search: "" }, history: { pushState: noop } },
  });
  assert.equal(navigate(same)("customers"), true);
  assert.equal(same.current, null);
  assert.deepEqual(sameViews, []);
  const other = recordState();
  assert.equal(navigate(other)("calendar"), true);
  assert.equal(other.current, null);
  // Browser back to an entry without a record closes only record pages.
  const node = findAll((item) => ts.isVariableDeclaration(item) && item.name.getText(ast) === "syncView")[0];
  for (const [state, expectedOpen] of [[null, false], [{ record: "customer:synthetic" }, true]]) {
    const record = recordState();
    const sync = evaluate(`const result = ${node.initializer.getText(ast)};`, {
      ...base, navItems: [["today"], ["customers"]], currentView: { current: "customers" }, historyOpenVersion: { current: 0 }, setHistoryModal: record.set, setView: noop,
      window: { location: { hash: "#customers", pathname: "/" }, history: { pushState: noop, state }, confirm: () => true },
    });
    sync();
    assert.equal(Boolean(record.current), expectedOpen);
  }
  const dialog = { current: { title: "2026.09.14 업무", date: "2026-09-14", items: [] } };
  dialog.set = (next) => { dialog.current = typeof next === "function" ? next(dialog.current) : next; };
  evaluate(`const result = ${node.initializer.getText(ast)};`, {
    ...base, navItems: [["today"], ["customers"]], currentView: { current: "customers" }, historyOpenVersion: { current: 0 }, setHistoryModal: dialog.set, setView: noop,
    window: { location: { hash: "#customers", pathname: "/" }, history: { pushState: noop, state: null }, confirm: () => true },
  })();
  assert.ok(dialog.current, "a date list dialog is not a page and stays open");
});
