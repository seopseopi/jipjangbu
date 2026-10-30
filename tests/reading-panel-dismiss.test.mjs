import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/work-manager.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("work-manager.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let expression;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "handleOutsidePointer") expression = node.initializer.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast); assert.ok(expression);
const js = ts.transpileModule(`const handler = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
class PageNode {}
class PageElement extends PageNode {
  constructor(inside = false, dialogSelector = "") { super(); this.inside = inside; this.dialogSelector = dialogSelector; }
  closest(selector) { return selector.split(",").map(value => value.trim()).includes(this.dialogSelector) ? this : null; }
}
function harness() {
  let closed = 0;
  const state = { sideRef: { current: true }, lockedRef: { current: false }, openModalIds: [1], modalId: 1, cardRef: { current: { contains: node => node.inside } }, closeRef: { current: () => { closed++; } }, Node: PageNode, Element: PageElement };
  return { ...state, closed: () => closed, handler: new Function(...Object.keys(state), `${js}; return handler;`)(...Object.values(state)) };
}
test("clicking the page dismisses its reading panel, while clicks within the panel stay local", () => {
  const h = harness(); h.handler({ target: new PageElement(true) }); assert.equal(h.closed(), 0);
  h.handler({ target: new PageElement() }); assert.equal(h.closed(), 1);
});
test("nested dialogs, mutation locks and a newer modal retain their own interaction", () => {
  const h = harness();
  for (const selector of ['dialog', '[role="dialog"]', '[role="alertdialog"]', '.modal-backdrop']) {
    h.handler({ target: new PageElement(false, selector) }); assert.equal(h.closed(), 0, selector);
  }
  h.lockedRef.current = true; h.handler({ target: new PageElement() }); assert.equal(h.closed(), 0);
  h.lockedRef.current = false; h.openModalIds.push(2); h.handler({ target: new PageElement() }); assert.equal(h.closed(), 0);
  h.openModalIds.pop(); h.sideRef.current = false; h.handler({ target: new PageElement() }); assert.equal(h.closed(), 0);
});
