import assert from "node:assert/strict";
import { attachTestSession } from "./helpers/security-session.mjs";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";
import { handleSecurityRequest, schedulePostMutationBackup } from "../worker/security.ts";

// All records, customer names, addresses and prices below are synthetic. Execute
// the real stores/routes and deployed migrations, never a hosted DB or account.
const root = new URL("../", import.meta.url);
const roots = [new URL("app/", root).href, new URL("db/", root).href];
const bindingKey = "jipjangbu-deletion-safety-db";
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
      return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText };
    }
    return nextLoad(url, context);
  },
});
const [deletion, workData, followups, workRoute, workDetailRoute, listingRoute, historyRoute, previewRoute, trashRoute, trashDetailRoute, restoreRoute, customerDetailRoute] = await Promise.all([
  import("../db/deletion-store.ts"), import("../app/api/work-logs/data.ts"), import("../app/api/follow-ups/_store.ts"),
  import("../app/api/work-logs/route.ts"), import("../app/api/work-logs/[id]/route.ts"),
  import("../app/api/listings/route.ts"), import("../app/api/listings/[key]/route.ts"),
  import("../app/api/deletions/preview/route.ts"), import("../app/api/trash/route.ts"),
  import("../app/api/trash/[id]/route.ts"), import("../app/api/trash/[id]/restore/route.ts"),
  import("../app/api/customers/[id]/route.ts"),
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
  sqlite.prepare("INSERT INTO customers (id,name,notes) VALUES (?,?,?)").run("synthetic-customer", "합성 삭제검증 고객", "합성 고객 메모");
  for (const name of ["매물등록", "매물수정", "매물취소", "계약작성", "전화"]) sqlite.prepare("INSERT INTO work_types(name) VALUES (?)").run(name);
  let failure = null;
  let race = null;
  const batches = [];
  const db = {
    prepare(sql) {
      const query = sqlite.prepare(sql);
      let values = [];
      const execute = () => {
        if (failure?.(sql, values)) throw new Error("Synthetic deletion transaction failure");
        if (query.columns().length) return { results: query.all(...values), success: true, meta: { changes: 0 } };
        const result = query.run(...values);
        return { results: [], success: true, meta: { changes: Number(result.changes) } };
      };
      return {
        bind(...bindings) { values = bindings; return this; },
        async first(column) { const row = execute().results[0]; return column ? row?.[column] ?? null : row ?? null; },
        async all() { return execute(); },
        async run() { return execute(); },
        sql, execute,
      };
    },
    async batch(statements) {
      const sqls = statements.map((statement) => statement.sql);
      batches.push(sqls);
      if (race?.matches(sqls)) { const action = race.action; race = null; action(); }
      sqlite.exec("SAVEPOINT deletion_test_batch");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("RELEASE SAVEPOINT deletion_test_batch");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK TO SAVEPOINT deletion_test_batch");
        sqlite.exec("RELEASE SAVEPOINT deletion_test_batch");
        throw error;
      }
    },
  };
  globalThis[Symbol.for(bindingKey)] = db;
  t.mock.method(console, "error", () => {});
  t.after(() => { sqlite.close(); delete globalThis[Symbol.for(bindingKey)]; });
  const tables = ["customers", "work_logs", "work_log_properties", "listing_events", "listings", "follow_ups", "trash_records"];
  return {
    db, sqlite, batches,
    fail(predicate) { failure = predicate; },
    clearFailure() { failure = null; },
    raceBeforeWrite(action, statementPattern = /INSERT INTO trash_records/i) { race = { matches: (sqls) => sqls.some((sql) => statementPattern.test(sql)), action }; },
    snapshot() { return Object.fromEntries(tables.map((table) => [table, sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])); },
  };
}

const property = (overrides = {}) => ({ propertyType: "아파트", buildingName: "합성삭제단지", buildingDong: "101", unitNumber: "202", sizeType: "33", salePrice: "55000", jeonsePrice: "30000", monthlyRent: "", source: "합성 업소", ...overrides });
const key = (detail = property()) => [detail.propertyType, detail.buildingName, detail.buildingDong, detail.unitNumber].join("|");
const payload = (overrides = {}) => ({ workDate: "2026-09-14", customerId: "synthetic-customer", workType: "매물등록", content: "합성 삭제 대상 메모", details: [property()], ...overrides });
const createWork = (overrides) => workData.saveWorkLog(payload(overrides));
const row = (db, table, id) => db.sqlite.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
async function move(db, type, id) {
  const preview = await deletion.getDeletionPreview(db.db, type, id);
  return deletion.moveToTrash(db.db, type, id, preview.revision);
}
const rejectsStatus = (promise, status) => assert.rejects(promise, (error) => error instanceof deletion.DeletionError && error.status === status);
async function history(identity = key(), status = 200) {
  const response = await historyRoute.GET(new Request("https://synthetic.invalid/api/listings/example"), { params: Promise.resolve({ key: encodeURIComponent(identity) }) });
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}

test("휴지통 영구 삭제는 확인한 스냅샷만 제거하며 현재 기록과 다른 휴지통은 보존한다", async (t) => {
  const db = database(t);
  const first = await createWork();
  const removed = await move(db,"work",first.id);
  const second = await createWork({content:"보존할 업무"});
  const before = db.snapshot();
  const detail = await deletion.getTrashDetail(db.db, removed.trashId);
  await rejectsStatus(deletion.permanentlyDeleteTrash(db.db,removed.trashId,"wrong"),409);
  assert.deepEqual(db.snapshot(),before);
  const params = {params:Promise.resolve({id:removed.trashId})};
  const request = revision => new Request("https://synthetic.invalid/api/trash/example", {method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({revision})});
  assert.equal((await trashDetailRoute.DELETE(request(undefined),params)).status,409);
  assert.equal((await trashDetailRoute.DELETE(request(detail.preview.revision),params)).status,200);
  assert.ok(row(db,"work_logs",second.id));
  assert.deepEqual({...db.snapshot(),trash_records:before.trash_records},before);
  assert.equal(db.snapshot().trash_records.length,0);
  await rejectsStatus(deletion.restoreTrash(db.db,removed.trashId),404);
  assert.equal((await trashDetailRoute.DELETE(request(detail.preview.revision),params)).status,404);
});

