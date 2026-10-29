import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";
import { formatHistoryTimestamp, latestSavedListingEvent } from "../app/history-timestamps.ts";
import { findWorkDraftIssue } from "../app/work-form-rules.ts";
import { initialWorkDraft, workModalHandler } from "./helpers/work-copy.mjs";

// Execute the actual API handlers and schema against synthetic in-memory data.
// The binding adapter models D1's all-or-nothing batch, including a deliberately
// failing derived-listing write. No Cloudflare binding or real record is used.
const root = new URL("../", import.meta.url);
const roots = [new URL("app/", root).href, new URL("db/", root).href];
const bindingKey = "jipjangbu-listing-consistency-db";
const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (roots.some((prefix) => context.parentURL?.startsWith(prefix)) && specifier.startsWith(".")) {
      const resolved = new URL(specifier, context.parentURL).href;
      if (["db", "db/", "db/index.ts"].some((path) => resolved === new URL(path, root).href)) {
        return { url: moduleUrl(`export function getD1() { return globalThis[Symbol.for(${JSON.stringify(bindingKey)})]; }`), shortCircuit: true };
      }
      if (["db/bootstrap", "db/bootstrap.ts"].some((path) => resolved === new URL(path, root).href)) {
        return { url: moduleUrl("export async function ensureDatabase() {}"), shortCircuit: true };
      }
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (roots.some((prefix) => url.startsWith(prefix)) && url.endsWith(".ts")) {
      return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
    }
    return nextLoad(url, context);
  },
});
const [workRoute, detailRoute, listingRoute, historyRoute, deletionStore] = await Promise.all([
  import("../app/api/work-logs/route.ts"), import("../app/api/work-logs/[id]/route.ts"),
  import("../app/api/listings/route.ts"), import("../app/api/listings/[key]/route.ts"),
  import("../db/deletion-store.ts"),
]);
hook.deregister();

function database(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = new URL("drizzle/", root);
  for (const name of readdirSync(migrations).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) {
    assert.doesNotMatch(name, /private/);
    sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  for (const [id, name] of [["synthetic-customer", "합성 고객 가"], ["synthetic-other", "합성 고객 나"]]) sqlite.prepare("INSERT INTO customers(id,name) VALUES (?,?)").run(id, name);
  for (const type of ["매물등록", "매물수정", "매물취소", "계약작성", "전화", "집방문"]) sqlite.prepare("INSERT INTO work_types(name) VALUES (?)").run(type);
  let failure = null;
  const batches = [];
  globalThis[Symbol.for(bindingKey)] = {
    prepare(sql) {
      const query = sqlite.prepare(sql);
      let bindings = [];
      const execute = () => {
        if (failure?.(sql, bindings)) throw new Error("Synthetic listing projection failure");
        if (query.columns().length) return { results: query.all(...bindings), success: true, meta: { changes: 0 } };
        const result = query.run(...bindings);
        return { results: [], success: true, meta: { changes: Number(result.changes) } };
      };
      return {
        bind(...values) { bindings = values; return this; },
        async first() { return execute().results[0] ?? null; },
        async all() { return execute(); },
        async run() { return execute(); },
        sql, execute,
      };
    },
    async batch(statements) {
      batches.push(statements.map((statement) => statement.sql));
      sqlite.exec("SAVEPOINT synthetic_batch");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("RELEASE SAVEPOINT synthetic_batch");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK TO SAVEPOINT synthetic_batch");
        sqlite.exec("RELEASE SAVEPOINT synthetic_batch");
        throw error;
      }
    },
  };
  t.mock.method(console, "error", () => {});
  t.after(() => { sqlite.close(); delete globalThis[Symbol.for(bindingKey)]; });
  return {
    sqlite, batches,
    failProjection(predicate = () => true) { failure = (sql, bindings) => /(?:INSERT INTO|DELETE FROM) listings\b/i.test(sql) && predicate(sql, bindings); },
    clearFailure() { failure = null; },
    snapshot() { return Object.fromEntries(["work_logs", "work_log_properties", "listing_events", "listings", "listing_source_notes"].map((table) => [table, sqlite.prepare(`SELECT * FROM ${table} ORDER BY ${table === "listing_source_notes" ? "identity_key" : "id"}`).all()])); },
  };
}

