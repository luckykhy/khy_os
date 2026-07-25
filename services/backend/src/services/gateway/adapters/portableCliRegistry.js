'use strict';

/**
 * portableCliRegistry.js — 便携 CLI 工具的单一真源(纯叶子/pure-leaf、确定性、无副作用)。
 *
 * 背景(症状:陌生机器上 `khy claude` / `khy codex` / `khy opencode` 全部报「未检测到
 * xxx 命令」):这三个 CLI 都是可 `npm install` 的包,但 khy 只 spawn 裸命令,完全依赖
 * 系统 PATH。用户机器上没全局装 → 恒 ENOENT。本项目希望「npm 装好 khy 后,把 claude/
 * codex/opencode 做成可更新的便携版、开箱即用」——装进 khy 数据家 `~/.khy/tools/` 下,
 * 由 khy 自己解析路径、自己拉起、可 `khy tools update` 保持最新。
 *
 * 本叶子把「每个便携 CLI 对应哪个 npm 包、bin 名、便携目录名、探活参数」收敛为一处 SSOT,
 * 供解析器(portableCliResolver)、安装器(portableCliInstaller)、管理命令(handlers/tools)
 * 共同消费,杜绝三处各写一份映射导致漂移。
 *
 * 契约:纯数据 + 纯查询函数;无 IO、无副作用;确定性;绝不抛。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW-TO-EXTEND(抄写式,给弱智用户/小模型):新增一个便携 CLI 工具,只改本文件:
 *   1. 在 _TOOLS 里加一条 { key, pkg, bin, portableDir, versionArgs }:
 *        - key:          khy 命令名 / 工具键(小写,如 'aider')。
 *        - pkg:          npm 包名(如 'aider-chat')。
 *        - bin:          包 bin 字段里的可执行名(不含 .exe/.cmd,如 'aider')。
 *        - portableDir:  数据家下的隔离目录名(约定 `<key>-portable`,如 'aider-portable')。
 *        - versionArgs:  探活/显示版本用的参数(默认 ['--version'])。
 *   2. 不需要改解析器/安装器/管理命令——它们全部按 key 泛化处理。
 *   3. 若该工具已有专用解析器(如 opencode 的 opencodeBinResolver),在下方 _NATIVE_RESOLVER
 *      集合登记它的 key,让泛化解析器把它让给专用解析器(避免双份逻辑打架)。
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * @module services/gateway/adapters/portableCliRegistry
 */

/**
 * 便携 CLI 工具表(SSOT)。顺序稳定,供 `khy tools list` 直接渲染。
 * @type {ReadonlyArray<{key:string,pkg:string,bin:string,portableDir:string,versionArgs:string[]}>}
 */
const _TOOLS = Object.freeze([
  {
    key: 'claude',
    pkg: '@anthropic-ai/claude-code',
    bin: 'claude',
    portableDir: 'claude-portable',
    versionArgs: ['--version'],
  },
  {
    key: 'codex',
    pkg: '@openai/codex',
    bin: 'codex',
    portableDir: 'codex-portable',
    versionArgs: ['--version'],
  },
  {
    key: 'opencode',
    pkg: 'opencode-ai',
    bin: 'opencode',
    portableDir: 'opencode-portable',
    versionArgs: ['--version'],
  },
]);

/**
 * 已有专用解析器的工具 key。泛化解析器 resolveLaunchSpec 对这些 key 返回 null,
 * 把解析让给专用解析器(opencode → opencodeBinResolver),避免双份逻辑漂移。
 * @type {ReadonlySet<string>}
 */
const _NATIVE_RESOLVER = Object.freeze(new Set(['opencode']));

/** 归一化工具 key:去空白、转小写。非字符串 → ''。 */
function _normKey(key) {
  return typeof key === 'string' ? key.trim().toLowerCase() : '';
}

/** 返回全部工具条目(冻结副本引用,调用方只读)。 */
function listTools() {
  return _TOOLS;
}

/** 是否为已登记的便携 CLI 工具 key。 */
function isKnownTool(key) {
  const k = _normKey(key);
  return _TOOLS.some((t) => t.key === k);
}

/** 按 key 取工具条目;未知 → null(绝不抛)。 */
function getTool(key) {
  const k = _normKey(key);
  return _TOOLS.find((t) => t.key === k) || null;
}

/** 该工具是否交由专用解析器处理(泛化解析器应跳过)。 */
function hasNativeResolver(key) {
  return _NATIVE_RESOLVER.has(_normKey(key));
}

module.exports = {
  listTools,
  isKnownTool,
  getTool,
  hasNativeResolver,
};