test("복구된 휴지통 항목에 뒤늦게 영구 삭제를 요청해도 복구된 원본은 지우지 않는다", async t => {
  const db=database(t), work=await createWork(), removed=await move(db,"work",work.id);
  const detail=await deletion.getTrashDetail(db.db,removed.trashId);
  await deletion.restoreTrash(db.db,removed.trashId);
  const before=db.snapshot();
  await rejectsStatus(deletion.permanentlyDeleteTrash(db.db,removed.trashId,detail.preview.revision),404);
  assert.deepEqual(db.snapshot(),before);
});

test("휴지통 일괄 삭제는 선택한 기록만 삭제하고 잘못된 확인은 전부 보존한다", async t => {
  const db = database(t), entries = [];
  for (let i = 0; i < 3; i++) {
    const work = await createWork({ content: `일괄 삭제 합성 ${i}` });
    const removed = await move(db, "work", work.id);
    const detail = await deletion.getTrashDetail(db.db, removed.trashId);
    entries.push({ id: removed.trashId, revision: detail.preview.revision });
  }
  const before = db.snapshot();
  await rejectsStatus(deletion.permanentlyDeleteTrashBatch(db.db, []), 400);
  await rejectsStatus(deletion.permanentlyDeleteTrashBatch(db.db, [entries[0], entries[0]]), 400);
  await rejectsStatus(deletion.permanentlyDeleteTrashBatch(db.db, [entries[0], { ...entries[1], revision: "stale" }]), 409);
  await rejectsStatus(deletion.permanentlyDeleteTrashBatch(db.db, [entries[0], { id: "missing", revision: "missing" }]), 409);
  assert.deepEqual(db.snapshot(), before);
  const racingDb = { prepare(sql) {
    const statement = db.db.prepare(sql);
    if (sql.startsWith("WITH targets")) {
      const run = statement.run;
      statement.run = async () => {
        db.sqlite.prepare("UPDATE trash_records SET deleted_at = ? WHERE id = ?").run("changed", entries[1].id);
        return run.call(statement);
      };
    }
    return statement;
  } };
  await rejectsStatus(deletion.permanentlyDeleteTrashBatch(racingDb, entries.slice(0, 2)), 409);
  assert.equal(db.snapshot().trash_records.length, 3);
  db.sqlite.prepare("UPDATE trash_records SET deleted_at = ? WHERE id = ?").run(before.trash_records.find(r => r.id === entries[1].id).deleted_at, entries[1].id);
  const response = await trashRoute.DELETE(new Request("https://synthetic.invalid/api/trash", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entries: entries.slice(0, 2) }) }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deletedCount, 2);
  assert.deepEqual(db.snapshot().trash_records.map(r => r.id), [entries[2].id]);
  assert.deepEqual({ ...db.snapshot(), trash_records: before.trash_records }, before);
});

test("삭제 미리보기는 저장된 내용·모든 연결 매물·영향을 읽기 전용으로 제공한다", async (t) => {
  const db = database(t);
  const second = property({ buildingDong: "202", unitNumber: "303" });
  const work = await createWork({ details: [property(), second] });
  const before = db.snapshot();
  const preview = await deletion.getDeletionPreview(db.db, "work", work.id);
  assert.equal(preview.type, "work");
  assert.equal(preview.id, work.id);
  assert.equal(preview.content, work.content);
  assert.equal(preview.blockedReason, null);
  assert.deepEqual(new Set(preview.affectedListings.map((item) => item.key)), new Set([key(), key(second)]));
  assert.ok(preview.affectedListings.every((item) => item.label));
  assert.ok(preview.warnings.length > 0);
  assert.equal(typeof preview.revision, "string");
  assert.ok(preview.revision.length > 10);
  assert.deepEqual(db.snapshot(), before);
});

test("여러 매물 업무는 한 번에 휴지통으로 이동하고 원래 ID·순서·본문으로 복구한다", async (t) => {
  const db = database(t);
  const second = property({ buildingDong: "202", unitNumber: "303", salePrice: "43000" });
  const work = await createWork({ details: [property(), second] });
  const before = db.snapshot();
  const removed = await move(db, "work", work.id);
  assert.equal(removed.ok, true);
  assert.equal(row(db, "work_logs", work.id), undefined);
  for (const table of ["work_log_properties", "listing_events", "listings"]) assert.equal(db.snapshot()[table].length, 0);
  assert.deepEqual(db.snapshot().customers, before.customers, "deleting a work does not delete its customer");
  assert.equal((await workRoute.GET(new Request("https://synthetic.invalid/api/work-logs?customerId=synthetic-customer"))).status, 200);
  const customerWorks = await (await workRoute.GET(new Request("https://synthetic.invalid/api/work-logs?customerId=synthetic-customer"))).json();
  assert.equal(customerWorks.total, 0);
  await history(key(), 404);
  await history(key(second), 404);
  const stored = await deletion.getTrashDetail(db.db, removed.trashId);
  assert.equal(stored.item.entityId, work.id);
  assert.equal(stored.preview.content, work.content);
  assert.equal(stored.preview.affectedListings.length, 2);
  const restored = await deletion.restoreTrash(db.db, removed.trashId);
  assert.deepEqual(restored, { ok: true, type: "work", entityId: work.id });
  for (const table of ["work_logs", "work_log_properties", "listing_events"]) assert.deepEqual(db.snapshot()[table], before[table], table);
  assert.equal((await history()).listing.sale_price, "55000");
  assert.equal((await history(key(second))).listing.sale_price, "43000");
  assert.equal((await deletion.getTrash(db.db, new URLSearchParams())).total, 0);
  await rejectsStatus(deletion.restoreTrash(db.db, removed.trashId), 404);
});

