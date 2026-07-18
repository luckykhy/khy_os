/**
 * Failover Order Store — user-defined channel priority chain for the AI gateway.
 *
 * 借鉴 cc-switch 的 provider_router 可排序故障转移队列：在网关的全自动 penalty
 * 评分路由之外，允许用户显式指定通道的尝试优先顺序（P1 → P2 → …）。两者共存：
 * 用户列出的通道按其给定顺序优先，未列出的通道接在其后并沿用既有自动评分排序。
 *
 * 持久化（零硬编码）：
 *   - 文件：<data-home>/gateway_failover.json = { enabled:boolean, order:string[] }
 *           （data-home 由 utils/dataHome 解析，默认 ~/.khy）
 *   - 环境变量覆盖：GATEWAY_FAILOVER_ORDER（逗号分隔，优先级高于文件）
 *
 * 所有读取在失败时静默回退为「未启用 / 空顺序」，保证零破坏：未配置时网关行为
 * 与改动前完全一致。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'gateway_failover.json';

function _filePath() {
  // getDataHome() 解析数据根目录并确保其存在；故障转移配置存于根目录下的单文件。
  const { getDataHome } = require('../../utils/dataHome');
  return path.join(getDataHome(), FILE_NAME);
}

// 将任意输入规范化为去重、去空白的字符串数组。
function _normalizeList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = String(item == null ? '' : item).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// 解析 GATEWAY_FAILOVER_ORDER 环境变量（逗号分隔）。返回规范化数组（可能为空）。
function _parseEnvOrder() {
  const raw = process.env.GATEWAY_FAILOVER_ORDER;
  if (raw == null || String(raw).trim() === '') return [];
  return _normalizeList(String(raw).split(','));
}

/**
 * 读取当前生效的用户故障转移顺序。
 * 优先级：环境变量 > 文件 > 默认（未启用）。
 * @returns {{ enabled: boolean, order: string[], source: 'env'|'file'|'default' }}
 */
function getFailoverOrder() {
  // 1) 环境变量覆盖（优先级最高）。
  const envOrder = _parseEnvOrder();
  if (envOrder.length > 0) {
    return { enabled: true, order: envOrder, source: 'env' };
  }

  // 2) 文件配置。
  try {
    const fp = _filePath();
    if (fs.existsSync(fp)) {
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      const order = _normalizeList(parsed && parsed.order);
      const enabled = !!(parsed && parsed.enabled) && order.length > 0;
      return { enabled, order, source: 'file' };
    }
  } catch { /* 坏文件 / 读失败 → 静默回退默认 */ }

  // 3) 默认：未启用。
  return { enabled: false, order: [], source: 'default' };
}

/**
 * 写入用户故障转移顺序到文件（启用）。
 * @param {string[]} list 通道 key 列表（按优先顺序）
 * @returns {{ enabled: boolean, order: string[] }}
 */
function setFailoverOrder(list) {
  const order = _normalizeList(list);
  const payload = { enabled: order.length > 0, order };
  try {
    fs.writeFileSync(_filePath(), JSON.stringify(payload, null, 2), 'utf-8');
  } catch (err) {
    throw new Error(`无法写入故障转移顺序配置: ${err.message}`);
  }
  return payload;
}

/**
 * 清除用户故障转移顺序（删除文件 → 回退全自动评分路由）。
 * @returns {{ enabled: boolean, order: string[] }}
 */
function clearFailoverOrder() {
  try {
    const fp = _filePath();
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch { /* 删除失败不致命：getFailoverOrder 仍会按内容判定 */ }
  return { enabled: false, order: [] };
}

module.exports = {
  getFailoverOrder,
  setFailoverOrder,
  clearFailoverOrder,
  _normalizeList, // 导出供测试
};
