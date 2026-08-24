'use strict';

/**
 * 双进程隔离的机器验证。
 *
 * 三条要证的事，都不靠「读代码觉得对」，而是真起子进程看它落在哪里：
 *   1. Worker 的工作目录在 spawn 之前就被钉死（子进程第一行代码看到的 cwd 已是 workspace）。
 *   2. 进程内 chdir 不改变轨迹归属（记录器取被钉死的路径，不取 process.cwd()）。
 *   3. Driver 到 Worker 只有一条自然语言通道：文件、环境变量、共享状态都不带管理信息。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const channel = require('../../../src/services/auditTrajectory/channel');
const parser = require('../../../src/services/auditTrajectory/parser');
const workerProcess = require('../../../src/services/auditTrajectory/workerProcess');
const workspaceGuard = require('../../../src/services/auditTrajectory/workspaceGuard');

jest.setTimeout(30000);

let tmpRoot;

function mkRoot(name) {
  const p = path.join(tmpRoot, name);
  fs.mkdirSync(p, { recursive: true });
  return fs.realpathSync(p);
}

/** 写一个假的 CLI 入口：只报告它看到的 cwd / argv / env，不依赖真 khy CLI（快且确定）。 */
function writeFakeEntry(dir, body) {
  const file = path.join(dir, 'fake-worker-entry.js');
  fs.writeFileSync(file, body, 'utf-8');
  return file;
}

beforeAll(() => {
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'khy-dualproc-')));
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
});

describe('workspaceGuard：纯路径判定', () => {
  const root = path.resolve('/proj');

  test('workspace 根本身与其子目录都算在内', () => {
    expect(workspaceGuard.isUnderWorkspace(root, path.join(root, 'workspace')).ok).toBe(true);
    expect(workspaceGuard.isUnderWorkspace(root, path.join(root, 'workspace', 'src', 'ui')).ok).toBe(true);
  });

  test('项目根本身不算（Driver 的目录不能当 Worker 的目录）', () => {
    const r = workspaceGuard.isUnderWorkspace(root, root);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('拒绝启动');
  });

  test('workspace-foo 这类同前缀目录必须判成不在内（字符串前缀比较会误判）', () => {
    expect(workspaceGuard.isUnderWorkspace(root, path.join(root, 'workspace-foo')).ok).toBe(false);
    expect(workspaceGuard.isUnderWorkspace(root, path.join(root, 'workspaceX', 'a')).ok).toBe(false);
  });

  test('项目外的目录不在内', () => {
    expect(workspaceGuard.isUnderWorkspace(root, path.resolve('/elsewhere/workspace')).ok).toBe(false);
  });

  test('缺参数时保守判否并说明缺了什么', () => {
    expect(workspaceGuard.isUnderWorkspace('', path.join(root, 'workspace')).ok).toBe(false);
    expect(workspaceGuard.isUnderWorkspace(root, '').reason).toContain('cwd');
  });

  test('大小写：win32 折叠，POSIX 区分', () => {
    const upper = path.join(root, 'WORKSPACE');
    const r = workspaceGuard.isUnderWorkspace(root, upper);
    expect(r.ok).toBe(process.platform === 'win32');
  });
});

