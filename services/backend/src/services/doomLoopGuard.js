'use strict';

/**
 * doomLoopGuard.js — Doom Loop 防护(借鉴 sst/opencode src/session/processor.ts:25, 302-327)
 *
 * 背景:khy-os 的 toolLoopDetector 有 11 个探测器覆盖「同工具 / 无进展 / ping-pong /
 * 停滞 / 死缠」等病态,但都是「发出 warning / 记日志」类,不会真正打断循环。
 * opencode 的 doom_loop 模式则走得更远:连续 N 次(normally 3)**同一 tool + 完全
 * 相同的 input** → 升级为 `permission.ask`,让用户介入决策(继续 / 换思路 / 终止),
 * 而不是无限循环耗光 token 与时间。本模块提供纯叶子实现,loop 在每轮 dispatch
 * 前调 `assessDoomLoop(toolName, params)` 拿到 `{action, reason, suggest}`,
 *   action='continue'    正常执行
 *   action='escalate'    提示模型「已 N 次相同调用,请基于已有结果回答或换思路」
 *   action='ask_user'    升级为用户询问(doom loop 风险,需显式确认才能继续)
 *
 * 关键设计:
 *   - 状态是 per-call 滑动窗口(最近 DOOM_WINDOW_SIZE 个调用),不是历史全量(避免
 *     长时间会话里无关的同工具调用被误判)
 *   - 「完全相同 input」按 params 序列化后的 SHA-256 判定(顺序无关、JSON 归一)
 *   - read-only 工具(纯观测,例如 read_file)门槛放宽到 5 次(允许模型重复探查)
 *   - 写工具(write_file/edit_file/shell 等)门槛 3 次即触发,防「反复提交相同修改」
 *   - 全局门控 KHY_DOOM_LOOP_GUARD(默认开),KHY_DOOM_LOOP_THRESHOLD_WRITE / READ
 *     显式覆盖阈值
 *
 * 契约:零副作用(只读输入 + 滑动窗口)、绝不抛、fail-soft(任何异常 → 返
 * `{action:'continue'}` 让上游正常执行)。
 *
 * 借鉴致谢:opencode 的 doom_loop 实现 — https://github.com/sst/opencode
 *  (BSD-3-Clause,Copyright (c) Anomaly Innovations)
 *
 * @module services/doomLoopGuard
 */

const crypto = require('crypto');

const OFF_VALUES = new Set(['0', 'false', 'off', 'no', 'disable', 'disabled']);

// 写工具集合:副作用大,门槛 3 次即触发 escalate + ask_user
const WRITE_TOOLS = new Set([
  'write_file',
  'writefile',
  'create_file',
  'createfile',
  'edit_file',
  'editfile',
  'edit',
  'patch',
  'apply_patch',
  'shell_command',
  'shellcommand',
  'bash',
  'execute_command',
  'executecommand',
  'run_command',
  'runcommand',
  'terminal',
  'exec',
  'delete_file',
  'deletefile',
  'remove_file',
  'removefile',
  'rm',
  'move_file',
  'movefile',
  'rename',
  'git_commit',
  'gitcommit',
  'git_push',
  'gitpush',
  'npm_install',
  'npminstall',
  'pip_install',
  'pipinstall',
]);

// 读工具集合:仅观测,门槛放宽到 5 次
const READ_TOOLS = new Set([
  'read_file',
  'readfile',
  'read_many_files',
  'readmanyfiles',
  'list_directory',
  'listdirectory',
  'listdir',
  'ls',
  'glob',
  'grep',
  'rg',
  'search',
  'search_content',
  'searchcontent',
  'find_files',
  'findfiles',
  'git_status',
  'gitstatus',
  'git_diff',
  'gitdiff',
  'git_log',
  'gitlog',
  'web_search',
  'websearch',
  'web_fetch',
  'webfetch',
]);

const DEFAULT_WINDOW_SIZE = 8;
const DEFAULT_WRITE_THRESHOLD = 3;
const DEFAULT_READ_THRESHOLD = 5;
const DEFAULT_ASK_USER_AFTER = 5; // 写工具连续 5 次相同 → 升级为 ask_user(超过 escalate)

function _normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/[\s\-]+/g, '_');
}

