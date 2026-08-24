'use strict';

/**
 * workerProcess.js — 以「启动前钉死工作目录」的方式拉起 Worker 进程。
 *
 * 三条硬约束，全部在 spawn 之前落地（启动后再补都算晚了）：
 *   1. 工作目录必须是项目根下的 workspace 子目录。校验不过直接抛，不启动。
 *      —— 靠 workspaceGuard.assertWorkerCwd()。
 *   2. 进程一诞生 cwd 就已经是 workspace：spawnOpts.cwd 由内核在 exec 时设置，
 *      子进程的第一行代码执行时 process.cwd() 就已经是 workspace，不存在
 *      「先在项目根跑一段再 chdir」的窗口。
 *   3. 进程内的任何 chdir 都不改变轨迹归属：把 workspace 路径同时写进
 *      KHY_AUDIT_PINNED_CWD，Worker 侧的 attachInWorker() 用它作为记录器的 cwd，
 *      于是即便进程内 process.chdir 到别处，已写与后写的事件都仍归属 workspace。
 *
 * 通道只有一条：一段纯自然语言文本，走命令行位置参数交给 `khy ai -p`。环境变量
 * 走 channel.sanitizeEnv 的白名单过滤（deny by default），不落任何中间文件、不设
 * 任何共享状态 —— 项目管理信息在这里没有第二条路可走。
 *
 * 超时按红线 3 用滑动空闲超时（复用 utils/spawnWithIdleTimeout），不做固定时长硬杀：
 * 前端开发任务里装依赖、起 dev server 都可能长时间安静地干活。
 *
 * @module services/auditTrajectory/workerProcess
 */

const fs = require('fs');
const path = require('path');

const channel = require('./channel');
const wire = require('./wire');
const workspaceGuard = require('./workspaceGuard');

/** 空闲超时缺省值：Worker 连续这么久没有任何输出才判定卡死。 */
const DEFAULT_IDLE_MS = 120000;

/** khy CLI 入口相对本文件的位置（services/backend/bin/khy.js）。 */
function defaultEntry() {
  return path.resolve(__dirname, '..', '..', '..', 'bin', 'khy.js');
}

/**
 * 计算一次启动方案，但不真的启动。校验不过就抛。
 *
 * 拆出来单独可测：单测无需真起子进程即可断言「cwd 钉死、env 干净、argv 只带一段文本」。
 *
 * @param {object} args
 * @param {string} args.projectRoot 项目根（Driver 的工作目录）
 * @param {string} args.message Driver 产出的纯自然语言文本（唯一通道）
 * @param {string} [args.cwd] 覆盖 Worker 工作目录（仍须在 workspace 内）
 * @param {string} [args.dirName] 覆盖 workspace 目录名
 * @param {boolean} [args.create] workspace 不存在时是否创建
 * @param {string} [args.node] node 可执行文件（默认 process.execPath）
 * @param {string} [args.entry] CLI 入口脚本
 * @param {object} [args.env] 源环境（默认 process.env）
 * @param {boolean} [args.strict] 通道文本的软禁词也拦
 * @param {boolean} [args.recordTrajectory] 是否给 Worker 打开轨迹记录（默认跟随源环境）
 * @returns {object} plan
 */
function planWorkerLaunch(args = {}) {
  // 顺序有讲究：先校验通道文本，再校验目录。文本不干净的话，目录再对也不该启动。
  const msg = channel.assertWorkerMessage(args.message, { strict: !!args.strict });

  const guard = workspaceGuard.assertWorkerCwd({
    projectRoot: args.projectRoot,
    cwd: args.cwd,
    dirName: args.dirName,
    create: !!args.create,
  });

  const entry = args.entry ? path.resolve(String(args.entry)) : defaultEntry();
  if (!fs.existsSync(entry)) {
    const err = new Error('启动 Worker 进程：CLI 入口 ' + entry + ' 不存在，拒绝启动');
    err.code = 'WORKER_ENTRY_MISSING';
    throw err;
  }

  const srcEnv = args.env || process.env;
  const record = args.recordTrajectory === undefined ? wire.isEnabled(srcEnv) : !!args.recordTrajectory;
  const sanitized = channel.sanitizeEnv(srcEnv, {
    overrides: {
      // 轨迹归属钉死在 workspace：进程内 chdir 不改变它。
      KHY_AUDIT_PINNED_CWD: guard.cwd,
      KHYQUANT_CWD: guard.cwd,
      ...(record ? { KHY_AUDIT_TRAJECTORY: '1' } : {}),
    },
  });

  return {
    ok: true,
    command: args.node ? String(args.node) : process.execPath,
    // 位置参数里只有那一段自然语言文本，没有任何任务、轮次、质检信息。
    argv: [entry, 'ai', '-p', msg.message],
    cwd: guard.cwd,
    workspaceRoot: guard.workspaceRoot,
    env: sanitized.env,
    droppedEnv: sanitized.dropped,
    idleMs: Number.isFinite(args.idleMs) ? args.idleMs : DEFAULT_IDLE_MS,
    message: msg.message,
    status:
      '准备启动 Worker 进程：工作目录钉死在 ' +
      guard.cwd +
      '，通道文本 ' +
      msg.message.length +
      ' 字，环境变量放行 ' +
      Object.keys(sanitized.env).length +
      ' 个 / 丢弃 ' +
      sanitized.dropped.length +
      ' 个',
  };
}

