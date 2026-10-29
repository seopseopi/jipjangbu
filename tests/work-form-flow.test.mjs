import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { findWorkDraftIssue, LISTING_WORK_TYPES } from "../app/work-form-rules.ts";
import { hasPropertyDraft, propertyFromListing } from "../app/listing-draft.ts";

const customers = [{ id: "synthetic-customer", name: "검증 고객" }];
const workTypes = ["전화상담", "집방문", ...LISTING_WORK_TYPES];
const blank = propertyFromListing({ id: "empty", identity_key: "empty" });
const property = { ...blank, propertyType: "아파트", buildingName: "검증단지", unitNumber: "101" };
const draft = { workDate: "2026-09-13", customerId: customers[0].id, workType: "전화상담", details: [blank] };
const issue = (changes) => findWorkDraftIssue({ ...draft, ...changes }, customers, workTypes);

test("ordinary consultation permits no property, while every listing-changing work type requires one", () => {
  assert.equal(issue({ details: [] }), null);
  assert.equal(issue({ workType: "집방문", details: [blank] }), null);
  for (const workType of LISTING_WORK_TYPES) {
    assert.equal(issue({ workType }).field, "property-0-propertyType", workType);
    assert.equal(issue({ workType, details: [property] }), null, workType);
  }
});

test("date, customer selection and work type errors follow the visible field order", () => {
  assert.equal(issue({ workDate: "", customerId: "", workType: "" }).field, "workDate");
  for (const workDate of ["2026-02-30", "2026-13-01", "not-a-date", "2026-2-1"]) assert.equal(issue({ workDate }).field, "workDate");
  assert.equal(issue({ workDate: "2028-02-29" }), null);
  assert.equal(issue({ customerId: "typed but not selected", workType: "" }).field, "customerId");
  assert.equal(issue({ workType: "" }).field, "workType");
  assert.equal(issue({ workType: "not configured" }).field, "workType");
});

test("listing validation ignores completely blank extra rows and locates incomplete entered rows", () => {
  assert.equal(issue({ workType: "매물수정", details: [blank, property, blank] }), null);
  for (const key of ["propertyType", "buildingName", "unitNumber"]) {
    const found = issue({ workType: "매물수정", details: [property, { ...property, [key]: " " }] });
    assert.equal(found.field, `property-1-${key}`);
    assert.match(found.message, /물건 2/);
  }
  assert.equal(issue({ workType: "매물등록", details: [property, { ...blank, source: "출처만 입력" }] }).field, "property-1-propertyType");
  assert.equal(issue({ workType: "매물등록", details: [{ ...property, buildingDong: "" }] }), null, "a building without dong remains valid");
  assert.equal(property.unitNumber, "101", "validation never changes the draft");
});

