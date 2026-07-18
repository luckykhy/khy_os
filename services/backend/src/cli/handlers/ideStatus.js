'use strict';

/**
 * ideStatus.js — `/ide` 命令薄壳:查看本机 IDE 集成状态。对齐 Claude Code 的 /ide(连 IDE 扩展喂选区/诊断 + 列出可连 IDE),
 * 但**诚实落到 khy 的本地语义**:不伪造 IDE 扩展 lock-file + WebSocket 握手,而是复用 ideDetector.detectAll 探测
 * 本机已装 IDE + bridgeServer.getStatusSnapshot 读 khy 自有 LAN bridge(IDE/移动端真正连入的通道)状态。
 *
 * 注意命名:既有 handlers/ide.js 的 handleIdeCommand(ideName,…) 是「按 IDE 名(kiro/cursor/claude/codex)列模型→选→对话」
 * 的另一种东西,与 CC 的 /ide「集成状态」语义无关 —— 故本文件另起 ideStatus.js,绝不动既有 ide.js。
 *
 * **背后逻辑**(语法解析 + 探测/快照归一 + 文本渲染)在纯叶子 services/ide/idePlan.js(单一真源·零 IO);
 * 本薄壳只做:门控、探测 IDE(委托 ideDetector.detectAll)、读 bridge 快照(委托 bridgeServer.getStatusSnapshot)、
 * 交叶子渲染。绝不另起炉灶,绝不写任何 host/port/path 硬编码 —— 探测路径与 bridge 端口全来自既有 SSOT。
 *
 * 诚实边界:只读 —— 绝不启动 IDE、绝不改 bridge 启停;bridge 只知客户端数,不区分对端是否为 IDE 扩展。
 *
 * 用法:`/ide [status|list|help]`(空参 = status)。门控 KHY_IDE_COMMAND 默认开;关 → 命令不接管(字节回退)。
 */

const { printInfo, printError } = require('../formatters');
const leaf = require('../../services/ide/idePlan');

// try/catch combinator 单一真源 utils/tryOr:执行 fn,任何异常 → dflt。
const _safe = require('../../utils/tryOr');

/** 探测本机已装 IDE(委托既有 ideDetector SSOT)。 */
function _detectIdes() {
  const det = _safe(() => require('../../services/gateway/adapters/ideDetector'), null);
  if (!det || typeof det.detectAll !== 'function') return [];
  return _safe(() => det.detectAll(), []) || [];
}

/** 读 bridge 运行快照(委托既有 bridgeServer SSOT)。 */
function _bridgeSnapshot() {
  const bridge = _safe(() => require('../../bridge/bridgeServer'), null);
  if (!bridge || typeof bridge.getStatusSnapshot !== 'function') return { running: false };
  return _safe(() => bridge.getStatusSnapshot(), { running: false }) || { running: false };
}

/**
 * `/ide` 入口。
 * @param {string} _subCommand
 * @param {string[]} [args]
 * @param {object} [_options]
 * @returns {Promise<boolean>} 是否接管该命令(门控关 → false)。
 */
async function handleIdeStatus(_subCommand, args = [], _options = {}) {
  if (!leaf.isEnabled(process.env)) {
    printInfo('ide 命令未启用(KHY_IDE_COMMAND 为关)。');
    return false;
  }

  const parsed = leaf.parseIdeArgs(args);

  if (parsed.action === 'help') {
    printInfo(leaf.buildHelpText());
    return true;
  }
  if (!parsed.valid && parsed.parseError === 'unknown_action') {
    printError(leaf.buildUnknownText());
    return true;
  }

  const detections = _detectIdes();

  if (parsed.action === 'list') {
    printInfo(leaf.buildListText(detections));
    return true;
  }

  const bridge = _bridgeSnapshot();
  printInfo(leaf.buildStatusText({ detections, bridge }));
  return true;
}

module.exports = { handleIdeStatus };
