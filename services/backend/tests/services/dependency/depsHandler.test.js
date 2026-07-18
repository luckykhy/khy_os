'use strict';

/**
 * depsHandler.test.js — `khy deps` CLI 薄表层(注入纯内存依赖门面,零真实安装)。
 *
 * 验收:list/versions/check/install 各子命令派发;install 按需选版本经 buildInstallPlan
 * 透传;装后复验(probe 仍缺 → 不谎报成功);已就绪免装;未知依赖如实报错;
 * **绝不自动 sudo**(失败仅给提权提示);门控/JSON 输出形状。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleDeps } = require('../../../src/cli/handlers/deps');

/** 捕获 stdout(JSON 模式断言);返回 { lines, restore }。 */
function captureStdout() {
  const orig = process.stdout.write;
  const chunks = [];
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  return {
    json() {
      const text = chunks.join('');
      const line = text.trim().split('\n').filter(Boolean).pop();
      return JSON.parse(line);
    },
    restore() { process.stdout.write = orig; },
  };
}

/** 构造纯内存依赖门面桩。 */
function fakeDeps(over = {}) {
  const calls = { buildInstallPlan: [], runInstall: [] };
  const base = {
    listDependencyIds: () => ['openjdk', 'ffmpeg'],
    getDependency: (id) => (id === 'openjdk'
      ? { id: 'openjdk', label: 'OpenJDK', install: { scope: 'global' }, docsUrl: 'https://adoptium.net' }
      : id === 'ffmpeg' ? { id: 'ffmpeg', label: 'ffmpeg', install: { scope: 'global' } } : null),
    listVersionable: () => [{ depId: 'openjdk', label: 'OpenJDK', versions: ['8', '11', '17', '21'], default: '21' }],
    parseDepSpec: (spec) => {
      const s = String(spec || '');
      const at = s.indexOf('@');
      if (at < 0) return { depId: s === 'jdk' ? 'openjdk' : s, version: null };
      return { depId: s.slice(0, at) === 'jdk' ? 'openjdk' : s.slice(0, at), version: s.slice(at + 1) || null };
    },
    isVersionable: (id) => id === 'openjdk',
    defaultEnv: () => ({ cwd: '/tmp', platform: 'linux' }),
    probe: () => ({ id: 'openjdk', present: false, detail: 'not on PATH' }),
    buildInstallPlan: (depId, env, opts) => {
      calls.buildInstallPlan.push({ depId, opts });
      const version = opts && opts.version;
      const command = version === '17'
        ? ['apt-get', 'install', '-y', 'openjdk-17-jdk']
        : ['apt-get', 'install', '-y', 'default-jdk'];
      return {
        depId, label: 'OpenJDK', manager: 'apt', command,
        displayCommand: command.join(' '), requiresElevation: true, docsUrl: 'https://adoptium.net',
        version: version === '17' ? '17' : null, requestedVersion: version || null,
        versionUnavailable: !!(version && version !== '17'),
      };
    },
    runInstall: async (plan, ctx) => { calls.runInstall.push({ plan, ctx }); return { ok: true }; },
  };
  return { dep: Object.assign(base, over), calls };
}

test('list --json: 输出依赖 + versionable 标记', async () => {
  const { dep } = fakeDeps();
  const cap = captureStdout();
  try {
    await handleDeps('list', [], { json: true }, dep);
    const out = cap.json();
    assert.equal(out.dependencies.length, 2);
    const jdk = out.dependencies.find((d) => d.id === 'openjdk');
    assert.equal(jdk.versionable, true);
    assert.equal(jdk.present, false);
  } finally { cap.restore(); }
});

test('versions --json: 列出 openjdk 版本', async () => {
  const { dep } = fakeDeps();
  const cap = captureStdout();
  try {
    await handleDeps('versions', ['openjdk'], { json: true }, dep);
    const out = cap.json();
    assert.equal(out.versionable, true);
    assert.deepEqual(out.versions, ['8', '11', '17', '21']);
    assert.equal(out.default, '21');
  } finally { cap.restore(); }
});