const property = (overrides = {}) => ({ propertyType: "아파트", buildingName: "합성단지", buildingDong: "106", unitNumber: "1503", sizeType: "33", salePrice: "55000", jeonsePrice: "30000", monthlyRent: "", source: "합성 업소", ...overrides });
const key = (detail = property()) => [detail.propertyType, detail.buildingName, detail.buildingDong, detail.unitNumber].join("|");
const payload = (overrides = {}) => ({ workDate: "2026-09-13", customerId: "synthetic-customer", workType: "매물등록", content: "합성 최초 등록", details: [property()], ...overrides });
async function mutate(method, value, id, expectedStatus = method === "POST" ? 201 : 200) {
  let editRevision;
  if (method === "PUT") {
    const response = await detailRoute.GET(new Request(`https://synthetic.invalid/api/work-logs/${id}`), { params: Promise.resolve({ id }) });
    assert.equal(response.status, 200);
    editRevision = (await response.json()).workLog.revision;
  }
  const bodyValue = method === "DELETE"
    ? { revision: (await deletionStore.getDeletionPreview(globalThis[Symbol.for(bindingKey)], "work", id)).revision }
    : method === "PUT" ? { ...value, revision: editRevision } : value;
  const request = new Request(`https://synthetic.invalid/api/work-logs${id ? `/${id}` : ""}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyValue) });
  const result = method === "POST" ? await workRoute.POST(request) : await detailRoute[method](request, { params: Promise.resolve({ id }) });
  const body = await result.json();
  assert.equal(result.status, expectedStatus, JSON.stringify(body));
  return body.workLog ?? body;
}
async function history(identity = key(), expectedStatus = 200) {
  const response = await historyRoute.GET(new Request("https://synthetic.invalid/api/listings/example"), { params: Promise.resolve({ key: identity }) });
  const body = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(body));
  return body;
}

function copyForm(original, changeDraft = () => {}) {
  const draft = initialWorkDraft({ mode: "copy", item: original });
  changeDraft(draft);
  const calls = [], errors = [], saved = [];
  const submit = workModalHandler("submit", {
    ...draft, modal: { mode: "copy", item: original }, saving: false, savePendingRef: { current: false }, savingMountedRef: { current: true },
    customers: [{ id: "synthetic-customer" }, { id: "synthetic-other" }], lookups: { workTypes: ["매물등록", "매물수정", "전화"] }, findWorkDraftIssue,
    setSaving() {}, setErrorField() {}, onBusyChange() {}, setError: (message) => { if (message) errors.push(message); },
    onSaved: async (...args) => saved.push(args),
    jsonFetch: async (url, options) => {
      calls.push({ url, ...options });
      assert.equal(url, "/api/work-logs");
      assert.equal(options.method, "POST");
      const response = await workRoute.POST(new Request(`https://synthetic.invalid${url}`, options));
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      return body;
    },
  });
  return { draft, calls, errors, saved, submit: () => submit({ preventDefault() {} }) };
}

test("실제 복사 폼 → 신규 등록 API → DB·매물이력: 원본 10개 물건은 보존하고 새 ID의 업무를 추가한다", async (t) => {
  const db = database(t);
  const details = Array.from({ length: 10 }, (_, index) => property({ unitNumber: String(1501 + index), source: `합성 업소 ${index + 1}` }));
  const original = await mutate("POST", payload({ workDate: "2026-09-01", details }));
  const before = db.snapshot();
  const form = copyForm(original, (draft) => {
    draft.customerId = "synthetic-other";
    draft.workType = "매물수정";
    draft.content = "복사 후 새 가격 확인";
    draft.details[0].salePrice = "56000";
  });
  await form.submit();
  assert.deepEqual(form.errors, []);
  assert.equal(form.saved.length, 1);
  const created = form.saved[0][1];
  assert.notEqual(created.id, original.id);
  assert.equal(created.work_date, "2026-09-16");
  assert.equal(created.customer_id, "synthetic-other");
  assert.equal(created.work_type, "매물수정");
  assert.equal(created.legacy_id, null);
  assert.equal(created.details.length, 10);
  const after = db.snapshot();
  assert.equal(after.work_logs.length, 2);
  assert.deepEqual(after.work_logs.find((work) => work.id === original.id), before.work_logs[0]);
  assert.deepEqual(after.work_log_properties.filter((item) => item.work_log_id === original.id), before.work_log_properties);
  assert.deepEqual(after.listing_events.filter((item) => item.work_log_id === original.id), before.listing_events);
  const originalIds = new Set(original.details.map((item) => item.id));
  assert(created.details.every((item) => !originalIds.has(item.id) && item.work_log_id === created.id));
  assert.deepEqual(created.details.map((item) => item.unit_number), details.map((item) => item.unitNumber));
  assert.deepEqual(created.details.map((item) => item.source), details.map((item) => item.source));
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM customers").get().count, 2, "copy does not duplicate customers");
  const listingHistory = await history(key(details[0]));
  assert.equal(listingHistory.listing.sale_price, "56000");
  assert.deepEqual(listingHistory.events.map((item) => item.work_log_id), [created.id, original.id]);
});

