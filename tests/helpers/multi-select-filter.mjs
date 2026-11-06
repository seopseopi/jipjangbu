import { readFileSync } from "node:fs";
import React from "react";
import ts from "typescript";
const source = readFileSync(new URL("../../app/multi-select-filter.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source.replace(/^import .*$/gm, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
}).outputText.replace(/^export /gm, "");
export const MultiSelectFilter = new Function("React", "useRef", "useEffect", `${compiled}; return MultiSelectFilter;`)(React, () => ({current: null}), () => {});