/**
 * 真正拉起 Worker 进程。
 *
 * @param {object} args 同 planWorkerLaunch，另加：
 * @param {boolean} [args.dryRun] 只返回方案不启动（单测与人工确认前预览用）
 * @param {number} [args.idleMs] 滑动空闲超时（无输出多久判卡死），默认 120000
 * @param {function} [args.onActivity] 转发给 spawnWithIdleTimeout 的活动回调
 * @param {function} [args.onStdoutChunk]
 * @param {string} [args.outputEncoding] 子进程输出解码方式，默认 utf-8（Worker 是 Node 进程）
 * @returns {Promise<object>} { ok, code, stdout, stderr, cwd, workspaceRoot, plan }
 */
async function launchWorker(args = {}) {
  const plan = planWorkerLaunch(args);
  if (args.dryRun) {
    return { ok: true, dryRun: true, plan, cwd: plan.cwd, workspaceRoot: plan.workspaceRoot };
  }

  const { spawnWithIdleTimeout } = require('../../utils/spawnWithIdleTimeout');
  try {
    const r = await spawnWithIdleTimeout(plan.command, plan.argv, {
      // cwd 在内核 exec 时生效：子进程第一行代码看到的 process.cwd() 就是 workspace。
      spawnOpts: { cwd: plan.cwd, env: plan.env, windowsHide: true },
      idleMs: plan.idleMs,
      label: 'Worker 进程',
      // Worker 是 Node 进程，管道里写的是 UTF-8 字节。不显式声明的话，Windows 上会
      // 走 OEM 代码页自动解码，Worker 回报的中文正文会整段变成乱码 —— 而这段正文
      // 正是 Driver 下一轮起草的依据，乱码等于证据链断在这里。
      outputEncoding: args.outputEncoding || 'utf-8',
      onActivity: typeof args.onActivity === 'function' ? args.onActivity : null,
      onStdoutChunk: typeof args.onStdoutChunk === 'function' ? args.onStdoutChunk : null,
    });
    return {
      ok: r.code === 0,
      code: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
      cwd: plan.cwd,
      workspaceRoot: plan.workspaceRoot,
      plan,
      status: '运行 Worker 进程 ' + path.basename(plan.cwd) + '：退出码 ' + r.code + '，输出 ' + String(r.stdout || '').length + ' 字',
    };
  } catch (err) {
    // 空闲超时与 spawn 失败都走这里：如实回报，不假装成功。
    return {
      ok: false,
      code: null,
      stdout: '',
      stderr: (err && err.message) || String(err),
      idleTimeout: !!(err && err.idleTimeout),
      cwd: plan.cwd,
      workspaceRoot: plan.workspaceRoot,
      plan,
      status: '运行 Worker 进程 ' + path.basename(plan.cwd) + '：失败（' + ((err && err.message) || err) + '）',
    };
  }
}

/**
 * Worker 侧读取被钉死的工作目录。
 * 优先取 KHY_AUDIT_PINNED_CWD —— 它由父进程在 spawn 前写定，进程内 chdir 改不动它。
 * @param {object} [env]
 * @returns {string}
 */
function pinnedCwdFromEnv(env = process.env) {
  const e = env && typeof env === 'object' ? env : {};
  const pinned = String(e.KHY_AUDIT_PINNED_CWD || e.KHYQUANT_CWD || '').trim();
  return pinned || process.cwd();
}

/**
 * Worker 侧接线：把审计记录器挂上 hook，cwd 用被钉死的那个。
 *
 * 这是「进程内的任何 cd 都不改变其轨迹归属」的落点：记录器的 cwd 取自环境变量而不是
 * process.cwd()，所以 chdir 之后新写的事件仍然归属 workspace。
 *
 * @param {object} [opts] { hookSystem, sessionId, dir, env, lang }
 * @returns {object} wire.attach 的返回值
 */
function attachInWorker(opts = {}) {
  const env = opts.env || process.env;
  const cwd = pinnedCwdFromEnv(env);
  return wire.attach({
    hookSystem: opts.hookSystem,
    sessionId: opts.sessionId,
    dir: opts.dir,
    lang: opts.lang,
    env,
    cwd,
  });
}

module.exports = {
  DEFAULT_IDLE_MS,
  defaultEntry,
  planWorkerLaunch,
  launchWorker,
  pinnedCwdFromEnv,
  attachInWorker,
};
