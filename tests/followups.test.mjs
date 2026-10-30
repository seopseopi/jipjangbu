import assert from "node:assert/strict";
import { attachTestSession } from "./helpers/security-session.mjs";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import ts from "typescript";
import { handleSecurityRequest, schedulePostMutationBackup } from "../worker/security.ts";

// The shared deletion store uses the application's extensionless TS imports.
// Preserve real store behavior while replacing only the unavailable D1 binding.
const root = new URL("../", import.meta.url);
const roots = [new URL("app/", root).href, new URL("db/", root).href];
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (roots.some((prefix) => context.parentURL?.startsWith(prefix)) && specifier.startsWith(".")) {
      const resolved = new URL(specifier, context.parentURL).href;
      if (["db", "db/", "db/index.ts"].some((path) => resolved === new URL(path, root).href)) {
        return { url: "data:text/javascript,export function getD1() { throw new Error('Pass the synthetic D1 binding explicitly'); }", shortCircuit: true };
      }
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (roots.some((prefix) => url.startsWith(prefix)) && url.endsWith(".ts")) return {
      format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});

const {
  createFollowUp,
  deleteFollowUp,
  FollowUpError,
  getFollowUp,
  getFollowUps,
  isCalendarDate,
  parseFollowUpInput,
  readFollowUpBody,
  seoulToday,
  updateFollowUp,
} = await import("../app/api/follow-ups/_store.ts");
const { getDeletionPreview } = await import("../db/deletion-store.ts");
// Deletion is intentionally imported lazily by the store at mutation time.
after(() => hook.deregister());

function database(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys = ON");
  const directory = new URL("../drizzle/", import.meta.url);
  for (const filename of readdirSync(directory).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync(new URL(filename, directory), "utf8"));
  }
  sqlite.exec(`INSERT INTO customers (id, name) VALUES ('customer-test', '연결 고객');
    INSERT INTO listings (id, identity_key, status, property_type, building_name, building_dong, unit_number)
    VALUES ('listing-test', '아파트|테스트|101|202', '매물등록', '아파트', '테스트', '101', '202')`);
  const db = {
    prepare(sql) {
      const query = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...bindings) { values = bindings; return this; },
        async run() { return { meta: query.run(...values) }; },
        async first() { return query.get(...values) ?? null; },
        async all() { return { success: true, results: query.all(...values) }; },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = await Promise.all(statements.map((statement) => statement.all()));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { db, sqlite };
}

async function patchFollowUp(db, id, body) {
  const current = await getFollowUp(db, id);
  return updateFollowUp(db, id, { revision: current.revision, ...body });
}

test("할 일은 빈 목록으로 시작하고 연결·완료·재개·삭제를 보존한다", async (t) => {
  const { db, sqlite } = database(t);
  assert.equal((await getFollowUps(db, new URLSearchParams())).items.length, 0);
  const created = await createFollowUp(db, {
    title: "  방문 시간 확인  ", notes: "연락한 뒤 완료", dueDate: "2026-09-12",
    customerId: "customer-test", listingKey: "아파트|테스트|101|202",
  });
  assert.equal(created.title, "방문 시간 확인");
  assert.equal(created.customer_name, "연결 고객");
  assert.equal(created.listing_label, "테스트 101동 202호");
  assert.equal(created.completed_at, null);

  const complete = await patchFollowUp(db, created.id, { completed: true });
  assert.ok(complete.completed_at);
  const edited = await patchFollowUp(db, created.id, { notes: "확인했음", completed: true });
  assert.equal(edited.title, created.title);
  assert.equal(edited.completed_at, complete.completed_at);
  assert.equal((await patchFollowUp(db, created.id, { completed: false })).completed_at, null);

  sqlite.prepare("DELETE FROM customers WHERE id = ?").run("customer-test");
  const detached = await getFollowUp(db, created.id);
  assert.equal(detached.customer_id, null);
  assert.equal(detached.title, created.title);
  assert.equal(detached.listing_key, created.listing_key);

  const cleared = await patchFollowUp(db, created.id, { listingKey: "", dueDate: null, notes: "" });
  assert.equal(cleared.listing_key, null);
  assert.equal(cleared.due_date, null);
  assert.equal(cleared.notes, "");
  const preview = await getDeletionPreview(db, "followup", created.id);
  await deleteFollowUp(db, created.id, preview.revision);
  await assert.rejects(getFollowUp(db, created.id), (error) => error.status === 404);
  await assert.rejects(deleteFollowUp(db, created.id, preview.revision), (error) => error.status === 404);
  await assert.rejects(patchFollowUp(db, created.id, { completed: true }), (error) => error.status === 404);
});

test("홈에서 추가하는 연결 없는 할 일도 여러 줄 메모를 저장하고 다시 조회한다", async (t) => {
  const { db } = database(t);
  const notes = "약속 시간 확인\n준비 서류 확인";
  const created = await createFollowUp(db, {
    title: "합성 방문 준비", notes, dueDate: null, customerId: null, listingKey: null,
  });
  assert.equal(created.notes, notes);
  const detail = await getFollowUp(db, created.id);
  assert.equal(detail.notes, notes);
  assert.equal(detail.customer_id, null);
  assert.equal(detail.listing_key, null);
  const list = await getFollowUps(db, new URLSearchParams());
  assert.equal(list.items.find((item) => item.id === created.id).notes, notes);
});

