import { mkdir, copyFile, readFile } from "node:fs/promises";

// Serve the unmodified upstream worker as a static asset. Vite's development
// error overlay assumes `window` and must not be injected into a Web Worker.
const root = new URL("../", import.meta.url);
const source = new URL("node_modules/pdfjs-dist/", root);
const { version } = JSON.parse(await readFile(new URL("package.json", source), "utf8"));
const destination = new URL("public/pdfjs/", root);
await mkdir(destination, { recursive: true });
await copyFile(new URL("build/pdf.worker.min.mjs", source), new URL(`pdf.worker-${version}.mjs`, destination));
await copyFile(new URL("LICENSE", source), new URL("LICENSE", destination));
