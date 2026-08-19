// build.mjs — bundle mermaid into a self-contained offline asset at
// docs/_assets/mermaid.min.js, loaded by every page the doc-site generator emits.
//
// Output (gitignored): docs/_assets/mermaid.min.js. All diagram back-ends are
// inlined (no code splitting, no dynamic fetch) so the doc site stays fully
// offline — that is a hard constraint stated in build_docs_site.js's header.
//
// Rebuild after bumping mermaid:  npm install && node build.mjs

import { build } from 'esbuild';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const outfile = resolve(root, 'docs', '_assets', 'mermaid.min.js');

await build({
  entryPoints: [resolve(here, 'entry.mjs')],
  bundle: true,
  format: 'iife',
  splitting: false,
  minify: true,
  sourcemap: false,
  outfile,
  target: ['es2020'],
  legalComments: 'none',
  // mermaid 的依赖树里有库读 process.env.NODE_ENV 做 dev 断言分支；浏览器里没有
  // process，不 define 会在运行时抛 ReferenceError。
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});

const bytes = statSync(outfile).size;
console.log(`[build] docs/_assets/mermaid.min.js written: ${(bytes / 1048576).toFixed(2)} MiB`);
