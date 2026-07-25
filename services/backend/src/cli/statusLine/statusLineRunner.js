'use strict';

/**
 * statusLineRunner.js — thin IO 壳:执行用户配置的 status line command,把约定的 stdin JSON
 * 喂给它,捕获 stdout,交给纯叶子 statusLineConfig 归一成一行。
 *
 * 这是「可执行 + 可刷新」闭环的执行端(每次调用 renderOnce 即一次刷新)。「可配置 / 可关闭」由
 * settings(statusLine.command)与门控 KHY_STATUS_LINE 承担,二者都在纯叶子里解析。
 *
 * 所有协作者可经 opts 注入(settings / snapshot / env / exec),测试用合成 exec 绝不起真子进程。
 * 绝不抛:任何执行失败都收敛成 {ok:false, reason, error},由 caller 诚实展示。
 */

const cfg = require('./statusLineConfig');

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

/** 解析执行超时(env KHY_STATUS_LINE_TIMEOUT_MS,默认 5s,绝不无界等待)。 */
function _timeoutMs(env) {
  const raw = env && env.KHY_STATUS_LINE_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TIMEOUT_MS;
}

/**
 * 默认执行器:用 shell 跑 command,stdin 喂 JSON。失败/超时不抛,统一返回 {status, stdout, stderr, error}。
 * @param {string} command
 * @param {string} input stdin 内容
 * @param {object} opts {timeoutMs}
 */
function _defaultExec(command, input, opts = {}) {
  const { spawnSync } = require('child_process');
  const isWin = process.platform === 'win32';
  const shell = isWin ? 'cmd' : 'sh';
  const flag = isWin ? '/c' : '-c';
  const res = spawnSync(shell, [flag, command], {
    input,
    timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    encoding: 'utf-8',
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error || null,
  };
}

/**
 * 渲染一次状态行(执行 = 刷新)。
 *
 * @param {object} args
 * @param {object} [args.settings] 已解析的 khy settings(statusLine.command 来源)
 * @param {object} [args.snapshot] buildStdinPayload 的输入快照
 * @param {object} [args.env] 环境(门控/超时)
 * @param {Function} [args.exec] 注入执行器(command, input, {timeoutMs}) → {status,stdout,stderr,error}
 * @returns {{ok:boolean, line:(string|null), raw:(string|null), reason:(string|null),
 *            error:(string|null), command:(string|null)}}
 */
function renderOnce(args = {}) {
  const env = args.env || process.env;
  const exec = typeof args.exec === 'function' ? args.exec : _defaultExec;

  if (!cfg.isEnabled(env)) {
    return { ok: false, line: null, raw: null, reason: 'disabled', error: null, command: null };
  }
  const resolved = cfg.resolveStatusLineSetting(args.settings || {});
  if (!resolved.configured) {
    return { ok: false, line: null, raw: null, reason: 'unconfigured', error: null, command: null };
  }

  let input;
  try {
    input = JSON.stringify(cfg.buildStdinPayload(args.snapshot || {}, env));
  } catch {
    input = '{}';
  }

  let result;
  try {
    result = exec(resolved.command, input, { timeoutMs: _timeoutMs(env) });
  } catch (err) {
    return {
      ok: false, line: null, raw: null, reason: 'exec_error',
      error: err && err.message ? err.message : String(err), command: resolved.command,
    };
  }

  if (result && result.error) {
    const msg = result.error.message || String(result.error);
    return { ok: false, line: null, raw: null, reason: 'exec_error', error: msg, command: resolved.command };
  }

  const raw = result && typeof result.stdout === 'string' ? result.stdout : '';
  const line = cfg.normalizeRenderedLine(raw, { padding: resolved.padding });
  if (!line) {
    const stderr = result && result.stderr ? String(result.stderr).trim() : '';
    return {
      ok: false, line: '', raw, reason: 'empty_output',
      error: stderr || null, command: resolved.command,
    };
  }
  return { ok: true, line, raw, reason: null, error: null, command: resolved.command };
}

module.exports = { renderOnce, DEFAULT_TIMEOUT_MS };
