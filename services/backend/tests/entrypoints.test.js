'use strict';

/**
 * entrypoints.test.js — 端矩阵的契约测试。
 *
 * 这些用例锁的是**声明层的硬约束**，而不是端自己能不能跑起来：
 *   - 真源表本身自洽（必填字段齐、id 唯一、kind/status 在枚举内）；
 *   - 表里没有端口字面量、没有绝对路径（工程规则 1 / RUNTIME-001）；
 *   - 解析不会崩：未知 id 返回 null / ok:false 而不是抛异常；
 *   - 平台档缺失时**诚实报缺失**，不猜一条命令出来。
 *
 * 「某个端真的起得来吗」不在这里测——那是 `khy entry probe` 的活，它读的是
 * 磁盘与本机工具链，而单测跑在 CI 上，磁盘状态并不稳定。把环境相关的断言
 * 混进契约测试，结果是测试随机红、然后被人 skip。
 */

const fs = require('fs');
const path = require('path');

const registry = require('../src/services/entrypoints/registry');
const entrypoints = require('../src/services/entrypoints');

const APP_ROOT = path.resolve(__dirname, '..', '..', '..');

describe('端矩阵 · 数据自洽', () => {
  it('真源表加载时零校验错误', () => {
    const registryData = registry.loadRegistry({ appRoot: APP_ROOT, force: true });
    expect(registryData.exists).toBe(true);
    expect(registryData.errors).toEqual([]);
  });

  it('端 id 唯一且非空', () => {
    const ids = registry.listIds({ appRoot: APP_ROOT });
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.trim()).toBe(id);
  });

  it('每个端的 kind 都落在 kinds 枚举内', () => {
    const { kinds } = registry.loadRegistry({ appRoot: APP_ROOT });
    for (const entry of registry.listEntries({ appRoot: APP_ROOT })) {
      expect(Object.keys(kinds)).toContain(entry.kind);
    }
  });

  it('每个端的 status 都落在 statuses 枚举内', () => {
    const { statuses } = registry.loadRegistry({ appRoot: APP_ROOT });
    for (const entry of registry.listEntries({ appRoot: APP_ROOT })) {
      expect(Object.keys(statuses)).toContain(entry.status);
    }
  });

  it('非 ready 的端必须写明理由（statusNote）', () => {
    for (const entry of registry.listEntries({ appRoot: APP_ROOT })) {
      if (entry.status === 'ready') continue;
      expect(typeof entry.statusNote).toBe('string');
      expect(entry.statusNote.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('端矩阵 · 产物坐标（读登记表，不抄路径）', () => {
  it('产物登记表能读到，且包含四端各自的 id', () => {
    const { index, errors } = registry.loadBuildOutputs({ appRoot: APP_ROOT, force: true });
    expect(errors).toEqual([]);
    // 四端各自的产物登记 id：终端(pip) / 桌面(electron-builder) / 手机(flutter) / 网页(ai-frontend)
    for (const id of ['pip-dist', 'electron-builder', 'flutter-android-release', 'ai-frontend']) {
      expect(index.has(id)).toBe(true);
    }
  });

  it('已知产物坐标解析出候选路径，且路径落在 appRoot 之下', () => {
    const detail = entrypoints.describe('desktop', { appRoot: APP_ROOT });
    expect(detail.artifact.registered).toBe(true);
    expect(detail.artifact.id).toBe('electron-builder');
    expect(detail.artifact.candidates.length).toBeGreaterThan(0);
    for (const candidate of detail.artifact.candidates) {
      expect(path.isAbsolute(candidate.abs)).toBe(true);
      expect(candidate.abs.startsWith(APP_ROOT)).toBe(true);
    }
    // 登记表里 rebuild 是「怎么把它变回来」的必填字段（LAYOUT-005 不变量 I1）。
    expect(typeof detail.artifact.rebuild).toBe('string');
    expect(detail.artifact.rebuild.length).toBeGreaterThan(0);
  });

  it('未登记 / 未声明产物时降级为说明，不抛异常', () => {
    const missing = registry.resolveArtifact({ id: 'x', artifactOutput: null }, { appRoot: APP_ROOT });
    expect(missing.registered).toBe(false);
    expect(missing.exists).toBe(false);
    expect(missing.reason).toContain('artifactOutput');

    const unknown = registry.resolveArtifact(
      { id: 'x', artifactOutput: 'no-such-output-id' },
      { appRoot: APP_ROOT }
    );
    expect(unknown.registered).toBe(false);
    // 报错要指向真源与修法，而不是只说「找不到」。
    expect(unknown.reason).toContain('BUILD-OUTPUTS.json');
  });

  it('空目录不算「已产出」', () => {
    const os = require('os');
    const fsLocal = require('fs');
    const root = fsLocal.mkdtempSync(path.join(os.tmpdir(), 'khy-entry-'));
    const emptyDir = path.join(root, 'empty');
    const zeroFile = path.join(root, 'zero.bin');
    const realFile = path.join(root, 'real.bin');
    fsLocal.mkdirSync(emptyDir);
    fsLocal.writeFileSync(zeroFile, '');
    fsLocal.writeFileSync(realFile, 'x');
    // 目录存在但空 → 构建失败/clean 后的空壳，报「已产出」会把人骗去白跑一趟。
    expect(registry.pathHasContent(emptyDir)).toBe(false);
    expect(registry.pathHasContent(zeroFile)).toBe(false);
    expect(registry.pathHasContent(realFile)).toBe(true);
    expect(registry.pathHasContent(path.join(root, 'nope'))).toBe(false);
    fsLocal.rmSync(root, { recursive: true, force: true });
  });

  it('shell 类端的入口文件与打包形态分开报（khy.bat 在 ≠ wheel 已构建）', () => {
    const detail = entrypoints.describe('cli', { appRoot: APP_ROOT });
    expect(detail.entryFiles.length).toBeGreaterThan(0);
    // 终端端的仓库内入口文件此刻就在磁盘上，这是「终端现在可用」的直接证据。
    const bat = detail.entryFiles.find(f => f.rel === 'khy.bat');
    expect(bat).toBeDefined();
    expect(bat.exists).toBe(true);
  });
});

describe('端矩阵 · 工程规则 1（RUNTIME-001）', () => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(APP_ROOT, registry.ENTRYPOINTS_REL), 'utf8')
  );

  it('端口只写 serviceDefaults 导出名，不出现端口字面量', () => {
    for (const entry of raw.entries) {
      for (const port of entry.ports || []) {
        expect(typeof port.ref).toBe('string');
        expect(port.ref).toMatch(/^[A-Z][A-Z0-9_]*$/);
        expect(port).not.toHaveProperty('port');
      }
    }
  });

  it('source 与计划里的路径都是仓库相对路径或 <appRoot> 占位符', () => {
    const looksAbsolute = value =>
      path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
    for (const entry of raw.entries) {
      expect(looksAbsolute(entry.source)).toBe(false);
      for (const rel of entry.entryFiles || []) {
        expect(looksAbsolute(rel)).toBe(false);
      }
      for (const field of ['launch', 'build']) {
        const plan = entry[field];
        if (!plan) continue;
        for (const step of Object.values(plan)) {
          if (!step || typeof step !== 'object') continue;
          if (step.cwd !== undefined) expect(looksAbsolute(step.cwd)).toBe(false);
        }
      }
    }
  });
});

describe('端矩阵 · 解析不崩', () => {
  it('未知 id 返回 null / ok:false，而不是抛异常', async () => {
    expect(registry.getEntry('no-such-end', { appRoot: APP_ROOT })).toBeNull();
    expect(entrypoints.describe('no-such-end', { appRoot: APP_ROOT })).toBeNull();

    const launched = await entrypoints.launch('no-such-end', { appRoot: APP_ROOT });
    expect(launched.ok).toBe(false);
    expect(launched.error).toContain('未知的端');
    // 报错里要给出候选，否则用户只能去翻表。
    expect(launched.error).toContain('khy entry list');
  });

  it('已声明的端解析出绝对 cwd，且落在 appRoot 之下', () => {
    const detail = entrypoints.describe('desktop', { appRoot: APP_ROOT });
    expect(detail).not.toBeNull();
    expect(detail.launch).not.toBeNull();
    expect(path.isAbsolute(detail.launch.cwd)).toBe(true);
    expect(detail.launch.cwd.startsWith(APP_ROOT)).toBe(true);
  });

  it('平台档缺失时诚实报缺失，不猜命令', async () => {
    const detail = entrypoints.describe('mobile', {
      appRoot: APP_ROOT,
      platform: 'linux',
    });
    // mobile 的构建脚本是 PowerShell，只声明了 win32 档。
    expect(detail.build).toBeNull();
    expect(detail.buildUnavailableReason).toContain('未声明');

    const built = await entrypoints.build('mobile', {
      appRoot: APP_ROOT,
      platform: 'linux',
      dryRun: true,
    });
    expect(built.ok).toBe(false);
  });

  it('端口 ref 指错时报 null + 修复建议，不返回猜的数字', () => {
    const resolved = registry.resolvePort('NOT_A_REAL_PORT_CONSTANT');
    expect(resolved.port).toBeNull();
    expect(resolved.reason).toContain('serviceDefaults');
  });

  it('dry-run 不执行任何进程，只回计划', async () => {
    const result = await entrypoints.launch('desktop', {
      appRoot: APP_ROOT,
      dryRun: true,
    });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.pid).toBeUndefined();
    expect(result.plan.command).toBeTruthy();
  });
});

// 下面四条都是**实测踩过**的回归，不是假想用例。每条注释写清当时是怎么错的——
// 少了这一段，后来的人会以为它们是凑数的边界断言，然后在重构时删掉。
describe('端矩阵 · 回归（都曾真实踩过）', () => {
  const { isOn, readArguments } = require('../src/cli/handlers/entrypoints');

  it('router 剥走的 --flags 不能被忽略（曾因此真的拉起了 Electron）', () => {
    // 实测：`khy entry launch desktop --dry-run` 只从 parsed.args 读开关，
    // 而 router.js 已把 --dry-run 移进了 parsed.options，于是 dry-run 静默失效。
    const viaRouter = readArguments({
      args: ['launch', 'desktop'],
      options: { 'dry-run': true },
    });
    expect(viaRouter.positionals).toEqual(['launch', 'desktop']);
    expect(isOn(viaRouter.options['dry-run'])).toBe(true);

    // 直接调用 handler 时 flag 仍在 args 里，这条路径也必须成立。
    const direct = readArguments({ args: ['launch', 'desktop', '--dry-run'] });
    expect(isOn(direct.options['dry-run'])).toBe(true);
  });

  it('detach 只在确认 spawn 成功后才报成功，且 pid 是真的', async () => {
    // 实测：spawn 是异步的，返回后立刻 resolve 会读到 pid=undefined，
    // 上层于是打印「已转入后台运行（PID undefined）」——假成功。
    const result = await entrypoints.launcher.runPlan({
      id: 'probe-target',
      field: 'launch',
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 1500)'],
      cwd: process.cwd(),
      mode: 'detach',
      shell: false,
    });
    expect(result.ok).toBe(true);
    expect(typeof result.pid).toBe('number');
  });

  it('命令不存在时报失败，绝不冒充「已在后台运行」', async () => {
    const result = await entrypoints.launcher.runPlan({
      id: 'probe-target',
      field: 'launch',
      command: 'definitely-not-a-real-cmd-xyz',
      args: [],
      cwd: process.cwd(),
      mode: 'detach',
      shell: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('启动失败');
    expect(result.pid).toBeUndefined();
  });

  it('Windows 上 npm 系命令走 shell，且用户参数里的 shell 元字符被挡住', () => {
    const { buildSpawnOptions, findUnsafeArg, WINDOWS_SHELL_COMMANDS } =
      entrypoints.launcher;
    expect(WINDOWS_SHELL_COMMANDS.has('npm')).toBe(true);

    const plan = {
      id: 'probe-target',
      field: 'launch',
      command: 'npm',
      args: ['run', 'build'],
      cwd: process.cwd(),
      mode: 'detach',
      shell: false,
    };
    const built = buildSpawnOptions(plan);
    // 实测：Windows 上 spawn('npm') 会 ENOENT，必须 shell。
    expect(built.options.shell).toBe(process.platform === 'win32');
    expect(built.error).toBeNull();

    // 走 shell 意味着用户参数里的 & | ; 会改变命令结构，必须挡住。
    expect(findUnsafeArg(['x & rm -rf y'])).toContain('shell 元字符');
    expect(findUnsafeArg(['--version'])).toBeNull();
  });
});
