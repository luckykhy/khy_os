#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  BUILD_INFO_FILENAME,
  normalizeTarget,
  platformSlug,
  writeArtifactManifest,
} = require('./artifact-manifest');

const ROOT = path.resolve(__dirname, '..', '..');
const VERSION = require(path.join(ROOT, 'services', 'backend', 'package.json')).version;
const NODE_VERSION = '22.12.0';
const KINDS = new Set(['portable-dev', 'portable-runtime']);
const ROOT_EXCLUDES = new Set([
  '.git', '.khy', '.khyquant', '.khyquant-data', '.khy-Trajectory',
  'khy-Trajectory', 'dist', 'data', 'cache', 'logs',
]);
const ANY_DIR_EXCLUDES = new Set([
  '__pycache__', '.pytest_cache', '.cache', 'coverage', '.nyc_output',
]);
const SECRET_OR_STATE_RE = /(?:^|\/)(?:\.env(?:\..*)?|[^/]+\.(?:db|db-wal|db-shm|sqlite|sqlite3|log|pid|pyc))$/i;
// source map 单独一条，不并进 SECRET_OR_STATE_RE：它既不是密钥也不是运行期状态，
// 排除它的理由是体积和源码泄露（khy 那份 map 有 66.9 MB，是 bundle 的 3.5 倍），
// 混进去会让那条正则的名字开始说谎，下一个人就不知道该往哪加规则了。
const DEBUG_SYMBOL_RE = /\.(?:map|js\.map|mjs\.map|css\.map)$/i;

function currentTarget() {
  return {
    platform: process.platform,
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
  };
}

function parseArgs(argv) {
  const current = currentTarget();
  const options = {
    kind: '',
    platform: current.platform,
    arch: current.arch,
    out: path.join(ROOT, 'dist', 'portable'),
    nodeRuntime: '',
    pythonRuntime: '',
    npmCache: '',
    pipCache: '',
    plan: false,
    force: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--kind') options.kind = argv[++index] || '';
    else if (token === '--platform') options.platform = argv[++index] || '';
    else if (token === '--arch') options.arch = argv[++index] || '';
    else if (token === '--out') options.out = path.resolve(argv[++index] || '');
    else if (token === '--node-runtime') options.nodeRuntime = path.resolve(argv[++index] || '');
    else if (token === '--python-runtime') options.pythonRuntime = path.resolve(argv[++index] || '');
    else if (token === '--npm-cache') options.npmCache = path.resolve(argv[++index] || '');
    else if (token === '--pip-cache') options.pipCache = path.resolve(argv[++index] || '');
    else if (token === '--plan') options.plan = true;
    else if (token === '--force') options.force = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else throw new Error(`Unknown option: ${token}`);
  }
  if (options.help) return options;
  if (!KINDS.has(options.kind)) {
    throw new Error('--kind must be portable-dev or portable-runtime');
  }
  const target = normalizeTarget(options.platform, options.arch);
  options.platform = target.platform;
  options.arch = target.arch;
  return options;
}

function printHelp() {
  console.log([
    'Usage: node scripts/portable/build-portable-artifact.js --kind <portable-dev|portable-runtime> [options]',
    '',
    'Common:',
    '  --platform <win32|linux|darwin>  Target OS (defaults to host)',
    '  --arch <x64|arm64>               Target architecture (defaults to host)',
    '  --out <dir>                      Parent output directory',
    '  --plan                           Validate inputs and print the layout only',
    '  --force                          Replace an existing artifact directory',
    '',
    'Runtime inputs (both kinds):',
    '  --node-runtime <dir>             Extracted Node runtime (required)',
    '  --python-runtime <dir>           Embedded Python runtime or venv (required)',
    '',
    'portable-dev caches:',
    '  --npm-cache <dir>                Offline npm cache (required)',
    '  --pip-cache <dir>                Offline pip wheel/cache directory (required)',
  ].join('\n'));
}

function resolveInputs(options) {
  const slug = platformSlug(options.platform, options.arch);
  return {
    slug,
    artifactName: `${options.kind}-${VERSION}-${slug}`,
    artifactDir: path.join(options.out, `${options.kind}-${VERSION}-${slug}`),
    aiFrontend: path.join(ROOT, 'apps', 'ai-frontend', 'dist'),
    quantFrontend: path.join(ROOT, 'software', 'khyquant', 'frontend', 'dist'),
    runtimeBundle: path.join(ROOT, 'dist', 'modules', 'khy', 'bundle.mjs'),
  };
}

