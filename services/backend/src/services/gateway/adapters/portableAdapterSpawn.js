'use strict';

/**
 * portableAdapterSpawn.js — 便携 CLI 适配器接线的极薄封装(纯叶子/绝不抛)。
 *
 * codexAdapter / claudeAdapter 都逼近 arch:god 2500 行上限,无法在其中内联「便携优先、
 * 否则回退裸命令」的判定。本叶子把这段逻辑收敛成 `forTool(key)` → { portableSpawn,
 * portableInstalled } 两个绑定好 toolKey 的函数,使两个 god-file 的 spawn/detect 接线各仅数行。
 *
 * 便携根目录默认 `~/.khy/tools`(经 dataHome.getDataHome() + 'tools' 拼接;不用 getDataDir,
 * 避免在 detect/spawn 这种热路径上顺手创建空目录——真正安装时安装器才建)。KHY_TOOLS_DIR 若
 * 已设置,底层 portableCliResolver 会优先采用它。
 *
 * 契约:两个返回函数均**绝不抛**——门关(KHY_PORTABLE_CLI=0/false/off/no)、未安装、
 * dataHome/resolver 任何异常 → 一律退化为调用方给出的裸命令回退(逐字节等价于适配器既有行为)。
 *
 * @module services/gateway/adapters/portableAdapterSpawn
 */

const path = require('path');

/** 便携工具根目录(默认 ~/.khy/tools);任何异常 → undefined(解析器随后退化)。 */
function _toolsRoot() {
  try {
    const { getDataHome } = require('../../../utils/dataHome');
    return path.join(getDataHome(), 'tools');
  } catch {
    return undefined;
  }
}

/**
 * 绑定某工具键,返回该工具的便携 spawn/detect 两个安全封装。
 * @param {string} toolKey - 'codex' | 'claude' | ...
 * @returns {{ portableSpawn: Function, portableInstalled: Function }}
 */
function forTool(toolKey) {
  /**
   * 解析该工具实际应 spawn 的 (command, args)。便携/覆盖命中 → 便携启动规格;
   * 否则原样返回调用方给的裸命令回退。绝不抛。
   * @param {string[]} args - 业务参数(spawn 可变尾部)
   * @param {string} fbCmd - 回退命令(适配器既有裸命令)
   * @param {string[]} fbArgs - 回退参数
   * @returns {{command:string, args:string[], resolvedFrom:string}}
   */
  function portableSpawn(args, fbCmd, fbArgs) {
    try {
      return require('./portableCliResolver').resolveSpawn(toolKey, args, {
        toolsRoot: _toolsRoot(),
        fallback: { command: fbCmd, args: fbArgs },
      });
    } catch {
      return { command: fbCmd, args: fbArgs, resolvedFrom: 'fallback' };
    }
  }

  /** 该工具是否已可经便携/覆盖解析(不含裸 PATH)。绝不抛 → 异常视为未安装。 */
  function portableInstalled() {
    try {
      return require('./portableCliResolver').isInstalled(toolKey, { toolsRoot: _toolsRoot() });
    } catch {
      return false;
    }
  }

  return { portableSpawn, portableInstalled };
}

module.exports = { forTool, _toolsRoot };