test("복사 저장 중 매물 반영 실패는 전체 롤백하고 초안을 유지해 정상 재시도한다", async (t) => {
  const db = database(t), original = await mutate("POST", payload({ workDate: "2026-09-01" }));
  const before = db.snapshot(), form = copyForm(original);
  const draftBefore = JSON.stringify(form.draft);
  db.failProjection();
  await form.submit();
  assert.equal(form.errors.length, 1);
  assert.equal(form.saved.length, 0);
  assert.deepEqual(db.snapshot(), before);
  assert.equal(JSON.stringify(form.draft), draftBefore);
  db.clearFailure();
  await form.submit();
  assert.equal(form.saved.length, 1);
  assert.equal(db.snapshot().work_logs.length, 2);
});

test("매물 변경이력 없는 물건도 모든 집방문·전화 업무를 중복 없이 최신순으로 조회한다", async (t) => {
  const db = database(t);
  const home = property({ buildingName: "합성힐스테이트1차", buildingDong: "105", unitNumber: "401", source: "합성뉴현대" });
  const older = await mutate("POST", payload({ workDate: "2026-09-01", workType: "집방문", details: [home] }));
  const recent = await mutate("POST", payload({ workDate: "2026-09-08", workType: "집방문", content: "합성 재방문", details: [property(), home] }));
  const call = await mutate("POST", payload({ workDate: "2026-09-07", workType: "전화", customerId: "synthetic-other", details: [home, { ...home, source: "다른 합성업소" }] }));
  for (const other of [{ unitNumber: "4010" }, { buildingDong: "106" }, { buildingName: "다른단지" }, { propertyType: "빌라" }]) {
    await mutate("POST", payload({ workType: "집방문", details: [{ ...home, ...other }] }));
  }
  const before = db.snapshot(), result = await history(key(home));
  assert.equal(result.listing, null, "do not invent a current status or price");
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.workLogs.map((work) => work.id), [recent.id, call.id, older.id]);
  assert.equal(result.workLogs[1].customer_id, "synthetic-other");
  assert.equal(JSON.parse(result.workLogs[0].properties_json)[1].source, "합성뉴현대");
  assert.equal(result.workLogs[0].property_count, 2);
  assert.deepEqual(db.snapshot(), before, "history reads do not create a listing or change business data");
  assert.equal(before.listings.length, 0);
  await history(key({ ...home, unitNumber: "9999" }), 404);
});

test("마지막 매물 변경업무를 삭제·정정해도 남은 일반 업무와 수정·복구 결과는 조회된다", async (t) => {
  const db = database(t);
  const visit = await mutate("POST", payload({ workType: "집방문", workDate: "2026-09-08" }));
  const registration = await mutate("POST", payload());
  await mutate("DELETE", undefined, registration.id);
  let result = await history();
  assert.equal(result.listing, null);
  assert.deepEqual(result.workLogs.map((work) => work.id), [visit.id]);
  const secondRegistration = await mutate("POST", payload());
  await mutate("PUT", payload({ workType: "전화" }), secondRegistration.id);
  result = await history();
  assert.equal(result.listing, null);
  assert.equal(result.workLogs.length, 2);
  await mutate("PUT", payload({ workType: "집방문", details: [property({ unitNumber: "1504" })] }), visit.id);
  assert.deepEqual((await history()).workLogs.map((work) => work.id), [secondRegistration.id]);
  assert.deepEqual((await history(key(property({ unitNumber: "1504" })))).workLogs.map((work) => work.id), [visit.id]);
  const removed = await mutate("DELETE", undefined, secondRegistration.id);
  await history(key(), 404);
  await deletionStore.restoreTrash(globalThis[Symbol.for(bindingKey)], removed.trashId);
  const restored = await history();
  assert.equal(restored.listing, null);
  assert.deepEqual(restored.workLogs.map((work) => work.id), [secondRegistration.id]);
  assert.equal(db.snapshot().listings.length, 0);
});

