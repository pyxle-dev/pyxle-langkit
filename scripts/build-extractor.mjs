#!/usr/bin/env node
/**
 * Bundle the JSX component extractor + its Babel dependencies into a single
 * self-contained ESM file (`jsx_component_extractor.bundle.mjs`) that runs with
 * zero npm setup. This is what ships in the wheel so `pyxle check` works on a
 * clean `pip install 'pyxle-framework[langkit]'` (the raw source `.mjs` imports
 * @babel/parser + @babel/traverse, which pip does not install).
 *
 * The `createRequire` banner is required: Babel's transitive deps do dynamic
 * `require()` of Node built-ins (e.g. `tty`), which esbuild's ESM output cannot
 * resolve without a real `require` in scope. CJS output is not an option — the
 * extractor uses top-level `await`.
 *
 * Re-run after editing `jsx_component_extractor.mjs`:  npm run build:extractor
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [join(root, "pyxle_langkit/js/jsx_component_extractor.mjs")],
  outfile: join(root, "pyxle_langkit/js/jsx_component_extractor.bundle.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});

console.log("Built pyxle_langkit/js/jsx_component_extractor.bundle.mjs");
