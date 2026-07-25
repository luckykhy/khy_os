'use strict';

/**
 * compile/registry.js — single source of truth mapping a LANGUAGE to its
 * toolchain: how to compile/type-check a single source file, how to run the
 * produced artifact, which dependency (registry depId) provides the toolchain,
 * and which diagnostics parser interprets its output.
 *
 * Consumed by:
 *   - tools/compileFile.js  (compile_file): compile/type-check one file.
 *   - tools/executeCode.js  (Phase 5):       compile-then-run non-JS snippets.
 *
 * Zero hardcoding elsewhere: argv builders return STRING ARRAYS (execFile, no
 * shell) so nothing is string-concatenated from model input.
 *
 * Per-language shape:
 *   {
 *     id, label, exts:[...], bin, toolchainDepId, diagnosticsType,
 *     mode: 'compiled' | 'interpreted' | 'syntax',
 *     artifactPath({outDir, stem}) -> string|null,
 *     buildArgv({src, outDir, stem}) -> string[],     // compile / type-check
 *     runArgv({artifact, outDir, stem, src}) -> string[]|null,  // execute
 *   }
 */

const path = require('path');
const { javacFlags, javaRunFlags } = require('../../utils/javaEncoding');

/** Platform-correct executable name (adds .exe on Windows). */
function _exe(stem) {
  return process.platform === 'win32' ? `${stem}.exe` : stem;
}

/** Derive a Java public class name from the file stem (must be a valid ident). */
function _javaClass(stem) {
  const c = String(stem).replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(c) ? c : `C_${c}`;
}

const LANGUAGES = {
  c: {
    id: 'c', label: 'C (gcc)', exts: ['.c'], bin: 'gcc', toolchainDepId: 'gcc',
    diagnosticsType: 'c', mode: 'compiled',
    artifactPath: ({ outDir, stem }) => path.join(outDir, _exe(stem)),
    buildArgv: ({ src, outDir, stem }) => ['gcc', src, '-o', path.join(outDir, _exe(stem)), '-O2', '-w'],
    runArgv: ({ artifact }) => [artifact],
  },
  cpp: {
    id: 'cpp', label: 'C++ (g++)', exts: ['.cpp', '.cc', '.cxx'], bin: 'g++', toolchainDepId: 'gpp',
    diagnosticsType: 'cpp', mode: 'compiled',
    artifactPath: ({ outDir, stem }) => path.join(outDir, _exe(stem)),
    buildArgv: ({ src, outDir, stem }) => ['g++', src, '-o', path.join(outDir, _exe(stem)), '-O2', '-std=c++17', '-w'],
    runArgv: ({ artifact }) => [artifact],
  },
  rust: {
    id: 'rust', label: 'Rust (rustc)', exts: ['.rs'], bin: 'rustc', toolchainDepId: 'rust',
    diagnosticsType: 'rust', mode: 'compiled',
    artifactPath: ({ outDir, stem }) => path.join(outDir, _exe(stem)),
    buildArgv: ({ src, outDir, stem }) => ['rustc', src, '-o', path.join(outDir, _exe(stem)), '-A', 'warnings'],
    runArgv: ({ artifact }) => [artifact],
  },
  go: {
    id: 'go', label: 'Go', exts: ['.go'], bin: 'go', toolchainDepId: 'go',
    diagnosticsType: 'go', mode: 'compiled',
    artifactPath: ({ outDir, stem }) => path.join(outDir, _exe(stem)),
    buildArgv: ({ src, outDir, stem }) => ['go', 'build', '-o', path.join(outDir, _exe(stem)), src],
    runArgv: ({ artifact }) => [artifact],
  },
  java: {
    id: 'java', label: 'Java (javac)', exts: ['.java'], bin: 'javac', toolchainDepId: 'openjdk',
    diagnosticsType: 'java', mode: 'compiled',
    // We pin the JVM to UTF-8 output via buildArgv/runArgv below, so the consumer
    // must decode the pipe as UTF-8 (not the console code page) for them to agree.
    utf8Output: true,
    artifactPath: ({ outDir, stem }) => path.join(outDir, `${_javaClass(stem)}.class`),
    // Force UTF-8 source charset + UTF-8 JVM stdout/stderr so compiler diagnostics
    // and program output never mojibake on a legacy-locale (GBK) Windows host.
    buildArgv: ({ src, outDir }) => ['javac', ...javacFlags(), '-d', outDir, src],
    runArgv: ({ outDir, stem }) => ['java', ...javaRunFlags(), '-cp', outDir, _javaClass(stem)],
  },
  python: {
    id: 'python', label: 'Python (py_compile syntax check)', exts: ['.py'], bin: 'python3', toolchainDepId: 'python3',
    diagnosticsType: 'python', mode: 'interpreted',
    artifactPath: () => null,
    // compile_file does a syntax check (compileall, no bytecode written to cwd).
    buildArgv: ({ src }) => ['python3', '-m', 'py_compile', src],
    runArgv: ({ src }) => ['python3', src],
  },
  typescript: {
    id: 'typescript', label: 'TypeScript (tsc)', exts: ['.ts'], bin: 'tsc', toolchainDepId: 'typescript',
    diagnosticsType: 'typescript', mode: 'syntax',
    artifactPath: ({ outDir, stem }) => path.join(outDir, `${stem}.js`),
    // Type-check only for compile_file (no emit); execution path emits then runs node.
    buildArgv: ({ src }) => ['tsc', '--noEmit', '--pretty', 'false', src],
    runArgv: ({ outDir, stem }) => ['node', path.join(outDir, `${stem}.js`)],
  },
};

// Build an extension → languageId index once.
const _byExt = {};
for (const lang of Object.values(LANGUAGES)) {
  for (const e of lang.exts) _byExt[e.toLowerCase()] = lang.id;
}

/** Canonicalize an alias to a registry language id (or the input if unknown). */
function _canon(language) {
  const l = String(language || '').trim().toLowerCase();
  const alias = { 'c++': 'cpp', cxx: 'cpp', cc: 'cpp', rs: 'rust', golang: 'go', py: 'python', ts: 'typescript', js: 'javascript' };
  return alias[l] || l;
}

/** Get a language definition by name/alias, or null. */
function getLanguage(language) {
  return LANGUAGES[_canon(language)] || null;
}

/** Infer a language id from a file path's extension, or null. */
function languageForFile(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return _byExt[ext] || null;
}

/** List supported language ids. */
function listLanguages() {
  return Object.keys(LANGUAGES);
}

/** Default source-file extension for a language (for writing snippets). */
function defaultExtension(language) {
  const lang = getLanguage(language);
  return lang ? lang.exts[0] : null;
}

module.exports = {
  LANGUAGES,
  getLanguage,
  languageForFile,
  listLanguages,
  defaultExtension,
  _canon,
  _exe,
  _javaClass,
};