test("최신 종료 업무 삭제는 이전 가격으로 되돌리고 과거 업무 복구는 더 최신 가격을 덮지 않는다", async (t) => {
  const db = database(t);
  const first = await createWork({ workDate: "2026-09-01" });
  const cancelled = await createWork({ workDate: "2026-09-12", workType: "매물취소", content: "합성 취소 메모", details: [property({ salePrice: "0" })] });
  assert.equal((await history()).listing.closed_at, "2026-09-12");
  const removed = await move(db, "work", cancelled.id);
  const previous = await history();
  assert.equal(previous.listing.status, "매물등록");
  assert.equal(previous.listing.sale_price, "55000");
  assert.equal(previous.listing.closed_at, null);
  const newer = await createWork({ workDate: "2026-09-14", workType: "매물수정", content: "합성 새로운 가격", details: [property({ salePrice: "51000" })] });
  await deletion.restoreTrash(db.db, removed.trashId);
  const result = await history();
  assert.deepEqual(result.events.map((event) => event.work_log_id), [newer.id, cancelled.id, first.id]);
  assert.equal(result.listing.sale_price, "51000");
  assert.equal(result.listing.status, "매물수정");
  assert.equal(result.listing.closed_at, null);
});

test("삭제한 엑셀 업무가 원본 메모·검색으로 재등장하지 않고 다른 원본 메모와 복구 원문은 보존한다", async (t) => {
  const db = database(t);
  await createWork({ workDate: "2026-09-01", content: "합성 유지 메모" });
  const wrong = await createWork({ workDate: "2026-09-12", workType: "매물수정", content: "합성삭제전용오입력", details: [property({ salePrice: "54000" })] });
  const retained = "  합성 별도 보관 특약 <확인> (매물수정)(2020-01-01)\n원본 전용 끝 메모  ";
  const original = `합성삭제전용오입력(매물수정)(2026-09-12)\n합성 유지 메모(매물등록)(2026-09-01)\n${retained}`;
  db.sqlite.prepare("UPDATE listings SET source_notes=? WHERE identity_key=?").run(original, key());
  const removed = await move(db, "work", wrong.id);
  const result = await history();
  assert.doesNotMatch(result.listing.source_notes, /합성삭제전용오입력/);
  assert.doesNotMatch(result.listing.notes, /합성삭제전용오입력/);
  assert.ok(result.listing.source_notes.includes(retained));
  assert.match(result.listing.source_notes, /합성 유지 메모/);
  const search = await listingRoute.GET(new Request("https://synthetic.invalid/api/listings?q=합성삭제전용오입력"));
  assert.equal((await search.json()).listings.length, 0);
  await deletion.restoreTrash(db.db, removed.trashId);
  const restored = await history();
  assert.match(restored.listing.source_notes, /합성삭제전용오입력/);
  assert.ok(restored.listing.source_notes.includes(retained));
  assert.equal(restored.events.find((event) => event.work_log_id === wrong.id).notes, "합성삭제전용오입력");
});

test("업무일·종별이 같아도 본문이 다른 원본 전용 메모는 삭제에 딸려 없어지지 않는다", async (t) => {
  const db = database(t);
  await createWork({ workDate: "2026-09-01", content: "합성 유지 업무" });
  const wrong = await createWork({ workDate: "2026-09-12", workType: "매물수정", content: "합성 오입력 업무 내용" });
  const sourceOnly = "  업무와 다른 원본 전용 특약 <보관>\n확인 필요 (매물수정)(2026-09-12)  ";
  db.sqlite.prepare("UPDATE listings SET source_notes=? WHERE identity_key=?").run(sourceOnly, key());
  await move(db, "work", wrong.id);
  const result = await history();
  assert.equal(result.listing.source_notes, sourceOnly);
  assert.ok(result.listing.notes.includes(sourceOnly));
  assert.doesNotMatch(result.listing.notes, /합성 오입력 업무 내용/);
});

test("원본 전용 앞줄과 삭제 업무 본문이 붙어 있어도 앞줄은 보존하고 해당 업무 부분만 숨긴다", async (t) => {
  const db = database(t);
  await createWork({ workDate: "2026-09-01", content: "합성 유지 업무" });
  const wrong = await createWork({ workDate: "2026-09-12", workType: "매물수정", content: "합성 삭제할 잘못된 메모" });
  const prefix = "  별도 원본 공통 규칙 <보관>  \r\n";
  const tail = "\n합성 원본 전용 뒷줄  ";
  db.sqlite.prepare("UPDATE listings SET source_notes=? WHERE identity_key=?").run(`${prefix}합성 삭제할 잘못된 메모(매물수정)(2026-09-12)${tail}`, key());
  const removed = await move(db, "work", wrong.id);
  const result = await history();
  assert.equal(result.listing.source_notes, prefix + tail);
  assert.doesNotMatch(result.listing.notes, /합성 삭제할 잘못된 메모/);
  await deletion.restoreTrash(db.db, removed.trashId);
  const restored = await history();
  assert.match(restored.listing.source_notes, /별도 원본 공통 규칙/);
  assert.match(restored.listing.source_notes, /합성 삭제할 잘못된 메모/);
  assert.match(restored.listing.source_notes, /합성 원본 전용 뒷줄/);
});

test("마지막 매물 업무를 삭제해도 원본을 휴지통에 보존하고 새 원본 메모를 덮지 않으며 복구한다", async (t) => {
  const db = database(t);
  const work = await createWork();
  const source = "합성 최초 원문(매물등록)(2026-09-14)\n별도 계약 특약";
  db.sqlite.prepare("UPDATE listings SET source_notes=? WHERE identity_key=?").run(source, key());
  const removed = await move(db, "work", work.id);
  await history(key(), 404);
  assert.ok(JSON.stringify(row(db, "trash_records", removed.trashId)).includes("별도 계약 특약"));
  const newer = await createWork({ workDate: "2026-09-15", content: "새로 등록한 업무", details: [property({ salePrice: "49000" })] });
  db.sqlite.prepare("UPDATE listings SET source_notes=? WHERE identity_key=?").run("새로 추가한 원본 메모", key());
  await deletion.restoreTrash(db.db, removed.trashId);
  const result = await history();
  assert.match(result.listing.source_notes, /합성 최초 원문/);
  assert.match(result.listing.source_notes, /별도 계약 특약/);
  assert.match(result.listing.source_notes, /새로 추가한 원본 메모/);
  assert.equal(result.listing.sale_price, "49000");
  assert.equal(result.events[0].work_log_id, newer.id);
});

