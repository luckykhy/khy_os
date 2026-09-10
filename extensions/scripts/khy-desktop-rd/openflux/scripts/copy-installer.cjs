'use strict';

/**
 * copy-installer.cjs — copy the Tauri NSIS installer into ./output.
 *
 * The Rust build directory comes from CARGO_TARGET_DIR (standard cargo env),
 * with the cargo default of ./target as fallback — never a machine-local path.
 */

const fs = require('fs');
const path = require('path');

const cargoTargetDir = process.env.CARGO_TARGET_DIR || path.join(process.cwd(), 'target');
const srcDir = path.join(cargoTargetDir, 'openflux-rust', 'release', 'bundle', 'nsis');
const outDir = path.join(process.cwd(), 'output');

fs.mkdirSync(outDir, { recursive: true });

const installers = fs.existsSync(srcDir)
  ? fs.readdirSync(srcDir).filter((f) => f.endsWith('.exe'))
  : [];

if (installers.length === 0) {
  console.error(`[copy-installer] No NSIS installer found in ${srcDir} — build with "tauri build --bundles nsis" first.`);
  process.exit(1);
}

for (const f of installers) {
  fs.copyFileSync(path.join(srcDir, f), path.join(outDir, f));
  console.log(`[copy-installer] Copied ${f} -> output\\`);
}
