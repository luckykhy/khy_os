'use strict';

/**
 * projectDetector — signal-driven detection of how to install, build and start
 * an arbitrary project, so `khy deploy` never hardcodes a specific application.
 *
 * Design rules (per project engineering law):
 *  - Zero hardcoding of concrete apps: every decision derives from deterministic
 *    on-disk signals (manifest files, lockfiles, declared scripts/entrypoints).
 *  - State transparency: the returned plan records every signal it matched and
 *    notes for anything it could NOT determine — it never fabricates a start
 *    command. Callers surface "unknown" honestly instead of guessing.
 *  - Cross-platform: command executables are resolved per platform (npm.cmd on
 *    Windows, etc.). Commands are emitted as { exe, args } argv arrays so no
 *    shell quoting is ever required.
 *  - Testability: all filesystem access goes through an injected `fs`-like
 *    object, so tests run against an in-memory tree with zero real I/O.
 *
 * @typedef {Object} Command
 * @property {string} exe        Executable name (platform-resolved).
 * @property {string[]} args     Argument vector.
 * @property {string} [display]  Human-readable form for logs.
 *
 * @typedef {Object} DetectionPlan
 * @property {string} type       node|python|go|rust|docker|static|make|unknown
 * @property {string[]} signals  Manifest/lock files that drove the decision.
 * @property {string|null} packageManager
 * @property {Command|null} install
 * @property {Command|null} build
 * @property {Command|null} start
 * @property {number|null} port  Best-effort default port (informational only).
 * @property {string[]} notes    Caveats / things that could not be determined.
 */

const path = require('path');

function defaultFs() {
  return require('fs');
}

/** Resolve a platform-correct executable name for Node tooling wrappers. */
function resolveExe(name, platform) {
  if (platform === 'win32') {
    // npm/npx/pnpm/yarn ship as .cmd shims on Windows; bare names fail spawn.
    if (['npm', 'npx', 'pnpm', 'yarn'].includes(name)) return `${name}.cmd`;
  }
  return name;
}

