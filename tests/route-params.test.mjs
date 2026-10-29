import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";
import { matchRoutePattern } from "../node_modules/vinext/dist/routing/route-pattern.js";

// Follow the installed router's real one-decode contract before entering the
// actual handlers. Only the D1 binding/bootstrap are replaced with synthetic DB.
const root = new URL("../", import.meta.url);
const roots = [new URL("app/", root).href, new URL("db/", root).href];
const bindingKey = "jipjangbu-route-contract-db";
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (roots.some((prefix) => context.parentURL?.startsWith(prefix)) && specifier.startsWith(".")) {
      const resolved = new URL(specifier, context.parentURL).href;
      if (["db", "db/", "db/index.ts"].some((path) => resolved === new URL(path, root).href)) return {
        url: `data:text/javascript,${encodeURIComponent(`export function getD1(){return globalThis[Symbol.for(${JSON.stringify(bindingKey)})]}`)}`, shortCircuit: true,
      };
      if (["db/bootstrap", "db/bootstrap.ts"].some((path) => resolved === new URL(path, root).href)) return { url: "data:text/javascript,export async function ensureDatabase(){}", shortCircuit: true };
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
const [customers, history, work, deletion] = await Promise.all([
  import("../app/api/customers/[id]/route.ts"), import("../app/api/listings/[key]/route.ts"),
  import("../app/api/work-logs/data.ts"), import("../db/deletion-store.ts"),
]);
hook.deregister();

function database(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(new URL("drizzle/", root)).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(`drizzle/${name}`, root), "utf8"));
  const db = { prepare(sql) {
    const query = sqlite.prepare(sql); let values = [];
    const execute = () => query.columns().length ? { results: query.all(...values), success: true } : { results: [], success: true, meta: query.run(...values) };
    return { bind(...args) { values = args; return this; }, async first() { return execute().results[0] ?? null; }, async run() { return execute(); }, async all() { return execute(); }, execute };
  }, async batch(statements) {
    sqlite.exec("SAVEPOINT route_test");
    try { const results = statements.map((statement) => statement.execute()); sqlite.exec("RELEASE route_test"); return results; }
    catch (error) { sqlite.exec("ROLLBACK TO route_test"); sqlite.exec("RELEASE route_test"); throw error; }
  } };
  globalThis[Symbol.for(bindingKey)] = db;
  t.after(() => { sqlite.close(); delete globalThis[Symbol.for(bindingKey)]; });
  return { db, sqlite };
}
function requestFor(kind, value, options) {
  const encoded = encodeURIComponent(value);
  const params = matchRoutePattern(["api", kind, encoded], ["api", kind, kind === "customers" ? ":id" : ":key"]);
  return [new Request(`https://test.invalid/api/${kind}/${encoded}`, options), { params: Promise.resolve(params) }];
}

test("실제 라우터→고객 API는 특수문자를 한 번만 해석하고 수정·삭제 대상을 혼동하지 않는다", async (t) => {
  const { db, sqlite } = database(t);
  const ids = ["비율100%", "고객%32", "고객2", "문의/연락?#"];
  for (const id of ids) sqlite.prepare("INSERT INTO customers(id,name) VALUES(?,?)").run(id, `합성 ${id}`);
  for (const id of ids) {
    const response = await customers.GET(...requestFor("customers", id));
    assert.equal(response.status, 200);
    const { customer } = await response.json();
    assert.equal(customer.id, id);
    const update = await customers.PUT(...requestFor("customers", id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `변경 ${id}`, notes: "합성 수정", expected: customer }) }));
    assert.equal(update.status, 200);
    assert.equal((await update.json()).customer.id, id);
  }
  const preview = await deletion.getDeletionPreview(db, "customer", "고객%32");
  const removed = await customers.DELETE(...requestFor("customers", "고객%32", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: preview.revision }) }));
  assert.equal(removed.status, 200);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM customers WHERE id='고객%32'").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM customers WHERE id='고객2'").get().count, 1);
});

test("실제 라우터를 거친 특수문자 매물 주소도 정확한 현재 값과 이력을 조회한다", async (t) => {
  const { sqlite } = database(t);
  sqlite.exec("INSERT INTO customers(id,name) VALUES('synthetic','합성 고객'); INSERT INTO work_types(name) VALUES('매물등록')");
  for (const name of ["100%타워", "건물%32", "건물2", "문의/연락?#"]) {
    const saved = await work.saveWorkLog({ workDate: "2026-10-29", customerId: "synthetic", workType: "매물등록", content: name, details: [{ propertyType: "상가", buildingName: name, buildingDong: "", unitNumber: "101" }] });
    const key = `상가|${name.toLocaleLowerCase("ko-KR")}||101`;
    const response = await history.GET(...requestFor("listings", key));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.listing.building_name, name);
    assert.equal(data.workLogs[0].id, saved.id);
  }
});
