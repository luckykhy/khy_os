// build.mjs — bundle @muyajs/core (MarkText's editor engine) + plugins into a
// self-contained offline asset under ../vendor/, served same-origin by the bridge.
//
// Output (committed + shipped): vendor/khyos-muya.js (+ code-split mermaid/vega
// chunks) and vendor/khyos-muya.css. All images/fonts are inlined as data URLs so
// the bundle stays fully offline with no external asset fetches.
//
// Rebuild after bumping @muyajs/core:  npm install && node build.mjs

import { build } from 'esbuild';
import { rmSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(here, '..', 'vendor');

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const ASSET_LOADERS = {
  '.png': 'dataurl',
  '.jpg': 'dataurl',
  '.jpeg': 'dataurl',
  '.gif': 'dataurl',
  '.webp': 'dataurl',
  '.svg': 'dataurl',
  '.woff': 'dataurl',
  '.woff2': 'dataurl',
  '.ttf': 'dataurl',
  '.eot': 'dataurl',
};

// IIFE single-file bundle: esbuild inlines mermaid/vega dynamic imports into one
// self-contained file instead of emitting 600+ code-split chunks. Trades lazy
// diagram loading for a one-time parse — acceptable for an on-demand editor, and
// far cleaner to commit/ship (2 files: khyos-muya.js + khyos-muya.css).
await build({
  entryPoints: { 'khyos-muya': resolve(here, 'entry.mjs') },
  bundle: true,
  format: 'iife',
  splitting: false,
  minify: true,
  sourcemap: false,
  outdir,
  target: ['es2020'],
  loader: ASSET_LOADERS,
  legalComments: 'none',
  logLevel: 'info',
});

// Emit a manifest listing the produced files + total size (for packaging sanity).
function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, base));
    else out.push({ file: full.slice(base.length + 1), bytes: st.size });
  }
  return out;
}
const files = walk(outdir).sort((a, b) => b.bytes - a.bytes);
const total = files.reduce((n, f) => n + f.bytes, 0);
writeFileSync(
  join(outdir, 'MANIFEST.json'),
  JSON.stringify({ engine: '@muyajs/core@0.2.0', totalBytes: total, files }, null, 2),
);
console.log(`[build] vendor/ written: ${files.length} files, ${(total / 1048576).toFixed(2)} MiB`);
for (const f of files.slice(0, 8)) console.log(`  ${(f.bytes / 1024).toFixed(0)} KiB  ${f.file}`);