test('versions --json: 非版本可选 → versionable=false', async () => {
  const { dep } = fakeDeps();
  const cap = captureStdout();
  try {
    await handleDeps('versions', ['ffmpeg'], { json: true }, dep);
    const out = cap.json();
    assert.equal(out.versionable, false);
    assert.deepEqual(out.versions, []);
  } finally { cap.restore(); }
});

test('check --json: 缺失探测', async () => {
  const { dep } = fakeDeps();
  const cap = captureStdout();
  try {
    await handleDeps('check', ['openjdk'], { json: true }, dep);
    const out = cap.json();
    assert.equal(out.present, false);
  } finally { cap.restore(); }
});

test('install jdk@17: 版本经 buildInstallPlan 透传 + 复验缺失不谎报成功', async () => {
  const { dep, calls } = fakeDeps();
  const cap = captureStdout();
  try {
    await handleDeps('install', ['jdk@17'], { json: true }, dep);
    const out = cap.json();
    // 版本透传到计划
    assert.equal(calls.buildInstallPlan[0].opts.version, '17');
    assert.equal(out.version, '17');
    assert.equal(out.command, 'apt-get install -y openjdk-17-jdk');
    // probe 仍缺 → verified=false → ok=false(绝不「装了就当好」)
    assert.equal(out.verified, false);
    assert.equal(out.ok, false);
  } finally { cap.restore(); }
});

test('install: 装后复验就绪 → ok=true', async () => {
  const { dep } = fakeDeps({ probe: () => ({ id: 'openjdk', present: true, detail: '/usr/bin/javac' }) });
  const cap = captureStdout();
  try {
    // 已就绪会走「免装」分支;用 force 强制走安装再复验
    await handleDeps('install', ['jdk@17'], { json: true, force: true }, dep);
    const out = cap.json();
    assert.equal(out.verified, true);
    assert.equal(out.ok, true);
  } finally { cap.restore(); }
});

test('install: 已就绪且非 force → 免装', async () => {
  const { dep, calls } = fakeDeps({ probe: () => ({ id: 'openjdk', present: true, detail: '/usr/bin/javac' }) });
  const cap = captureStdout();
  try {
    await handleDeps('install', ['openjdk'], { json: true }, dep);
    const out = cap.json();
    assert.equal(out.alreadyPresent, true);
    assert.equal(calls.runInstall.length, 0); // 未真正安装
  } finally { cap.restore(); }
});

test('install: versionUnavailable 透传(请求版本无映射退回默认)', async () => {
  const { dep } = fakeDeps();
  const cap = captureStdout();
  try {
    await handleDeps('install', ['jdk@99'], { json: true }, dep);
    const out = cap.json();
    assert.equal(out.versionUnavailable, true);
    assert.equal(out.version, null);
    assert.equal(out.requestedVersion, '99');
  } finally { cap.restore(); }
});

test('install: 未知依赖 → 不构建计划、不安装', async () => {
  const { dep, calls } = fakeDeps();
  const cap = captureStdout();
  try {
    await handleDeps('install', ['nonsuch'], {}, dep);
  } finally { cap.restore(); }
  assert.equal(calls.buildInstallPlan.length, 0);
  assert.equal(calls.runInstall.length, 0);
});

test('install: 安装命令仅来自 curated 计划(从不含 sudo)', async () => {
  const { dep, calls } = fakeDeps();
  const cap = captureStdout();
  try {
    await handleDeps('install', ['jdk@17'], { json: true }, dep);
  } finally { cap.restore(); }
  const argv = calls.runInstall[0].plan.command;
  assert.equal(argv.includes('sudo'), false, 'argv 绝不含 sudo');
  assert.equal(argv[0], 'apt-get');
});

test('未知子命令 / help 不抛', async () => {
  const { dep } = fakeDeps();
  const cap = captureStdout();
  try {
    assert.equal(await handleDeps('bogus', [], {}, dep), true);
    assert.equal(await handleDeps('help', [], {}, dep), true);
  } finally { cap.restore(); }
});