test("삭제 확인값 누락·잘못된 확인값·없는 대상·중복 삭제는 자료를 변경하지 않는다", async (t) => {
  const db = database(t);
  const work = await createWork();
  const preview = await deletion.getDeletionPreview(db.db, "work", work.id);
  const before = db.snapshot();
  for (const revision of [undefined, null, "", "malformed-confirmation"]) await rejectsStatus(deletion.moveToTrash(db.db, "work", work.id, revision), 400);
  await rejectsStatus(deletion.moveToTrash(db.db, "work", work.id, "0".repeat(64)), 409);
  await rejectsStatus(deletion.getDeletionPreview(db.db, "work", "missing"), 404);
  assert.deepEqual(db.snapshot(), before);
  await deletion.moveToTrash(db.db, "work", work.id, preview.revision);
  const removed = db.snapshot();
  await rejectsStatus(deletion.moveToTrash(db.db, "work", work.id, preview.revision), 404);
  assert.deepEqual(db.snapshot(), removed);
});

test("같은 초의 업무 본문·물건 변경도 삭제 확인값을 무효화한다", async (t) => {
  const db = database(t);
  const work = await createWork();
  const first = await deletion.getDeletionPreview(db.db, "work", work.id);
  const timestamp = row(db, "work_logs", work.id).updated_at;
  db.sqlite.prepare("UPDATE work_logs SET content=? WHERE id=?").run("다른 기기에서 같은 초 수정", work.id);
  assert.equal(row(db, "work_logs", work.id).updated_at, timestamp);
  const afterContent = db.snapshot();
  await rejectsStatus(deletion.moveToTrash(db.db, "work", work.id, first.revision), 409);
  assert.deepEqual(db.snapshot(), afterContent);
  const second = await deletion.getDeletionPreview(db.db, "work", work.id);
  assert.notEqual(second.revision, first.revision);
  db.sqlite.prepare("UPDATE work_log_properties SET unit_number='909' WHERE work_log_id=?").run(work.id);
  const afterDetail = db.snapshot();
  await rejectsStatus(deletion.moveToTrash(db.db, "work", work.id, second.revision), 409);
  assert.deepEqual(db.snapshot(), afterDetail);
});

test("미리보기 검증과 삭제 배치 사이에 다른 기기가 저장한 업무도 원자적으로 보호한다", async (t) => {
  const db = database(t);
  const work = await createWork();
  const preview = await deletion.getDeletionPreview(db.db, "work", work.id);
  let concurrentState;
  db.raceBeforeWrite(() => {
    db.sqlite.prepare("UPDATE work_logs SET content=? WHERE id=?").run("검증 뒤 경합으로 저장한 내용", work.id);
    concurrentState = db.snapshot();
  });
  await rejectsStatus(deletion.moveToTrash(db.db, "work", work.id, preview.revision), 409);
  assert.ok(concurrentState, "the injected write must occur immediately before the deletion transaction");
  assert.deepEqual(db.snapshot(), concurrentState);
});

test("삭제 도중 휴지통 저장·두 번째 매물 재계산 실패는 전체 작업을 롤백한다", async (t) => {
  const db = database(t);
  const second = property({ unitNumber: "303" });
  const work = await createWork({ details: [property(), second] });
  for (const fail of [
    (sql) => /INSERT INTO trash_records/i.test(sql),
    (sql, values) => /(?:DELETE FROM|INSERT INTO) listings\b/i.test(sql) && values.includes(key(second)),
  ]) {
    const before = db.snapshot();
    db.fail(fail);
    await assert.rejects(move(db, "work", work.id));
    assert.deepEqual(db.snapshot(), before);
    db.clearFailure();
  }
  const removed = await move(db, "work", work.id);
  assert.ok(removed.trashId);
  assert.equal((await deletion.getTrash(db.db, new URLSearchParams())).total, 1);
});

test("복구 도중 매물 재계산 실패는 휴지통과 활성 기록 모두 원상태를 유지한다", async (t) => {
  const db = database(t);
  const work = await createWork();
  const removed = await move(db, "work", work.id);
  const before = db.snapshot();
  db.fail((sql) => /INSERT INTO listings\b/i.test(sql));
  await assert.rejects(deletion.restoreTrash(db.db, removed.trashId));
  assert.deepEqual(db.snapshot(), before);
  db.clearFailure();
  await deletion.restoreTrash(db.db, removed.trashId);
  assert.equal(row(db, "work_logs", work.id).content, work.content);
});

test("이미 존재하는 동일 ID는 복구가 덮어쓰지 않으며 원본은 휴지통에 남는다", async (t) => {
  const db = database(t);
  const work = await createWork();
  const removed = await move(db, "work", work.id);
  db.sqlite.prepare("INSERT INTO work_logs(id,work_date,customer_id,work_type,content) VALUES (?,?,?,?,?)").run(work.id, "2026-09-15", "synthetic-customer", "전화", "동일 ID의 현재 기록");
  const before = db.snapshot();
  await rejectsStatus(deletion.restoreTrash(db.db, removed.trashId), 409);
  assert.deepEqual(db.snapshot(), before);
});

test("복구 상태 확인 뒤 같은 ID가 생기는 경합도 새 기록과 휴지통을 그대로 보존한다", async (t) => {
  const db = database(t);
  const work = await createWork();
  const removed = await move(db, "work", work.id);
  let concurrentState;
  db.raceBeforeWrite(() => {
    db.sqlite.prepare("INSERT INTO work_logs(id,work_date,customer_id,work_type,content) VALUES (?,?,?,?,?)").run(work.id, "2026-09-15", "synthetic-customer", "전화", "복구 직전 새로 생긴 현재 기록");
    concurrentState = db.snapshot();
  }, /INSERT INTO work_logs/i);
  await rejectsStatus(deletion.restoreTrash(db.db, removed.trashId), 409);
  assert.ok(concurrentState, "the conflicting work must be inserted after restore state validation");
  assert.deepEqual(db.snapshot(), concurrentState);
});

