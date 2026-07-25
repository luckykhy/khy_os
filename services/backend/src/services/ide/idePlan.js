'use strict';

/**
 * idePlan.js — `/ide`(查看本机 IDE 集成状态)的零 IO 确定性单一真源(纯叶子)。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无副作用;IDE 探测结果、bridge 状态快照、env 全经入参注入,本叶子绝不
 * 读 process.env、绝不触文件、绝不开网络。真正的「探测已装 IDE(读默认安装路径 + env 额外提示)」「读 bridge server
 * 运行快照」(有 fs/网络 IO)都在薄壳 handler,委托既有 ideDetector.detectAll + bridgeServer.getStatusSnapshot,
 * 绝不另起炉灶。本叶子只做:由「探测列表 + bridge 快照」推导是否就绪 + 文本渲染。
 *
 * 背后的逻辑(对齐 Claude Code /ide —— 但**诚实落到 khy 的本地语义**):CC 的 /ide 是连上 IDE 扩展(VS Code/JetBrains)
 * 经 lock-file + WebSocket 通道把选区/诊断/打开文件喂给会话,并列出可连的 IDE。khy **没有那个 IDE 扩展协议端 —— 绝不
 * 伪造一个扩展握手**;但 khy **真有**同构本地基质:① `ideDetector.detectAll` 探测本机已装 IDE(安装路径 + 数据目录),
 * ② `bridgeServer` 是 khy 自己的 LAN bridge(IDE/移动端真正会连进来的通道)。把它们一合,khy 的 /ide = **如实展示
 * 「探测到哪些 IDE」+「bridge 通道是否在跑、连进来几个客户端」**,让用户知道集成现状,而非伪造一条不存在的扩展链路。
 *
 * 诚实边界:① 只读、绝不启动 IDE、绝不改 bridge 状态(启停 bridge 另走既有命令);② 不伪造「已连接某 IDE 扩展」——
 * khy 只知道 bridge 上**有几个客户端**,不区分对端是不是 IDE;③ bridge 未跑时如实说明,并提示它是 IDE/移动端的连接通道。
 *
 * 注意:本文件刻意不在注释里书写 require-调用样式,避免架构债扫描器把它当成幽灵依赖边。本叶子零依赖。
 */

const _STATUS_WORDS = new Set(['status', 'state', 'show', '状态', '查看']);
const _LIST_WORDS = new Set(['list', 'ls', '列出', '列表']);
const _HELP_WORDS = new Set(['help', '-h', '--help', '帮助', '用法']);

/**
 * 解析 `/ide [status|list|help]`。空参 = status(对齐 CC 默认展示集成现状)。
 * @param {string[]} args
 * @returns {{action:'status'|'list'|'help', valid:boolean, parseError:(string|null)}}
 */
function parseIdeArgs(args) {
  const list = Array.isArray(args) ? args : [];
  const first = list.length > 0 ? String(list[0] == null ? '' : list[0]).trim().toLowerCase() : '';
  if (first === '') return { action: 'status', valid: true, parseError: null };
  if (_HELP_WORDS.has(first)) return { action: 'help', valid: true, parseError: null };
  if (_LIST_WORDS.has(first)) return { action: 'list', valid: true, parseError: null };
  if (_STATUS_WORDS.has(first)) return { action: 'status', valid: true, parseError: null };
  return { action: 'status', valid: false, parseError: 'unknown_action' };
}

/**
 * 由探测列表归一出「可用 IDE / 全部 IDE」。纯函数。
 * @param {Array<object>} detections - ideDetector.detectAll() 的结果(或 null)
 * @returns {{ all:Array<object>, available:Array<object>, availableCount:number }}
 */
function summarizeDetections(detections) {
  const list = Array.isArray(detections) ? detections.filter((d) => d && typeof d === 'object') : [];
  const available = list.filter((d) => d.available === true);
  return { all: list, available, availableCount: available.length };
}

