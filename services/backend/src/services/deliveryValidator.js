/**
 * Delivery Validator — cross-platform artifact deliverability verification.
 *
 * Validates whether a project's build artifacts can be delivered on
 * macOS, Linux, and Windows. Supports Node.js, Python, WASM, and Docker.
 *
 * Score-based assessment (0-100):
 *   error = -15, warning = -5, info = -1
 *   >= 80 = pass, >= 50 = warn, < 50 = fail
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// SSOT: the delivery target platforms this validator assesses
// (macOS, Linux, Windows — see file header). Frozen so the shared list
// cannot be mutated; copy with [...] before storing on a mutable issue.
const TARGET_PLATFORMS = Object.freeze(['win32', 'darwin', 'linux']);

// ─── Known Native Modules (require platform-specific compilation) ──────────

const NATIVE_MODULES = new Set([
  'better-sqlite3', 'sharp', 'bcrypt', 'canvas', 'node-gyp',
  'node-sass', 'sqlite3', 'grpc', 'cpu-features', 'fsevents',
  'keytar', 'usb', 'serialport', 'robotjs', 'ffi-napi',
  'ref-napi', 'node-hid', 'electron', 'sodium-native',
  'bufferutil', 'utf-8-validate', 'farmhash', 'leveldown',
]);

// Modules that only work on specific platforms
const PLATFORM_SPECIFIC_MODULES = {
  'fsevents':   { platforms: ['darwin'], note: 'macOS-only file watching' },
  'win-version-info': { platforms: ['win32'], note: 'Windows-only' },
  'windows-mutex': { platforms: ['win32'], note: 'Windows-only' },
  'macos-alias': { platforms: ['darwin'], note: 'macOS-only' },
};

// Python packages that are platform-specific
const PYTHON_PLATFORM_DEPS = {
  'pywin32':        { platforms: ['win32'], note: 'Windows COM automation' },
  'pywinpty':       { platforms: ['win32'], note: 'Windows pseudo-terminal' },
  'wmi':            { platforms: ['win32'], note: 'Windows Management Instrumentation' },
  'pyobjc':         { platforms: ['darwin'], note: 'macOS Objective-C bridge' },
  'pyobjc-core':    { platforms: ['darwin'], note: 'macOS Objective-C bridge' },
  'appkit':         { platforms: ['darwin'], note: 'macOS AppKit' },
  'linux-procfs':   { platforms: ['linux'], note: 'Linux /proc filesystem' },
  'python-xlib':    { platforms: ['linux'], note: 'Linux X11 bindings' },
  'dbus-python':    { platforms: ['linux'], note: 'Linux D-Bus bindings' },
  'systemd-python': { platforms: ['linux'], note: 'Linux systemd bindings' },
};

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ValidationIssue
 * @property {string} file
 * @property {number|null} line
 * @property {'error'|'warning'|'info'} severity
 * @property {string} rule
 * @property {string} message
 * @property {string[]} platforms
 */

/**
 * @typedef {Object} ValidationReport
 * @property {string} projectPath
 * @property {string} projectType
 * @property {number} score
 * @property {'pass'|'warn'|'fail'} verdict
 * @property {ValidationIssue[]} issues
 * @property {{ win32: boolean, darwin: boolean, linux: boolean }} platformReady
 * @property {number} durationMs
 */

// ─── Main Entry ────────────────────────────────────────────────────────────

/**
 * Validate a project for cross-platform delivery readiness.
 * @param {string} projectPath
 * @param {object} [options]
 * @param {string[]|null} [options.types] - Force project types to validate
 * @param {string[]|null} [options.platforms] - Limit to specific platforms
 * @param {boolean} [options.verbose] - Include info-level issues
 * @returns {Promise<ValidationReport>}
 */