function requireFile(file, label, errors) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    errors.push(`${label} missing: ${file || '<not specified>'}`);
  }
}

/** 多选一：任一存在即可。用于同时支持 npm / pnpm 两种 lockfile。 */
function requireAnyFile(files, label, errors) {
  const found = files.some((file) => file && fs.existsSync(file) && fs.statSync(file).isFile());
  if (!found) {
    errors.push(`${label} missing: ${files.join(' | ')}`);
  }
}

function requireDir(dir, label, errors) {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    errors.push(`${label} missing: ${dir || '<not specified>'}`);
  }
}

function validateInputs(options, inputs) {
  const errors = [];
  requireDir(options.nodeRuntime, 'Node runtime', errors);
  requireDir(options.pythonRuntime, 'Python runtime', errors);
  if (options.kind === 'portable-dev') {
    requireDir(options.npmCache, 'npm offline cache', errors);
    requireDir(options.pipCache, 'pip offline cache', errors);
    // 迁移期两套安装布局并存，所以这里问的是「有没有一份可复现的锁」，
    // 而不是「有没有 package-lock.json」。写死 npm 那一份会让 pnpm 侧的
    // clean checkout 明明可以 --frozen-lockfile 装出来，却被便携构建拒收。
    requireAnyFile(
      [path.join(ROOT, 'package-lock.json'), path.join(ROOT, 'pnpm-lock.yaml')],
      'root lockfile (package-lock.json 或 pnpm-lock.yaml)',
      errors,
    );
    requireDir(path.join(ROOT, 'node_modules'), 'root workspace dependencies', errors);
    requireDir(path.join(ROOT, 'apps', 'ai-frontend', 'node_modules'), 'AI frontend dependencies', errors);
    requireDir(path.join(ROOT, 'software', 'khyquant', 'frontend', 'node_modules'), 'quant frontend dependencies', errors);
  }
  requireFile(path.join(inputs.aiFrontend, 'index.html'), 'AI frontend build', errors);
  requireFile(path.join(inputs.quantFrontend, 'index.html'), 'quant frontend build', errors);
  if (options.kind === 'portable-runtime') {
    requireFile(inputs.runtimeBundle, 'standalone runtime bundle', errors);
  }
  return errors;
}

