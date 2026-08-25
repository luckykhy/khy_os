// 交易域接口封装。
//
// 路径按后端实际挂载点书写：下单与持仓在 `/api/trading`（server.js 把 routes/trade
// 挂在这个复数形式上，而非 `/api/trade`），成交历史在 `/api/trades`。两者同源于
// khyquant 应用，应用缺席时后端整段跳过挂载 —— 此时请求得到 404，由调用方
// `describeQuantOutage` 翻译成人话，而不是把 "HTTP 404" 甩给用户。
import { apiJson } from './client';

/** khyquant 未安装时后端不挂载交易路由，404 是「应用缺席」而非「请求写错」。 */
export function describeQuantOutage(error) {
  const message = String(error?.message || '');
  if (/HTTP 404/.test(message)) return '当前节点未安装量化应用，交易功能不可用';
  return message || '请求失败';
}

function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

// ── 账户与持仓 ──────────────────────────────────────────────

export function fetchAccount() {
  return apiJson('/api/trading/account');
}

export async function fetchPositions() {
  const data = await apiJson('/api/trading/positions');
  return Array.isArray(data) ? data : data.positions || data.list || [];
}

export function fetchTradingStats() {
  return apiJson('/api/trading/stats');
}

/** 平掉一笔未平仓交易。`id` 是交易记录 id，不是标的代码。 */
export function closePosition(id) {
  return apiJson(`/api/trading/${encodeURIComponent(id)}/close`, { method: 'POST' });
}

// ── 委托下单 ────────────────────────────────────────────────

/**
 * 提交委托。后端对数量与价格有硬性校验（整手、涨跌停），失败时返回
 * success:false + message，由 apiJson 抛成 Error，页面直接展示该文案。
 */
export function submitOrder(order) {
  return apiJson('/api/trading/order', { method: 'POST', body: JSON.stringify(order) });
}

export async function fetchPendingOrders() {
  const data = await apiJson('/api/trading/pending');
  return Array.isArray(data) ? data : data.orders || data.list || [];
}

export function cancelOrder(orderId) {
  return apiJson(`/api/trading/cancel/${encodeURIComponent(orderId)}`, { method: 'POST' });
}

// ── 成交历史 ────────────────────────────────────────────────

/** 返回 { trades, pagination }，与后端 `/api/trades` 的响应结构一致。 */
export async function fetchTrades({ page = 1, pageSize = 20, symbol, side } = {}) {
  const data = await apiJson(`/api/trades${query({ page, pageSize, symbol, side })}`);
  return { trades: data.trades || [], pagination: data.pagination || null };
}

export function fetchTradeSummary() {
  return apiJson('/api/trades/stats/summary');
}

// ── 策略与回测 ──────────────────────────────────────────────

export async function fetchStrategies() {
  const data = await apiJson('/api/strategies');
  return Array.isArray(data) ? data : data.strategies || data.list || [];
}

/** 返回 { list, total, page, pageSize }，与后端 `/api/backtest` 的响应结构一致。 */
export async function fetchBacktests({ page = 1, pageSize = 10, status } = {}) {
  const data = await apiJson(`/api/backtest${query({ page, pageSize, status })}`);
  return { list: data.list || [], total: Number(data.total || 0) };
}

export function fetchBacktestDetail(id) {
  return apiJson(`/api/backtest/${encodeURIComponent(id)}`);
}