function _isWriteTool(name) {
  return WRITE_TOOLS.has(_normalizeName(name));
}

function _isReadTool(name) {
  return READ_TOOLS.has(_normalizeName(name));
}

/**
 * 序列化 params 为稳定 JSON 字符串(键按字典序排序,数组保持原序)。不可序列化 →
 * 走 try/catch 回退到「按字符串」,绝不抛。
 *
 * 注:JSON.stringify 在 V8 / Node 22 上保留对象 key 的插入序,不是字典序。这会让
 * `{a:1,b:2}` 和 `{b:2,a:1}` 产生不同 fingerprint,跨调用方 / 跨模块比对失效。
 * 这里手写一个 key-sorted replacer 来稳定序列化:
 *   - 对象:键排序后逐个序列化(递归处理嵌套对象)
 *   - 数组:保序逐个序列化
 *   - 函数:替换为 [fn:name]
 *   - 循环引用:替换为 [Circular]
 */
function _sortKeys(value, seen) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== 'object') {
    if (typeof value === 'function') {
      return `[fn:${value.name || 'anon'}]`;
    }
    return value;
  }
  if (seen && seen.has(value)) {
    return '[Circular]';
  }
  const nextSeen = seen || new WeakSet();
  nextSeen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => _sortKeys(v, nextSeen));
  }
  // plain object — sort keys
  const out = {};
  for (const k of Object.keys(value).sort()) {
    out[k] = _sortKeys(value[k], nextSeen);
  }
  return out;
}

function _paramsFingerprint(params) {
  try {
    if (params == null) {
      return 'null';
    }
    return JSON.stringify(_sortKeys(params, null));
  } catch {
    try {
      return String(params);
    } catch {
      return '';
    }
  }
}

/**
 * 单次调用的指纹。tool+input 一起 hash,跨大小写 / 字段顺序稳定。
 */
