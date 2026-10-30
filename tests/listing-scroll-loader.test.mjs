import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

// Run the production effects with controlled observers and promises. No browser,
// API, timers, or persistence binding is contacted.
const source = readFileSync(new URL("../app/listing-scroll-loader.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("listing-scroll-loader.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "ListingScrollLoader");
assert.ok(component);
const compiled = ts.transpileModule(component.getText(ast).replace(/^export /, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
}).outputText;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness({ observer = true, onLoadMore = async () => 200 } = {}) {
  const refs = [], effects = [], cleanups = [], observers = [], listeners = new Map(), frames = new Map(), scrolls = [];
  let refIndex = 0, effectIndex = 0, nextFrame = 0, queued = [], top = 3000;
  let props = { queryKey: "same-query", loaded: 100, hasMore: true, enabled: true, busy: false, error: "", onLoadMore };
  const sentinel = { getBoundingClientRect: () => ({ top, bottom: top + 1 }) };
  const window = {
    innerHeight: 800,
    scrollTo: (value) => scrolls.push(value),
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  if (observer) window.IntersectionObserver = class {
    constructor(callback, options) { this.callback = callback; this.options = options; this.disconnected = false; observers.push(this); }
    observe(node) { this.node = node; }
    disconnect() { this.disconnected = true; }
    emit(isIntersecting, target = this.node) { this.callback([{ target, isIntersecting }]); }
  };
  const Loader = new Function("React", "useRef", "useEffect", "window", `${compiled}; return ListingScrollLoader;`)(
    React,
    (initial) => refs[refIndex++] ??= { current: initial },
    (effect, deps) => {
      const index = effectIndex++, before = effects[index];
      if (!before || deps.some((value, cursor) => !Object.is(value, before[cursor]))) {
        effects[index] = deps;
        queued.push([index, effect]);
      }
    },
    window,
  );
  return {
    observers, scrolls, frames, listeners, sentinel,
    render(next = {}) {
      props = { ...props, ...next };
      refIndex = 0; effectIndex = 0; queued = [];
      const tree = Loader(props);
      tree.props.ref.current = sentinel;
      for (const [index, effect] of queued) { cleanups[index]?.(); cleanups[index] = effect(); }
      return tree;
    },
    unmount() { for (const cleanup of cleanups) cleanup?.(); refs[0].current = null; },
    position(value) { top = value; },
    dispatch(name) { for (const listener of listeners.get(name) ?? []) listener(); },
    flushFrames() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); },
  };
}

test("the sentinel requests only near the viewport and repeated notifications share one pending request", async () => {
  const pending = deferred(), calls = [];
  const h = harness({ onLoadMore: () => { calls.push(true); return pending.promise; } });
  const tree = h.render(), observer = h.observers[0];
  assert.equal(observer.node, h.sentinel);
  assert.deepEqual(observer.options, { root: null, rootMargin: "480px 0px", threshold: 0 });
  assert.doesNotMatch(renderToStaticMarkup(tree), /button|더 보기|다음 페이지/);
  observer.emit(false);
  observer.emit(true, {});
  assert.equal(calls.length, 0);
  observer.emit(true);
  observer.emit(true);
  assert.equal(calls.length, 1);
  pending.resolve(200);
  await settle();
});

test("disabled, busy, failed, completed and missing callbacks never observe or request another page", () => {
  for (const blocked of [{ enabled: false }, { busy: true }, { error: "synthetic failure" }, { hasMore: false }, { onLoadMore: undefined }]) {
    const h = harness({ onLoadMore: () => assert.fail("a blocked loader must not request data") });
    const tree = h.render(blocked);
    assert.equal(h.observers.length, 0);
    assert.equal(h.listeners.size, 0);
    assert.equal(renderToStaticMarkup(tree).includes('role="status"'), blocked.busy === true);
  }
});

