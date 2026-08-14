'use strict';

/**
 * _execCompat.js — 一个「与 child_process.execSync 契约同形、但**非阻塞事件循环**」的
 * 命令执行垫片,用来根治「同步 execSync 卡死 khy」的一类假死。
 *
 * 为什么要它:多个工具(Grep / git* / manageDeps / shellCommand 回退路径)用**同步**
 * `execSync(cmd, { timeout })` 跑子进程。即便设了 timeout,execSync 在子进程期间**阻塞
 * 整个 Node 事件循环**——spinner 停转、keypress/ESC 无法处理——用户感知为「卡死」;而
 * 调度层那道 `Promise.race` 软超时(toolCalling `_withToolTimeout`,默认 120s)对同步阻塞
 * **完全无效**(阻塞期间 setTimeout 回调根本不会触发)。把 execSync 换成 `exec`(异步)后,
 * 子进程在后台跑、事件循环照转、ESC 可中断、软超时也能真正生效——而**输出/退出码/抛错
 * 形状与 execSync 逐字节同形**,故调用方 try/catch(`err.status===1` 等)零改动即可复用。
 *
 * 契约(execSync 同形):
 *   - 成功(退出码 0)→ resolve 出 stdout(**未指定 encoding 时为 Buffer**,与 execSync 同;
 *     指定 encoding 如 'utf-8' 则为 string,受 encoding/maxBuffer 约束)。
 *   - 失败(非 0 退出 / 信号 / 超时)→ reject 一个 Error,带 execSync 同名字段:
 *       `.status`(退出码,数字或 null)、`.signal`、`.stdout`、`.stderr`、`.message`。
 *     ripgrep/grep 的「无匹配」是退出码 1 → 调用方 `err.status === 1` 分支照常命中。
 *   - 超时:走 exec 自身的 `timeout`+`killSignal`(与 execSync 同语义),超时 err 亦带上述字段。
 *
 * 纯垫片:除子进程外零副作用、绝不同步阻塞、绝不抛(错误经 reject 传递)。
 *
 * 门控(dogfood flagRegistry):
 *   KHY_EXEC_NONBLOCKING 默认 on —— 关 → 调用方逐字节回退今日 execSync(见各工具接线)。
 */

const { exec } = require('child_process');

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/** 非阻塞执行总开关。默认 on;关 → 调用方走今日 execSync 路径(逐字节回退)。 */
function isNonBlockingExecEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : {});
  try {
    const flagRegistry = require('../services/flagRegistry');
    return flagRegistry.isFlagEnabled('KHY_EXEC_NONBLOCKING', e);
  } catch {
    const raw = e && e.KHY_EXEC_NONBLOCKING;
    if (raw === undefined || raw === null) return true;
    return !OFF_VALUES.includes(String(raw).trim().toLowerCase());
  }
}

/**
 * execSync 的非阻塞等价物。签名/选项/返回值/抛错字段与 execSync 同形,只是**不阻塞事件循环**。
 *
 * @param {string} command 要执行的命令(与 execSync 一样经 shell 解释)。
 * @param {object} [options] 透传给 child_process.exec 的选项(cwd/encoding/maxBuffer/timeout/…)。
 * @returns {Promise<string|Buffer>} 成功 → stdout;失败 → reject(带 .status/.signal/.stdout/.stderr)。
 */
function execAsync(command, options) {
  // execSync 在**未指定 encoding** 时返回 Buffer(raw bytes);而 exec 的默认 encoding 是
  // 'utf8'(返回 string)。为忠实做 execSync 的 drop-in(shellCommand 回退路径依赖 raw bytes
  // 走 Windows 智能解码),未指定 encoding 时补 'buffer',让 exec 也返回 Buffer。显式传了
  // encoding(如 Grep 的 'utf-8')则原样透传。浅拷贝避免改到调用方对象。
  const opts = options ? { ...options } : {};
  if (opts.encoding === undefined) opts.encoding = 'buffer';
  return new Promise((resolve, reject) => {
    // exec 的回调:err 为 null → 成功;否则 err 带 .code(退出码)/.signal/.killed。
    exec(command, opts, (err, stdout, stderr) => {
      if (!err) {
        resolve(stdout);
        return;
      }
      // 归一成 execSync 同形的 Error:退出码字段名从 exec 的 `code` 映射到 execSync 的 `status`。
      // exec 已在 err 上带了 message;补齐 status/stdout/stderr,让调用方 `err.status===1` 等分支复用。
      try {
        if (err.status === undefined) {
          err.status = (typeof err.code === 'number') ? err.code : null;
        }
        if (err.stdout === undefined) err.stdout = stdout;
        if (err.stderr === undefined) err.stderr = stderr;
      } catch { /* 防呆:归一失败也照常 reject 原 err */ }
      reject(err);
    });
  });
}

module.exports = {
  isNonBlockingExecEnabled,
  execAsync,
};