const source = readFileSync(new URL("../app/work-manager.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("work-manager.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(root, predicate) {
  let found;
  function visit(node) { if (predicate(node)) found = node; ts.forEachChild(node, visit); }
  visit(root);
  assert.ok(found);
  return found;
}
const workModal = find(ast, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "WorkModal");
const customerModal = find(ast, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "CustomerModal");
function compile(expression, environment) {
  const javascript = ts.transpileModule(`const actual = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function(...Object.keys(environment), `${javascript}; return actual;`)(...Object.values(environment));
}
function namedHandler(root, name, environment) {
  return compile(find(root, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast), environment);
}

test("the actual work submit stops before any request and records the first missing field", async () => {
  const found = { error: "", field: null };
  const submit = namedHandler(workModal, "submit", {
    saving: false, savePendingRef: { current: false }, ...draft, workType: "매물수정", customers, lookups: { workTypes }, findWorkDraftIssue,
    setErrorField: (field) => { found.field = field; }, setError: (message) => { found.error = message; },
    setSaving: () => assert.fail("must not start saving"), jsonFetch: () => assert.fail("must not send an invalid record"),
  });
  let prevented = false;
  await submit({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(found.field, "property-0-propertyType");
  assert.match(found.error, /매물수정/);
});

test("the actual work submit preserves all entered fields and reports a failed save without closing", async () => {
  let sent, error = "", saving = false;
  const details = [property];
  const submit = namedHandler(workModal, "submit", {
    ...draft, details, content: "검증 상담 메모", item: undefined, saving: false, savePendingRef: { current: false }, customers, lookups: { workTypes }, findWorkDraftIssue,
    onBusyChange: undefined, savingMountedRef: { current: true },
    setErrorField: () => {}, setError: (message) => { error = message; }, setSaving: (value) => { saving = value; },
    jsonFetch: async (url, init) => { sent = { url, body: JSON.parse(init.body) }; throw new Error("연결을 확인해 주세요."); },
    onSaved: () => assert.fail("a failed save must retain the editor"),
  });
  await submit({ preventDefault() {} });
  assert.equal(sent.url, "/api/work-logs");
  assert.equal(sent.body.content, "검증 상담 메모");
  assert.deepEqual(sent.body.details, details);
  assert.equal(error, "연결을 확인해 주세요.");
  assert.equal(saving, false);
});

test("editing sends the read revision and preserves the draft when a concurrent edit conflicts", async () => {
  const details = [structuredClone(property)];
  const before = structuredClone(details);
  let sent, error = "", saving = false, closed = false;
  const submit = namedHandler(workModal, "submit", {
    ...draft, details, content: "작성 중인 메모", item: { id: "synthetic-work", revision: "original-revision" },
    saving: false, savePendingRef: { current: false }, customers, lookups: { workTypes }, findWorkDraftIssue,
    onBusyChange: undefined, savingMountedRef: { current: true },
    setErrorField: () => {}, setError: (message) => { error = message; }, setSaving: (value) => { saving = value; },
    jsonFetch: async (url, init) => {
      sent = { url, method: init.method, body: JSON.parse(init.body) };
      throw Object.assign(new Error("충돌"), { status: 409 });
    },
    onSaved: () => { closed = true; },
  });
  await submit({ preventDefault() {} });
  assert.equal(sent.method, "PUT");
  assert.equal(sent.body.revision, "original-revision");
  assert.equal(sent.body.content, "작성 중인 메모");
  assert.deepEqual(details, before);
  assert.match(error, /다른 기기/);
  assert.match(error, /복사.*최신 업무/);
  assert.equal(closed, false);
  assert.equal(saving, false);
});

const removalButton = find(workModal, (node) => ts.isJsxElement(node) && node.openingElement.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute) && attribute.name.text === "className" && attribute.initializer?.text === "remove-detail"));
const removal = find(removalButton, (node) => ts.isJsxAttribute(node) && node.name.text === "onClick").initializer.expression.getText(ast);
function removeHarness(detail, allow) {
  let prompts = 0, rows = [property, detail], resets = 0;
  const remove = compile(removal, {
    detail, index: 1, hasPropertyDraft,
    window: { confirm: () => { prompts++; return allow; } },
    setReferenceHistory: () => { resets++; }, setListingPickerIndex: () => {}, setListingLoadedMessage: () => {}, setError: () => {}, setErrorField: () => {},
    setDetails: (updater) => { rows = updater(rows); },
  });
  remove();
  return { prompts, rows, resets };
}

test("removing a populated property requires confirmation and declining preserves all draft and history state", () => {
  const changed = { ...property, buildingName: "작성 중 물건" };
  const denied = removeHarness(changed, false);
  assert.equal(denied.prompts, 1);
  assert.deepEqual(denied.rows, [property, changed]);
  assert.equal(denied.resets, 0);
  const accepted = removeHarness(changed, true);
  assert.deepEqual(accepted.rows, [property]);
  assert.equal(accepted.rows[0], property);
});

test("removing a blank extra property is immediate and keeps the other property", () => {
  const removed = removeHarness(blank, false);
  assert.equal(removed.prompts, 0);
  assert.deepEqual(removed.rows, [property]);
});

test("new customer submission hands the authoritative saved customer back for immediate selection", async () => {
  const savedCustomer = { id: "synthetic-new", name: "검증 신규 고객", notes: "검증 메모" };
  let completed;
  const submit = namedHandler(customerModal, "submit", {
    saving: false, modal: { mode: "new" }, id: " synthetic-new ", name: " 검증 신규 고객 ", notes: "검증 메모",
    onBusyChange: undefined, savingMountedRef: { current: true },
    setSaving: () => {}, setError: (error) => assert.equal(error, ""),
    jsonFetch: async () => ({ customer: savedCustomer }),
    onSaved: async (...args) => { completed = args; },
  });
  await submit({ preventDefault() {} });
  assert.equal(completed[1], savedCustomer.id);
  assert.deepEqual(completed[2], { ...savedCustomer, created_at: "", updated_at: "", history_count: 0, is_demo: 0 });
});

test("the editor exposes an alert, address examples, shared listing rules and distinct save versus delete actions", () => {
  const text = workModal.getText(ast);
  assert.match(text, /findWorkDraftIssue/);
  assert.match(text, /LISTING_WORK_TYPES\.has\(workType\)/);
  assert.match(text, /role="alert"/);
  assert.match(text, /data-work-field=\{`property-\$\{index\}-unitNumber`\}/);
  assert.match(text, /className="work-record-actions"/);
  assert.match(text, /className="work-save-state"/);
  assert.match(text, /modal\.initialListing \? \[propertyFromListing\(modal\.initialListing\)\]/);
  assert.match(text, /placeholder="예: 1503"/);
});

function busyHarness(modalNode, name, options = {}) {
  const busy = [], errors = [];
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const mounted = { current: true };
  const run = namedHandler(modalNode, name, {
    ...draft, details: [property], content: "검증 메모", item: { id: "synthetic-work" },
    modal: { mode: "edit", item: { id: "synthetic-customer" } },
    id: "synthetic-customer", name: "검증 고객", notes: "", saving: false, savePendingRef: { current: false },
    customers, lookups: { workTypes }, findWorkDraftIssue,
    setErrorField: () => {}, setError: (value) => { if (value) errors.push(value); }, setSaving: () => {},
    window: { confirm: () => true }, savingMountedRef: mounted,
    onBusyChange: (value) => busy.push(value),
    jsonFetch: () => pending, onSaved: async () => {},
    ...options,
  });
  return { busy, errors, finish, mounted, run };
}

test("work and customer saves report busy synchronously and release it only after completion", async () => {
  for (const modalNode of [workModal, customerModal]) {
    for (const name of ["submit"]) {
      const harness = busyHarness(modalNode, name);
      const task = harness.run({ preventDefault() {} });
      assert.deepEqual(harness.busy, [true], `${modalNode.name.text}.${name} blocks navigation before awaiting the request`);
      harness.finish({ ok: true });
      await task;
      assert.deepEqual(harness.busy, [true, false]);
      assert.deepEqual(harness.errors, []);
    }
  }
});

test("work and customer deletion opens the shared preview without discarding an unsaved draft or sending a write", () => {
  for (const modalNode of [workModal, customerModal]) {
    const calls = [];
    const harness = busyHarness(modalNode, "remove", {
      dirty: true,
      onDelete: (...args) => calls.push(args),
      jsonFetch: () => assert.fail("Opening a deletion preview must not delete or save data"),
    });
    harness.run();
    assert.deepEqual(calls, [[modalNode === workModal ? "synthetic-work" : "synthetic-customer", true]]);
    assert.deepEqual(harness.busy, []);
    const locked = busyHarness(modalNode, "remove", { saving: true, dirty: true, onDelete: () => assert.fail("Cannot delete while saving") });
    locked.run();
  }
});

test("failed mutations release the navigation lock and invalid drafts never acquire it", async () => {
  for (const modalNode of [workModal, customerModal]) {
    const harness = busyHarness(modalNode, "submit", { jsonFetch: async () => { throw new Error("합성 연결 실패"); } });
    await harness.run({ preventDefault() {} });
    assert.deepEqual(harness.busy, [true, false]);
    assert.deepEqual(harness.errors, ["합성 연결 실패"]);
  }
  const invalid = busyHarness(workModal, "submit", { customerId: "" });
  await invalid.run({ preventDefault() {} });
  assert.deepEqual(invalid.busy, []);
});

test("unmount releases the lock and an old request's late finally cannot unlock a newer editor", async () => {
  for (const modalNode of [workModal, customerModal]) {
    const harness = busyHarness(modalNode, "submit");
    const task = harness.run({ preventDefault() {} });
    const effect = find(modalNode, (node) => ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[0].getText(ast).includes("busyCallbackRef.current?.(false)"));
    const cleanup = compile(effect.arguments[0].getText(ast), {
      savingMountedRef: harness.mounted,
      busyCallbackRef: { current: (value) => harness.busy.push(value) },
    })();
    cleanup();
    assert.deepEqual(harness.busy, [true, false]);
    harness.busy.push(true); // A newly mounted editor starts its own mutation.
    harness.finish({ ok: true });
    await task;
    assert.deepEqual(harness.busy, [true, false, true]);
  }
});

test("토지는 주소 하나면 유효하고 다른 물건은 호수가 계속 필요하다", () => {
  const land = { ...blank, propertyType: "토지", buildingName: "인천 서구 검암동 123-45", unitNumber: "" };
  assert.equal(issue({ workType: "매물등록", details: [land] }), null);
  assert.equal(issue({ workType: "매물등록", details: [{ ...land, buildingName: "" }] }).field, "property-0-buildingName");
  assert.equal(issue({ workType: "매물등록", details: [{ ...land, propertyType: "아파트" }] }).field, "property-0-unitNumber");
});
