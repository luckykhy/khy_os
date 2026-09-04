'use strict';

/**
 * workspaceGuard.js — Worker 工作目录的「钉死 + 启动前校验」。
 *
 * 双进程隔离里 Worker 只有一件事必须绝对成立：它的工作目录是项目根下的
 * `workspace` 子目录，而且**在进程启动前就已经 cd 进去**。启动后再 chdir 是不算的
 * —— 那时子进程已经以项目根为 cwd 跑过一段，任何相对路径解析、任何 hook 初始化
 * 都已经把项目根写进了轨迹。所以校验必须发生在 spawn 之前，且失败就拒绝启动。
 *
 * 两个层次，故意分开：
 *   isUnderWorkspace()   纯函数，只做路径包含判定，零 IO，可在任何地方安全调用。
 *   validateWorkerCwd()  在纯判定之上补 realpath 解析与存在性检查（要 IO）。
 *   assertWorkerCwd()    校验不过直接抛 WorkerCwdError —— 这就是「拒绝启动并报错」。
 *
 * 易错点（都有单测钉住）：
 *   - `<root>/workspace-foo` 不算在 workspace 下（前缀字符串比较会误判成在，
 *     所以必须用 path.relative 而不是 startsWith）。
 *   - win32 下盘符与路径大小写不敏感，比较前要统一大小写；POSIX 下必须区分。
 *   - 符号链接：真实路径在 workspace 下才算，避免用软链绕出去。
 *
 * @module services/auditTrajectory/workspaceGuard
 */

const fs = require('fs');
const path = require('path');

/** Worker 唯一合法的工作目录名（相对项目根）。 */
const WORKSPACE_DIR_NAME = 'workspace';

/** 校验失败抛这个类型，调用方可据 code 分支处理。 */
class WorkerCwdError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'WorkerCwdError';
    this.code = detail.code || 'WORKER_CWD_INVALID';
    Object.assign(this, detail);
  }
}