test("매물 개별 업무에는 상태변경뿐 아니라 두 번째 물건의 전화도 포함하고 수정·삭제·주소 경계를 반영한다", async (t) => {
  database(t);
  const registration = await mutate("POST", payload({ workDate: "2026-09-12" }));
  const call = await mutate("POST", payload({ workType: "전화", content: "묶음 방문 상담", customerId: "synthetic-other", details: [property({ unitNumber: "999" }), property()] }));
  await mutate("POST", payload({ workType: "전화", details: [property({ unitNumber: "15030" })] }));
  await mutate("POST", payload({ workType: "전화", details: [property({ buildingName: "다른 합성단지" })] }));
  await mutate("POST", payload({ workType: "전화", details: [property({ propertyType: "빌라" })] }));
  const result = await history();
  assert.deepEqual(result.events.map((event) => event.work_log_id), [registration.id], "the listing-status timeline must not be rewritten by ordinary work");
  assert.deepEqual(result.workLogs.map((work) => work.id), [call.id, registration.id]);
  assert.equal(result.workLogs[0].customer_id, "synthetic-other");
  assert.equal(JSON.parse(result.workLogs[0].properties_json).length, 2);
  await mutate("PUT", payload({ workType: "전화", content: "주소 변경", details: [property({ unitNumber: "999" })] }), call.id);
  assert.deepEqual((await history()).workLogs.map((work) => work.id), [registration.id]);
  await mutate("PUT", payload({ workType: "전화" }), call.id);
  assert.equal((await history()).workLogs.length, 2);
  await mutate("DELETE", null, call.id);
  assert.deepEqual((await history()).workLogs.map((work) => work.id), [registration.id]);
});

test("원문이 없는 신규 매물의 반복 수정은 메모 사본을 보관하지 않고 기존 빈 tombstone만 유지한다", async (t) => {
  const db = database(t);
  const original = await mutate("POST", payload());
  for (let index = 0; index < 3; index++) {
    await mutate("PUT", payload({ content: `보관할 원문이 아닌 합성 수정 ${index}` }), original.id);
    assert.deepEqual(db.snapshot().listing_source_notes, []);
  }
  db.sqlite.prepare("INSERT INTO listing_source_notes(identity_key,source_notes) VALUES (?, '')").run(key());
  await mutate("PUT", payload({ content: "빈 tombstone 이후의 합성 수정" }), original.id);
  const preserved = db.snapshot().listing_source_notes[0];
  assert.equal(preserved.source_notes, "");
  assert.equal(preserved.event_history, "[]", "new work notes are not originals covered by an empty tombstone");
  assert.equal((await history()).listing.source_notes, "");
});

test("마지막 상태 업무를 일반 업무로 바꿨다가 되돌려도 엑셀 전용 원문을 보존한다", async (t) => {
  const db = database(t);
  const original = await mutate("POST", payload());
  const source = "  업무에 없는 합성 엑셀 특약\n두 번째 원문 줄  ";
  db.sqlite.prepare("UPDATE listings SET source_notes=? WHERE identity_key=?").run(source, key());
  await mutate("PUT", payload({ workType: "전화" }), original.id);
  assert.equal(db.snapshot().listings.length, 0, "ordinary work must not fabricate an active listing");
  assert.equal(db.snapshot().listing_source_notes[0].source_notes, source);
  await mutate("PUT", payload(), original.id);
  assert.equal((await history()).listing.source_notes, source);
  assert.equal((await history()).events.length, 1);
});

test("주소를 정정할 때 원문은 원래 주소에 보관하고 다른 집으로 복사하지 않는다", async (t) => {
  const db = database(t);
  const original = await mutate("POST", payload());
  const source = "합성 원래 집의 엑셀 특약";
  db.sqlite.prepare("UPDATE listings SET source_notes=? WHERE identity_key=?").run(source, key());
  const corrected = property({ unitNumber: "1604" });
  await mutate("PUT", payload({ details: [corrected] }), original.id);
  assert.equal((await history(key(corrected))).listing.source_notes, "");
  assert.equal(db.sqlite.prepare("SELECT source_notes FROM listing_source_notes WHERE identity_key=?").get(key()).source_notes, source);
  await mutate("PUT", payload(), original.id);
  assert.equal((await history()).listing.source_notes, source);
});