test("할 일의 서울 날짜·기한 필터·검색·전체 요약이 일관된다", async (t) => {
  const { db } = database(t);
  const now = new Date("2026-09-11T15:30:00Z");
  assert.equal(seoulToday(now), "2026-09-12");
  const saved = [];
  for (const [title, dueDate] of [["기한 없음", null], ["밀린 확인", "2026-09-11"], ["오늘 확인", "2026-09-12"],
    ["주간 확인", "2026-09-19"], ["다음주 확인", "2026-09-20"], ["100% 확인", "2026-09-12"]]) {
    saved.push(await createFollowUp(db, { title, dueDate, customerId: "customer-test" }));
  }
  await patchFollowUp(db, saved[5].id, { completed: true });
  const all = await getFollowUps(db, new URLSearchParams("status=all"), now);
  assert.deepEqual({ ...all.summary }, { open: 5, overdue: 1, today: 1, completed: 1 });
  assert.equal(all.items[0].title, "밀린 확인");
  assert.equal(all.items.at(-2).title, "기한 없음");
  assert.equal(all.items.at(-1).title, "100% 확인");
  assert.deepEqual((await getFollowUps(db, new URLSearchParams("due=today"), now)).items.map((item) => item.title), ["오늘 확인"]);
  assert.deepEqual((await getFollowUps(db, new URLSearchParams("due=overdue"), now)).items.map((item) => item.title), ["밀린 확인"]);
  assert.deepEqual((await getFollowUps(db, new URLSearchParams("due=upcoming"), now)).items.map((item) => item.title), ["주간 확인"]);
  const filtered = await getFollowUps(db, new URLSearchParams("status=all&q=%25"), now);
  assert.deepEqual(filtered.items.map((item) => item.title), ["100% 확인"]);
  assert.deepEqual(filtered.summary, all.summary);
  assert.equal((await getFollowUps(db, new URLSearchParams("q=연결 고객"), now)).items.length, 5);
});

test("연결된 매물이 사라져도 기존 연결을 유지한 할 일 수정과 연결 해제가 가능하다", async (t) => {
  const { db, sqlite } = database(t);
  const listingKey = "아파트|테스트|101|202";
  const item = await createFollowUp(db, {
    title: "매물 확인", notes: "원본 메모", customerId: "customer-test", listingKey,
  });
  sqlite.prepare("DELETE FROM listings WHERE identity_key = ?").run(listingKey);

  const updated = await patchFollowUp(db, item.id, {
    title: "매물 다시 확인", notes: "주소 변경 확인 필요", dueDate: "2026-09-20",
    customerId: "customer-test", listingKey, completed: true,
  });
  assert.equal(updated.title, "매물 다시 확인");
  assert.equal(updated.notes, "주소 변경 확인 필요");
  assert.equal(updated.due_date, "2026-09-20");
  assert.ok(updated.completed_at);
  assert.equal(updated.listing_key, listingKey);
  assert.equal(updated.listing_label, null);
  assert.equal(updated.customer_name, "연결 고객");

  await assert.rejects(patchFollowUp(db, item.id, { listingKey: "another-missing-listing" }), FollowUpError);
  await assert.rejects(patchFollowUp(db, item.id, { customerId: "missing-customer" }), FollowUpError);
  const detached = await patchFollowUp(db, item.id, { listingKey: null, completed: false });
  assert.equal(detached.listing_key, null);
  assert.equal(detached.completed_at, null);
  await assert.rejects(patchFollowUp(db, item.id, { listingKey }), FollowUpError);
});

test("잘못된 할 일 입력·날짜·필터·존재하지 않는 연결을 거부한다", async (t) => {
  const { db, sqlite } = database(t);
  for (const body of [null, [], 123, "제목", {}, { title: " " }, { title: "a".repeat(201) },
    { title: "제목", notes: null }, { title: "제목", notes: "a".repeat(5001) },
    { title: "제목", dueDate: 123 }, { title: "제목", dueDate: "2026-02-29" },
    { title: "제목", customerId: {} }, { title: "제목", completed: true }, { title: "제목", typo: "x" }]) {
    assert.throws(() => parseFollowUpInput(body), FollowUpError);
  }
  for (const body of [{}, { completed: "false" }, { completed: null }, { dueDate: "2026-99-99" }]) {
    assert.throws(() => parseFollowUpInput(body, true), FollowUpError);
  }
  for (const date of ["2024-02-29", "2026-12-31", "0001-01-01"]) assert.equal(isCalendarDate(date), true, date);
  for (const date of ["2026-02-29", "2026-04-31", "2026-00-01", "0000-01-01", "2026-1-01"]) assert.equal(isCalendarDate(date), false, date);
  for (const query of ["status=bad", "due=bad", "status=all&status=open", "limit=10", `q=${"a".repeat(201)}`]) {
    await assert.rejects(getFollowUps(db, new URLSearchParams(query)), FollowUpError);
  }
  await assert.rejects(createFollowUp(db, { title: "고객", customerId: "missing" }), FollowUpError);
  await assert.rejects(createFollowUp(db, { title: "매물", listingKey: "missing" }), FollowUpError);
  await assert.rejects(readFollowUpBody(new Request("https://test.invalid", { method: "POST", body: "{" })), FollowUpError);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM follow_ups").get().count, 0);
  assert.throws(() => sqlite.prepare("INSERT INTO follow_ups (id,title) VALUES ('bad','')").run(), /CHECK constraint/);
});

