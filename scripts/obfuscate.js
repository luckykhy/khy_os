#!/usr/bin/env node
/**
 * @pattern Command, Strategy
 */
/**
 * Obfuscate all .js files in a target directory using javascript-obfuscator.
 *
 * Usage:  node scripts/obfuscate.js <target-dir>
 * Example: node scripts/obfuscate.js khy_os/bundled/backend/src
 *
 * Applies high-strength obfuscation to make reverse-engineering impractical:
 * - Control flow flattening (breaks logical structure)
 * - String array encryption with RC4 (hides all string literals)
 * - Dead code injection (adds noise)
 * - Identifier renaming to hex (removes semantic meaning)
 * - Unicode escape sequences (obscures remaining readable text)
 * - Split strings (fragments string constants)
 *
 * Files are obfuscated IN PLACE — only run on expendable copies (e.g. bundled/).
 */
const fs = require('fs');
const path = require('path');

// Resolve javascript-obfuscator from backend/node_modules
// (it's a devDependency there, not globally installed)
const ROOT = path.resolve(__dirname, '..');
const modulePaths = [
  path.join(ROOT, 'node_modules', 'javascript-obfuscator'),
  path.join(ROOT, 'backend', 'node_modules', 'javascript-obfuscator'),
  'javascript-obfuscator', // fallback to global
];

let JavaScriptObfuscator;
for (const mp of modulePaths) {
  try { JavaScriptObfuscator = require(mp); break; } catch { /* next */ }
}
if (!JavaScriptObfuscator) {
  console.error('Cannot find javascript-obfuscator. Run: cd backend && npm install');
  process.exit(1);
}

const targetDir = process.argv[2];
if (!targetDir) {
  console.error('Usage: node scripts/obfuscate.js <target-dir>');
  process.exit(1);
}

if (!fs.existsSync(targetDir)) {
  console.error(`Target directory does not exist: ${targetDir}`);
  process.exit(1);
}

// Maximum-strength obfuscation — designed to be unrecoverable by AI.
// Even with access to the obfuscated code, language models should not
// be able to reconstruct meaningful source or business logic.
const OBFUSCATION_OPTIONS = {
  // ── Control flow destruction ─────────────────────────────────────
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 1,   // 100% — flatten ALL control flow

  // ── Dead code noise ──────────────────────────────────────────────
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.7,     // 70% — heavy noise injection

  // ── String encryption (RC4 + base64 double layer) ────────────────
  stringArray: true,
  stringArrayEncoding: ['rc4'],
  stringArrayThreshold: 1,             // 100% — encrypt ALL strings
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 5,         // 5 layers of wrapper indirection
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersType: 'function',
  stringArrayIndexShift: true,         // shift indices to break pattern matching
  stringArrayCallsTransform: true,     // transform string array call sites
  stringArrayCallsTransformThreshold: 1,

  // ── String fragmentation ─────────────────────────────────────────
  splitStrings: true,
  splitStringsChunkLength: 3,          // 3-char fragments — extremely granular

  // ── Identifier destruction ───────────────────────────────────────
  identifierNamesGenerator: 'mangled-shuffled', // shorter + shuffled names
  renameGlobals: false,                // must be false for Node.js require()
  renameProperties: false,             // must be false for module.exports

  // ── Unicode + escape obfuscation ─────────────────────────────────
  unicodeEscapeSequence: true,

  // ── Object/property obfuscation ──────────────────────────────────
  transformObjectKeys: true,

  // ── Number obfuscation ───────────────────────────────────────────
  numbersToExpressions: true,

  // ── Node.js compatibility (must stay disabled) ───────────────────
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,

  // ── Target ───────────────────────────────────────────────────────
  target: 'node',

  // ── Randomize each build (non-deterministic → harder to diff) ────
  seed: 0,

  // ── Simplify (disabled to preserve maximum obfuscation depth) ────
  simplify: false,
};

// Files/directories to skip (config, entry points that need readable paths)
const SKIP_PATTERNS = [
  'node_modules',
  'package.json',
  'package-lock.json',
  '.env',
];

function shouldSkip(filePath) {
  return SKIP_PATTERNS.some(p => filePath.includes(p));
}

function getAllJsFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkip(fullPath)) {
        results.push(...getAllJsFiles(fullPath));
      }
    } else if (entry.isFile() && entry.name.endsWith('.js') && !shouldSkip(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────
const files = getAllJsFiles(targetDir);
console.log(`Obfuscating ${files.length} JS files in ${targetDir}...`);

let success = 0;
let failed = 0;

for (const file of files) {
  try {
    const code = fs.readFileSync(file, 'utf8');

    // Skip very small files (likely just module.exports re-exports)
    if (code.length < 50) {
      success++;
      continue;
    }

    const result = JavaScriptObfuscator.obfuscate(code, OBFUSCATION_OPTIONS);
    fs.writeFileSync(file, result.getObfuscatedCode(), 'utf8');
    success++;
  } catch (err) {
    console.error(`  [WARN] Failed to obfuscate ${path.relative(targetDir, file)}: ${err.message}`);
    // Leave original file in place on failure
    failed++;
  }
}

console.log(`Done: ${success} obfuscated, ${failed} failed (of ${files.length} total)`);
process.exit(failed > files.length * 0.1 ? 1 : 0); // fail if >10% error rate