test("주소 키 구분자는 모든 주소 필드에서 원자적으로 거절하고 메모와 물건지는 그대로 허용한다", async (t) => {
  const db = database(t);
  for (const field of ["propertyType", "buildingName", "buildingDong", "unitNumber"]) {
    const before = db.snapshot();
    await mutate("POST", payload({ workType: "전화", details: [property({ [field]: "A|B" })] }), undefined, 400);
    assert.deepEqual(db.snapshot(), before);
  }
  const saved = await mutate("POST", payload({ content: "메모 A|B", details: [property({ source: "업소 A|B" })] }));
  assert.equal(saved.content, "메모 A|B");
  assert.equal(saved.details[0].source, "업소 A|B");
  const before = db.snapshot();
  await mutate("PUT", payload({ details: [property({ buildingName: "A|B" })] }), saved.id, 400);
  assert.deepEqual(db.snapshot(), before);
});

test("매물 수정 업무는 이전 이력을 보존하며 현재 가격·메모·고객 이력을 함께 갱신한다", async (t) => {
  const db = database(t);
  const registration = await mutate("POST", payload({ workDate: "2026-09-12" }));
  db.sqlite.prepare("UPDATE listings SET source_notes='합성 엑셀 원문' WHERE identity_key=?").run(key());
  const modification = await mutate("POST", payload({ workType: "매물수정", content: "합성 가격 인하", details: [property({ salePrice: "53000", jeonsePrice: "28000" })] }));
  const result = await history();
  assert.equal(result.listing.sale_price, "53000");
  assert.equal(result.listing.jeonse_price, "28000");
  assert.equal(result.listing.status, "매물수정");
  assert.equal(result.listing.closed_at, null);
  assert.equal(result.listing.registered_at, "2026-09-12");
  assert.equal(result.listing.source_notes, "합성 엑셀 원문");
  assert.equal(result.listing.notes, "합성 엑셀 원문\n합성 가격 인하 (매물수정) (2026-09-13)\n합성 최초 등록 (매물등록) (2026-09-12)");
  assert.deepEqual(result.events.map((event) => event.work_log_id), [modification.id, registration.id]);
  assert.deepEqual(result.events.map((event) => event.sale_price), ["53000", "55000"]);
  assert.equal(result.events[0].customer_name, "합성 고객 가");
  const customer = await workRoute.GET(new Request("https://synthetic.invalid/api/work-logs?customerId=synthetic-customer"));
  assert.equal((await customer.json()).total, 2);
  const listings = await listingRoute.GET(new Request("https://synthetic.invalid/api/listings?state=active"));
  assert.equal((await listings.json()).listings[0].sale_price, "53000");
});

test("매물 투영 저장이 실패하면 신규 업무·물건·이력을 모두 원상태로 되돌린다", async (t) => {
  const db = database(t);
  const before = db.snapshot();
  db.failProjection();
  await mutate("POST", payload(), undefined, 500);
  assert.deepEqual(db.snapshot(), before);
  db.clearFailure();
  await mutate("POST", payload());
  assert.equal((await history()).events.length, 1, "retry cannot duplicate a previously half-saved event");
});

test("기존 수정 업무 정정은 중복 이력 없이 가격·내용·연결 고객을 바꾼다", async (t) => {
  database(t);
  const work = await mutate("POST", payload());
  const before = await history();
  await mutate("PUT", payload({ workType: "매물수정", customerId: "synthetic-other", content: "합성 메모 정정", details: [property({ salePrice: "51000", monthlyRent: "2000/80" })] }), work.id);
  const after = await history();
  assert.equal(after.listing.id, before.listing.id, "the listing record identity stays stable");
  assert.equal(after.events.length, 1);
  assert.equal(after.events[0].work_log_id, work.id);
  assert.equal(after.events[0].customer_id, "synthetic-other");
  assert.equal(after.events[0].customer_name, "합성 고객 나");
  assert.equal(after.events[0].notes, "합성 메모 정정");
  assert.equal(after.events[0].sale_price, "51000");
  assert.equal(after.listing.sale_price, "51000");
  assert.equal(after.listing.monthly_rent, "2000/80");
  assert.equal(after.events[0].event_order, before.events[0].event_order);
});

