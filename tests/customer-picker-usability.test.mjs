import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Run the actual picker functions/handlers with synthetic DOM geometry and state.
const source = readFileSync(new URL("../app/customer-picker.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("customer-picker.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function findNode(predicate) {
  let found;
  function visit(node) {
    if (predicate(node)) found = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, "tested picker code exists");
  return found;
}

function compile(expression, environment = {}) {
  const js = ts.transpileModule(`const actual = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(...Object.keys(environment), `${js}; return actual;`)(...Object.values(environment));
}

const revealNode = findNode((node) => ts.isFunctionDeclaration(node) && node.name?.text === "revealActiveCustomer");
const revealActiveCustomer = compile(revealNode.getText(ast));

function resultsFixture({ top = 50, height = 265, border = 1, scrollTop = 0, optionTop, optionHeight = 55 }) {
  const selected = {
    getBoundingClientRect: () => ({ top: optionTop, bottom: optionTop + optionHeight, height: optionHeight }),
    scrollIntoView: () => assert.fail("must not scroll the enclosing modal or page"),
  };
  return {
    clientTop: border,
    clientHeight: height,
    scrollTop,
    getBoundingClientRect: () => ({ top }),
    querySelector: (selector) => { assert.equal(selector, '[aria-selected="true"]'); return selected; },
  };
}

test("keyboard selection below the visible customer list reveals its last line with the smallest internal scroll", () => {
  const results = resultsFixture({ optionTop: 301 });
  revealActiveCustomer(results);
  assert.equal(results.scrollTop, 40);
});

test("moving upward or wrapping to the first customer reveals its first line without moving a visible option", () => {
  const above = resultsFixture({ scrollTop: 300, optionTop: 11 });
  revealActiveCustomer(above);
  assert.equal(above.scrollTop, 260);
  for (const optionTop of [51, 100, 261]) {
    const visible = resultsFixture({ scrollTop: 300, optionTop });
    revealActiveCustomer(visible);
    assert.equal(visible.scrollTop, 300);
  }
});

test("large text rows, replaced search results, and empty lists keep safe scroll behavior", () => {
  const tall = resultsFixture({ scrollTop: 100, optionTop: 80, optionHeight: 400 });
  revealActiveCustomer(tall);
  assert.equal(tall.scrollTop, 129, "an oversized row starts at its name instead of hiding it");
  const refreshed = resultsFixture({ scrollTop: 400, optionTop: -349 });
  revealActiveCustomer(refreshed);
  assert.equal(refreshed.scrollTop, 0);
  revealActiveCustomer(null);
  const empty = { scrollTop: 80, querySelector: () => null };
  revealActiveCustomer(empty);
  assert.equal(empty.scrollTop, 80);
});

const keyboardNode = findNode((node) => ts.isJsxAttribute(node) && node.name.text === "onKeyDown");
const keyboardSource = keyboardNode.initializer.expression.getText(ast);

function keyboardHarness({ open = true, active = 0, count = 12 } = {}) {
  const state = { open, active, chosen: [] };
  const matches = Array.from({ length: count }, (_, index) => ({ id: `synthetic-${index}`, name: `예시 고객 ${index}` }));
  return {
    state,
    press(key, nativeEvent = {}) {
      const event = { key, nativeEvent, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
      compile(keyboardSource, {
        matches, open: state.open, active: state.active,
        setOpen: (value) => { state.open = value; },
        setActive: (updater) => { state.active = updater(state.active); },
        choose: (customer) => state.chosen.push(customer.id),
      })(event);
      return event;
    },
  };
}

test("arrow keys still wrap across all customer choices and Enter chooses the active customer", () => {
  const harness = keyboardHarness();
  assert.equal(harness.press("ArrowUp").prevented, true);
  assert.equal(harness.state.active, 11);
  harness.press("ArrowDown");
  assert.equal(harness.state.active, 0);
  for (let index = 0; index < 7; index += 1) harness.press("ArrowDown");
  assert.equal(harness.state.active, 7);
  assert.equal(harness.press("Enter").prevented, true);
  assert.deepEqual(harness.state.chosen, ["synthetic-7"]);
});

test("Korean composition Enter, arrows and Escape do not choose a customer or alter the list", () => {
  for (const nativeEvent of [{ isComposing: true }, { isComposing: false, keyCode: 229 }]) {
    const harness = keyboardHarness();
    for (const key of ["Enter", "ArrowDown", "Escape"]) assert.equal(harness.press(key, nativeEvent).prevented, false);
    assert.equal(harness.state.open, true);
    assert.equal(harness.state.active, 0);
    assert.deepEqual(harness.state.chosen, []);
    harness.press("Enter", { isComposing: false, keyCode: 13 });
    assert.deepEqual(harness.state.chosen, ["synthetic-0"]);
  }
});

test("Escape closes only the customer list, and empty-result Enter never submits the work form", () => {
  const harness = keyboardHarness({ count: 0 });
  harness.press("ArrowDown");
  assert.equal(harness.state.active, 0);
  assert.equal(harness.press("Enter").prevented, true);
  assert.deepEqual(harness.state.chosen, []);
  const escape = harness.press("Escape");
  assert.equal(escape.prevented, true);
  assert.equal(escape.stopped, true);
  assert.equal(harness.state.open, false);
  assert.equal(harness.press("Escape").stopped, false, "a subsequent Escape remains available to the enclosing editor");
});

test("the scrolling effect follows selection, query results and open state without moving keyboard focus", () => {
  const effect = findNode((node) => ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect");
  assert.equal(effect.arguments[1].getText(ast), "[active, open, matches]");
  const calls = [];
  const results = {};
  for (const open of [false, true]) {
    compile(effect.arguments[0].getText(ast), { open, resultsRef: { current: results }, revealActiveCustomer: (list) => calls.push(list) })();
  }
  assert.deepEqual(calls, [results]);
  const listRef = findNode((node) => ts.isJsxAttribute(node) && node.name.text === "ref");
  assert.equal(listRef.initializer.expression.getText(ast), "resultsRef");
  assert.doesNotMatch(revealNode.getText(ast), /\.focus\(|scrollIntoView|window\.|document\./);
});