test("appending rows checks the new sentinel position instead of fetching every remaining page", async () => {
  const calls = [], h = harness({ onLoadMore: async () => { calls.push(true); return 200; } });
  h.render();
  const old = h.observers[0];
  old.emit(true);
  await settle();
  h.render({ loaded: 200 });
  assert.equal(old.disconnected, true);
  old.emit(true);
  h.observers.at(-1).emit(false);
  assert.equal(calls.length, 1, "appending has moved the sentinel beyond the viewport");
  h.observers.at(-1).emit(true);
  assert.equal(calls.length, 2, "scrolling to the new boundary requests the next page");
  await settle();
  const last = h.observers.at(-1);
  h.render({ loaded: 250, hasMore: false });
  assert.equal(last.disconnected, true);
  last.emit(true);
  assert.equal(calls.length, 2);
});

test("an error stops automatic retries and resuming the parent retry flow re-enables observation", async () => {
  const calls = [], h = harness({ onLoadMore: async () => { calls.push(true); return undefined; } });
  h.render();
  const original = h.observers[0];
  original.emit(true);
  await settle();
  h.render({ error: "synthetic failure" });
  original.emit(true);
  h.render({ busy: true });
  assert.equal(calls.length, 1);
  assert.equal(h.observers.length, 1);
  h.render({ busy: false, error: "" });
  const retried = h.observers.at(-1);
  assert.notEqual(retried, original);
  retried.emit(true);
  assert.equal(calls.length, 2);
  await settle();
});

test("changing a query invalidates its observer and pending request without letting an old finally unlock the new one", async () => {
  const first = deferred(), second = deferred(), calls = [];
  const h = harness({ onLoadMore: () => { calls.push("old"); return first.promise; } });
  h.render();
  const old = h.observers[0];
  old.emit(true);
  h.render({ queryKey: "replacement-query", onLoadMore: () => { calls.push("new"); return second.promise; } });
  assert.equal(old.disconnected, true);
  old.emit(true);
  const current = h.observers.at(-1);
  current.emit(true);
  assert.deepEqual(calls, ["old", "new"]);
  first.resolve(200);
  await settle();
  current.emit(true);
  assert.deepEqual(calls, ["old", "new"], "the old promise cannot release the current pending lock");
  second.resolve(200);
  await settle();
  h.unmount();
  current.emit(true);
  assert.deepEqual(calls, ["old", "new"]);
});

test("only a query change resets document scroll; append, busy state and same-query refresh preserve the reading position", () => {
  const h = harness();
  h.render();
  h.render({ loaded: 200 });
  h.render({ busy: true });
  h.render({ busy: false, enabled: false });
  h.render({ enabled: true });
  h.render({ error: "synthetic error" });
  h.render({ error: "" });
  assert.deepEqual(h.scrolls, []);
  h.render({ queryKey: "new-filter", loaded: 0, enabled: false });
  assert.deepEqual(h.scrolls, [{ top: 0 }]);
  h.render({ loaded: 100, enabled: true });
  h.render({ queryKey: "same-query" });
  assert.deepEqual(h.scrolls, [{ top: 0 }, { top: 0 }]);
});

test("the scroll fallback measures the real viewport, coalesces events and removes every listener and frame on cleanup", async () => {
  const pending = deferred(), calls = [];
  const h = harness({ observer: false, onLoadMore: () => { calls.push(true); return pending.promise; } });
  h.render();
  assert.equal(h.listeners.get("scroll").size, 1);
  assert.equal(h.listeners.get("resize").size, 1);
  h.flushFrames();
  assert.equal(calls.length, 0);
  h.position(1500);
  h.dispatch("scroll");
  h.dispatch("resize");
  assert.equal(h.frames.size, 1);
  h.flushFrames();
  assert.equal(calls.length, 0);
  h.position(1200);
  h.dispatch("scroll");
  h.flushFrames();
  h.dispatch("resize");
  h.flushFrames();
  assert.equal(calls.length, 1);
  h.dispatch("scroll");
  assert.equal(h.frames.size, 1);
  h.unmount();
  assert.equal(h.frames.size, 0);
  assert.equal(h.listeners.get("scroll").size, 0);
  assert.equal(h.listeners.get("resize").size, 0);
  h.dispatch("scroll");
  assert.equal(h.frames.size, 0);
  pending.resolve(200);
  await settle();
});