describe('workspaceGuard：启动前校验（含 IO）', () => {
  test('workspace 不存在则拒绝（没法在启动前 cd 进去）', () => {
    const root = mkRoot('io-missing');
    const r = workspaceGuard.validateWorkerCwd({ projectRoot: root });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('WORKER_CWD_MISSING');
  });

  test('create 为真时创建 workspace 并通过', () => {
    const root = mkRoot('io-create');
    const r = workspaceGuard.validateWorkerCwd({ projectRoot: root, create: true });
    expect(r.ok).toBe(true);
    expect(fs.statSync(path.join(root, 'workspace')).isDirectory()).toBe(true);
    expect(workspaceGuard.normalizeForCompare(r.cwd)).toBe(workspaceGuard.normalizeForCompare(path.join(root, 'workspace')));
  });

  test('cwd 指到 workspace 之外时拒绝', () => {
    const root = mkRoot('io-outside');
    fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
    const r = workspaceGuard.validateWorkerCwd({ projectRoot: root, cwd: root });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('WORKER_CWD_OUTSIDE_WORKSPACE');
  });

  test('项目根不存在时拒绝，而不是凭空造目录树', () => {
    const r = workspaceGuard.validateWorkerCwd({ projectRoot: path.join(tmpRoot, 'no-such-root'), create: true });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PROJECT_ROOT_MISSING');
  });

  test('assertWorkerCwd 不通过直接抛 WorkerCwdError', () => {
    const root = mkRoot('io-throw');
    let caught = null;
    try {
      workspaceGuard.assertWorkerCwd({ projectRoot: root, cwd: root });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(workspaceGuard.WorkerCwdError);
    expect(caught.code).toBe('WORKER_CWD_OUTSIDE_WORKSPACE');
  });
});

describe('channel：唯一通道的词汇门禁', () => {
  test('正经前端需求放行，且不被中文常用字误伤', () => {
    const text = '首页顶部做一个轮播图，图片轮廓要圆角，下面再放一个五星评分组件，分数用大号数字';
    const r = channel.buildWorkerMessage(text);
    expect(r.ok).toBe(true);
    expect(r.message).toBe(text);
    expect(r.soft.length).toBeGreaterThan(0); // 评分是软词：报告但不拦
  });

  const dirty = [
    ['任务编号 A-12 的页面请补一下', '任务编号'],
    ['第 3 轮请把按钮改小', '第 3 轮'],
    ['本轮先做列表页', '本轮'],
    ['这个要过质检的，注意格式', '质检'],
    ['做完我要验收', '验收'],
    ['这是本次交付物', '交付物'],
    ['评分标准里要求响应式', '评分标准'],
    ['QA will check the spacing', 'QA'],
    ['round 2: fix the header', 'round 2'],
    ['this is the acceptance criteria', 'acceptance'],
    ['把上一轮的提示词再执行一遍', '上一轮'],
  ];

  test.each(dirty)('拦下管理词：%s', (text, term) => {
    const r = channel.buildWorkerMessage(text);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CHANNEL_FORBIDDEN_VOCABULARY');
    expect(r.hard.some((h) => h.term.replace(/\s+/g, ' ').toLowerCase() === term.toLowerCase())).toBe(true);
  });

  test('拒绝而不是静默删词：不返回任何被改写过的正文', () => {
    const r = channel.buildWorkerMessage('这一轮要过验收，把登录页做完');
    expect(r.ok).toBe(false);
    expect(r.message).toBe('');
    expect(r.reason).toContain('拒绝发出');
    expect(r.reason).toContain('请改写后重试');
    // 也不能把干净片段拼回去当成可发文本
    expect(r.reason).not.toContain('把登录页做完');
  });

  test('strict 模式下软词也拦，默认模式只报告', () => {
    const text = '做一个打分面板';
    expect(channel.buildWorkerMessage(text).ok).toBe(true);
    expect(channel.buildWorkerMessage(text, { strict: true }).ok).toBe(false);
  });

  test('空文本拒绝发出', () => {
    const r = channel.buildWorkerMessage('   ');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CHANNEL_EMPTY');
  });

  test('assertWorkerMessage 不通过直接抛', () => {
    expect(() => channel.assertWorkerMessage('第 1 轮开始')).toThrow(channel.ChannelViolationError);
  });

  test('环境变量白名单：deny by default，名字与值都要过关', () => {
    const src = {
      PATH: '/usr/bin',
      KHY_AUDIT_TRAJECTORY: '1',
      KHY_TASK_ID: 'T-7',
      KHY_ROUND: '3',
      MY_SECRET_PLAN: 'whatever',
      LANG: 'zh_CN.UTF-8',
      TZ: 'Asia/Shanghai',
    };
    const r = channel.sanitizeEnv(src, { overrides: { KHY_AUDIT_PINNED_CWD: '/proj/workspace' } });
    expect(Object.keys(r.env).sort()).toEqual(
      ['KHY_AUDIT_PINNED_CWD', 'KHY_AUDIT_TRAJECTORY', 'LANG', 'PATH', 'TZ'].sort()
    );
    expect(r.dropped.map((d) => d.name).sort()).toEqual(['KHY_ROUND', 'KHY_TASK_ID', 'MY_SECRET_PLAN'].sort());
  });

  test('白名单变量的值里夹带管理信息也要丢掉', () => {
    const r = channel.sanitizeEnv({ LANG: '第 2 轮 zh_CN', PATH: '/usr/bin' });
    expect(r.env.LANG).toBeUndefined();
    expect(r.env.PATH).toBe('/usr/bin');
    expect(r.dropped[0].why).toContain('变量值命中管理词');
  });
});

/** 生成一个「只报告自己看到了什么」的假 CLI 入口。 */
function reportEntryBody(wpPath) {
  return [
    "'use strict';",
    "const os = require('os');",
    '// 第一行代码取到的 cwd 就是内核 exec 时设定的工作目录：',
    '// 如果父进程是在启动后才 cd，这里拿到的会是项目根。',
    'const first = process.cwd();',
    'const wp = require(' + JSON.stringify(wpPath) + ');',
    'const pinnedBefore = wp.pinnedCwdFromEnv(process.env);',
    'process.chdir(os.tmpdir());',
    'const afterChdir = process.cwd();',
    'const pinnedAfter = wp.pinnedCwdFromEnv(process.env);',
    'process.stdout.write(JSON.stringify({',
    '  first,',
    '  afterChdir,',
    '  pinnedBefore,',
    '  pinnedAfter,',
    '  argv: process.argv.slice(2),',
    '  envKeys: Object.keys(process.env),',
    '}));',
  ].join('\n');
}

describe('workerProcess：启动方案在 spawn 之前就定死', () => {
  const WP_PATH = require.resolve('../../../src/services/auditTrajectory/workerProcess');

  function prepare(name) {
    const root = mkRoot(name);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const entry = writeFakeEntry(root, reportEntryBody(WP_PATH));
    return { root, workspace: fs.realpathSync(workspace), entry };
  }

  test('argv 里只有一段自然语言文本，cwd 是 workspace', () => {
    const { root, workspace, entry } = prepare('plan-shape');
    const plan = workerProcess.planWorkerLaunch({
      projectRoot: root,
      message: '把首页的登录按钮改成主色，圆角小一点',
      entry,
      env: { PATH: process.env.PATH || '' },
    });
    expect(plan.argv).toEqual([entry, 'ai', '-p', '把首页的登录按钮改成主色，圆角小一点']);
    expect(workspaceGuard.normalizeForCompare(plan.cwd)).toBe(workspaceGuard.normalizeForCompare(workspace));
    expect(plan.env.KHY_AUDIT_PINNED_CWD).toBe(plan.cwd);
    expect(plan.env.KHYQUANT_CWD).toBe(plan.cwd);
    expect(plan.status).toContain('工作目录钉死在');
  });

  test('通道文本不干净时在算方案阶段就抛（更谈不上启动）', () => {
    const { root, entry } = prepare('plan-dirty');
    expect(() =>
      workerProcess.planWorkerLaunch({ projectRoot: root, message: '第 2 轮把表格补上', entry })
    ).toThrow(channel.ChannelViolationError);
  });

  test('工作目录不在 workspace 下时抛 WorkerCwdError', () => {
    const { root, entry } = prepare('plan-outside');
    expect(() =>
      workerProcess.planWorkerLaunch({ projectRoot: root, message: '做个列表页', cwd: root, entry })
    ).toThrow(workspaceGuard.WorkerCwdError);
  });

  test('CLI 入口缺失时拒绝启动', () => {
    const { root } = prepare('plan-noentry');
    let caught = null;
    try {
      workerProcess.planWorkerLaunch({ projectRoot: root, message: '做个列表页', entry: path.join(root, 'nope.js') });
    } catch (err) {
      caught = err;
    }
    expect(caught && caught.code).toBe('WORKER_ENTRY_MISSING');
  });

  test('dryRun 只出方案不起进程', async () => {
    const { root, entry } = prepare('plan-dry');
    const r = await workerProcess.launchWorker({ projectRoot: root, message: '做个列表页', entry, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.plan.argv[1]).toBe('ai');
    expect(r.stdout).toBeUndefined();
  });

  test('真起子进程：它看到的第一个 cwd 就是 workspace，进程内 chdir 不改变钉死值', async () => {
    const { root, workspace, entry } = prepare('spawn-pinned');
    const r = await workerProcess.launchWorker({
      projectRoot: root,
      message: '把卡片间距调大一点，标题字号也加大',
      entry,
      idleMs: 8000,
      env: { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '' },
    });
    expect(r.ok).toBe(true);
    const out = JSON.parse(r.stdout);
    const norm = workspaceGuard.normalizeForCompare;
    // 1. 启动前就 cd 进去了
    expect(norm(out.first)).toBe(norm(workspace));
    // 2. 进程内 chdir 确实改了 process.cwd()
    expect(norm(out.afterChdir)).not.toBe(norm(workspace));
    // 3. 但轨迹归属仍然钉在 workspace
    expect(norm(out.pinnedBefore)).toBe(norm(workspace));
    expect(norm(out.pinnedAfter)).toBe(norm(workspace));
    // 4. 通道只有那段文本
    expect(out.argv).toEqual(['ai', '-p', '把卡片间距调大一点，标题字号也加大']);
  });

  test('子进程环境里一个管理变量都没有', async () => {
    const { root, entry } = prepare('spawn-env');
    const r = await workerProcess.launchWorker({
      projectRoot: root,
      message: '页脚加上版权信息',
      entry,
      idleMs: 8000,
      env: {
        PATH: process.env.PATH || '',
        SystemRoot: process.env.SystemRoot || '',
        KHY_TASK_ID: 'T-99',
        KHY_ROUND_INDEX: '4',
        KHY_QA_ENDPOINT: 'reviewer',
        KHY_DELIVERABLE: 'yes',
      },
    });
    expect(r.ok).toBe(true);
    const out = JSON.parse(r.stdout);
    const leaked = out.envKeys.filter((k) => /TASK|ROUND|QA|DELIVER|ACCEPT|SCORE|RUBRIC/i.test(k));
    expect(leaked).toEqual([]);
  });

  test('空闲超时按滑动窗口终止，不是固定时长硬杀', async () => {
    const { root } = prepare('spawn-idle');
    const silent = writeFakeEntry(root, 'setTimeout(function () {}, 60000);');
    const started = Date.now();
    const r = await workerProcess.launchWorker({
      projectRoot: root,
      message: '先什么都不做',
      entry: silent,
      idleMs: 600,
      env: { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '' },
    });
    expect(r.ok).toBe(false);
    expect(r.idleTimeout).toBe(true);
    expect(Date.now() - started).toBeLessThan(20000);
    expect(r.status).toContain('运行 Worker 进程');
  });
});

describe('attachInWorker：轨迹归属取被钉死的目录', () => {
  test('进程内 chdir 之后写的事件仍归属 workspace', async () => {
    const hookSystem = require('../../../src/services/hooks/hookSystem');
    const root = mkRoot('attach-pinned');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const pinned = fs.realpathSync(workspace);
    const trajDir = path.join(root, 'traj');
    const original = process.cwd();

    hookSystem.reload(root);
    const attached = workerProcess.attachInWorker({
      hookSystem,
      sessionId: 'worker-pinned',
      dir: trajDir,
      env: { KHY_AUDIT_TRAJECTORY: '1', KHY_AUDIT_PINNED_CWD: pinned },
    });
    expect(attached.enabled).toBe(true);

    try {
      process.chdir(os.tmpdir()); // Worker 进程内自己乱 cd
      await hookSystem.trigger('PrePrompt', { prompt: '给页面加一个返回顶部按钮', iteration: 1 });
      const target = path.join(pinned, 'top.js');
      await hookSystem.trigger('PreToolUse', { toolName: 'Write', params: { file_path: target }, iteration: 1 });
      fs.writeFileSync(target, 'export const top = () => window.scrollTo(0, 0);\n', 'utf-8');
      await hookSystem.trigger('PostToolUse', {
        toolName: 'Write',
        params: { file_path: target },
        result: { success: true },
        elapsed: 5,
      });
    } finally {
      process.chdir(original);
      hookSystem.reload(root);
    }

    const parsed = parser.parseTrajectory(attached.recorder.file);
    expect(parsed.malformed).toBe(0);
    expect(parsed.events.length).toBeGreaterThanOrEqual(4);
    const norm = workspaceGuard.normalizeForCompare;
    for (const e of parsed.events) {
      expect(norm(e.cwd)).toBe(norm(pinned));
    }
    expect(parsed.toolCalls.map((c) => c.name)).toEqual(['Write']);
    const judged = parser.judgeRounds(parsed);
    expect(judged.rounds[0].valid).toBe(true);
  });
});