function _callFingerprint(toolName, params) {
  const t = _normalizeName(toolName);
  const p = _paramsFingerprint(params);
  return crypto
    .createHash('sha256')
    .update(`${t}\u0000${p}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * DoomLoopGuard 实例:跟踪最近 N 次调用的指纹,提供 `assess(toolName, params)` 给
 * loop 在每次 dispatch 前调用。
 *
 * @param {object} [opts]
 * @param {number} [opts.windowSize=8]    滑动窗口大小(最近 N 个调用)
 * @param {number} [opts.writeThreshold=3] 写工具 escalate 阈值
 * @param {number} [opts.readThreshold=5]  读工具 escalate 阈值
 * @param {number} [opts.askUserAfter=5]   写工具 ask_user 阈值
 * @param {object} [opts.env]              env 来源(默认 process.env)
 */
function createDoomLoopGuard(opts = {}) {
  const window = [];
  const cfg = {
    windowSize: Number.isFinite(opts.windowSize) && opts.windowSize > 0 ? opts.windowSize : DEFAULT_WINDOW_SIZE,
    writeThreshold: Number.isFinite(opts.writeThreshold) && opts.writeThreshold > 0
      ? opts.writeThreshold
      : DEFAULT_WRITE_THRESHOLD,
    readThreshold: Number.isFinite(opts.readThreshold) && opts.readThreshold > 0
      ? opts.readThreshold
      : DEFAULT_READ_THRESHOLD,
    askUserAfter: Number.isFinite(opts.askUserAfter) && opts.askUserAfter > 0
      ? opts.askUserAfter
      : DEFAULT_ASK_USER_AFTER,
  };

  // 主动读取 env 覆盖(仅创建时读一次,运行时 env 变更不生效)
  try {
    const e = opts.env || process.env;
    if (e) {
      const writeEnv = parseInt(String(e.KHY_DOOM_LOOP_THRESHOLD_WRITE || ''), 10);
      if (Number.isFinite(writeEnv) && writeEnv > 0) {
        cfg.writeThreshold = writeEnv;
      }
      const readEnv = parseInt(String(e.KHY_DOOM_LOOP_THRESHOLD_READ || ''), 10);
      if (Number.isFinite(readEnv) && readEnv > 0) {
        cfg.readThreshold = readEnv;
      }
      const askEnv = parseInt(String(e.KHY_DOOM_LOOP_ASK_USER_AFTER || ''), 10);
      if (Number.isFinite(askEnv) && askEnv > 0) {
        cfg.askUserAfter = askEnv;
      }
    }
  } catch {
    /* fail-soft */
  }

  function push(toolName, params) {
    const fp = _callFingerprint(toolName, params);
    window.push({
      fp,
      tool: _normalizeName(toolName),
      at: Date.now(),
    });
    if (window.length > cfg.windowSize) {
      window.shift();
    }
    return fp;
  }

  /**
   * 评估下一次调用是否构成 doom loop。
   * @param {string} toolName
   * @param {object} [params]
   * @returns {{
   *   action: 'continue'|'escalate'|'ask_user',
   *   reason: string,
   *   suggest: string,
   *   consecutiveCount: number,
   *   fingerprint: string,
   * }}
   */
  function assess(toolName, params) {
    try {
      const fp = push(toolName, params);
      const tool = _normalizeName(toolName);
      // 计算当前调用在窗口尾部连续出现的次数
      let count = 0;
      for (let i = window.length - 1; i >= 0; i -= 1) {
        if (window[i].fp === fp) {
          count += 1;
        } else {
          break;
        }
      }
      // 「连续」必须是完全相同(包含 tool name,不只是 hash —— 防止 params 凑巧碰撞)
      const sameTool = window.slice(-count).every((e) => e.tool === tool);
      const consecutiveCount = sameTool ? count : 1;
      // 当前这次是第 1 次,不动
      if (consecutiveCount <= 1) {
        return {
          action: 'continue',
          reason: '',
          suggest: '',
          consecutiveCount: 1,
          fingerprint: fp,
        };
      }
      const isWrite = _isWriteTool(tool);
      const threshold = isWrite ? cfg.writeThreshold : cfg.readThreshold;
      if (consecutiveCount < threshold) {
        return {
          action: 'continue',
          reason: '',
          suggest: '',
          consecutiveCount,
          fingerprint: fp,
        };
      }
      // 达到门槛
      const reason =
        `已连续 ${consecutiveCount} 次以完全相同参数调用「${tool}」` +
        (isWrite ? '(该工具会改动文件/系统状态)' : '(该工具为读操作)');
      const suggest = isWrite
        ? '请立即停止重试,基于已有工具结果用中文写出最终回答;若现有结果不充分,改用明显不同的方法或参数,而不是把同一条命令原样重发。'
        : '请基于最近一次成功返回的内容作答;若信息不足,改用其他探测角度,而不是把同一次读取原样重发。';
      // 写工具超过 askUserAfter → 升级为 ask_user(必须用户确认才能继续)
      if (isWrite && consecutiveCount >= cfg.askUserAfter) {
        return {
          action: 'ask_user',
          reason: reason + '。继续可能无意义地消耗 token 与时间,建议人工介入。',
          suggest,
          consecutiveCount,
          fingerprint: fp,
        };
      }
      return {
        action: 'escalate',
        reason,
        suggest,
        consecutiveCount,
        fingerprint: fp,
      };
    } catch {
      return {
        action: 'continue',
        reason: '',
        suggest: '',
        consecutiveCount: 0,
        fingerprint: '',
      };
    }
  }

  function reset() {
    window.length = 0;
  }

  function snapshot() {
    return {
      windowSize: cfg.windowSize,
      writeThreshold: cfg.writeThreshold,
      readThreshold: cfg.readThreshold,
      askUserAfter: cfg.askUserAfter,
      recent: window.slice(),
    };
  }

  return { assess, reset, snapshot, _config: cfg };
}

/** 全局门控 KHY_DOOM_LOOP_GUARD(默认开,显式 0/false/off/no/disable/disabled 关闭) */
function isDoomLoopGuardEnabled(env = process.env) {
  try {
    const e = env || process.env;
    const v = e && e.KHY_DOOM_LOOP_GUARD;
    if (v === undefined || v === null || v === '') {
      return true;
    }
    return !OFF_VALUES.has(String(v).trim().toLowerCase());
  } catch {
    return true;
  }
}

module.exports = {
  isDoomLoopGuardEnabled,
  createDoomLoopGuard,
  _isWriteTool,
  _isReadTool,
  _paramsFingerprint,
  _callFingerprint,
};
