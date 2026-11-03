import React from "react";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../../app/listing-scroll-loader.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("listing-scroll-loader.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "ListingScrollLoader");
const compiled = ts.transpileModule(declaration.getText(ast).replace(/^export /, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
export const ListingScrollLoader = new Function("React", "useEffect", "useRef", `${compiled}; return ListingScrollLoader;`)(React, React.useEffect, React.useRef);
