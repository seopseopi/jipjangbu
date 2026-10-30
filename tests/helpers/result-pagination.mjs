import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import ts from "typescript";

// Run the production pagination hook with controlled state instead of calling
// React hooks outside a component in the source-level workflow harnesses.
const hookSource = readFileSync(new URL("../../app/result-pagination.ts", import.meta.url), "utf8");
const hookAst = ts.createSourceFile("result-pagination.ts", hookSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const hookFunctions = hookAst.statements.filter(ts.isFunctionDeclaration).map((node) => node.getText(hookAst).replace(/^export /, "")).join("\n");
const hookJs = ts.transpileModule(hookFunctions, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;

export function resultPaginationHarness() {
  const states = [], refs = [], effectDeps = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0, effects = [], changed = false;
  const hooks = {
    useState(initial) {
      const index = stateIndex++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], (value) => {
        const next = typeof value === "function" ? value(states[index]) : value;
        if (!Object.is(next, states[index])) { states[index] = next; changed = true; }
      }];
    },
    useRef(initial) { return refs[refIndex++] ??= { current: initial }; },
    useEffect(effect, deps) {
      const index = effectIndex++, before = effectDeps[index];
      if (!before || !deps || deps.some((value, cursor) => !Object.is(value, before[cursor]))) {
        effectDeps[index] = deps;
        effects.push(effect);
      }
    },
  };
  const actual = new Function(...Object.keys(hooks), `${hookJs}; return { useResultPage, useResultListRef, resultPageBounds };`)(...Object.values(hooks));
  return {
    ...actual,
    render(callback) {
      let result;
      for (let pass = 0; pass < 10; pass++) {
        stateIndex = 0; refIndex = 0; effectIndex = 0; effects = []; changed = false;
        result = callback();
        for (const effect of effects) effect();
        if (!changed) return result;
      }
      assert.fail("pagination hook did not settle");
    },
  };
}

const managerSource = readFileSync(new URL("../../app/work-manager.tsx", import.meta.url), "utf8");
const managerAst = ts.createSourceFile("work-manager.tsx", managerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const pagination = managerAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "ResultPagination");
assert.ok(pagination, "production result pagination exists");
const componentJs = ts.transpileModule(pagination.getText(managerAst), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText;
export const ResultPagination = new Function("React", "Icon", `${componentJs}; return ResultPagination;`)(React, () => null);
export const initialResultPage = (...args) => {
  const harness = resultPaginationHarness();
  return harness.render(() => harness.useResultPage(...args));
};

export const initialResultListRef = (...args) => {
  const harness = resultPaginationHarness();
  return harness.render(() => harness.useResultListRef(...args));
};
