'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ROOT,
  VERSION,
  hostTarget,
  parseArgs,
  windowsPythonCandidates,
  resolveRuntimeInputs,
  resolveDevInputs,
  artifactPaths,
  createStages,
  packagePortable,
} = require('../portable/package-portable');

function baseOptions(overrides = {}) {
  const target = hostTarget();
  return {
    ...parseArgs([], { platform: target.platform, arch: target.arch }),
    ...overrides,
  };
}

function tempDir(t, name = 'khy portable package-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('parseArgs defaults to a current-platform runtime release', () => {
  const options = parseArgs([], { platform: 'win32', arch: 'x64' });
  assert.equal(options.kind, 'runtime');
  assert.equal(options.platform, 'win32');
  assert.equal(options.arch, 'x64');
  assert.equal(options.out, path.join(ROOT, 'dist', 'releases'));
  assert.equal(options.artifactOut, path.join(ROOT, 'dist', 'portable'));
  assert.equal(options.skipBuild, false);
  assert.equal(options.keepArtifact, false);
});

test('parseArgs accepts development inputs and paths with spaces or Chinese text', () => {
  const options = parseArgs([
    '--kind', 'dev',
    '--out', '临时 输出/releases',
    '--artifact-out', '临时 输出/artifacts',
    '--node-runtime', '运行时/node',
    '--python-runtime', '运行时/python',
    '--npm-cache', '缓存/npm',
    '--pip-cache', '缓存/pip',
    '--skip-build',
    '--keep-artifact',
  ], { platform: 'win32', arch: 'x64' });
  assert.equal(options.kind, 'dev');
  assert.equal(options.out, path.resolve('临时 输出/releases'));
  assert.equal(options.artifactOut, path.resolve('临时 输出/artifacts'));
  assert.equal(options.nodeRuntime, path.resolve('运行时/node'));
  assert.equal(options.pythonRuntime, path.resolve('运行时/python'));
  assert.equal(options.skipBuild, true);
  assert.equal(options.keepArtifact, true);
});

test('hostTarget normalizes supported host names and architectures', () => {
  assert.deepEqual(hostTarget('win32', 'x64'), { platform: 'win32', arch: 'x64' });
  assert.deepEqual(hostTarget('darwin', 'arm64'), { platform: 'darwin', arch: 'arm64' });
  assert.deepEqual(hostTarget('linux', 'ia32'), { platform: 'linux', arch: 'x64' });
});

test('runtime stages build frontends, assemble, verify, and archive in order', () => {
  const options = baseOptions({ kind: 'runtime' });
  const inputs = {
    nodeRuntime: path.dirname(process.execPath),
    pythonRuntime: path.resolve('runtime/python'),
  };
  const stages = createStages(options, inputs);
  assert.deepEqual(stages.map(stage => stage.name), [
    'Build AI frontend',
    'Build quant frontend',
    'Assemble portable artifact',
    'Verify portable artifact',
    'Create zip archive',
  ]);
  assert.equal(stages[2].args[stages[2].args.indexOf('--node-runtime') + 1], inputs.nodeRuntime);
  assert.equal(stages[2].args[stages[2].args.indexOf('--python-runtime') + 1], inputs.pythonRuntime);
  assert.deepEqual(stages.at(-1).args.slice(-2), ['--out', options.out]);
});

test('skip-build reuses runtime outputs but still assembles and verifies the release', () => {
  const options = baseOptions({ kind: 'runtime', skipBuild: true });
  assert.deepEqual(createStages(options, {
    nodeRuntime: path.dirname(process.execPath),
    pythonRuntime: path.resolve('runtime/python'),
  }).map(stage => stage.name), [
    'Assemble portable artifact',
    'Verify portable artifact',
    'Create zip archive',
  ]);
});

test('development stages forward every embedded runtime and cache path', () => {
  const options = baseOptions({ kind: 'dev' });
  const inputs = {
    nodeRuntime: path.resolve('便携 runtime/node'),
    pythonRuntime: path.resolve('便携 runtime/python'),
    npmCache: path.resolve('便携 cache/npm'),
    pipCache: path.resolve('便携 cache/pip'),
  };
  const stages = createStages(options, inputs);
  assert.deepEqual(stages.map(stage => stage.name), [
    'Assemble portable artifact',
    'Verify portable artifact',
    'Create zip archive',
  ]);
  const args = stages[0].args;
  for (const [flag, value] of [
    ['--node-runtime', inputs.nodeRuntime],
    ['--python-runtime', inputs.pythonRuntime],
    ['--npm-cache', inputs.npmCache],
    ['--pip-cache', inputs.pipCache],
  ]) {
    assert.equal(args[args.indexOf(flag) + 1], value);
  }
});