test("할 일 변경 전후 암호화 백업에 실제 할 일 데이터가 포함된다", async (t) => {
  const { db } = database(t);
  const item = await createFollowUp(db, { title: "백업에 남길 할 일" });
  const writes = [];
  const pending = [];
  const secret = "33".repeat(32);
  const env = {
    DB: db,
    APP_ADMIN_USERNAME: "test-admin",
    APP_SESSION_SECRET: secret,
    BACKUP_ENCRYPTION_KEY: "22".repeat(32),
    BACKUPS: { async put(key, value, options) { writes.push({ key, value, options }); } },
  };
  const token = attachTestSession(env);
  const request = new Request(`https://jipjangbu.invalid/api/follow-ups/${item.id}`, {
    method: "PATCH", headers: { Cookie: `jipjangbu_session=${token}` },
  });
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  assert.equal(await handleSecurityRequest(request, env, ctx), null);
  await patchFollowUp(db, item.id, { completed: true });
  schedulePostMutationBackup(request, new Response(null, { status: 200 }), env, ctx);
  await Promise.all(pending);
  assert.equal(writes.length, 2);
  const key = await crypto.subtle.importKey("raw", Buffer.from(env.BACKUP_ENCRYPTION_KEY, "hex"), "AES-GCM", false, ["decrypt"]);
  const snapshots = [];
  for (const write of writes) {
    assert.deepEqual([...write.value.slice(0, 4)], [0x4a, 0x4a, 0x42, 0x31]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: write.value.slice(4, 16) }, key, write.value.slice(16));
    snapshots.push(JSON.parse(new TextDecoder().decode(plaintext)));
  }
  assert.equal(snapshots[0].tables.follow_ups[0].completed_at, null);
  assert.ok(snapshots[1].tables.follow_ups[0].completed_at);
  for (const snapshot of snapshots) {
    assert.equal(snapshot.counts.follow_ups, 1);
    assert.equal(snapshot.tables.follow_ups[0].title, item.title);
  }
});

test("같은 초의 다른 기기 수정도 오래된 초안·완료 처리로 덮어쓸 수 없다", async (t) => {
  const { db } = database(t);
  const original = await createFollowUp(db, { title: "다음 연락", notes: "처음 메모", dueDate: "2026-10-30" });
  const changed = await updateFollowUp(db, original.id, { revision: original.revision, notes: "기기 A 새 메모" });
  assert.notEqual(changed.revision, original.revision);
  for (const body of [
    { title: original.title, notes: original.notes, dueDate: "2026-11-02" },
    { completed: true },
  ]) await assert.rejects(updateFollowUp(db, original.id, { revision: original.revision, ...body }), (error) => error.status === 409);
  const current = await getFollowUp(db, original.id);
  assert.equal(current.notes, "기기 A 새 메모");
  assert.equal(current.completed_at, null);
  const saved = await updateFollowUp(db, original.id, { revision: current.revision, dueDate: "2026-11-02" });
  assert.equal(saved.notes, current.notes);
  assert.equal(saved.due_date, "2026-11-02");
  await assert.rejects(updateFollowUp(db, original.id, { notes: "revision 없는 이전 클라이언트" }), (error) => error.status === 400);
});

test("할 일 읽기와 쓰기 사이의 변경·삭제도 조건부 UPDATE가 원자적으로 방어한다", async (t) => {
  const { db, sqlite } = database(t);
  const original = await createFollowUp(db, { title: "경합 검증", notes: "읽은 메모" });
  for (const remove of [false, true]) {
    const before = await getFollowUp(db, original.id);
    const racing = { ...db, prepare(sql) {
      const statement = db.prepare(sql);
      if (/^UPDATE follow_ups SET/.test(sql)) {
        const run = statement.run.bind(statement);
        statement.run = async () => {
          if (remove) sqlite.prepare("DELETE FROM follow_ups WHERE id = ?").run(original.id);
          else sqlite.prepare("UPDATE follow_ups SET notes = ? WHERE id = ?").run("쓰기 직전 다른 기기 변경", original.id);
          return run();
        };
      }
      return statement;
    } };
    await assert.rejects(updateFollowUp(racing, original.id, { revision: before.revision, title: "오래된 저장" }), (error) => error.status === 409);
    if (!remove) assert.equal((await getFollowUp(db, original.id)).notes, "쓰기 직전 다른 기기 변경");
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM follow_ups").get().count, 0);
});