async function validate(projectPath, options = {}) {
  const startMs = Date.now();
  const resolvedPath = path.resolve(projectPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Path not found: ${resolvedPath}`);
  }

  const projectType = options.types ? options.types[0] : detectProjectType(resolvedPath);

  /** @type {ValidationReport} */
  const report = {
    projectPath: resolvedPath,
    projectType,
    score: 100,
    verdict: 'pass',
    issues: [],
    platformReady: { win32: true, darwin: true, linux: true },
    durationMs: 0,
  };

  // Run validators based on project type
  const types = options.types || [projectType];
  for (const type of types) {
    switch (type) {
      case 'nodejs':  await validateNodejs(resolvedPath, report); break;
      case 'python':  await validatePython(resolvedPath, report); break;
      case 'wasm':    await validateWasm(resolvedPath, report); break;
      case 'docker':  await validateDocker(resolvedPath, report); break;
    }
  }

  // Filter by platform if requested
  if (options.platforms) {
    report.issues = report.issues.filter(issue =>
      issue.platforms.length === 0 ||
      issue.platforms.some(p => options.platforms.includes(p))
    );
  }

  // Filter info-level if not verbose
  if (!options.verbose) {
    report.issues = report.issues.filter(i => i.severity !== 'info');
  }

  // Compute score
  for (const issue of report.issues) {
    if (issue.severity === 'error') report.score -= 15;
    else if (issue.severity === 'warning') report.score -= 5;
    else report.score -= 1;
  }
  report.score = Math.max(0, report.score);

  // Verdict
  report.verdict = report.score >= 80 ? 'pass' : report.score >= 50 ? 'warn' : 'fail';

  // Platform readiness
  for (const platform of TARGET_PLATFORMS) {
    const hasErrors = report.issues.some(i =>
      i.severity === 'error' && i.platforms.includes(platform)
    );
    report.platformReady[platform] = !hasErrors;
  }

  report.durationMs = Date.now() - startMs;
  return report;
}

// ─── Project Type Detection ────────────────────────────────────────────────

function detectProjectType(projectPath) {
  const stat = fs.statSync(projectPath);
  const dir = stat.isDirectory() ? projectPath : path.dirname(projectPath);

  if (fs.existsSync(path.join(dir, 'package.json'))) return 'nodejs';
  if (fs.existsSync(path.join(dir, 'setup.py')) ||
      fs.existsSync(path.join(dir, 'pyproject.toml')) ||
      fs.existsSync(path.join(dir, 'requirements.txt'))) return 'python';
  if (_hasWasmFiles(dir)) return 'wasm';
  if (fs.existsSync(path.join(dir, 'Dockerfile'))) return 'docker';
  return 'unknown';
}

function _hasWasmFiles(dir) {
  try {
    return fs.readdirSync(dir).some(f => f.endsWith('.wasm'));
  } catch { return false; }
}

// ─── Node.js Validator ─────────────────────────────────────────────────────

async function validateNodejs(projectPath, report) {
  const pkgPath = path.join(projectPath, 'package.json');
  if (!fs.existsSync(pkgPath)) return;

  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); }
  catch { _addIssue(report, 'package.json', null, 'error', 'node/invalid-package', 'Invalid package.json', []); return; }

  // 1. Native module dependencies
  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  for (const dep of Object.keys(allDeps)) {
    if (NATIVE_MODULES.has(dep)) {
      _addIssue(report, 'package.json', null, 'warning', 'node/native-module',
        `Native module "${dep}" requires platform-specific compilation`, [...TARGET_PLATFORMS]);
    }
    if (PLATFORM_SPECIFIC_MODULES[dep]) {
      const info = PLATFORM_SPECIFIC_MODULES[dep];
      const affected = TARGET_PLATFORMS.filter(p => !info.platforms.includes(p));
      _addIssue(report, 'package.json', null, 'error', 'node/platform-dep',
        `"${dep}" only works on ${info.platforms.join(', ')} (${info.note})`, affected);
    }
  }

  // 2. Engines field check
  if (!pkg.engines) {
    _addIssue(report, 'package.json', null, 'info', 'node/no-engines',
      'No "engines" field — consumers cannot verify Node.js version compatibility', []);
  }

  // 3. Scan JS/TS files for hardcoded paths and line endings
  const sourceFiles = _findSourceFiles(projectPath, ['.js', '.ts', '.mjs', '.cjs'], 200);
  for (const file of sourceFiles) {
    _scanFileForPathIssues(file, projectPath, report, 'node');
  }

  // 4. Check for shebang in bin entries
  if (pkg.bin) {
    const bins = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : pkg.bin;
    for (const [name, binPath] of Object.entries(bins)) {
      const absPath = path.join(projectPath, binPath);
      if (fs.existsSync(absPath)) {
        const head = _readHead(absPath, 256);
        if (head.startsWith('#!')) {
          _addIssue(report, binPath, 1, 'info', 'node/shebang',
            `Shebang "${head.split('\n')[0]}" — Windows requires .cmd wrapper`, ['win32']);
        }
      }
    }
  }
}

// ─── Python Validator ──────────────────────────────────────────────────────

async function validatePython(projectPath, report) {
  // Parse requirements
  const reqFiles = ['requirements.txt', 'requirements-dev.txt', 'requirements_dev.txt'];
  const deps = new Set();

  for (const rf of reqFiles) {
    const reqPath = path.join(projectPath, rf);
    if (!fs.existsSync(reqPath)) continue;
    const lines = fs.readFileSync(reqPath, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
      const pkgName = trimmed.split(/[>=<!\[\]]/)[0].trim().toLowerCase();
      if (pkgName) deps.add(pkgName);
    }
  }

  // Also parse setup.py install_requires if accessible
  const setupPy = path.join(projectPath, 'setup.py');
  if (fs.existsSync(setupPy)) {
    const content = fs.readFileSync(setupPy, 'utf-8');
    const installReqs = content.match(/install_requires\s*=\s*\[([\s\S]*?)\]/);
    if (installReqs) {
      const matches = installReqs[1].matchAll(/['"]([^'"]+)['"]/g);
      for (const m of matches) {
        const pkgName = m[1].split(/[>=<!\[\]]/)[0].trim().toLowerCase();
        if (pkgName) deps.add(pkgName);
      }
    }
  }

  // 1. Platform-specific dependency check
  for (const dep of deps) {
    if (PYTHON_PLATFORM_DEPS[dep]) {
      const info = PYTHON_PLATFORM_DEPS[dep];
      const affected = TARGET_PLATFORMS.filter(p => !info.platforms.includes(p));
      _addIssue(report, 'requirements', null, 'error', 'python/platform-dep',
        `"${dep}" only works on ${info.platforms.join(', ')} (${info.note})`, affected);
    }
  }

  // 2. Check wheel tags in dist/ if present
  const distDir = path.join(projectPath, 'dist');
  if (fs.existsSync(distDir)) {
    try {
      const wheels = fs.readdirSync(distDir).filter(f => f.endsWith('.whl'));
      for (const whl of wheels) {
        // Wheel filename: name-version(-build)-(python)-(abi)-(platform).whl
        if (whl.includes('linux') && !whl.includes('manylinux')) {
          _addIssue(report, `dist/${whl}`, null, 'warning', 'python/wheel-tag',
            'Wheel is linux-specific, not manylinux — may not work on all Linux distros', ['linux']);
        }
        if (whl.includes('win') || whl.includes('macosx')) {
          const platform = whl.includes('win') ? 'Windows' : 'macOS';
          _addIssue(report, `dist/${whl}`, null, 'info', 'python/wheel-platform',
            `Wheel is ${platform}-specific`, []);
        }
      }
    } catch { /* ignore */ }
  }

  // 3. Scan .py files for path issues
  const pyFiles = _findSourceFiles(projectPath, ['.py'], 100);
  for (const file of pyFiles) {
    _scanPythonPathIssues(file, projectPath, report);
  }
}

// ─── WASM Validator ────────────────────────────────────────────────────────

async function validateWasm(projectPath, report) {
  // Find .wasm files
  const wasmFiles = [];
  _findFiles(projectPath, '.wasm', wasmFiles, 3);

  if (wasmFiles.length === 0) {
    _addIssue(report, '*', null, 'warning', 'wasm/no-files',
      'No .wasm files found in project', []);
    return;
  }

  for (const wasmFile of wasmFiles) {
    const relPath = path.relative(projectPath, wasmFile);
    const stat = fs.statSync(wasmFile);

    // Size check
    if (stat.size > 50 * 1024 * 1024) {
      _addIssue(report, relPath, null, 'warning', 'wasm/large-module',
        `WASM module is ${(stat.size / 1024 / 1024).toFixed(1)} MB — may be slow to load`, []);
    }

    // Try to compile
    try {
      const buffer = fs.readFileSync(wasmFile);
      const module = new WebAssembly.Module(buffer);

      // Check exports
      const exports = WebAssembly.Module.exports(module);
      const funcExports = exports.filter(e => e.kind === 'function');
      if (funcExports.length === 0) {
        _addIssue(report, relPath, null, 'warning', 'wasm/no-exports',
          'WASM module has no function exports', []);
      }

      // Check imports (host dependencies)
      const imports = WebAssembly.Module.imports(module);
      if (imports.length > 0) {
        const modules = [...new Set(imports.map(i => i.module))];
        _addIssue(report, relPath, null, 'info', 'wasm/imports',
          `Requires host imports from: ${modules.join(', ')}`, []);
      }

      // Check memory
      const memExports = exports.filter(e => e.kind === 'memory');
      const memImports = imports.filter(e => e.kind === 'memory');
      if (memExports.length === 0 && memImports.length === 0) {
        _addIssue(report, relPath, null, 'info', 'wasm/no-memory',
          'No memory exported or imported — module is pure compute', []);
      }
    } catch (err) {
      _addIssue(report, relPath, null, 'error', 'wasm/compile-error',
        `Failed to compile: ${err.message}`, []);
    }
  }
}

// ─── Docker Validator ──────────────────────────────────────────────────────

async function validateDocker(projectPath, report) {
  const dockerfile = _resolveDockerfile(projectPath);
  if (!dockerfile) {
    _addIssue(report, '*', null, 'error', 'docker/no-dockerfile',
      'No Dockerfile found', []);
    return;
  }

  const content = fs.readFileSync(dockerfile, 'utf-8');
  const lines = content.split('\n');
  const dockerRelPath = path.relative(projectPath, dockerfile) || 'Dockerfile';
  const dockerDir = path.dirname(dockerfile);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Check FROM base images
    if (line.startsWith('FROM')) {
      const image = line.replace(/^FROM\s+/, '').split(/\s+/)[0];
      if (image.includes('windows')) {
        _addIssue(report, dockerRelPath, i + 1, 'warning', 'docker/windows-base',
          `Windows base image "${image}" — only runs on Windows hosts with Windows containers`, ['linux', 'darwin']);
      }
    }

    // Check COPY with absolute paths
    if (line.startsWith('COPY') || line.startsWith('ADD')) {
      if (/[A-Z]:\\/.test(line)) {
        _addIssue(report, dockerRelPath, i + 1, 'error', 'docker/windows-path',
          'Windows-style path in COPY/ADD — will fail on Linux/macOS Docker hosts', ['linux', 'darwin']);
      }
    }

    // Check RUN with platform-specific commands
    if (line.startsWith('RUN')) {
      if (line.includes('apt-get') || line.includes('yum') || line.includes('apk')) {
        // Linux package managers are fine in Docker (expected)
      }
      if (line.includes('brew install')) {
        _addIssue(report, dockerRelPath, i + 1, 'warning', 'docker/macos-command',
          'Homebrew in Dockerfile — typically used in macOS, unusual in containers', []);
      }
    }
  }

  // Check .dockerignore (prefer Dockerfile directory, then project root)
  const hasDockerIgnore = fs.existsSync(path.join(dockerDir, '.dockerignore'))
    || fs.existsSync(path.join(projectPath, '.dockerignore'));
  if (!hasDockerIgnore) {
    _addIssue(report, '*', null, 'info', 'docker/no-ignore',
      'No .dockerignore — build context may include unnecessary files', []);
  }
}

function _resolveDockerfile(projectPath) {
  const direct = path.join(projectPath, 'Dockerfile');
  if (fs.existsSync(direct)) return direct;

  const common = ['backend', 'ai-backend', 'frontend', 'packages/backend', 'packages/frontend']
    .map(dir => path.join(projectPath, dir, 'Dockerfile'));
  for (const candidate of common) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const stack = [{ dir: projectPath, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    if (depth > 2) continue;

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === 'Dockerfile') return full;
      if (entry.isDirectory()) stack.push({ dir: full, depth: depth + 1 });
    }
  }
  return null;
}

// ─── File Scanning Helpers ─────────────────────────────────────────────────

function _scanFileForPathIssues(filePath, projectPath, report, prefix) {
  const relPath = path.relative(projectPath, filePath);
  let content;
  try { content = fs.readFileSync(filePath, 'utf-8'); }
  catch { return; }

  const lines = content.split('\n');

  for (let i = 0; i < Math.min(lines.length, 500); i++) {
    const line = lines[i];

    // Hardcoded Unix absolute paths (not in comments/strings is hard to detect,
    // so we look for obvious patterns in code)
    if (/['"`]\/(?:usr|etc|opt|home|var|tmp)\//.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('*')) {
      _addIssue(report, relPath, i + 1, 'warning', `${prefix}/hardcoded-unix-path`,
        'Hardcoded Unix path — will fail on Windows', ['win32']);
    }

    // Hardcoded Windows paths
    if (/['"`][A-Z]:\\/.test(line)) {
      _addIssue(report, relPath, i + 1, 'warning', `${prefix}/hardcoded-win-path`,
        'Hardcoded Windows path — will fail on Unix', ['linux', 'darwin']);
    }
  }

  // Line ending check (CRLF)
  if (content.includes('\r\n')) {
    const crlfCount = (content.match(/\r\n/g) || []).length;
    const lfCount = (content.match(/(?<!\r)\n/g) || []).length;
    if (crlfCount > lfCount) {
      _addIssue(report, relPath, null, 'info', `${prefix}/crlf`,
        'File uses CRLF line endings — may cause issues with Unix shebang or git diff', []);
    }
  }
}

