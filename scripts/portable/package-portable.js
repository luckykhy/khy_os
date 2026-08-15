#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { normalizeTarget, platformSlug } = require('./artifact-manifest');

const ROOT = path.resolve(__dirname, '..', '..');
const VERSION = require(path.join(ROOT, 'services', 'backend', 'package.json')).version;
const VALID_KINDS = new Set(['runtime', 'dev']);

function hostTarget(platform = process.platform, arch = process.arch) {
  return normalizeTarget(platform, arch === 'arm64' ? 'arm64' : 'x64');
}

function parseArgs(argv, defaults = {}) {
  const target = hostTarget(defaults.platform, defaults.arch);
  const options = {
    kind: 'runtime',
    out: path.join(ROOT, 'dist', 'releases'),
    artifactOut: path.join(ROOT, 'dist', 'portable'),
    platform: target.platform,
    arch: target.arch,
    nodeRuntime: '',
    pythonRuntime: '',
    npmCache: '',
    pipCache: '',
    skipBuild: false,
    keepArtifact: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next || next.startsWith('--')) throw new Error(`${token} requires a value`);
      return next;
    };
    if (token === '--kind') options.kind = value();
    else if (token === '--out') options.out = path.resolve(value());
    else if (token === '--artifact-out') options.artifactOut = path.resolve(value());
    else if (token === '--node-runtime') options.nodeRuntime = path.resolve(value());
    else if (token === '--python-runtime') options.pythonRuntime = path.resolve(value());
    else if (token === '--npm-cache') options.npmCache = path.resolve(value());
    else if (token === '--pip-cache') options.pipCache = path.resolve(value());
    else if (token === '--skip-build') options.skipBuild = true;
    else if (token === '--keep-artifact') options.keepArtifact = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else throw new Error(`Unknown option: ${token}`);
  }

  if (!VALID_KINDS.has(options.kind)) throw new Error('--kind must be runtime or dev');
  return options;
}

function printHelp() {
  console.log([
    'Usage: node scripts/portable/package-portable.js [options]',
    '',
    '  --kind <runtime|dev>       Package type (default: runtime)',
    '  --out <dir>                Zip output directory (default: dist/releases)',
    '  --artifact-out <dir>       Assembled artifact parent (default: dist/portable)',
    '  --skip-build               Reuse existing frontend build outputs',
    '  --keep-artifact            Keep the assembled directory after creating the zip',
    '  --node-runtime <dir>       Embedded Node runtime override',
    '  --python-runtime <dir>     Embedded Python runtime override',
    '  --npm-cache <dir>          portable-dev npm cache override',
    '  --pip-cache <dir>          portable-dev pip cache override',
    '  -h, --help                 Show this help',
  ].join('\n'));
}

function commandLabel(command, args) {
  return [command, ...args].map(value => /\s/.test(value) ? JSON.stringify(value) : value).join(' ');
}

function defaultRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    windowsHide: true,
  });
  if (result.error) throw new Error(`${commandLabel(command, args)}: ${result.error.message}`);
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${commandLabel(command, args)} exited with ${result.status}${output ? `\n${output}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

function requirePath(target, label, installHint, type = 'dir') {
  let valid = false;
  try {
    const stat = fs.statSync(target);
    valid = type === 'file' ? stat.isFile() : stat.isDirectory();
  } catch { /* handled below */ }
  if (!valid) throw new Error(`${label} missing: ${target}\nRun: ${installHint}`);
}

function checkRuntimePrerequisites() {
  requirePath(path.join(ROOT, 'node_modules'), 'root dependencies', 'npm ci');
  requirePath(path.join(ROOT, 'apps', 'ai-frontend', 'node_modules'), 'AI frontend dependencies', 'npm ci --prefix apps/ai-frontend');
  requirePath(path.join(ROOT, 'software', 'khyquant', 'frontend', 'node_modules'), 'quant frontend dependencies', 'npm ci --prefix software/khyquant/frontend');
}

function windowsPythonCandidates(env = process.env) {
  const programsDir = env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Python');
  if (!programsDir) return [];
  try {
    return fs.readdirSync(programsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^Python\d+$/i.test(entry.name))
      .map(entry => path.join(programsDir, entry.name, 'python.exe'))
      .filter(candidate => fs.existsSync(candidate))
      .sort((left, right) => right.localeCompare(left, 'en'));
  } catch {
    return [];
  }
}

function resolvePython(run, env = process.env) {
  const candidates = process.platform === 'win32'
    ? [env.PYTHON, 'py', 'python', ...windowsPythonCandidates(env)]
    : [env.PYTHON, 'python3', 'python'];
  for (const candidate of candidates.filter(Boolean)) {
    try {
      const args = path.basename(candidate).toLowerCase() === 'py' ? ['-3', '-c', 'import sys; print(sys.executable)'] : ['-c', 'import sys; print(sys.executable)'];
      const output = run(candidate, args, { capture: true });
      const executable = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean).pop() || '';
      if (executable && fs.existsSync(executable)) return executable;
    } catch { /* try the next command */ }
  }
  throw new Error('Python runtime not found; install Python 3.8+ or pass --python-runtime <dir>');
}

function findPythonExecutable(runtimeDir) {
  const candidates = process.platform === 'win32'
    ? ['python.exe', 'python3.exe']
    : ['bin/python3', 'bin/python'];
  for (const relative of candidates) {
    const candidate = path.join(runtimeDir, relative);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Python executable missing in runtime: ${runtimeDir}`);
}