test('Windows Python discovery selects the newest standard user install', t => {
  const root = tempDir(t);
  const programs = path.join(root, 'Programs', 'Python');
  const python311 = path.join(programs, 'Python311', 'python.exe');
  const python313 = path.join(programs, 'Python313', 'python.exe');
  fs.mkdirSync(path.dirname(python311), { recursive: true });
  fs.mkdirSync(path.dirname(python313), { recursive: true });
  fs.writeFileSync(python311, 'fixture');
  fs.writeFileSync(python313, 'fixture');
  fs.mkdirSync(path.join(programs, 'Launcher'), { recursive: true });

  assert.deepEqual(windowsPythonCandidates({ LOCALAPPDATA: root }), [python313, python311]);
  assert.deepEqual(windowsPythonCandidates({}), []);
});

test('resolveDevInputs discovers Python and both caches through injected commands', t => {
  const root = tempDir(t);
  const pythonRuntime = path.join(root, 'Python Runtime');
  const npmCache = path.join(root, 'npm cache');
  const pipCache = path.join(root, 'pip 缓存');
  fs.mkdirSync(pythonRuntime, { recursive: true });
  fs.mkdirSync(npmCache, { recursive: true });
  fs.mkdirSync(pipCache, { recursive: true });
  const pythonExecutable = process.platform === 'win32'
    ? path.join(pythonRuntime, 'python.exe')
    : path.join(pythonRuntime, 'bin', 'python3');
  fs.mkdirSync(path.dirname(pythonExecutable), { recursive: true });
  fs.writeFileSync(pythonExecutable, 'fixture');
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args });
    if (args.some(value => value.includes('sys.executable'))) return `${pythonExecutable}\n`;
    if (args.includes('config')) return `${npmCache}\n`;
    if (args.includes('pip')) return `${pipCache}\n`;
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
  const options = baseOptions({ kind: 'dev', nodeRuntime: path.dirname(process.execPath) });
  const result = resolveDevInputs(options, { run, env: { PYTHON: 'fixture-python' } });
  assert.deepEqual(result, {
    nodeRuntime: path.dirname(process.execPath),
    pythonRuntime,
    npmCache,
    pipCache,
  });
  assert.equal(calls.length, 3);
});

test('explicit Python runtime remains usable when only pip cache is discovered', t => {
  const root = tempDir(t);
  const pythonRuntime = path.join(root, 'python');
  const executable = path.join(pythonRuntime, process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  const npmCache = path.join(root, 'npm');
  const pipCache = path.join(root, 'pip');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'fixture');
  const calls = [];
  const result = resolveDevInputs(baseOptions({
    kind: 'dev',
    pythonRuntime,
    npmCache,
  }), {
    run(command, args) {
      calls.push({ command, args });
      return pipCache;
    },
  });
  assert.equal(result.pythonRuntime, pythonRuntime);
  assert.equal(result.pipCache, pipCache);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, executable);
});

test('packagePortable stops on a failed stage before archive creation', async t => {
  const root = tempDir(t, 'khy package failure-');
  const options = baseOptions({
    kind: 'runtime',
    skipBuild: true,
    out: path.join(root, '发布 输出'),
    artifactOut: path.join(root, '展开 产物'),
  });
  const calls = [];
  await assert.rejects(
    packagePortable(options, {
      runtimeInputs: {
        nodeRuntime: path.dirname(process.execPath),
        pythonRuntime: path.resolve('runtime/python'),
      },
      run(command, args) {
        calls.push({ command, args });
        if (calls.length === 2) throw new Error('health check failed');
      },
      allowMissingArchive: true,
    }),
    /health check failed/
  );
  assert.equal(calls.length, 2);
  assert.equal(calls.some(call => call.args.includes('pack-portable.js')), false);
});

test('packagePortable reports the expected zip and cleans the intermediate artifact', async t => {
  const root = tempDir(t, 'khy package success-');
  const removed = [];
  const options = baseOptions({
    kind: 'runtime',
    skipBuild: true,
    out: path.join(root, '发布 输出'),
    artifactOut: path.join(root, '展开 产物'),
  });
  const paths = artifactPaths(options);
  const result = await packagePortable(options, {
    runtimeInputs: {
      nodeRuntime: path.dirname(process.execPath),
      pythonRuntime: path.resolve('runtime/python'),
    },
    run(command, args) {
      if (args.some(value => value.endsWith('pack-portable.js'))) {
        fs.mkdirSync(path.dirname(paths.archivePath), { recursive: true });
        fs.writeFileSync(paths.archivePath, 'zip fixture');
      }
    },
    remove(target) { removed.push(target); },
  });
  assert.equal(result.archivePath, path.join(options.out, `portable-runtime-${VERSION}-${paths.slug}.zip`));
  assert.equal(result.size, Buffer.byteLength('zip fixture'));
  assert.deepEqual(removed, [paths.artifactDir]);
});
