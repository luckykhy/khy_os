/**
 * CLI Handler: 通道健康可视化与故障转移顺序管理。
 *
 * 借鉴 cc-switch 的网关管理面板，向用户暴露每个适配器的熔断/冷却/错误率状态，
 * 并允许显式设置用户自定义故障转移顺序（与网关全自动 penalty 评分共存）。
 *
 * 命令：
 *   khy channels [status]          显示所有通道健康面板
 *   khy channels order             显示当前用户故障转移顺序（含来源）
 *   khy channels order set k1,k2   设置用户故障转移顺序
 *   khy channels order reset       清除用户顺序（回退全自动评分）
 *   khy channels reset <adapter>   手动恢复单个通道（清除熔断/冷却）
 */
'use strict';

const chalk = require('chalk').default || require('chalk');
const {
  printSuccess, printError, printWarn, printInfo, printTable,
} = require('../formatters');

const ICON_GEAR = '⚙';

// 电路态 → 中文标签 + 颜色。
function _circuitLabel(state) {
  switch (String(state || '').toLowerCase()) {
    case 'open':      return chalk.red('● 熔断');
    case 'half_open': return chalk.yellow('◐ 半开');
    default:          return chalk.green('○ 正常');
  }
}

function _formatMs(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n <= 0) return '-';
  if (n < 1000) return `${n}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.floor(n / 60000)}m${Math.round((n % 60000) / 1000)}s`;
}

function _formatRate(rate, total) {
  const r = Number(rate) || 0;
  if (!total) return chalk.dim('-');
  const pct = `${(r * 100).toFixed(0)}%`;
  if (r >= 0.6) return chalk.red(pct);
  if (r >= 0.3) return chalk.yellow(pct);
  return chalk.green(pct);
}

function _truncate(text, max = 36) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '-';
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

async function _getGateway() {
  const gateway = require('../../services/gateway/aiGateway');
  if (!gateway._initialized) {
    try { await gateway.init(); } catch { /* 初始化失败仍可读快照（多为内存态） */ }
  }
  return gateway;
}

// ── 健康面板 ────────────────────────────────────────────────────────────────

async function _handleStatus() {
  const gateway = await _getGateway();
  let snapshot = [];
  try {
    snapshot = await gateway.getChannelHealthSnapshot();
  } catch (err) {
    printError(`读取通道健康失败: ${err.message || err}`);
    return;
  }

  console.log(`\n  ${ICON_GEAR}  ${chalk.cyan.bold('AI 通道健康面板')}\n`);

  if (!Array.isArray(snapshot) || snapshot.length === 0) {
    printWarn('未发现已注册的通道');
    return;
  }

  const rows = snapshot.map((c) => {
    const orderCell = c.failoverPosition ? chalk.cyan(`P${c.failoverPosition}`) : chalk.dim('-');
    const reason = c.circuitReason ? chalk.dim(`(${c.circuitReason})`) : '';
    const lastErr = c.lastError
      ? _truncate(c.lastError.errorType || c.lastError.error)
      : chalk.dim('-');
    return [
      c.key,
      c.enabled ? chalk.green('是') : chalk.dim('否'),
      `${_circuitLabel(c.circuitState)} ${reason}`.trim(),
      _formatMs(c.cooldownRemainingMs),
      String(c.failureCount || 0),
      `${_formatRate(c.errorRate, c.windowTotal)} ${chalk.dim(`(${c.windowFailed}/${c.windowTotal})`)}`,
      lastErr,
      orderCell,
    ];
  });

  printTable(
    ['通道', '启用', '电路态', '冷却剩余', '连续失败', '窗口错误率', '最近错误', '顺序'],
    rows
  );

  const order = gateway.getFailoverOrder();
  if (order && order.enabled && order.order.length > 0) {
    console.log(`\n  ${chalk.dim('用户故障转移顺序:')} ${chalk.cyan(order.order.join(' → '))} ${chalk.dim(`(来源: ${order.source})`)}\n`);
  } else {
    console.log(`\n  ${chalk.dim('用户故障转移顺序: 未设置（全自动 penalty 评分路由）')}\n`);
  }
}

// ── 故障转移顺序 ──────────────────────────────────────────────────────────────

async function _handleOrder(args = []) {
  const gateway = await _getGateway();
  const action = String(args[0] || '').trim().toLowerCase();

  if (action === 'set') {
    // 通道列表可用逗号或空格分隔：order set kiro,relay 或 order set kiro relay
    const raw = args.slice(1).join(',');
    const list = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (list.length === 0) {
      printError('请提供通道列表，例如: khy channels order set relay,kiro');
      return;
    }
    try {
      const result = gateway.setFailoverOrder(list);
      printSuccess(`已设置故障转移顺序: ${result.order.join(' → ')}`);
      printInfo('未列出的通道将接在其后，并沿用全自动 penalty 评分排序');
    } catch (err) {
      printError(`设置失败: ${err.message || err}`);
    }
    return;
  }

  if (action === 'reset' || action === 'clear') {
    try {
      gateway.clearFailoverOrder();
      printSuccess('已清除用户故障转移顺序，回退全自动评分路由');
    } catch (err) {
      printError(`清除失败: ${err.message || err}`);
    }
    return;
  }

  // 默认：显示当前顺序
  const order = gateway.getFailoverOrder();
  console.log(`\n  ${chalk.cyan.bold('故障转移顺序')}\n`);
  if (order && order.enabled && order.order.length > 0) {
    order.order.forEach((key, i) => {
      console.log(`  ${chalk.cyan(`P${i + 1}`)}  ${key}`);
    });
    console.log(`\n  ${chalk.dim(`来源: ${order.source}（env 覆盖 > 文件 > 默认）`)}\n`);
  } else {
    printInfo('未设置用户顺序，当前使用全自动 penalty 评分路由');
    console.log(`  ${chalk.dim('设置示例: khy channels order set relay,kiro')}\n`);
  }
}

// ── 手动恢复单通道 ────────────────────────────────────────────────────────────

async function _handleReset(args = []) {
  const key = String(args[0] || '').trim().toLowerCase();
  if (!key) {
    printError('请指定要恢复的通道，例如: khy channels reset kiro');
    return;
  }
  const gateway = await _getGateway();
  try {
    const ok = await gateway.resetChannel(key);
    if (ok) printSuccess(`已手动恢复通道 ${key}（清除熔断/冷却/失败计数）`);
    else printWarn(`未找到通道: ${key}`);
  } catch (err) {
    printError(`恢复失败: ${err.message || err}`);
  }
}

/**
 * 主入口 — 对标 verify.js 的 handle(subCommand, args, options) 签名。
 */
async function handleChannels(subCommand, args = [], options = {}) {
  const sub = String(subCommand || 'status').trim().toLowerCase();

  switch (sub) {
    case 'order':
      return _handleOrder(args);
    case 'reset':
      return _handleReset(args);
    case 'status':
    case '':
      return _handleStatus();
    default:
      // 未知子命令按状态处理，保持容错
      return _handleStatus();
  }
}

module.exports = { handleChannels };