test("과거 업무를 고쳐도 더 최근 날짜의 매물 상태·가격을 덮어쓰지 않는다", async (t) => {
  database(t);
  const first = await mutate("POST", payload({ workDate: "2026-09-01" }));
  const latest = await mutate("POST", payload({ workDate: "2026-09-15", workType: "매물수정", content: "합성 최신 가격", details: [property({ salePrice: "51000" })] }));
  await mutate("PUT", payload({ workDate: "2026-09-02", content: "합성 과거 기록 정정", details: [property({ salePrice: "54000" })] }), first.id);
  const result = await history();
  assert.equal(result.listing.sale_price, "51000");
  assert.equal(result.listing.registered_at, "2026-09-02");
  assert.equal(result.events[0].work_log_id, latest.id);
  assert.equal(result.events[1].sale_price, "54000");
  assert.match(result.listing.notes, /합성 과거 기록 정정/);
});

test("같은 날 이전 업무를 수정해도 기존 시간순서와 최신 매물 가격을 유지한다", async (t) => {
  const db = database(t);
  const first = await mutate("POST", payload());
  const second = await mutate("POST", payload({ workType: "매물수정", details: [property({ salePrice: "52000" })] }));
  // Deterministic event ordering models two real saves on the same business day.
  db.sqlite.prepare("UPDATE listing_events SET event_order=100 WHERE work_log_id=?").run(first.id);
  db.sqlite.prepare("UPDATE listing_events SET event_order=200 WHERE work_log_id=?").run(second.id);
  await mutate("PUT", payload({ content: "합성 이전 업무 내용 정정", details: [property({ salePrice: "54000" })] }), first.id);
  const result = await history();
  assert.deepEqual(result.events.map((event) => event.work_log_id), [second.id, first.id]);
  assert.equal(result.listing.sale_price, "52000");
  assert.equal(result.events[1].event_order, 100);
});

test("최신 취소 업무 삭제는 이전 매물을 복원하고 마지막 이력 삭제는 현재 매물도 제거한다", async (t) => {
  const db = database(t);
  const first = await mutate("POST", payload({ workDate: "2026-09-12" }));
  const cancelled = await mutate("POST", payload({ workType: "매물취소", content: "합성 취소", details: [property({ salePrice: "0" })] }));
  const closed = await history();
  assert.equal(closed.listing.closed_at, "2026-09-13");
  assert.equal(closed.listing.status, "매물취소");
  await mutate("DELETE", undefined, cancelled.id);
  const restored = await history();
  assert.equal(restored.listing.closed_at, null);
  assert.equal(restored.listing.status, "매물등록");
  assert.equal(restored.listing.sale_price, "55000");
  assert.equal(restored.events.length, 1);
  assert.doesNotMatch(restored.listing.notes, /합성 취소/);
  await mutate("DELETE", undefined, first.id);
  await history(key(), 404);
  const { listing_source_notes, ...active } = db.snapshot();
  assert.deepEqual(active, { work_logs: [], work_log_properties: [], listing_events: [], listings: [] });
  assert.deepEqual(listing_source_notes.map(({ identity_key, source_notes }) => ({ identity_key, source_notes })), [{ identity_key: key(), source_notes: "" }]);
});

test("물건 주소를 정정하면 기존 주소·새 주소 이력과 현재 매물을 각각 재계산한다", async (t) => {
  database(t);
  const original = await mutate("POST", payload({ workDate: "2026-09-12" }));
  const corrected = await mutate("POST", payload({ workType: "매물수정", details: [property({ salePrice: "52000" })] }));
  const moved = property({ unitNumber: "1504", salePrice: "51000" });
  await mutate("PUT", payload({ workType: "매물수정", content: "합성 주소 정정", details: [moved] }), corrected.id);
  const previous = await history();
  const next = await history(key(moved));
  assert.equal(previous.listing.sale_price, "55000");
  assert.deepEqual(previous.events.map((event) => event.work_log_id), [original.id]);
  assert.equal(next.listing.sale_price, "51000");
  assert.equal(next.listing.unit_number, "1504");
  assert.deepEqual(next.events.map((event) => event.work_log_id), [corrected.id]);
});

