'use strict';

/**
 * startupSqliteProbe.js — 启动期 SQLite 驱动轻量探针（防静默死亡）。
 *
 * 背景：better-sqlite3 原生模块 ABI 不匹配时可能直接段错误，进程无任何输出即
 * 退出（静默死亡）。本探针把「加载适配器 + 打开 :memory: 数据库」放进子进程，
 * 段错误只会杀死子进程；主进程据此给出可读错误与修复指引。
 *
 * 契约：
 *   - 返回 { checked, ok, driver, detail }
 *   - checked=false 表示探针未得出结论（超时/自身异常/门控关）→ 调用方必须放行
 *   - 仅 checked=true 且 ok=false 才应中止启动
 *   - 本模块绝不 throw、绝不打印
 *
 * 门控：KHY_STARTUP_SQLITE_PROBE 默认开；0/false/off/no 关闭（checked=false 放行）。
 */

const { spawnSync } = require('child_process');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

function _gateEnabled(env) {
  const v = (env || process.env).KHY_STARTUP_SQLITE_PROBE;
  if (v === undefined || v === null) {
    return true;
  }
  return !_FALSY.has(String(v).trim().toLowerCase());
}

/**
 * 同步运行探针（子进程隔离，默认预算 ~1.2s，超时视为不确定并放行）。
 * @param {object} [options] { timeoutMs, env }
 * @returns {{checked: boolean, ok: boolean, driver: string, detail: string}}
 */
function runStartupSqliteProbe(options = {}) {
  const result = { checked: false, ok: true, driver: '', detail: '' };
  try {
    if (!_gateEnabled(options.env)) {
      result.detail = 'probe disabled by KHY_STARTUP_SQLITE_PROBE';
      return result;
    }
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 1200;
    // 先解析路径（不加载模块）：适配器真正 require 发生在子进程里。
    const adapterPath = require.resolve('../config/sqlite-adapter');
    const script = [
      `const A = require(${JSON.stringify(adapterPath)});`,
      'const D = A.Database || A;',
      "const db = new D(':memory:');",
      "db.exec('CREATE TABLE probe_t(v INTEGER)');",
      'db.close();',
      "process.stdout.write('KHY_SQLITE_OK:' + ((A.__driverInfo && A.__driverInfo.type) || 'unknown'));",
    ].join('\n');
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    });
    const match = String(child.stdout || '').match(/KHY_SQLITE_OK:(\S+)/);
    if (match) {
      // 子进程已证明加载安全 → 主进程内读取 __driverInfo 供诊断展示。
      result.checked = true;
      result.ok = true;
      result.driver = match[1];
      try {
        const info = require('../config/sqlite-adapter').__driverInfo;
        if (info && info.type) {
          result.driver = info.type;
        }
      } catch {
        /* 以子进程结果为准 */
      }
      return result;
    }
    if (child.error && child.error.code === 'ETIMEDOUT') {
      // 超时 = 不确定：绝不为探针拖慢/阻断启动。
      result.detail = `probe timeout (>${timeoutMs}ms)`;
      return result;
    }
    if (child.error) {
      // 探针自身派生失败（非驱动问题）→ 放行。
      result.detail = `probe spawn failed: ${child.error.message || child.error}`;
      return result;
    }
    result.checked = true;
    result.ok = false;
    if (child.signal) {
      result.detail = `SQLite 探针子进程被信号 ${child.signal} 终止（疑似 better-sqlite3 原生模块段错误 / ABI 不匹配）`;
    } else {
      const stderrTail = String(child.stderr || '')
        .trim()
        .split(/\r?\n/)
        .slice(-3)
        .join(' | ');
      result.detail = `SQLite 探针子进程退出码 ${child.status}${stderrTail ? `：${stderrTail}` : ''}`;
    }
    return result;
  } catch (err) {
    // 探针自身异常一律放行（checked=false）。
    result.checked = false;
    result.ok = true;
    result.detail = `probe internal error: ${err && err.message ? err.message : err}`;
    return result;
  }
}

module.exports = { runStartupSqliteProbe, _gateEnabled };