test("한 매물의 여러 삭제 중 일부만 복구하면 아직 휴지통에 있는 업무의 원문은 재등장하지 않는다", async (t) => {
  const db = database(t);
  const first = await createWork({ workDate: "2026-09-01", content: "합성 첫 번째 원문" });
  const second = await createWork({ workDate: "2026-09-12", workType: "매물수정", content: "합성 두 번째 원문" });
  db.sqlite.prepare("UPDATE listings SET source_notes=? WHERE identity_key=?").run("합성 두 번째 원문(매물수정)(2026-09-12)\n합성 첫 번째 원문(매물등록)(2026-09-01)\n합성 오래된 별도 메모", key());
  const firstRemoved = await move(db, "work", first.id);
  const secondRemoved = await move(db, "work", second.id);
  await history(key(), 404);
  await deletion.restoreTrash(db.db, firstRemoved.trashId);
  const partial = await history();
  assert.equal(partial.events.length, 1);
  assert.equal(partial.events[0].work_log_id, first.id);
  assert.doesNotMatch(partial.listing.source_notes, /합성 두 번째 원문/);
  assert.doesNotMatch(partial.listing.notes, /합성 두 번째 원문/);
  assert.match(partial.listing.source_notes, /합성 오래된 별도 메모/);
  await deletion.restoreTrash(db.db, secondRemoved.trashId);
  const full = await history();
  assert.deepEqual(full.events.map((event) => event.work_log_id), [second.id, first.id]);
  assert.match(full.listing.source_notes, /합성 첫 번째 원문/);
  assert.match(full.listing.source_notes, /합성 두 번째 원문/);
});

test("복구에 필요한 고객이 외부 변경으로 없어진 경우 연결을 임의 생성하거나 유실하지 않는다", async (t) => {
  const db = database(t);
  const work = await createWork();
  const removed = await move(db, "work", work.id);
  db.sqlite.prepare("DELETE FROM customers WHERE id=?").run("synthetic-customer");
  const before = db.snapshot();
  await rejectsStatus(deletion.restoreTrash(db.db, removed.trashId), 409);
  assert.deepEqual(db.snapshot(), before);
});

test("활성 업무와 휴지통 업무의 고객은 삭제를 막아 복구 관계를 보존한다", async (t) => {
  const db = database(t);
  const work = await createWork();
  for (const state of ["active", "trash"]) {
    if (state === "trash") await move(db, "work", work.id);
    const preview = await deletion.getDeletionPreview(db.db, "customer", "synthetic-customer");
    assert.ok(preview.blockedReason, state);
    const before = db.snapshot();
    await rejectsStatus(deletion.moveToTrash(db.db, "customer", "synthetic-customer", preview.revision), 409);
    assert.deepEqual(db.snapshot(), before);
  }
});

test("고객 삭제 확인 뒤 새 연결 업무가 생기는 경합은 고객·새 업무를 모두 보존한다", async (t) => {
  const db = database(t);
  const preview = await deletion.getDeletionPreview(db.db, "customer", "synthetic-customer");
  assert.equal(preview.blockedReason, null);
  let concurrentState;
  db.raceBeforeWrite(() => {
    db.sqlite.prepare("INSERT INTO work_logs(id,work_date,customer_id,work_type,content) VALUES (?,?,?,?,?)").run("synthetic-concurrent-work", "2026-09-15", "synthetic-customer", "전화", "고객 삭제 직전 연결된 업무");
    concurrentState = db.snapshot();
  });
  await rejectsStatus(deletion.moveToTrash(db.db, "customer", "synthetic-customer", preview.revision), 409);
  assert.ok(concurrentState, "the new dependency must be created immediately before the customer deletion transaction");
  assert.deepEqual(db.snapshot(), concurrentState);
});

test("활성 할 일과 휴지통 할 일의 고객도 삭제 차단 대상이다", async (t) => {
  const db = database(t);
  const item = await followups.createFollowUp(db.db, { title: "합성 연결된 확인", customerId: "synthetic-customer" });
  for (const state of ["active", "trash"]) {
    if (state === "trash") await move(db, "followup", item.id);
    const preview = await deletion.getDeletionPreview(db.db, "customer", "synthetic-customer");
    assert.ok(preview.blockedReason, state);
    await rejectsStatus(deletion.moveToTrash(db.db, "customer", "synthetic-customer", preview.revision), 409);
    assert.ok(row(db, "customers", "synthetic-customer"));
  }
});

test("연결 없는 고객은 이름·메모·생성시각·ID를 그대로 삭제·복구한다", async (t) => {
  const db = database(t);
  const before = row(db, "customers", "synthetic-customer");
  const preview = await deletion.getDeletionPreview(db.db, "customer", before.id);
  assert.equal(preview.blockedReason, null);
  const removed = await deletion.moveToTrash(db.db, "customer", before.id, preview.revision);
  assert.equal(row(db, "customers", before.id), undefined);
  const detail = await deletion.getTrashDetail(db.db, removed.trashId);
  assert.match(detail.preview.title, /합성 삭제검증 고객/);
  assert.match(detail.preview.content, /합성 고객 메모/);
  await deletion.restoreTrash(db.db, removed.trashId);
  assert.deepEqual(row(db, "customers", before.id), before);
});

test("할 일은 완료일·기한·고객·사라진 매물 연결까지 원래대로 삭제·복구한다", async (t) => {
  const db = database(t);
  await createWork();
  const item = await followups.createFollowUp(db.db, { title: "합성 100% 확인", notes: "완료한 일의 보관 메모", dueDate: "2026-09-20", customerId: "synthetic-customer", listingKey: key() });
  await followups.updateFollowUp(db.db, item.id, { completed: true });
  const before = row(db, "follow_ups", item.id);
  const removed = await move(db, "followup", item.id);
  assert.equal((await followups.getFollowUps(db.db, new URLSearchParams("status=all"))).items.length, 0);
  db.sqlite.prepare("DELETE FROM listings WHERE identity_key=?").run(key());
  await deletion.restoreTrash(db.db, removed.trashId);
  assert.deepEqual(row(db, "follow_ups", item.id), before);
  const restored = await followups.getFollowUp(db.db, item.id);
  assert.equal(restored.listing_key, key());
  assert.equal(restored.listing_label, null);
  assert.ok(restored.completed_at);
});

