'use strict';

/**
 * compile/ subsystem — registry (language → toolchain), shared diagnostics
 * parser, the compile_file tool, and build_project's extended ecosystem
 * detection. Real-compiler cases are GUARDED on toolchain presence so the suite
 * stays green on machines without gcc/rustc/etc.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const registry = require('../../../src/services/compile/registry');
const { parseDiagnostics } = require('../../../src/services/compile/diagnostics');
const compileFile = require('../../../src/tools/compileFile');
const buildProject = require('../../../src/tools/buildProject');

function have(bin) {
  try { return spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0; }
  catch { return false; }
}

// ── registry: language resolution ──────────────────────────────────────────
describe('compile/registry — language single source of truth', () => {
  test('resolves aliases to canonical ids', () => {
    assert.equal(registry.getLanguage('c++').id, 'cpp');
    assert.equal(registry.getLanguage('rs').id, 'rust');
    assert.equal(registry.getLanguage('py').id, 'python');
    assert.equal(registry.getLanguage('ts').id, 'typescript');
    assert.equal(registry.getLanguage('golang').id, 'go');
  });

  test('unknown language → null', () => {
    assert.equal(registry.getLanguage('cobol'), null);
  });

  test('languageForFile maps extensions', () => {
    assert.equal(registry.languageForFile('a.c'), 'c');
    assert.equal(registry.languageForFile('a.rs'), 'rust');
    assert.equal(registry.languageForFile('a.unknown'), null);
  });

  test('every language declares a toolchain depId + diagnosticsType + argv builder', () => {
    for (const id of registry.listLanguages()) {
      const lang = registry.getLanguage(id);
      assert.ok(lang.toolchainDepId, `${id} has toolchainDepId`);
      assert.ok(lang.diagnosticsType, `${id} has diagnosticsType`);
      const argv = lang.buildArgv({ src: '/tmp/x' + lang.exts[0], outDir: '/tmp', stem: 'x' });
      assert.ok(Array.isArray(argv) && argv.length > 0, `${id} buildArgv is argv array`);
    }
  });

  // Java environment mojibake fix: javac/java must be pinned to UTF-8 so CN
  // Windows compiler diagnostics and System.out do not turn into garbage, and
  // the language must flag utf8Output so the spawn decodes the pipe as UTF-8.
  test('java compile/run argv pin the JVM to UTF-8 and declare utf8Output', () => {
    const java = registry.getLanguage('java');
    assert.ok(java, 'java language is registered');
    assert.equal(java.utf8Output, true, 'java declares utf8Output so the pipe decodes as UTF-8');

    const build = java.buildArgv({ src: '/tmp/X.java', outDir: '/tmp/o', stem: 'X' });
    assert.ok(build.includes('-encoding'), 'javac declares source -encoding');
    assert.ok(build.includes('-J-Dfile.encoding=UTF-8'), 'javac forwards UTF-8 to its JVM');
    // -encoding must be followed by UTF-8.
    assert.equal(build[build.indexOf('-encoding') + 1], 'UTF-8');

    const run = java.runArgv({ outDir: '/tmp/o', stem: 'X' });
    assert.ok(run.includes('-Dfile.encoding=UTF-8'), 'java run pins file.encoding=UTF-8');
    assert.ok(run.includes('-Dsun.stdout.encoding=UTF-8'), 'java run pins stdout encoding');
  });
});

// ── diagnostics: pure parser (no toolchain needed) ──────────────────────────
describe('compile/diagnostics — structured parse per language', () => {
  test('gcc/clang error grammar', () => {
    const { errors } = parseDiagnostics('main.c:3:10: error: ‘x’ undeclared', 'c');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].line, 3);
    assert.equal(errors[0].col, 10);
    assert.match(errors[0].message, /undeclared/);
  });

  test('rust error grammar with code', () => {
    const { errors } = parseDiagnostics('error[E0308]: mismatched types', 'rust');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'E0308');
  });

  test('tsc grammar', () => {
    const { errors } = parseDiagnostics("a.ts(1,7): error TS2322: Type 'string' is not assignable.", 'typescript');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'TS2322');
  });

  test('python py_compile traceback', () => {
    const out = '  File "x.py", line 2\n    def f(:\n          ^\nSyntaxError: invalid syntax';
    const { errors } = parseDiagnostics(out, 'python');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].line, 2);
    assert.match(errors[0].message, /SyntaxError/);
  });

  test('java grammar (no column)', () => {
    const { errors } = parseDiagnostics('Main.java:1: error: cannot find symbol', 'java');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].line, 1);
  });
});

// ── compile_file: validation (no toolchain needed) ──────────────────────────
describe('compile_file — input validation', () => {
  test('unsupported language returns structured error', async () => {
    const r = await compileFile.execute({ language: 'cobol', code: 'x' });
    assert.equal(r.success, false);
    assert.match(r.error, /Unsupported language/);
  });

  test('missing code AND file returns structured error', async () => {
    const r = await compileFile.execute({ language: 'c' });
    assert.equal(r.success, false);
    assert.match(r.error, /requires either/);
  });
});

// ── compile_file: real compiles (guarded on toolchain presence) ─────────────
describe('compile_file — real compilation diagnostics', () => {
  test('C: valid compiles, invalid yields precise diagnostics', async (t) => {
    if (!have('gcc')) return t.skip('gcc not installed');
    const ok = await compileFile.execute({ language: 'c', code: 'int main(){return 0;}' });
    assert.equal(ok.success, true);
    assert.equal(ok.data.compiled, true);

    const bad = await compileFile.execute({ language: 'c', code: 'int main(){ return undeclared_var; }' });
    assert.equal(bad.success, false);
    assert.ok(bad.data.errorCount >= 1);
    assert.ok(bad.data.errors[0].line >= 1);
    assert.ok(bad.data.nextAction);
  });

  test('Python: syntax check passes/fails', async (t) => {
    if (!have('python3')) return t.skip('python3 not installed');
    const ok = await compileFile.execute({ language: 'python', code: 'print(1+1)' });
    assert.equal(ok.success, true);
    assert.equal(ok.data.checked, true);

    const bad = await compileFile.execute({ language: 'python', code: 'def f(:\n  pass' });
    assert.equal(bad.success, false);
    assert.ok(bad.data.errorCount >= 1);
  });

  test('Rust: invalid yields mismatched-types diagnostic', async (t) => {
    if (!have('rustc')) return t.skip('rustc not installed');
    const bad = await compileFile.execute({ language: 'rust', code: 'fn main(){ let _x: i32 = "s"; }' });
    assert.equal(bad.success, false);
    assert.ok(bad.data.errorCount >= 1);
  });

  test('outputPath persists the artifact', async (t) => {
    if (!have('gcc')) return t.skip('gcc not installed');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-compile-out-'));
    const out = path.join(dir, 'prog');
    try {
      const r = await compileFile.execute({ language: 'c', code: 'int main(){return 0;}', outputPath: out });
      assert.equal(r.success, true);
      assert.ok(r.data.artifact, 'artifact path returned');
      assert.ok(fs.existsSync(r.data.artifact), 'artifact exists on disk');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── build_project: extended ecosystem detection ─────────────────────────────
describe('build_project — extended ecosystem detection', () => {
  // Override the command with a harmless echo so detection (projectType) is
  // exercised WITHOUT invoking the real (possibly absent) build tool.
  async function detectType(markerFile) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-detect-'));
    try {
      fs.writeFileSync(path.join(dir, markerFile), '{}');
      const r = await buildProject.execute({ cwd: dir, command: 'echo detected' });
      return r.data ? r.data.projectType : null;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('*.csproj → dotnet', async () => { assert.equal(await detectType('App.csproj'), 'dotnet'); });
  test('*.sln → dotnet', async () => { assert.equal(await detectType('Sln.sln'), 'dotnet'); });
  test('moon.mod.json → moonbit', async () => { assert.equal(await detectType('moon.mod.json'), 'moonbit'); });
  test('pyproject.toml → python', async () => { assert.equal(await detectType('pyproject.toml'), 'python'); });
  test('meson.build → meson', async () => { assert.equal(await detectType('meson.build'), 'meson'); });
});