/** 统一成可比较形态：绝对化 + 去尾分隔符 + win32 折叠大小写。 */
function normalizeForCompare(p) {
  let s = path.resolve(String(p || ''));
  if (s.length > 1) {
    s = s.replace(/[\\/]+$/, '') || s;
  }
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/**
 * 纯判定：cwd 是否就是（或位于）项目根下的 workspace 目录。零 IO。
 *
 * @param {string} projectRoot 项目根
 * @param {string} cwd 待判定目录
 * @param {object} [opts] { dirName: 覆盖 workspace 目录名 }
 * @returns {{ok:boolean, workspaceRoot:string, relative:string, reason:string}}
 */
function isUnderWorkspace(projectRoot, cwd, opts = {}) {
  const dirName = String(opts.dirName || WORKSPACE_DIR_NAME);
  const rootRaw = String(projectRoot || '');
  const cwdRaw = String(cwd || '');
  const workspaceRoot = rootRaw ? path.resolve(rootRaw, dirName) : '';

  if (!rootRaw || !cwdRaw) {
    return {
      ok: false,
      workspaceRoot,
      relative: '',
      reason: `校验 Worker 工作目录：缺少${!rootRaw ? ' projectRoot' : ''}${!cwdRaw ? ' cwd' : ''}，无法判定归属`,
    };
  }

  // 用 path.relative 而不是字符串前缀：前缀比较会把 <root>/workspace-foo 误判成在
  // workspace 下（"workspace-foo".startsWith("workspace") 为真），那是隔离的破口。
  const rel = path.relative(normalizeForCompare(workspaceRoot), normalizeForCompare(cwdRaw));
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  return {
    ok: inside,
    workspaceRoot,
    relative: rel,
    reason: inside
      ? `校验 Worker 工作目录：${rel === '' ? 'workspace 根' : rel} 位于 ${dirName} 之内，通过`
      : `校验 Worker 工作目录：${cwdRaw} 不在 ${workspaceRoot} 之内（相对路径 ${rel || '空'}），拒绝启动`,
  };
}

/**
 * 启动前校验（含 IO）：目录必须存在、必须是目录、真实路径必须在 workspace 下。
 *
 * @param {object} args
 * @param {string} args.projectRoot 项目根
 * @param {string} [args.cwd] Worker 预定工作目录；缺省取 <projectRoot>/workspace
 * @param {string} [args.dirName]
 * @param {boolean} [args.create] workspace 不存在时是否创建（默认 false：不存在即拒绝）
 * @returns {{ok:boolean, cwd:string, workspaceRoot:string, code?:string, reason:string}}
 */
function validateWorkerCwd(args = {}) {
  const dirName = String(args.dirName || WORKSPACE_DIR_NAME);
  const projectRoot = String(args.projectRoot || '');
  const workspaceRoot = projectRoot ? path.resolve(projectRoot, dirName) : '';
  const wanted = args.cwd ? path.resolve(String(args.cwd)) : workspaceRoot;

  const basic = isUnderWorkspace(projectRoot, wanted, { dirName });
  if (!basic.ok) {
    return { ok: false, cwd: wanted, workspaceRoot, code: 'WORKER_CWD_OUTSIDE_WORKSPACE', reason: basic.reason };
  }

  // 项目根本身必须存在：不存在说明调用方传错了根，宁可报错也不要凭空造目录树。
  if (!_isDir(projectRoot)) {
    return {
      ok: false,
      cwd: wanted,
      workspaceRoot,
      code: 'PROJECT_ROOT_MISSING',
      reason: `校验 Worker 工作目录：项目根 ${projectRoot} 不存在或不是目录，拒绝启动`,
    };
  }

  if (!_isDir(wanted)) {
    if (!args.create) {
      return {
        ok: false,
        cwd: wanted,
        workspaceRoot,
        code: 'WORKER_CWD_MISSING',
        reason: `校验 Worker 工作目录：${wanted} 不存在（或不是目录），无法在启动前 cd 进去，拒绝启动`,
      };
    }
    try {
      fs.mkdirSync(wanted, { recursive: true });
    } catch (err) {
      return {
        ok: false,
        cwd: wanted,
        workspaceRoot,
        code: 'WORKER_CWD_UNCREATABLE',
        reason: `校验 Worker 工作目录：创建 ${wanted} 失败（${(err && err.message) || err}），拒绝启动`,
      };
    }
  }

  // 软链可以把 <root>/workspace 指到仓库外，按真实路径再判一次才算钉住。
  const realCwd = _realpath(wanted);
  const realWorkspace = _realpath(workspaceRoot);
  const rel = path.relative(normalizeForCompare(realWorkspace), normalizeForCompare(realCwd));
  const insideReal = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (!insideReal) {
    return {
      ok: false,
      cwd: realCwd,
      workspaceRoot: realWorkspace,
      code: 'WORKER_CWD_SYMLINK_ESCAPE',
      reason: `校验 Worker 工作目录：真实路径 ${realCwd} 经符号链接跑到 ${realWorkspace} 之外，拒绝启动`,
    };
  }

  return {
    ok: true,
    cwd: realCwd,
    workspaceRoot: realWorkspace,
    reason: `校验 Worker 工作目录：${realCwd} 已钉在 ${dirName} 内，可以启动`,
  };
}

/**
 * 同 validateWorkerCwd，但不通过就抛 —— 「直接拒绝启动并报错」的落点。
 * @throws {WorkerCwdError}
 */
function assertWorkerCwd(args = {}) {
  const r = validateWorkerCwd(args);
  if (!r.ok) {
    throw new WorkerCwdError(r.reason, { code: r.code, cwd: r.cwd, workspaceRoot: r.workspaceRoot });
  }
  return r;
}

function _isDir(p) {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function _realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(String(p || ''));
  }
}

module.exports = {
  WORKSPACE_DIR_NAME,
  WorkerCwdError,
  isUnderWorkspace,
  validateWorkerCwd,
  assertWorkerCwd,
  normalizeForCompare,
};