/** 渲染 IDE 探测列表文本(list)。 */
function buildListText(detections) {
  const { all, availableCount } = summarizeDetections(detections);
  const lines = [];
  lines.push('🖥  ide · 本机已探测 IDE');
  if (all.length === 0) {
    lines.push('  未探测到任何已知 IDE(可经 GATEWAY_EXTRA_IDES + <NAME>_INSTALL_PATH 提示额外 IDE)。');
    return lines.join('\n');
  }
  for (const d of all) {
    const mark = d.available ? '✓' : '·';
    const where = d.installPath || d.dataPath || '未找到安装/数据路径';
    lines.push(`  ${mark} ${d.name}${d.available ? '' : '(未安装)'} — ${where}`);
  }
  lines.push(`  共 ${all.length} 项,其中 ${availableCount} 项可用。`);
  return lines.join('\n');
}

/** 渲染 bridge 通道 + IDE 探测合并状态文本(status)。 */
function buildStatusText(input) {
  const src = input && typeof input === 'object' ? input : {};
  const { available, availableCount } = summarizeDetections(src.detections);
  const bridge = src.bridge && typeof src.bridge === 'object' ? src.bridge : { running: false };
  const lines = [];
  lines.push('🖥  ide · 本机 IDE 集成状态');

  // ① IDE 探测
  if (availableCount === 0) {
    lines.push('  IDE: 未探测到可用 IDE。');
  } else {
    lines.push(`  IDE: 探测到 ${availableCount} 个可用 — ${available.map((d) => d.name).join(', ')}`);
  }

  // ② bridge 通道(IDE/移动端真正连进来的通道)
  if (bridge.running === true) {
    lines.push(`  通道: bridge 运行中${bridge.url ? ` · ${bridge.url}` : ''} · 已连客户端 ${Number(bridge.clientCount) || 0} 个`);
    lines.push('    (bridge 是 IDE/移动端连入 khy 的通道;khy 只知客户端数,不区分对端是否为 IDE 扩展。)');
  } else {
    lines.push('  通道: bridge 未运行 —— 它是 IDE/移动端连入 khy 的通道,需要时请启动它。');
  }

  // 对齐 CC 的诚实说明:khy 无 IDE 扩展协议端。
  lines.push('  说明: khy 不伪造 IDE 扩展握手协议;本命令只读,绝不启动 IDE 或改动 bridge。');
  return lines.join('\n');
}

function buildHelpText() {
  return [
    '/ide —— 查看本机 IDE 集成状态(对齐 Claude Code /ide,但诚实落到 khy 本地语义)',
    '  用法:',
    '    /ide          展示 IDE 集成状态(探测到的 IDE + bridge 通道是否在跑)(默认)',
    '    /ide list     仅列出本机探测到的 IDE(安装/数据路径)',
    '  说明:',
    '    · 与 CC 经 IDE 扩展 lock-file + WebSocket 喂选区/诊断不同:khy 无 IDE 扩展协议端,不伪造握手。',
    '    · khy 展示 ideDetector 探测到的已装 IDE + 自有 bridge 通道(IDE/移动端真正连入的通道)状态。',
    '    · 只读:绝不启动 IDE、绝不改 bridge 启停(启停另走 bridge 命令)。仅本机。',
  ].join('\n');
}

function buildUnknownText() {
  return `未知子命令。${buildHelpText()}`;
}

/**
 * 门控 KHY_IDE_COMMAND(默认开;关时薄壳字节回退为「不接管」)。
 * @param {object} env
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || {};
  const raw = e.KHY_IDE_COMMAND === undefined ? 'true' : e.KHY_IDE_COMMAND;
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  return !(s === '' || s === '0' || s === 'false' || s === 'off' || s === 'no');
}

module.exports = {
  parseIdeArgs,
  summarizeDetections,
  buildListText,
  buildStatusText,
  buildHelpText,
  buildUnknownText,
  isEnabled,
};