function ensureEmptyArtifactDir(dir, force) {
  if (fs.existsSync(dir)) {
    if (!force) throw new Error(`Artifact directory already exists: ${dir} (use --force to replace it)`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

function isExcludedSource(relative, entry) {
  const normalized = relative.split(path.sep).join('/');
  const segments = normalized.split('/');
  if (segments.length === 1 && entry.isDirectory() && ROOT_EXCLUDES.has(entry.name)) return true;
  if (entry.isDirectory() && ANY_DIR_EXCLUDES.has(entry.name)) return true;
  if (entry.isFile() && SECRET_OR_STATE_RE.test(normalized)) return true;
  if (entry.isFile() && DEBUG_SYMBOL_RE.test(normalized)) return true;
  return false;
}

/** 前端 dist 的拷贝过滤：vite 构建会在产物里留 .map，便携包不需要它们。 */
function distAssetFilter(relative, entry) {
  if (entry.isFile() && DEBUG_SYMBOL_RE.test(relative.split(path.sep).join('/'))) return false;
  return true;
}

function copyTree(source, destination, options = {}) {
  const sourceRoot = path.resolve(source);
  let copiedFiles = 0;
  let copiedBytes = 0;

  function walk(currentSource, currentDestination, relativeDir) {
    fs.mkdirSync(currentDestination, { recursive: true });
    const entries = fs.readdirSync(currentSource, { withFileTypes: true });
    for (const entry of entries) {
      const relative = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      if (options.filter && !options.filter(relative, entry)) continue;
      const from = path.join(currentSource, entry.name);
      const to = path.join(currentDestination, entry.name);
      if (entry.isSymbolicLink()) {
        if (options.skipSymlinks) continue;
        const real = fs.realpathSync(from);
        const stat = fs.statSync(real);
        if (stat.isDirectory()) walk(real, to, relative);
        else {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(real, to);
          copiedFiles += 1;
          copiedBytes += stat.size;
        }
      } else if (entry.isDirectory()) {
        walk(from, to, relative);
      } else if (entry.isFile()) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        const stat = fs.statSync(from);
        if (process.platform !== 'win32') fs.chmodSync(to, stat.mode & 0o777);
        copiedFiles += 1;
        copiedBytes += stat.size;
      }
    }
  }

  walk(sourceRoot, path.resolve(destination), '');
  return { copiedFiles, copiedBytes };
}

function writeLaunchers(artifactDir, kind, target) {
  const windows = target.platform === 'win32';
  const state = windows ? '%ROOT%state\\.khy' : '$ROOT/state/.khy';
  if (windows) {
    const command = kind === 'portable-dev'
      ? '"%ROOT%runtime\\python\\python.exe" -m khy_platform %*'
      : '"%ROOT%runtime\\node\\node.exe" "%ROOT%runtime\\khy\\bundle.mjs" %*';
    const lines = [
      '@echo off',
      'setlocal',
      'set "ROOT=%~dp0"',
      'set "KHY_PORTABLE_ROOT=%ROOT%"',
      'set "KHYQUANT_PORTABLE_ROOT=%ROOT%"',
      `set "KHY_OS_ROOT=%ROOT%${kind === 'portable-dev' ? 'source' : ''}"`,
      `set "KHY_DATA_HOME=${state}"`,
      `set "KHY_PROJECT_DATA_HOME=${state}"`,
      `set "KHYQUANT_DATA_HOME=${state}"`,
      `set "KHYOS_HOME=${state}"`,
      `set "KHY_RUNTIME_HOME=${state}\\runtime"`,
      `set "KHY_CACHE_HOME=${state}\\cache"`,
      `set "KHY_LOG_HOME=${state}\\logs"`,
      `set "KHY_TEMP_HOME=${state}\\tmp"`,
    ];
    lines.push('set "PATH=%ROOT%runtime\\node;%ROOT%runtime\\python;%PATH%"');
    lines.push('set "PYTHONHOME=%ROOT%runtime\\python"');
    lines.push('set "PYTHONNOUSERSITE=1"');
    lines.push('set "PYTHONUSERBASE=%ROOT%state\\.khy\\python-user"');
    lines.push('set "npm_config_cache=%ROOT%state\\.khy\\cache\\npm"');
    lines.push('set "PIP_CACHE_DIR=%ROOT%state\\.khy\\cache\\pip"');
    if (kind === 'portable-dev') {
      lines.push('set "PYTHONPATH=%ROOT%source\\platform;%ROOT%source\\software\\khyquant;%PYTHONPATH%"');
      lines.push('set "npm_config_cache=%ROOT%caches\\npm"');
      lines.push('set "PIP_CACHE_DIR=%ROOT%caches\\pip"');
      lines.push('if /i "%~1"=="shell" (');
      lines.push('  shift');
      lines.push('  cd /d "%ROOT%source"');
      lines.push('  cmd.exe /k');
      lines.push('  exit /b %ERRORLEVEL%');
      lines.push(')');
    }
    lines.push(command, 'exit /b %ERRORLEVEL%', '');
    fs.writeFileSync(path.join(artifactDir, 'launch.bat'), lines.join('\r\n'), 'utf8');
  } else {
    const command = kind === 'portable-dev'
      ? 'exec "$ROOT/runtime/python/bin/python3" -m khy_platform "$@"'
      : 'exec "$ROOT/runtime/node/bin/node" "$ROOT/runtime/khy/bundle.mjs" "$@"';
    const lines = [
      '#!/usr/bin/env sh',
      'set -eu',
      'ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
      'export KHY_PORTABLE_ROOT="$ROOT"',
      'export KHYQUANT_PORTABLE_ROOT="$ROOT"',
      `export KHY_OS_ROOT="$ROOT/${kind === 'portable-dev' ? 'source' : ''}"`,
      'export KHY_DATA_HOME="$ROOT/state/.khy"',
      'export KHY_PROJECT_DATA_HOME="$KHY_DATA_HOME"',
      'export KHYQUANT_DATA_HOME="$KHY_DATA_HOME"',
      'export KHYOS_HOME="$KHY_DATA_HOME"',
      'export KHY_RUNTIME_HOME="$KHY_DATA_HOME/runtime"',
      'export KHY_CACHE_HOME="$KHY_DATA_HOME/cache"',
      'export KHY_LOG_HOME="$KHY_DATA_HOME/logs"',
      'export KHY_TEMP_HOME="$KHY_DATA_HOME/tmp"',
    ];
    lines.push('export PATH="$ROOT/runtime/node/bin:$ROOT/runtime/python/bin:$PATH"');
    lines.push('export PYTHONHOME="$ROOT/runtime/python"');
    lines.push('export PYTHONNOUSERSITE=1');
    lines.push('export PYTHONUSERBASE="$ROOT/state/.khy/python-user"');
    lines.push('export npm_config_cache="$ROOT/state/.khy/cache/npm"');
    lines.push('export PIP_CACHE_DIR="$ROOT/state/.khy/cache/pip"');
    if (kind === 'portable-dev') {
      lines.push('export PYTHONPATH="$ROOT/source/platform:$ROOT/source/software/khyquant${PYTHONPATH:+:$PYTHONPATH}"');
      lines.push('export npm_config_cache="$ROOT/caches/npm"');
      lines.push('export PIP_CACHE_DIR="$ROOT/caches/pip"');
      lines.push('if [ "${1:-}" = "shell" ]; then');
      lines.push('  shift');
      lines.push('  cd "$ROOT/source"');
      lines.push('  exec "${SHELL:-/bin/sh}" "$@"');
      lines.push('fi');
    }
    lines.push(command, '');
    const launcher = path.join(artifactDir, 'launch.sh');
    fs.writeFileSync(launcher, lines.join('\n'), 'utf8');
    fs.chmodSync(launcher, 0o755);
  }
}

function gitCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function writeBuildInfo(artifactDir, options, inputs) {
  const info = {
    schemaVersion: 1,
    kind: options.kind,
    version: VERSION,
    target: { platform: options.platform, arch: options.arch },
    sourceCommit: gitCommit(),
    builder: { node: process.version, platform: process.platform, arch: process.arch },
    inputs: {
      nodeRuntime: path.relative(ROOT, options.nodeRuntime).split(path.sep).join('/'),
      pythonRuntime: path.relative(ROOT, options.pythonRuntime).split(path.sep).join('/'),
      source: options.kind === 'portable-dev' ? '.' : undefined,
      bundle: options.kind === 'portable-runtime'
        ? path.relative(ROOT, inputs.runtimeBundle).split(path.sep).join('/')
        : undefined,
    },
  };
  fs.writeFileSync(path.join(artifactDir, BUILD_INFO_FILENAME), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  return info;
}

function buildDev(options, inputs) {
  const artifactDir = inputs.artifactDir;
  copyTree(ROOT, path.join(artifactDir, 'source'), {
    skipSymlinks: true,
    filter: (relative, entry) => !isExcludedSource(relative, entry),
  });
  copyTree(options.nodeRuntime, path.join(artifactDir, 'runtime', 'node'), { skipSymlinks: false });
  copyTree(options.pythonRuntime, path.join(artifactDir, 'runtime', 'python'), { skipSymlinks: false });
  copyTree(options.npmCache, path.join(artifactDir, 'caches', 'npm'), { skipSymlinks: false });
  copyTree(options.pipCache, path.join(artifactDir, 'caches', 'pip'), { skipSymlinks: false });
  fs.mkdirSync(path.join(artifactDir, 'artifacts'), { recursive: true });
}

function runtimeSourceFilter(relative, entry) {
  if (isExcludedSource(relative, entry)) return false;
  const normalized = relative.split(path.sep).join('/');
  const excludedRoots = [
    'services/backend/node_modules',
    'services/backend/tests',
    'services/backend/coverage',
    'software/khyquant/frontend',
  ];
  if (excludedRoots.some(root => normalized === root || normalized.startsWith(`${root}/`))) return false;
  const roots = [
    'services/backend',
    'platform/packages/shared',
    'software/khyquant',
    'platform/khy_platform',
  ];
  if (normalized === 'node_modules' || normalized.startsWith('node_modules/')) return true;
  if (roots.some(root => normalized === root || normalized.startsWith(`${root}/`))) return true;
  if (entry.isDirectory()) return roots.some(root => root.startsWith(`${normalized}/`));
  // 锁文件一并带进便携包：装它的人要能复现同一棵依赖树。两种锁都放行，
  // 带哪一份由工作树里实际存在哪一份决定。
  return ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(normalized);
}

function buildRuntime(options, inputs) {
  const artifactDir = inputs.artifactDir;
  const runtimeDir = path.join(artifactDir, 'runtime', 'khy');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.copyFileSync(inputs.runtimeBundle, path.join(runtimeDir, 'bundle.mjs'));
  copyTree(options.nodeRuntime, path.join(artifactDir, 'runtime', 'node'), { skipSymlinks: false });
  copyTree(options.pythonRuntime, path.join(artifactDir, 'runtime', 'python'), { skipSymlinks: false });
  copyTree(inputs.aiFrontend, path.join(artifactDir, 'web', 'ai'), {
    skipSymlinks: false,
    filter: distAssetFilter,
  });
  copyTree(inputs.quantFrontend, path.join(artifactDir, 'web', 'quant'), {
    skipSymlinks: false,
    filter: distAssetFilter,
  });
  fs.mkdirSync(path.join(artifactDir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'config', 'env.example'), [
    '# Optional runtime overrides',
    '# KHY_DATA_HOME is set by launch.* to state/.khy',
    'KHY_HOST=127.0.0.1',
    '',
  ].join('\n'), 'utf8');
}

async function buildArtifact(options) {
  const inputs = resolveInputs(options);
  const errors = validateInputs(options, inputs);
  if (options.plan) return { options, inputs, errors, built: false };
  if (errors.length) throw new Error(`Artifact prerequisites failed:\n- ${errors.join('\n- ')}`);

  ensureEmptyArtifactDir(inputs.artifactDir, options.force);
  if (options.kind === 'portable-dev') buildDev(options, inputs);
  else buildRuntime(options, inputs);

  fs.writeFileSync(path.join(inputs.artifactDir, '.portable'), 'khy-portable-v1\n', 'utf8');
  fs.mkdirSync(path.join(inputs.artifactDir, 'state', '.khy'), { recursive: true });
  writeLaunchers(inputs.artifactDir, options.kind, {
    platform: options.platform,
    arch: options.arch,
  });
  const buildInfo = writeBuildInfo(inputs.artifactDir, options, inputs);
  const manifest = await writeArtifactManifest(inputs.artifactDir, {
    kind: options.kind,
    name: inputs.artifactName,
    version: VERSION,
    platform: options.platform,
    arch: options.arch,
    runtimes: { node: NODE_VERSION, python: 'embedded' },
    frontends: options.kind === 'portable-runtime'
      ? {
          ai: { built: true, entry: 'web/ai/index.html' },
          quant: { built: true, entry: 'web/quant/index.html' },
        }
      : {
          ai: { source: 'source/apps/ai-frontend' },
          quant: { source: 'source/software/khyquant/frontend' },
        },
    nativeModules: [],
    source: { commit: buildInfo.sourceCommit },
  });
  return { options, inputs, errors: [], built: true, manifest };
}

function printPlan(result) {
  const { options, inputs, errors } = result;
  console.log(`Artifact: ${inputs.artifactName}`);
  console.log(`Output:   ${inputs.artifactDir}`);
  console.log(`Target:   ${inputs.slug}`);
  console.log(`Kind:     ${options.kind}`);
  if (options.kind === 'portable-runtime') {
    console.log(`Node:     ${options.nodeRuntime || '<not specified>'}`);
    console.log(`Python:   ${options.pythonRuntime || '<not specified>'}`);
    console.log(`Bundle:   ${inputs.runtimeBundle}`);
    console.log(`AI web:   ${inputs.aiFrontend}`);
    console.log(`Quant web:${inputs.quantFrontend}`);
  } else {
    console.log(`Node:     ${options.nodeRuntime || '<not specified>'}`);
    console.log(`Python:   ${options.pythonRuntime || '<not specified>'}`);
    console.log(`npm cache:${options.npmCache || '<not specified>'}`);
    console.log(`pip cache:${options.pipCache || '<not specified>'}`);
  }
  if (errors.length) {
    console.log('\nMissing prerequisites:');
    for (const error of errors) console.log(`- ${error}`);
  } else {
    console.log('\nPrerequisites: PASS');
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const result = await buildArtifact(options);
  if (options.plan) {
    printPlan(result);
    return result.errors.length ? 1 : 0;
  }
  console.log(`Built ${result.inputs.artifactName}`);
  console.log(`Files: ${result.manifest.files.length}`);
  console.log(`Path:  ${result.inputs.artifactDir}`);
  return 0;
}

module.exports = {
  ROOT,
  VERSION,
  NODE_VERSION,
  parseArgs,
  resolveInputs,
  validateInputs,
  isExcludedSource,
  distAssetFilter,
  runtimeSourceFilter,
  copyTree,
  writeLaunchers,
  buildArtifact,
  printPlan,
};

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`[portable-build] ${error.message}`);
    process.exitCode = 1;
  });
}
