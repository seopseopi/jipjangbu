import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = file => readFileSync(path.join(root, file), "utf8");
const manifest = JSON.parse(read("dist/server/__vite_rsc_assets_manifest.js").trim().replace(/^export default\s+/, "").replace(/;$/, ""));
const layoutCss = manifest.serverResources?.["app/layout.tsx"]?.css ?? [];
assert.equal(layoutCss.length, 1, "the layout must load one complete application stylesheet");
const compiled = read(path.join("dist/client", layoutCss[0].replace(/^\//, "")));
assert.ok(compiled.includes(".renewal-pagination"), "the server-loaded stylesheet must already include the renewed lists");
assert.ok(compiled.includes(".insights-renewal"), "the server-loaded stylesheet must already include the renewed insights");
for (const selector of [".journal-day-group", ".listing-renewal-table", ".customer-renewal-table", ".trash-selectable", ".reference-page-heading", ".reference-home-main", ".reference-filters", ".settings-section", ".structure-page-actions"]) {
  assert.ok(compiled.includes(selector), `the server-loaded stylesheet must include ${selector}`);
}
assert.ok(compiled.lastIndexOf("--canvas:#efeae1") > compiled.indexOf("--canvas:#e5eaf0"), "renewal tokens must follow the original tokens");
const lateCss = Object.entries(manifest.clientReferenceDeps ?? {}).flatMap(([reference, deps]) => (deps.css ?? []).map(file => ({ reference, file })));
assert.deepEqual(lateCss, [], "client references must not inject later styles that change the application cascade");

const entry = "app/application.css";
const visited = new Set();
function followImports(file) {
  if (visited.has(file)) return;
  visited.add(file);
  for (const match of read(file).matchAll(/@import\s+["'](\.[^"']+)["']/g)) {
    followImports(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
  }
}
followImports(entry);
function filesIn(directory) {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(item => {
    const file = path.posix.join(directory, item.name);
    return item.isDirectory() ? filesIn(file) : [file];
  });
}
const appFiles = filesIn("app");
assert.deepEqual(appFiles.filter(file => file.endsWith(".css") && !visited.has(file)), [], "every application stylesheet must be included in the canonical entry");
const directImports = appFiles.filter(file => /\.[jt]sx?$/.test(file)).flatMap(file => [...read(file).matchAll(/^import\s+["']([^"']+\.css)["'];?$/gm)].map(match => `${file}:${match[1]}`));
assert.deepEqual(directImports, ["app/layout.tsx:./application.css"], "styles must be loaded by the layout rather than by lazy components");
const imports = [...read(entry).matchAll(/@import\s+["']\.\/([^"']+)["']/g)].map(match => match[1]);
assert.ok(imports.indexOf("globals.css") < imports.indexOf("renewal.css"));
assert.ok(imports.indexOf("structures/structures.css") < imports.indexOf("renewal.css"));
assert.ok(imports.indexOf("work-reading-list.css") < imports.indexOf("renewal.css"));
assert.ok(imports.indexOf("renewal.css") < imports.indexOf("management-renewal.css"));
assert.ok(imports.indexOf("renewal.css") < imports.indexOf("insights-renewal.css"));
assert.ok(imports.indexOf("management-renewal.css") < imports.indexOf("reference-management.css"));
assert.ok(imports.indexOf("renewal.css") < imports.indexOf("reference-layout.css"));
assert.ok(imports.indexOf("work-form-renewal.css") < imports.indexOf("forms-polish.css"));
console.log(`Verified one server-loaded stylesheet, ${visited.size} source stylesheets and no late client CSS.`);