test("휴지통 목록은 종류·검색·쪽을 지원하고 내부 복구 스냅샷은 노출하지 않는다", async (t) => {
  const db = database(t);
  const first = await followups.createFollowUp(db.db, { title: "합성 100% 확인" });
  const second = await followups.createFollowUp(db.db, { title: "합성 일반 확인" });
  await move(db, "followup", first.id);
  await move(db, "followup", second.id);
  await move(db, "customer", "synthetic-customer");
  const result = await deletion.getTrash(db.db, new URLSearchParams());
  assert.equal(result.total, 3);
  for (const item of result.items) assert.deepEqual(Object.keys(item).sort(), ["id", "type", "entityId", "title", "subtitle", "deletedAt"].sort());
  assert.equal((await deletion.getTrash(db.db, new URLSearchParams("type=customer"))).total, 1);
  const escaped = await deletion.getTrash(db.db, new URLSearchParams("type=followup&q=%25"));
  assert.deepEqual(escaped.items.map((item) => item.entityId), [first.id]);
  const page = await deletion.getTrash(db.db, new URLSearchParams("limit=1&offset=1"));
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, result.items[1].id);
  assert.equal(page.limit, 1);
  assert.equal(page.offset, 1);
  for (const query of ["type=listing", `q=${"x".repeat(201)}`, "offset=-1"]) await rejectsStatus(deletion.getTrash(db.db, new URLSearchParams(query)), 400);
});

test("삭제 미리보기·DELETE·휴지통 상세·복구 API는 확인값과 오류 상태를 일관되게 전달한다", async (t) => {
  const db = database(t);
  const work = await createWork();
  const params = { params: Promise.resolve({ id: work.id }) };
  const previewResponse = await previewRoute.GET(new Request(`https://synthetic.invalid/api/deletions/preview?type=work&id=${work.id}`));
  assert.equal(previewResponse.status, 200);
  const { preview } = await previewResponse.json();
  assert.equal(preview.content, work.content);
  const missing = await workDetailRoute.DELETE(new Request(`https://synthetic.invalid/api/work-logs/${work.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" }), params);
  assert.equal(missing.status, 400);
  assert.ok(row(db, "work_logs", work.id));
  const removedResponse = await workDetailRoute.DELETE(new Request(`https://synthetic.invalid/api/work-logs/${work.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: preview.revision }) }), params);
  assert.equal(removedResponse.status, 200);
  const removed = await removedResponse.json();
  const trashParams = { params: Promise.resolve({ id: removed.trashId }) };
  const list = await trashRoute.GET(new Request("https://synthetic.invalid/api/trash?type=work"));
  assert.equal(list.status, 200);
  assert.equal((await list.json()).total, 1);
  const detail = await trashDetailRoute.GET(new Request(`https://synthetic.invalid/api/trash/${removed.trashId}`), trashParams);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).preview.content, work.content);
  const restored = await restoreRoute.POST(new Request(`https://synthetic.invalid/api/trash/${removed.trashId}/restore`, { method: "POST" }), trashParams);
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).entityId, work.id);
  const gone = await trashDetailRoute.GET(new Request(`https://synthetic.invalid/api/trash/${removed.trashId}`), trashParams);
  assert.equal(gone.status, 404);
});

function securityFixture(db) {
  const writes = [], pending = [];
  const env = {
    DB: db.db, APP_ADMIN_USERNAME: "synthetic-admin", APP_SESSION_SECRET: "33".repeat(32),
    BACKUP_ENCRYPTION_KEY: "22".repeat(32),
    BACKUPS: { async put(key, value, options) { writes.push({ key, value, options }); } },
  };
  const token = attachTestSession(env);
  const request = (path, method, headers = {}) => new Request(`https://synthetic.invalid${path}`, {
    method, headers: { Cookie: `jipjangbu_session=${token}`, Origin: "https://synthetic.invalid", ...headers },
  });
  return { env, writes, pending, request, ctx: { waitUntil(promise) { pending.push(promise); } } };
}

test("삭제·복구 전후 암호화 백업은 휴지통 스냅샷과 활성 자료를 함께 보존한다", async (t) => {
  const db = database(t);
  const work = await createWork();
  const { env, writes, pending, request, ctx } = securityFixture(db);
  const removeRequest = request(`/api/work-logs/${work.id}`, "DELETE");
  assert.equal(await handleSecurityRequest(removeRequest, env, ctx), null);
  const removed = await move(db, "work", work.id);
  schedulePostMutationBackup(removeRequest, new Response(null, { status: 200 }), env, ctx);
  await Promise.all(pending);
  const restoreRequest = request(`/api/trash/${removed.trashId}/restore`, "POST");
  assert.equal(await handleSecurityRequest(restoreRequest, env, ctx), null);
  await deletion.restoreTrash(db.db, removed.trashId);
  schedulePostMutationBackup(restoreRequest, new Response(null, { status: 200 }), env, ctx);
  await Promise.all(pending);
  assert.equal(writes.length, 4);
  const encryptionKey = await crypto.subtle.importKey("raw", Buffer.from(env.BACKUP_ENCRYPTION_KEY, "hex"), "AES-GCM", false, ["decrypt"]);
  const snapshots = [];
  for (const write of writes) {
    assert.deepEqual([...write.value.slice(0, 4)], [0x4a, 0x4a, 0x42, 0x31]);
    const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: write.value.slice(4, 16) }, encryptionKey, write.value.slice(16));
    snapshots.push(JSON.parse(new TextDecoder().decode(clear)));
  }
  assert.deepEqual(snapshots.map((snapshot) => snapshot.counts.trash_records), [0, 1, 1, 0]);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.counts.work_logs), [1, 0, 0, 1]);
  assert.equal(snapshots[1].tables.trash_records[0].entity_id, work.id);
  assert.equal(JSON.parse(snapshots[1].tables.trash_records[0].snapshot).work.content, work.content);
  assert.equal(snapshots[3].tables.work_logs[0].id, work.id);
  assert.deepEqual(writes.map((write) => write.options.customMetadata.reason), ["pre-delete-work-logs", "post-delete-work-logs", "pre-post-trash", "post-post-trash"]);
});

