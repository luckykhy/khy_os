'use strict';

/**
 * _portableAutoInstall.js — ide.js 启动前的「未安装 → 交互确认 → 装便携版 → 复检」桥。
 *
 * 当用户跑 `khy claude` / `khy codex` 而适配器 getStatus().available===false 时,与其
 * 直接报错退出,不如问一句「未安装,是否现在安装便携版?[Y/n]」——用户点头(默认 Y)才
 * 调安装器把便携版装进数据家 `~/.khy/tools/`,装完复检 available,让本次启动直接继续。
 *
 * 门 KHY_PORTABLE_CLI_AUTOINSTALL 默认开;关 → 本桥直接返回「不可用、未尝试」,ide.js
 * 走原报错路径(逐字节等价于加桥之前的行为)。
 *
 * 边界:仅对注册表已登记的便携工具(claude/codex/opencode)生效;非 TTY / 无可用 readline
 * → 不提示、不安装(不能在非交互环境替用户拍板下载)。绝不抛。
 *
 * @module cli/handlers/_portableAutoInstall
 */

const _OFF = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_PORTABLE_CLI_AUTOINSTALL 默认开,仅显式 0/false/off/no 关闭。 */
function isAutoInstallEnabled(env = process.env) {
  const v = (env || process.env || {}).KHY_PORTABLE_CLI_AUTOINSTALL;
  return !(v !== undefined && _OFF.has(String(v).trim().toLowerCase()));
}

/** 便携工具根目录缺省(~/.khy/tools);解析器是纯叶,由此注入。绝不抛。 */
function _toolsRoot() {
  try {
    const path = require('path');
    const { getDataHome } = require('../../utils/dataHome');
    return path.join(getDataHome(), 'tools');
  } catch {
    return undefined;
  }
}

/** 用已有 readline 提问 [Y/n],空/ y/yes → true,其余 → false。绝不抛。 */
function _confirmYesDefault(rl, question) {
  return new Promise((resolve) => {
    try {
      rl.question(question, (answer) => {
        const a = String(answer || '').trim().toLowerCase();
        resolve(a === '' || a === 'y' || a === 'yes');
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * 适配器不可用时,若该工具可便携安装且处于交互环境,提示确认后安装并复检。
 *
 * @param {string} ideName - 工具键(claude/codex/opencode)
 * @param {object} adapter - 网关适配器(需有 getStatus / 可选 detect)
 * @param {object} [context] - { rl } 来自 REPL;io 为注入的打印函数(测试用)
 * @returns {Promise<{available:boolean, attempted:boolean, gated?:boolean}>}
 */
async function maybeAutoInstallPortable(ideName, adapter, context = {}) {
  const io = (context && context.io) || {};
  const say = typeof io.info === 'function' ? io.info : (m) => { try { console.log(m); } catch { /* noop */ } };
  const warn = typeof io.warn === 'function' ? io.warn : say;

  if (!isAutoInstallEnabled()) return { available: false, attempted: false, gated: true };

  let registry;
  try {
    registry = require('../../services/gateway/adapters/portableCliRegistry');
  } catch {
    return { available: false, attempted: false };
  }
  if (!registry.isKnownTool(ideName)) return { available: false, attempted: false };

  const rl = context && context.rl;
  const isTty = !!(process.stdin && process.stdin.isTTY);
  if (!rl || !isTty) return { available: false, attempted: false };

  const tool = registry.getTool(ideName);
  const ok = await _confirmYesDefault(
    rl,
    `${tool.key} 未安装,是否现在安装便携版(${tool.pkg}@latest → ~/.khy/tools)?[Y/n] `
  );
  if (!ok) return { available: false, attempted: false };

  say(`正在安装 ${tool.key} 便携版(${tool.pkg}@latest)…`);
  let result;
  try {
    const installer = require('../../services/gateway/adapters/portableCliInstaller');
    result = await installer.install(tool.key, {
      toolsRoot: _toolsRoot(),
      onProgress: (text) => { const s = String(text).trim(); if (s) { try { process.stdout.write(`  ${s}\n`); } catch { /* noop */ } } },
    });
  } catch (err) {
    warn(`安装失败: ${(err && err.message) || String(err)}`);
    return { available: false, attempted: true };
  }

  if (!result || !result.ok) {
    if (result && result.gated) { warn(result.error || '便携安装已被关闭'); return { available: false, attempted: true, gated: true }; }
    warn(`安装失败: ${(result && result.error) || '未知错误'}`);
    return { available: false, attempted: true };
  }

  say(`${tool.key} 便携版已安装到 ${result.packageDir || '数据家 tools 目录'}`);

  // 复检:强制刷新 detect(若适配器支持),再读 getStatus。
  let available = false;
  try {
    if (typeof adapter.detect === 'function') adapter.detect(true);
    available = !!(adapter.getStatus && adapter.getStatus().available);
  } catch {
    available = false;
  }
  return { available, attempted: true };
}

module.exports = { maybeAutoInstallPortable, isAutoInstallEnabled };
