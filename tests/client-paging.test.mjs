import assert from "node:assert/strict";
import test from "node:test";
import { canAppendPage } from "../app/client-paging.ts";

test("changing a filter blocks pagination immediately, before the first-page effect starts", () => {
  const loadedQuery = JSON.stringify(["", "전화", "", ""]);
  const nextQuery = JSON.stringify(["", "매물등록", "", ""]);
  assert.equal(canAppendPage(loadedQuery, loadedQuery, false, false), true);
  assert.equal(canAppendPage(loadedQuery, nextQuery, false, false), false);
});

test("A rows cannot be extended by B page two while B page one is pending", async () => {
  let loadedQuery = "A";
  let firstPagePending = false;
  let rows = Array.from({ length: 100 }, (_, i) => `A-${i}`);
  let resolveFirst;
  const response = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const requestedOffsets = [];
  const currentQuery = "B";
  firstPagePending = true;
  const firstPage = response
    .then((items) => {
      loadedQuery = currentQuery;
      rows = items;
    })
    .finally(() => {
      firstPagePending = false;
    });
  function requestMore() {
    if (!canAppendPage(loadedQuery, currentQuery, firstPagePending, false))
      return;
    requestedOffsets.push(rows.length);
  }
  requestMore();
  assert.deepEqual(requestedOffsets, []);
  resolveFirst(["B-0", "B-1"]);
  await firstPage;
  requestMore();
  assert.deepEqual(rows, ["B-0", "B-1"]);
  assert.deepEqual(requestedOffsets, [2]);
});

test("a failed new-filter first page cannot enable pagination on the old rows", () => {
  assert.equal(canAppendPage("A", "B", true, false), false);
  assert.equal(canAppendPage("A", "B", false, false), false);
  assert.equal(canAppendPage(null, "B", false, false), false);
});

test("refreshing the same query and duplicate next-page clicks remain locked", () => {
  assert.equal(canAppendPage("A", "A", true, false), false);
  assert.equal(canAppendPage("A", "A", false, true), false);
  assert.equal(canAppendPage("A", "A", false, false), true);
});

test("전체 목록을 여러 페이지로 수집하고 중복이나 중간 오류는 부분 성공으로 처리하지 않는다", async () => {
  const { collectOffsetPages } = await import("../app/client-paging.ts");
  const calls = [];
  const rows = await collectOffsetPages(async (offset) => {
    calls.push(offset);
    return offset === 0 ? [{ id: "1" }, { id: "2" }] : [{ id: "3" }];
  }, 2);
  assert.deepEqual(calls, [0, 2]);
  assert.deepEqual(rows.map((row) => row.id), ["1", "2", "3"]);
  await assert.rejects(collectOffsetPages(async () => [{ id: "1" }, { id: "2" }], 2), /변경/);
  await assert.rejects(collectOffsetPages(async (offset) => { if (offset) throw new Error("offline"); return [{ id: "1" }, { id: "2" }]; }, 2), /offline/);
});