function _scanPythonPathIssues(filePath, projectPath, report) {
  const relPath = path.relative(projectPath, filePath);
  let content;
  try { content = fs.readFileSync(filePath, 'utf-8'); }
  catch { return; }

  const lines = content.split('\n');
  for (let i = 0; i < Math.min(lines.length, 500); i++) {
    const line = lines[i];
    if (line.trim().startsWith('#')) continue;

    // os.path.join with hardcoded separator
    if (/['"]\/['"]/.test(line) && line.includes('os.path')) {
      // Probably fine, os.path handles it
    }

    // Direct path separator usage
    if (/['"`]\/(?:usr|etc|opt|home|var)\//.test(line)) {
      _addIssue(report, relPath, i + 1, 'warning', 'python/hardcoded-unix-path',
        'Hardcoded Unix path — use pathlib.Path or os.path.join', ['win32']);
    }
    if (/['"`][A-Z]:\\/.test(line)) {
      _addIssue(report, relPath, i + 1, 'warning', 'python/hardcoded-win-path',
        'Hardcoded Windows path — use pathlib.Path or os.path.join', ['linux', 'darwin']);
    }
  }
}

function _findSourceFiles(projectPath, extensions, maxFiles) {
  const results = [];
  const skipDirs = new Set(['node_modules', '.git', '__pycache__', '.venv', 'dist', 'build', 'vendor', '.tox']);

  function walk(dir, depth) {
    if (depth > 5 || results.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name) && !entry.name.startsWith('.')) {
          walk(path.join(dir, entry.name), depth + 1);
        }
      } else if (extensions.some(ext => entry.name.endsWith(ext))) {
        results.push(path.join(dir, entry.name));
      }
    }
  }

  walk(projectPath, 0);
  return results;
}

function _findFiles(dir, ext, results, maxDepth, depth = 0) {
  if (depth > maxDepth || results.length > 20) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        _findFiles(path.join(dir, entry.name), ext, results, maxDepth, depth + 1);
      } else if (entry.name.endsWith(ext)) {
        results.push(path.join(dir, entry.name));
      }
    }
  } catch { /* skip */ }
}

function _readHead(filePath, bytes) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.slice(0, read).toString('utf-8');
  } catch { return ''; }
}

function _addIssue(report, file, line, severity, rule, message, platforms) {
  report.issues.push({ file, line, severity, rule, message, platforms });
}

module.exports = {
  validate,
  detectProjectType,
  validateNodejs,
  validatePython,
  validateWasm,
  validateDocker,
};