test("묶음 업무의 한 물건 제거는 그 매물만 정리하며 남은 물건은 수정 이력을 반영한다", async (t) => {
  database(t);
  const second = property({ buildingDong: "205", unitNumber: "802", salePrice: "40000" });
  const work = await mutate("POST", payload({ details: [property(), second] }));
  await mutate("PUT", payload({ workType: "매물수정", details: [{ ...second, salePrice: "39000" }], content: "합성 두 번째 물건만 유지" }), work.id);
  await history(key(), 404);
  const remaining = await history(key(second));
  assert.equal(remaining.events.length, 1);
  assert.equal(remaining.listing.sale_price, "39000");
  assert.equal(remaining.events[0].work_log_id, work.id);
});

test("매물 상태 업무를 일반 상담으로 정정하면 이력과 현재 매물도 함께 되돌린다", async (t) => {
  database(t);
  const first = await mutate("POST", payload({ workDate: "2026-09-12" }));
  const second = await mutate("POST", payload({ workType: "매물취소", details: [property({ salePrice: "0" })] }));
  await mutate("PUT", payload({ workType: "전화", content: "합성 상담 기록 정정", details: [property()] }), second.id);
  const result = await history();
  assert.equal(result.listing.closed_at, null);
  assert.equal(result.listing.status, "매물등록");
  assert.deepEqual(result.events.map((event) => event.work_log_id), [first.id]);
  const detail = await detailRoute.GET(new Request("https://synthetic.invalid/api/work-logs/example"), { params: Promise.resolve({ id: second.id }) });
  assert.equal((await detail.json()).workLog.work_type, "전화");
});

test("수정 중 투영 오류가 나면 고객·내용·금액·이력과 매물 모두 원상태를 유지한다", async (t) => {
  const db = database(t);
  const work = await mutate("POST", payload());
  const before = db.snapshot();
  db.failProjection();
  await mutate("PUT", payload({ customerId: "synthetic-other", content: "저장되면 안 되는 합성 변경", details: [property({ salePrice: "1" })] }), work.id, 500);
  assert.deepEqual(db.snapshot(), before);
});

test("삭제 중 투영 오류가 나면 업무·이력·매물을 어느 것도 삭제하지 않는다", async (t) => {
  const db = database(t);
  const work = await mutate("POST", payload());
  const before = db.snapshot();
  db.failProjection();
  await mutate("DELETE", undefined, work.id, 500);
  assert.deepEqual(db.snapshot(), before);
});

test("묶음 업무의 두 번째 매물 갱신 실패도 먼저 갱신한 매물을 포함해 전부 롤백한다", async (t) => {
  const db = database(t);
  const first = property();
  const second = property({ buildingDong: "205", unitNumber: "802" });
  const work = await mutate("POST", payload({ details: [first, second] }));
  const before = db.snapshot();
  db.failProjection((_sql, bindings) => bindings.includes(key(second)));
  await mutate("PUT", payload({ workType: "매물수정", details: [{ ...first, salePrice: "1" }, { ...second, salePrice: "2" }] }), work.id, 500);
  assert.deepEqual(db.snapshot(), before);
});

test("매물 현재값·이력은 동일 조회 묶음으로 읽고 신규 수정은 한 쓰기 묶음에 포함한다", async (t) => {
  const db = database(t);
  await mutate("POST", payload());
  const mutation = db.batches.find((batch) => batch.some((sql) => /INSERT INTO work_logs/.test(sql)));
  assert.ok(mutation.some((sql) => /INSERT INTO listing_events/.test(sql)));
  assert.ok(mutation.some((sql) => /INSERT INTO listings/.test(sql)));
  const before = db.batches.length;
  await history();
  const reads = db.batches.slice(before);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].length, 3);
  assert.match(reads[0][0], /SELECT \* FROM listings/);
  assert.match(reads[0][1], /FROM listing_events/);
});

test("불완전한 매물 수정 요청은 저장 전에 거절하고 기존 매물·이력을 유지한다", async (t) => {
  const db = database(t);
  const work = await mutate("POST", payload());
  const before = db.snapshot();
  await mutate("PUT", payload({ workType: "매물수정", details: [property({ unitNumber: "" })] }), work.id, 400);
  assert.deepEqual(db.snapshot(), before);
});

