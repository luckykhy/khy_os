'use strict';

/**
 * sessionChecklistResetService — 新会话启动时清空 legacy 会话清单文件的薄壳(执行 IO)。
 *
 * 背景(真缺口):V1 TodoWrite(os.tmpdir()/khy-todos.json)与兼容 todoWrite
 * (.khyquant/todo_state.json)语义上都是「本会话计划清单」,却落成全局 / 进程级文件、
 * 不与会话绑定。启动任务清理(taskCleanupService)只按年龄清持久化 large-task store,从不
 * 碰这两条 legacy 链路,故会话清单「重启还在」。本模块在**新会话(非 resume)**启动时清空
 * 它们,给 TodoWrite 真正的会话边界。
 *
 * 职责划分:本模块**执行 IO**(解析目录、fs.existsSync/unlinkSync),故它**不是**叶子、
 *   不受 leaf-contract 扫描。「该清哪些文件」的判定收敛在同目录叶子模块
 *   sessionChecklistResetPolicy;本模块只删除被它批准的路径、并解析写入 / 读取侧的基目录。
 *
 * 不变量:fail-soft——目录解析失败 / existsSync 抛 / unlink 抛 / 门控关 / resume 会话,都不得
 *   抛出、不得阻塞会话;最差只是「这次没清」。
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const policy = require('./sessionChecklistResetPolicy');
const todoStorePath = require('./todoStorePath');

/**
 * 解析写入 / 读取侧的基目录(镜像 TodoWriteTool / 兼容 todoWrite / largeTasks 读侧)。
 *   · tmpdir       = os.tmpdir()                → khy-todos.json 及 tmp 下 khyquant/todo_state.json
 *   · compatTmpdir = platformUtils.getTmpDir()  → 兼容 todoWrite 的 tmp 候选(TEMP||TMP||os.tmpdir)
 *   · homedir      = os.homedir()               → .khyquant/todo_state.json(= getLegacyDataHome)
 *   · cwd          = process.cwd()              → 工作区 .khyquant/todo_state.json
 * @returns {{tmpdir:string, compatTmpdir:string, homedir:string, cwd:string}}
 */
function _resolvePaths() {
  let compatTmpdir = '';
  try {
    compatTmpdir = require('../tools/platformUtils').getTmpDir();
  } catch { /* platformUtils 不可用 → 叶子会回退到 tmpdir */ }
  let tmpdir = '';
  try { tmpdir = os.tmpdir(); } catch { /* ignore */ }
  let homedir = '';
  try { homedir = os.homedir(); } catch { /* ignore */ }
  let cwd = '';
  try { cwd = (typeof process !== 'undefined' && typeof process.cwd === 'function') ? process.cwd() : ''; } catch { /* ignore */ }
  return {
    tmpdir: tmpdir || '',
    compatTmpdir: compatTmpdir || tmpdir || '',
    homedir: homedir || '',
    cwd: cwd || '',
  };
}

/**
 * 清理 tmpdir 下**陈旧的会话作用域清单孤儿**(`khy-todos-<sid>.json`)。
 *
 * 会话作用域(todoStorePath)按 sessionId 分文件后,已废弃会话的清单文件会长期堆积在
 * tmpdir。判定收敛在纯叶子 `todoStorePath.selectStaleTodoFiles`(按 mtime 年龄,壳注入
 * now):**近期修改的文件一律保留**(可能属并发活会话,绝不误删),只清长期未动的。
 *
 * fail-soft:门控关 / readdir 抛 / stat 抛 / 无匹配 → 返回 [];绝不抛、不阻塞会话。
 * @returns {string[]} 已删除的孤儿路径
 */