test("삭제·휴지통·복구는 로그인과 동일 출처를 검사하며 안전 백업 실패 시 변경을 막는다", async (t) => {
  const db = database(t);
  const work = await createWork();
  const { env, writes, request, ctx } = securityFixture(db);
  const before = db.snapshot();
  for (const [path, method] of [["/api/deletions/preview?type=work&id=missing", "GET"], ["/api/trash", "GET"], ["/api/trash/example", "GET"], ["/api/trash/example", "DELETE"], ["/api/trash/example/restore", "POST"], [`/api/work-logs/${work.id}`, "DELETE"]]) {
    const response = await handleSecurityRequest(new Request(`https://synthetic.invalid${path}`, { method }), env, ctx);
    assert.equal(response.status, 401, path);
  }
  for (const [path, method] of [[`/api/work-logs/${work.id}`, "DELETE"], ["/api/trash/example", "DELETE"], ["/api/trash/example/restore", "POST"]]) {
    for (const headers of [{ Origin: "https://different.invalid" }, { "Sec-Fetch-Site": "cross-site" }]) {
      assert.equal((await handleSecurityRequest(request(path, method, headers), env, ctx)).status, 403);
    }
  }
  assert.equal(writes.length, 0);
  env.BACKUPS.put = async () => { throw new Error("Synthetic backup unavailable"); };
  assert.equal((await handleSecurityRequest(request(`/api/work-logs/${work.id}`, "DELETE"), env, ctx)).status, 503);
  assert.equal((await handleSecurityRequest(request("/api/trash/example/restore", "POST"), env, ctx)).status, 503);
  assert.equal((await handleSecurityRequest(request("/api/trash/example", "DELETE"), env, ctx)).status, 503);
  assert.deepEqual(db.snapshot(), before);
});

async function readWorkForEdit(id) {
  const response = await workDetailRoute.GET(new Request(`https://synthetic.invalid/api/work-logs/${id}`), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 200);
  return (await response.json()).workLog;
}