test("묶음 업무 상세는 업무 내용과 모든 물건을 같은 조회 묶음에서 순서대로 읽는다", async (t) => {
  const db = database(t);
  const work = await mutate("POST", payload({ details: [property(), property({ unitNumber: "1504" }), property({ unitNumber: "1505" })] }));
  const before = db.batches.length;
  const response = await detailRoute.GET(new Request("https://synthetic.invalid/api/work-logs/example"), { params: Promise.resolve({ id: work.id }) });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.workLog.content, "합성 최초 등록");
  assert.deepEqual(body.workLog.details.map((detail) => detail.unit_number), ["1503", "1504", "1505"]);
  assert.deepEqual(body.workLog.details.map((detail) => detail.sequence), [1, 2, 3]);
  assert.match(body.workLog.revision, /^[a-f0-9]{64}$/);
  assert.equal(db.batches.length - before, 1);
  assert.equal(db.batches.at(-1).length, 3);
});

test("매물 이력 API는 기존 이벤트 필드·업무일 정렬을 보존하며 연결 업무의 생성·저장 시각을 함께 반환한다", async (t) => {
  const db = database(t);
  const olderWork = await mutate("POST", payload({ workDate: "2026-09-01", content: "합성 이전 업무 추가 메모" }));
  const newerBusinessWork = await mutate("POST", payload({ workDate: "2026-09-15", workType: "매물수정", content: "합성 최신 업무일 메모" }));
  db.sqlite.prepare("UPDATE work_logs SET created_at='2026-09-01 01:00:00', updated_at='2026-09-13 08:52:25' WHERE id=?").run(olderWork.id);
  db.sqlite.prepare("UPDATE work_logs SET created_at='2026-09-12 01:00:00', updated_at='2026-09-12 01:00:00' WHERE id=?").run(newerBusinessWork.id);
  db.sqlite.prepare("UPDATE listing_events SET created_at='2026-09-01 01:00:01' WHERE work_log_id=?").run(olderWork.id);
  const before = db.snapshot();
  const response = await history();
  assert.deepEqual(db.snapshot(), before, "the expanded GET remains read-only");
  assert.deepEqual(response.events.map((event) => event.work_log_id), [newerBusinessWork.id, olderWork.id]);
  for (const event of response.events) {
    const stored = before.listing_events.find((row) => row.id === event.id);
    const work = before.work_logs.find((row) => row.id === event.work_log_id);
    for (const [field, value] of Object.entries(stored)) assert.equal(event[field], value, `existing event field ${field} remains unchanged`);
    assert.equal(event.work_created_at, work.created_at);
    assert.equal(event.work_updated_at, work.updated_at);
    assert.equal(event.customer_id, work.customer_id);
    assert.equal(event.customer_name, "합성 고객 가");
  }
  const edited = response.events[1];
  assert.equal(edited.created_at, "2026-09-01 01:00:01", "event creation time is not overwritten by the work timestamp alias");
  assert.equal(edited.work_created_at, "2026-09-01 01:00:00");
  assert.equal(edited.work_updated_at, "2026-09-13 08:52:25");
  assert.equal(formatHistoryTimestamp(edited.work_updated_at), "2026.09.13 17:52");
  assert.equal(latestSavedListingEvent(response.events), edited, "latest save is independent from the first business-date row");
});

test("과거 업무를 정정하면 이력 업무일을 바꾸거나 새 기록을 늘리지 않고 최근 저장 시각을 전달한다", async (t) => {
  const db = database(t);
  const work = await mutate("POST", payload({ workDate: "2026-09-01" }));
  db.sqlite.prepare("UPDATE work_logs SET created_at='2026-09-01 01:00:00', updated_at='2026-09-01 01:00:00' WHERE id=?").run(work.id);
  const before = await history();
  await mutate("PUT", payload({ workDate: "2026-09-01", content: "합성 추가 연락 메모" }), work.id);
  const response = await history();
  const saved = db.sqlite.prepare("SELECT created_at, updated_at FROM work_logs WHERE id=?").get(work.id);
  assert.equal(response.events.length, 1);
  assert.equal(response.events[0].event_date, "2026-09-01");
  assert.equal(response.events[0].event_order, before.events[0].event_order);
  assert.equal(response.events[0].notes, "합성 추가 연락 메모");
  assert.equal(response.events[0].work_created_at, "2026-09-01 01:00:00");
  assert.equal(response.events[0].work_updated_at, saved.updated_at);
  assert.notEqual(response.events[0].work_updated_at, before.events[0].work_updated_at);
  assert.ok(formatHistoryTimestamp(response.events[0].work_updated_at));
});
