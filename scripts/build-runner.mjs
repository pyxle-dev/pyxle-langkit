#!/usr/bin/env node
/**
 * Bundle the React parser runner + its Babel dependency into a single
 * self-contained ESM file (`react_parser_runner.bundle.mjs`) that runs with
 * zero npm setup — exactly like the JSX component extractor bundle. This is
 * what ships in the wheel so `pyxle-langkit lint`'s React analysis works on a
 * clean pip install (the raw source `.mjs` imports @babel/parser, which pip
 * does not install; Node resolves bare imports from the runner's own
 * directory, not the linted project, so app node_modules never help).
 *
 * The `createRequire` banner is required for the same reason as the
 * extractor: Babel's transitive deps do dynamic `require()` of Node
 * built-ins, which esbuild's ESM output cannot resolve otherwise.
 *
 * Re-run after editing `react_parser_runner.mjs`:  npm run build:runner
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [join(root, "pyxle_langkit/js/react_parser_runner.mjs")],
  outfile: join(root, "pyxle_langkit/js/react_parser_runner.bundle.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});

console.log("Built pyxle_langkit/js/react_parser_runner.bundle.mjs");