function npmInvocation(env = process.env) {
  if (process.platform !== 'win32') return { command: 'npm', args: [] };
  const candidates = [
    env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const cli = candidates.find(candidate => fs.existsSync(candidate));
  if (!cli) throw new Error('npm CLI not found next to the active Node runtime');
  return { command: process.execPath, args: [cli] };
}

function runtimeRootForExecutable(executable, platform = process.platform) {
  const binDir = path.dirname(executable);
  return platform === 'win32' ? binDir : path.dirname(binDir);
}

function resolveRuntimeInputs(options, dependencies = {}) {
  const run = dependencies.run || defaultRun;
  const env = dependencies.env || process.env;
  const pythonExecutable = options.pythonRuntime
    ? findPythonExecutable(options.pythonRuntime)
    : resolvePython(run, env);
  return {
    nodeRuntime: path.resolve((options.nodeRuntime || runtimeRootForExecutable(process.execPath)).trim()),
    pythonRuntime: path.resolve((options.pythonRuntime || runtimeRootForExecutable(pythonExecutable)).trim()),
  };
}

function resolveDevInputs(options, dependencies = {}) {
  const run = dependencies.run || defaultRun;
  const env = dependencies.env || process.env;
  const runtimeInputs = resolveRuntimeInputs(options, dependencies);
  const pythonExecutable = findPythonExecutable(runtimeInputs.pythonRuntime);
  const npm = npmInvocation(env);
  const npmCache = options.npmCache || run(npm.command, [...npm.args, 'config', 'get', 'cache'], { capture: true });
  const pipArgs = path.basename(pythonExecutable).toLowerCase() === 'py.exe'
    ? ['-3', '-m', 'pip', 'cache', 'dir']
    : ['-m', 'pip', 'cache', 'dir'];
  const pipCache = options.pipCache || run(pythonExecutable, pipArgs, { capture: true });
  return {
    ...runtimeInputs,
    npmCache: path.resolve(npmCache.trim()),
    pipCache: path.resolve(pipCache.trim()),
  };
}

function artifactPaths(options) {
  const slug = platformSlug(options.platform, options.arch);
  const name = `portable-${options.kind}-${VERSION}-${slug}`;
  return {
    slug,
    name,
    artifactDir: path.join(options.artifactOut, name),
    archivePath: path.join(options.out, `${name}.zip`),
  };
}

function createStages(options, runtimeInputs) {
  const paths = artifactPaths(options);
  const node = process.execPath;
  const npm = npmInvocation();
  const stages = [];

  if (options.kind === 'runtime' && !options.skipBuild) {
    stages.push(
      { name: 'Build AI frontend', command: npm.command, args: [...npm.args, 'run', 'build', '--prefix', 'apps/ai-frontend'] },
      { name: 'Build quant frontend', command: npm.command, args: [...npm.args, 'run', 'build', '--prefix', 'software/khyquant/frontend'] },
    );
  }

  const buildArgs = [
    'scripts/portable/build-portable-artifact.js',
    '--kind', `portable-${options.kind}`,
    '--platform', options.platform,
    '--arch', options.arch,
    '--out', options.artifactOut,
    '--force',
  ];
  buildArgs.push(
    '--node-runtime', runtimeInputs.nodeRuntime,
    '--python-runtime', runtimeInputs.pythonRuntime,
  );
  if (options.kind === 'dev') {
    buildArgs.push(
      '--npm-cache', runtimeInputs.npmCache,
      '--pip-cache', runtimeInputs.pipCache,
    );
  }
  stages.push(
    { name: 'Assemble portable artifact', command: node, args: buildArgs },
    { name: 'Verify portable artifact', command: node, args: ['scripts/portable/portable-health-check.js', '--artifact', paths.artifactDir] },
    { name: 'Create zip archive', command: node, args: ['scripts/portable/pack-portable.js', '--artifact', paths.artifactDir, '--out', options.out] },
  );
  return stages;
}

async function packagePortable(options, dependencies = {}) {
  const run = dependencies.run || defaultRun;
  const log = dependencies.log || console.log;
  const remove = dependencies.remove || (target => fs.rmSync(target, { recursive: true, force: true }));
  const paths = artifactPaths(options);

  const current = hostTarget();
  if (options.platform !== current.platform || options.arch !== current.arch) {
    throw new Error(`Local packaging only supports ${platformSlug(current.platform, current.arch)}; use the CI matrix for ${paths.slug}`);
  }
  if (options.kind === 'runtime' && !options.skipBuild && !dependencies.skipPrerequisiteCheck) {
    checkRuntimePrerequisites();
  }
  const runtimeInputs = dependencies.runtimeInputs || (options.kind === 'dev'
    ? resolveDevInputs(options, dependencies)
    : resolveRuntimeInputs(options, dependencies));
  const stages = createStages(options, runtimeInputs);
  fs.mkdirSync(options.out, { recursive: true });

  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    log(`[${index + 1}/${stages.length}] ${stage.name}`);
    run(stage.command, stage.args, { cwd: ROOT });
  }

  if (!fs.existsSync(paths.archivePath) && !dependencies.allowMissingArchive) {
    throw new Error(`Archive was not created: ${paths.archivePath}`);
  }
  const size = fs.existsSync(paths.archivePath) ? fs.statSync(paths.archivePath).size : 0;
  if (!options.keepArtifact) remove(paths.artifactDir);
  return { ...paths, size, keptArtifact: options.keepArtifact };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const result = await packagePortable(options);
  console.log('');
  console.log(`Portable package ready: ${result.archivePath}`);
  console.log(`Size: ${(result.size / (1024 * 1024)).toFixed(1)} MB`);
  console.log(result.keptArtifact ? `Artifact kept: ${result.artifactDir}` : 'Intermediate artifact removed');
  return 0;
}

module.exports = {
  ROOT,
  VERSION,
  hostTarget,
  parseArgs,
  defaultRun,
  checkRuntimePrerequisites,
  windowsPythonCandidates,
  resolvePython,
  findPythonExecutable,
  runtimeRootForExecutable,
  npmInvocation,
  resolveRuntimeInputs,
  resolveDevInputs,
  artifactPaths,
  createStages,
  packagePortable,
  main,
};

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`[portable-package] ${error.message}`);
    process.exitCode = 1;
  });
}