function exists(fs, p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function readJson(fs, p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readText(fs, p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function cmd(exe, args, platform) {
  const resolved = resolveExe(exe, platform);
  return { exe: resolved, args, display: [resolved, ...args].join(' ') };
}

/**
 * Detect the package manager for a Node project from lockfiles, falling back
 * to a declared `packageManager` field, then npm.
 */
function detectNodePackageManager(fs, dir, pkg) {
  if (exists(fs, path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (exists(fs, path.join(dir, 'yarn.lock'))) return 'yarn';
  if (exists(fs, path.join(dir, 'bun.lockb'))) return 'bun';
  if (exists(fs, path.join(dir, 'package-lock.json'))) return 'npm';
  if (pkg && typeof pkg.packageManager === 'string') {
    const name = pkg.packageManager.split('@')[0];
    if (['pnpm', 'yarn', 'bun', 'npm'].includes(name)) return name;
  }
  return 'npm';
}

function nodeInstallCommand(pm, hasLock, platform) {
  switch (pm) {
    case 'pnpm':
      return cmd('pnpm', ['install'], platform);
    case 'yarn':
      return cmd('yarn', ['install'], platform);
    case 'bun':
      return cmd('bun', ['install'], platform);
    case 'npm':
    default:
      // `npm ci` requires a lockfile and a clean install; fall back to install.
      return hasLock ? cmd('npm', ['ci'], platform) : cmd('npm', ['install'], platform);
  }
}

function nodeRunScript(pm, script, platform) {
  switch (pm) {
    case 'pnpm':
      return cmd('pnpm', ['run', script], platform);
    case 'yarn':
      return cmd('yarn', [script], platform);
    case 'bun':
      return cmd('bun', ['run', script], platform);
    case 'npm':
    default:
      return cmd('npm', ['run', script], platform);
  }
}

const NODE_ENTRY_CANDIDATES = [
  'server.js', 'app.js', 'index.js', 'main.js',
  'src/server.js', 'src/index.js', 'src/main.js',
  'dist/index.js', 'dist/main.js', 'build/index.js',
];

function detectNode(fs, dir, platform, plan) {
  const pkg = readJson(fs, path.join(dir, 'package.json'));
  plan.type = 'node';
  plan.signals.push('package.json');
  const pm = detectNodePackageManager(fs, dir, pkg);
  plan.packageManager = pm;
  const hasLock = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'package-lock.json']
    .some((f) => exists(fs, path.join(dir, f)));
  if (hasLock) plan.signals.push('lockfile');
  plan.install = nodeInstallCommand(pm, hasLock, platform);

  const scripts = (pkg && pkg.scripts) || {};
  if (scripts.build) plan.build = nodeRunScript(pm, 'build', platform);

  if (scripts.start) {
    plan.start = nodeRunScript(pm, 'start', platform);
  } else if (pkg && typeof pkg.main === 'string' && exists(fs, path.join(dir, pkg.main))) {
    plan.start = cmd('node', [pkg.main], platform);
    plan.notes.push(`未声明 start 脚本，回退到 package.json main: ${pkg.main}`);
  } else {
    const entry = NODE_ENTRY_CANDIDATES.find((f) => exists(fs, path.join(dir, f)));
    if (entry) {
      plan.start = cmd('node', [entry], platform);
      plan.notes.push(`未声明 start 脚本，探测到入口文件: ${entry}`);
    } else {
      plan.notes.push('无法确定启动命令（无 start 脚本 / main / 常见入口文件），请用 --cmd 指定');
    }
  }
  return plan;
}

function detectPython(fs, dir, platform, plan) {
  plan.type = 'python';
  const py = platform === 'win32' ? 'python' : 'python3';

  const hasRequirements = exists(fs, path.join(dir, 'requirements.txt'));
  const hasPyproject = exists(fs, path.join(dir, 'pyproject.toml'));
  const hasSetup = exists(fs, path.join(dir, 'setup.py'));
  if (hasRequirements) {
    plan.signals.push('requirements.txt');
    plan.install = cmd(py, ['-m', 'pip', 'install', '-r', 'requirements.txt'], platform);
  } else if (hasPyproject) {
    plan.signals.push('pyproject.toml');
    plan.install = cmd(py, ['-m', 'pip', 'install', '.'], platform);
  } else if (hasSetup) {
    plan.signals.push('setup.py');
    plan.install = cmd(py, ['-m', 'pip', 'install', '.'], platform);
  }

  // Start detection: Procfile web line > Django manage.py > common entrypoints.
  const proc = readText(fs, path.join(dir, 'Procfile'));
  const webLine = proc && proc.split(/\r?\n/).map((l) => l.trim())
    .find((l) => /^web\s*:/i.test(l));
  if (webLine) {
    plan.signals.push('Procfile');
    const command = webLine.replace(/^web\s*:/i, '').trim();
    plan.start = { exe: command.split(/\s+/)[0], args: command.split(/\s+/).slice(1), display: command };
    plan.notes.push('启动命令取自 Procfile 的 web 行');
    return plan;
  }

  if (exists(fs, path.join(dir, 'manage.py'))) {
    plan.signals.push('manage.py');
    plan.start = cmd(py, ['manage.py', 'runserver'], platform);
    plan.notes.push('探测到 Django manage.py');
    plan.port = 8000;
    return plan;
  }

  const entry = ['app.py', 'main.py', 'wsgi.py', 'asgi.py', 'run.py', 'server.py']
    .find((f) => exists(fs, path.join(dir, f)));
  if (entry) {
    plan.start = cmd(py, [entry], platform);
    plan.notes.push(`探测到 Python 入口文件: ${entry}`);
  } else {
    plan.notes.push('无法确定 Python 启动命令，请用 --cmd 指定');
  }
  return plan;
}

function detectGo(fs, dir, platform, plan) {
  plan.type = 'go';
  plan.signals.push('go.mod');
  plan.install = cmd('go', ['mod', 'download'], platform);
  plan.build = cmd('go', ['build', './...'], platform);
  plan.start = cmd('go', ['run', '.'], platform);
  plan.notes.push('Go 启动默认 `go run .`，如有编译产物请用 --cmd 指定');
  return plan;
}

function detectRust(fs, dir, platform, plan) {
  plan.type = 'rust';
  plan.signals.push('Cargo.toml');
  plan.build = cmd('cargo', ['build', '--release'], platform);
  plan.start = cmd('cargo', ['run', '--release'], platform);
  return plan;
}

function detectDocker(fs, dir, platform, plan) {
  plan.type = 'docker';
  plan.signals.push('Dockerfile');
  plan.notes.push('Dockerfile 项目：build = `docker build`，启动需镜像标签与端口映射，建议用 --cmd 指定 docker run');
  return plan;
}

function detectStatic(fs, dir, platform, plan) {
  plan.type = 'static';
  plan.signals.push('index.html');
  const py = platform === 'win32' ? 'python' : 'python3';
  plan.start = cmd(py, ['-m', 'http.server', '8080'], platform);
  plan.port = 8080;
  plan.notes.push('静态站点：默认用内置 http.server 在 8080 提供服务');
  return plan;
}

function detectMake(fs, dir, platform, plan) {
  plan.type = 'make';
  plan.signals.push('Makefile');
  const mk = readText(fs, path.join(dir, 'Makefile')) || '';
  const targets = new Set(
    mk.split(/\r?\n/)
      .map((l) => l.match(/^([A-Za-z0-9_.-]+):/))
      .filter(Boolean)
      .map((m) => m[1]),
  );
  if (targets.has('build')) plan.build = cmd('make', ['build'], platform);
  const runTarget = ['run', 'start', 'serve'].find((t) => targets.has(t));
  if (runTarget) {
    plan.start = cmd('make', [runTarget], platform);
  } else {
    plan.notes.push('Makefile 无 run/start/serve 目标，请用 --cmd 指定启动命令');
  }
  return plan;
}

/**
 * Detect a project plan from on-disk signals.
 *
 * @param {string} dir Project source directory.
 * @param {Object} [opts]
 * @param {Object} [opts.fs] Injected fs-like object (existsSync/readFileSync).
 * @param {string} [opts.platform] process.platform override (for tests).
 * @returns {DetectionPlan}
 */
function detectProject(dir, opts = {}) {
  const fs = opts.fs || defaultFs();
  const platform = opts.platform || process.platform;

  const plan = {
    type: 'unknown',
    signals: [],
    packageManager: null,
    install: null,
    build: null,
    start: null,
    port: null,
    notes: [],
  };

  // Order matters: a project may carry multiple manifests; pick the most
  // specific runnable signal first. Node and Python lead because they are the
  // most common deployable runtimes in this ecosystem.
  if (exists(fs, path.join(dir, 'package.json'))) {
    return detectNode(fs, dir, platform, plan);
  }
  if (
    exists(fs, path.join(dir, 'requirements.txt')) ||
    exists(fs, path.join(dir, 'pyproject.toml')) ||
    exists(fs, path.join(dir, 'setup.py'))
  ) {
    return detectPython(fs, dir, platform, plan);
  }
  if (exists(fs, path.join(dir, 'go.mod'))) return detectGo(fs, dir, platform, plan);
  if (exists(fs, path.join(dir, 'Cargo.toml'))) return detectRust(fs, dir, platform, plan);
  if (exists(fs, path.join(dir, 'Dockerfile'))) return detectDocker(fs, dir, platform, plan);
  if (exists(fs, path.join(dir, 'index.html'))) return detectStatic(fs, dir, platform, plan);
  if (exists(fs, path.join(dir, 'Makefile'))) return detectMake(fs, dir, platform, plan);

  plan.notes.push('无法识别项目类型（未找到已知清单文件），请用 --cmd 指定启动命令');
  return plan;
}

module.exports = {
  detectProject,
  resolveExe,
  // exported for unit tests
  detectNodePackageManager,
  NODE_ENTRY_CANDIDATES,
};
