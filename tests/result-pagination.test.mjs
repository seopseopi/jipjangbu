import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/result-pagination.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source.replace(/^import .*;\n/m, "").replaceAll("export function", "function"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
function harness(loaded = 100, total = 130, query = "all", pageSize = 10) {
  const slots = []; let cursor = 0, dirty = false;
  const h = { loaded, total, query, pageSize };
  const state = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = initial;
    return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; dirty = true; }];
  };
  const ref = initial => { const index = cursor++; return slots[index] ??= { current: initial }; };
  const hook = new Function("useState", "useRef", "useEffect", `${compiled}; return useResultPage;`)(state, ref, () => {});
  h.render = () => {
    let current;
    do { dirty = false; cursor = 0; current = hook(h.loaded, h.total, h.query, h.pageSize); } while (dirty);
    return current;
  };
  return h;
}

test("loaded pages stay local and the next server window opens only at its boundary", async () => {
  const h = harness(); let reads = 0;
  const load = async () => { reads++; h.loaded = 130; return 130; };
  for (let page = 0; page < 9; page++) await h.render().next(load);
  assert.equal(h.render().page, 9); assert.equal(reads, 0);
  await h.render().next(load);
  assert.equal(reads, 1); assert.equal(h.render().page, 10);
  assert.deepEqual([h.render().start, h.render().end], [100, 110]);
  h.render().previous(); assert.equal(h.render().page, 9);
  assert.equal(reads, 1);
});

test("failed extra reads keep the current records and page available for retry", async () => {
  const h = harness(10, 20);
  await h.render().next(async () => undefined);
  assert.deepEqual([h.render().page, h.render().start, h.render().end], [0, 0, 10]);
  await h.render().next(async () => { h.loaded = 20; return 20; });
  assert.equal(h.render().page, 1);
});

test("a late next-page response cannot move a different query, and returning to a query starts at its first page", async () => {
  const h = harness(10, 20); let finish;
  const pending = h.render().next(() => new Promise(resolve => { finish = resolve; }));
  h.query = "new search"; h.render(); finish(20); await pending;
  assert.equal(h.render().page, 0);
  h.loaded = 20; await h.render().next(); assert.equal(h.render().page, 1);
  h.query = "all"; assert.equal(h.render().page, 0);
  h.query = "new search"; assert.equal(h.render().page, 0);
});

test("deleting the last records clamps the page and zero results never create an invalid range", async () => {
  const h = harness(21, 21); await h.render().next(); await h.render().next();
  assert.equal(h.render().page, 2);
  h.loaded = 20; h.total = 20; assert.equal(h.render().page, 1);
  h.loaded = 21; h.total = 21; assert.equal(h.render().page, 1, "new records do not revive a deleted last-page selection");
  h.loaded = 0; h.total = 0;
  assert.deepEqual([h.render().page, h.render().pages, h.render().start, h.render().end], [0, 1, 0, 0]);
});

test("returning to an earlier query does not revive its pending next-page request", async () => {
  const h = harness(10, 20); let finish;
  const pending = h.render().next(() => new Promise(resolve => { finish = resolve; }));
  h.query = "another search"; h.render();
  h.query = "all"; h.render();
  finish(20); await pending;
  assert.equal(h.render().page, 0);
});