function _pruneStaleScopedTodos(paths, fsImpl, env) {
  try {
    if (!todoStorePath.todoSessionScopeEnabled(env)) return [];
    const tmpdir = (paths && paths.tmpdir) || '';
    if (!tmpdir) return [];
    let names = [];
    try { names = fsImpl.readdirSync(tmpdir); } catch { return []; }
    if (!Array.isArray(names) || names.length === 0) return [];

    const entries = [];
    for (const name of names) {
      if (!todoStorePath.SCOPED_FILE_RE.test(String(name || ''))) continue;
      const full = path.join(tmpdir, name);
      try {
        const st = fsImpl.statSync(full);
        entries.push({ path: full, mtimeMs: st && Number(st.mtimeMs) });
      } catch { /* stat 失败(竞态删除等):跳过 */ }
    }
    if (entries.length === 0) return [];

    const now = Date.now();
    const stale = todoStorePath.selectStaleTodoFiles({ entries, now, env });
    const removed = [];
    for (const p of stale) {
      try {
        if (fsImpl.existsSync(p)) { fsImpl.unlinkSync(p); removed.push(p); }
      } catch { /* 单条失败:少清而已 */ }
    }
    return removed;
  } catch {
    return [];
  }
}

/** 清理提示行(removed>0 时打印)。color 可选(与 taskCleanupService 同款签名)。 */
function _noticeLine(removed, color) {
  const paint = typeof color === 'function' ? color : (t) => t;
  return paint(
    `🧹 已清空上一会话遗留的临时任务清单(${removed} 个 legacy todo 文件);本会话从空白清单开始。`,
    'notice',
  );
}

/**
 * 新会话启动时清空 legacy 会话清单文件。
 *
 * @param {object} [opts]
 * @param {boolean}  [opts.resumed]  是否为 resume 会话(true → 豁免,不清空)。
 * @param {object}   [opts.env]      环境(默认 process.env)。
 * @param {Function} [opts.log]      日志行输出(如 console.log);removed>0 时调用一次。
 * @param {object}   [opts.paths]    注入基目录(测试用);缺省用 _resolvePaths()。
 * @param {object}   [opts.fs]       注入 fs(测试用);缺省用真实 fs。
 * @returns {{ran:boolean, removed:number, paths:string[]}}
 *          门控关 / resume → {ran:false, removed:0, paths:[]};fail-soft:任何异常 → 如实少清。
 */
function resetSessionChecklist(opts = {}) {
  const env = opts.env || (typeof process !== 'undefined' ? process.env : {});
  try {
    if (!policy.isEnabled(env)) {
      return { ran: false, removed: 0, paths: [] };
    }
    // resume 会话:承接上一会话的清单,豁免清空(与 clearHistory 同边界)。
    if (opts.resumed) {
      return { ran: false, removed: 0, paths: [] };
    }

    const paths = opts.paths || _resolvePaths();
    const targets = policy.selectResetPaths({ resumed: !!opts.resumed, paths, env });
    const fsImpl = opts.fs || fs;

    const removed = [];
    for (const p of (Array.isArray(targets) ? targets : [])) {
      try {
        if (fsImpl.existsSync(p)) {
          fsImpl.unlinkSync(p);
          removed.push(p);
        }
      } catch {
        // 单条文件失败(权限 / 竞态删除):吞掉、少清而已,继续下一条。
      }
    }

    // 会话作用域启用时:附带清理长期未动的 `khy-todos-<sid>.json` 孤儿(并发活会话安全)。
    // 与 legacy 清空正交——即便 targets 为空(全局文件不存在)也应回收陈旧分文件。
    try {
      for (const p of _pruneStaleScopedTodos(paths, fsImpl, env)) removed.push(p);
    } catch { /* fail-soft:孤儿清理失败不影响主流程 */ }

    if (removed.length === 0) {
      return { ran: true, removed: 0, paths: [] };
    }

    if (removed.length > 0 && typeof opts.log === 'function') {
      try {
        opts.log(_noticeLine(removed.length, opts.color));
      } catch {
        // 日志失败不影响清理结果。
      }
    }

    return { ran: true, removed: removed.length, paths: removed };
  } catch {
    return { ran: false, removed: 0, paths: [] };
  }
}

module.exports = {
  resetSessionChecklist,
  _resolvePaths,
  _pruneStaleScopedTodos,
  _noticeLine,
};