async function updateWork(id, body) {
  return workDetailRoute.PUT(new Request(`https://synthetic.invalid/api/work-logs/${id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
}

test("업무 편집 버전이 없거나 이전 버전이면 저장하지 않고 최신 업무와 매물을 보존한다", async (t) => {
  const db = database(t);
  const work = await createWork();
  const initial = await readWorkForEdit(work.id);
  assert.equal(typeof initial.revision, "string");
  assert.ok(initial.revision.length > 10);

  const before = db.snapshot();
  for (const revision of [undefined, null, ""]) {
    const response = await updateWork(work.id, payload({ revision, content: "버전이 없는 수정" }));
    assert.equal(response.status, 400);
    assert.deepEqual(db.snapshot(), before);
  }

  const competingProperty = property({ unitNumber: "303" });
  const saved = await updateWork(work.id, payload({ revision: initial.revision, content: "다른 기기의 저장", details: [competingProperty] }));
  assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
  const latest = await readWorkForEdit(work.id);
  assert.notEqual(latest.revision, initial.revision);
  const competingState = db.snapshot();
  assert.equal(competingState.work_logs[0].content, "다른 기기의 저장");
  assert.deepEqual(competingState.listings.map((item) => item.identity_key), [key(competingProperty)]);

  const stale = await updateWork(work.id, payload({ revision: initial.revision, content: "이전 화면의 저장", details: [property({ unitNumber: "404" })] }));
  assert.equal(stale.status, 409);
  assert.deepEqual(db.snapshot(), competingState);
});

test("같은 초에 변경된 본문과 물건 및 매물 이벤트도 업무 편집 충돌을 일으킨다", async (t) => {
  const db = database(t);
  const work = await createWork();
  for (const change of [
    () => db.sqlite.prepare("UPDATE work_logs SET content=? WHERE id=?").run("같은 초의 다른 내용", work.id),
    () => db.sqlite.prepare("UPDATE work_log_properties SET sale_price=? WHERE work_log_id=?").run("12345", work.id),
    () => db.sqlite.prepare("UPDATE listing_events SET event_order=event_order+1 WHERE work_log_id=?").run(work.id),
  ]) {
    const initial = await readWorkForEdit(work.id);
    const timestamp = row(db, "work_logs", work.id).updated_at;
    change();
    assert.equal(row(db, "work_logs", work.id).updated_at, timestamp);
    const changedState = db.snapshot();
    const response = await updateWork(work.id, payload({ revision: initial.revision }));
    assert.equal(response.status, 409);
    assert.deepEqual(db.snapshot(), changedState);
  }
});

test("업무 편집 검증과 쓰기 배치 사이에 다른 기기의 수정이 끼어들어도 전체 상태를 보존한다", async (t) => {
  const db = database(t);
  const work = await createWork();
  const initial = await readWorkForEdit(work.id);
  const concurrentProperty = property({ unitNumber: "303" });
  let concurrentState;
  db.raceBeforeWrite(() => {
    db.sqlite.prepare("UPDATE work_logs SET content=? WHERE id=?").run("검증 후 다른 기기의 저장", work.id);
    db.sqlite.prepare("UPDATE work_log_properties SET unit_number=? WHERE work_log_id=?").run(concurrentProperty.unitNumber, work.id);
    db.sqlite.prepare("UPDATE listing_events SET listing_key=?, unit_number=? WHERE work_log_id=?").run(key(concurrentProperty), concurrentProperty.unitNumber, work.id);
    db.sqlite.prepare("UPDATE listings SET identity_key=?, unit_number=? WHERE identity_key=?").run(key(concurrentProperty), concurrentProperty.unitNumber, key());
    concurrentState = db.snapshot();
  }, /INSERT\s+INTO\s+work_logs\b/i);
  const response = await updateWork(work.id, payload({ revision: initial.revision, content: "경합한 오래된 저장", details: [property({ unitNumber: "404" })] }));
  assert.ok(concurrentState, "the competing write must run immediately before the edit transaction");
  assert.equal(response.status, 409);
  assert.deepEqual(db.snapshot(), concurrentState);
  assert.deepEqual(concurrentState.listings.map((item) => item.identity_key), [key(concurrentProperty)]);
});

test("업무 편집 검증 후 다른 기기가 삭제하면 오래된 저장이 삭제된 업무를 되살리지 않는다", async (t) => {
  const db = database(t);
  const work = await createWork();
  const initial = await readWorkForEdit(work.id);
  let deletedState;
  db.raceBeforeWrite(() => {
    db.sqlite.prepare("DELETE FROM listing_events WHERE work_log_id=?").run(work.id);
    db.sqlite.prepare("DELETE FROM work_log_properties WHERE work_log_id=?").run(work.id);
    db.sqlite.prepare("DELETE FROM work_logs WHERE id=?").run(work.id);
    db.sqlite.prepare("DELETE FROM listings WHERE identity_key=?").run(key());
    deletedState = db.snapshot();
  }, /INSERT\s+INTO\s+work_logs\b/i);
  const response = await updateWork(work.id, payload({ revision: initial.revision, content: "삭제 후 오래된 저장" }));
  assert.ok(deletedState, "the competing deletion must run immediately before the edit transaction");
  assert.equal(response.status, 409);
  assert.deepEqual(db.snapshot(), deletedState);
});

test("10개를 초과한 물건은 잘라 저장하지 않고 전체 요청을 거절한다", async (t) => {
  const db = database(t);
  const before = db.snapshot();
  const result = await workRoute.POST(new Request("https://synthetic.invalid/api/work-logs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload({ details: Array.from({ length: 11 }, (_, index) => property({ unitNumber: String(index + 1) })) })),
  }));
  assert.equal(result.status, 400);
  assert.deepEqual(db.snapshot(), before);
});

test("고객 편집도 같은 초에 다른 기기가 바꾼 정보를 덮어쓰지 않는다", async (t) => {
  const db = database(t);
  const expected = db.sqlite.prepare("SELECT name, notes, created_at, updated_at, is_demo FROM customers WHERE id = ?").get("synthetic-customer");
  db.sqlite.prepare("UPDATE customers SET notes = ? WHERE id = ?").run("다른 기기에서 바꾼 메모", "synthetic-customer");
  const request = new Request("https://synthetic.invalid/api/customers/synthetic-customer", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "오래된 이름", notes: "오래된 메모", expected }) });
  const response = await customerDetailRoute.PUT(request, { params: Promise.resolve({ id: "synthetic-customer" }) });
  assert.equal(response.status, 409);
  assert.equal(db.sqlite.prepare("SELECT notes FROM customers WHERE id = ?").get("synthetic-customer").notes, "다른 기기에서 바꾼 메모");
});

test("토지는 전체 주소만으로 저장·주소 검색·이력·삭제 복구가 이어진다", async (t) => {
  const db = database(t);
  const land = property({ propertyType: "토지", buildingName: "인천 서구 검암동 123-45", buildingDong: "", unitNumber: "" });
  const work = await createWork({ details: [land] });
  const identity = key(land);
  const listing = await historyRoute.GET(new Request("https://synthetic.invalid"), { params: Promise.resolve({ key: encodeURIComponent(identity) }) });
  assert.equal(listing.status, 200);
  assert.equal((await listing.json()).workLogs[0].id, work.id);
  for (const query of ["검암동 123-45", "123-45", "인천 서구 검암동 123-45"]) {
    const response = await workRoute.GET(new Request(`https://synthetic.invalid/api/work-logs?q=${encodeURIComponent(query)}`));
    assert.ok((await response.json()).workLogs.some((item) => item.id === work.id), query);
    const listings = await listingRoute.GET(new Request(`https://synthetic.invalid/api/listings?q=${encodeURIComponent(query)}`));
    assert.ok((await listings.json()).listings.some((item) => item.identity_key === identity), query);
  }
  const removed = await move(db, "work", work.id);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM listings WHERE identity_key = ?").get(identity).n, 0);
  await deletion.restoreTrash(db.db, removed.trashId);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM listings WHERE identity_key = ?").get(identity).n, 1);
});

test("고객 상세 조회와 수정은 비고를 유지하고 이전 버전은 거절한다", async (t) => {
  database(t);
  const params = { params: Promise.resolve({ id: "synthetic-customer" }) };
  const get = () => customerDetailRoute.GET(new Request("https://synthetic.invalid"), params);
  const first = (await (await get()).json()).customer;
  assert.equal(first.notes, "합성 고객 메모");
  const update = (expected, notes) => customerDetailRoute.PUT(new Request("https://synthetic.invalid", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "고친 고객명", notes, expected }) }), params);
  const saved = await update(first, "새 메모\n두 번째 줄");
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).customer.notes, "새 메모\n두 번째 줄");
  assert.equal((await update(first, "덮어쓰기" )).status, 409);
  assert.equal((await (await get()).json()).customer.notes, "새 메모\n두 번째 줄");
});

test("기존 토지의 건물명·동·호 값은 주소를 바꾸지 않은 업무 수정에서 그대로 유지된다", async (t) => {
  const db = database(t);
  const land = property({ propertyType: "토지", buildingName: "검증 동네", buildingDong: "101", unitNumber: "202" });
  const created = await createWork({ details: [land] });
  const saved = await workData.saveWorkLog(payload({ revision: created.revision, content: "본문만 수정", details: [land] }), created.id);
  assert.equal(saved.details[0].building_name, land.buildingName);
  assert.equal(saved.details[0].building_dong, land.buildingDong);
  assert.equal(saved.details[0].unit_number, land.unitNumber);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM listings WHERE identity_key = ?").get(key(land)).n, 1);
});
