'use strict';

/**
 * portableCliInstaller.js — 把便携 CLI(claude/codex/opencode)装/更新到 khy 数据家
 * `~/.khy/tools/<pkg>-portable/` 下(变更操作:有网络 + 落盘副作用,非纯叶)。
 *
 * 用 `npm install <pkg>@latest --prefix <toolsRoot>/<portableDir>` 把包装进隔离目录,
 * 由 portableCliResolver 解析路径、适配器直接 spawn。更新即重跑同一命令(@latest 拉最新)。
 *
 * 安全:命令用**参数数组**而非字符串拼接(杜绝命令注入);仅执行固定 `npm install`;包名/前缀
 * 来自 SSOT 注册表 + 受信数据家路径,不含用户自由文本。绝不把任何 key/token 写盘或入参。
 * 门 KHY_PORTABLE_CLI_INSTALL 默认开;关 → install/update 直接返回 {ok:false, gated:true}。
 *
 * @module services/gateway/adapters/portableCliInstaller
 */

const path = require('path');
const { spawn } = require('child_process');
const registry = require('./portableCliRegistry');
const resolver = require('./portableCliResolver');

const _OFF = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_PORTABLE_CLI_INSTALL 默认开,仅显式 0/false/off/no 关闭。 */
function isInstallEnabled(env = process.env) {
  const v = (env || process.env || {}).KHY_PORTABLE_CLI_INSTALL;
  return !(v !== undefined && _OFF.has(String(v).trim().toLowerCase()));
}

/** 解析便携工具根目录(与解析器同约定):KHY_TOOLS_DIR > 注入 toolsRoot > getDataDir('tools')。 */
function _toolsRoot(env, toolsRoot) {
  const fromEnv = env && env.KHY_TOOLS_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return path.resolve(fromEnv.trim());
  if (typeof toolsRoot === 'string' && toolsRoot.trim()) return path.resolve(toolsRoot.trim());
  return require('../../../utils/dataHome').getDataDir('tools');
}

/** win32 上 npm 是 npm.cmd,须经 cmd.exe 执行(避免裸 spawn ENOENT / DEP0190)。 */
function _npmSpawn(installArgs, cwdDir, onProgress) {
  const isWin = process.platform === 'win32';
  const command = isWin ? (process.env.COMSPEC || 'cmd.exe') : 'npm';
  const args = isWin ? ['/d', '/s', '/c', 'npm', ...installArgs] : installArgs;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: cwdDir,
        env: process.env,
        windowsHide: isWin,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, error: (err && err.message) || String(err) });
      return;
    }
    let stderr = '';
    const emit = (text) => { try { if (onProgress) onProgress(text); } catch { /* best effort */ } };
    if (child.stdout) child.stdout.on('data', (d) => emit(d.toString()));
    if (child.stderr) child.stderr.on('data', (d) => { const s = d.toString(); stderr += s; emit(s); });
    child.on('error', (err) => resolve({ ok: false, error: (err && err.message) || String(err) }));
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: `npm install 退出码 ${code}${stderr ? `: ${stderr.trim().slice(-400)}` : ''}` });
    });
  });
}

/**
 * 安装/更新一个便携 CLI 工具到数据家。install 与 update 同实现(都用 @latest 拉最新)。
 * @param {string} toolKey
 * @param {object} [opts] - { env, toolsRoot, onProgress }
 * @returns {Promise<{ok:boolean, gated?:boolean, error?:string, packageDir?:string}>}
 */
async function install(toolKey, opts = {}) {
  const env = opts.env || process.env;
  if (!isInstallEnabled(env)) return { ok: false, gated: true, error: '便携安装已被 KHY_PORTABLE_CLI_INSTALL 关闭' };
  const tool = registry.getTool(toolKey);
  if (!tool) return { ok: false, error: `未知便携工具: ${toolKey}` };

  const root = _toolsRoot(env, opts.toolsRoot);
  const prefix = path.join(root, tool.portableDir);
  // `npm install <pkg>@latest --prefix <prefix>` — prefix 下自成 node_modules 隔离安装。
  const installArgs = ['install', `${tool.pkg}@latest`, '--prefix', prefix, '--no-audit', '--no-fund'];
  const result = await _npmSpawn(installArgs, root, opts.onProgress);
  if (!result.ok) return result;
  return { ok: true, packageDir: resolver.packageDir(tool.key, { env, toolsRoot: root }) };
}

/** update 是 install 的语义别名(@latest 保证拉最新)。 */
function update(toolKey, opts = {}) {
  return install(toolKey, opts);
}

module.exports = {
  isInstallEnabled,
  install,
  update,
};
