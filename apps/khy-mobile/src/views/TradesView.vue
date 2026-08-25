<script setup>
import { onMounted, ref } from 'vue';
import { describeQuantOutage, fetchTradeSummary, fetchTrades } from '@/api/trading';
import { operationStatus, statusText } from '@/api/status';

const trades = ref([]);
const summary = ref(null);
const pagination = ref(null);
const sideFilter = ref('');
const page = ref(1);
const loadingMore = ref(false);
const status = ref(operationStatus('读取', '成交记录', '等待开始'));
const error = ref('');

function money(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
}
function moment(value) {
  return value ? String(value).replace('T', ' ').slice(0, 16) : '—';
}
function toneOf(value) {
  const num = Number(value || 0);
  return num > 0 ? 'up' : num < 0 ? 'down' : '';
}

async function load({ append = false } = {}) {
  error.value = '';
  const target = append ? '成交记录下一页' : '成交记录';
  status.value = operationStatus('读取', target, '进行中');
  try {
    const data = await fetchTrades({ page: page.value, pageSize: 20, side: sideFilter.value || undefined });
    trades.value = append ? [...trades.value, ...data.trades] : data.trades;
    pagination.value = data.pagination;
    status.value = operationStatus('读取', target, `已加载 ${trades.value.length}/${data.pagination?.total ?? trades.value.length} 条`, 'success');
  } catch (cause) {
    error.value = describeQuantOutage(cause);
    status.value = operationStatus('读取', target, '失败', 'error');
  }
}

// 统计与列表互不阻塞：统计失败不该让流水也空着，所以单独吞掉它的错误。
async function loadSummary() {
  try { summary.value = await fetchTradeSummary(); } catch { summary.value = null; }
}

async function changeFilter() {
  page.value = 1;
  await load();
}

async function loadMore() {
  loadingMore.value = true;
  page.value += 1;
  await load({ append: true });
  loadingMore.value = false;
}

async function refresh() {
  page.value = 1;
  await Promise.all([load(), loadSummary()]);
}

onMounted(refresh);
</script>

<template><div class="stack">
  <div class="row"><div><h1 class="page-title">流水</h1><p class="page-subtitle">成交记录与资金统计</p></div><button class="button" title="刷新" @click="refresh">↻</button></div>

  <section v-if="summary" class="grid-2">
    <div class="metric-box"><span>成交笔数</span><strong>{{ summary.totalTrades ?? 0 }}</strong></div>
    <div class="metric-box"><span>买 / 卖</span><strong>{{ summary.buyTrades ?? 0 }} / {{ summary.sellTrades ?? 0 }}</strong></div>
    <div class="metric-box"><span>累计盈亏</span><strong :class="toneOf(summary.totalProfit)">{{ money(summary.totalProfit) }}</strong></div>
    <div class="metric-box"><span>收益率</span><strong :class="toneOf(summary.profitRate)">{{ summary.profitRate ?? '—' }}%</strong></div>
  </section>

  <select v-model="sideFilter" aria-label="买卖方向" @change="changeFilter">
    <option value="">全部方向</option><option value="buy">仅买入</option><option value="sell">仅卖出</option>
  </select>

  <p class="status-line" :class="status.tone">{{ statusText(status) }}</p>
  <p v-if="error" class="alert">{{ error }}</p>

  <section v-if="trades.length" class="trade-list">
    <article v-for="trade in trades" :key="trade.id" class="trade-row">
      <div>
        <strong>{{ trade.symbolName || trade.symbol }}</strong>
        <span class="muted">{{ moment(trade.filledAt || trade.createdAt) }}</span>
      </div>
      <div class="figures">
        <span class="side" :class="trade.side">{{ trade.side === 'buy' ? '买入' : '卖出' }}</span>
        <span class="muted">{{ trade.quantity }} × {{ money(trade.price) }}</span>
        <strong :class="toneOf(trade.profit)">{{ trade.profit == null ? money(trade.amount) : money(trade.profit) }}</strong>
      </div>
    </article>
  </section>
  <p v-else-if="!error" class="panel muted">还没有成交记录</p>

  <button
    v-if="pagination && trades.length < pagination.total"
    class="button" :disabled="loadingMore" @click="loadMore">
    {{ loadingMore ? '读取 · 下一页 · 进行中' : `加载更多（剩余 ${pagination.total - trades.length} 条）` }}
  </button>
</div></template>

<style scoped>
.metric-box { display: grid; gap: 5px; padding: 14px; background: #111a24; border: 1px solid #243241; border-radius: 8px; }
.metric-box span { color: #8ca0b5; font-size: 12px; }
.metric-box strong { font-size: 19px; }
.trade-list { display: grid; border: 1px solid #243241; border-radius: 8px; overflow: hidden; }
.trade-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 13px 14px; background: #111a24; border-bottom: 1px solid #243241; }
.trade-row:last-child { border-bottom: 0; }
.trade-row > div { display: grid; gap: 4px; }
.trade-row .muted { font-size: 12px; }
.figures { justify-items: end; }
.side { padding: 2px 7px; border-radius: 4px; font-size: 11px; }
.side.buy { background: #3a2020; color: #ffb9a5; }
.side.sell { background: #18382f; color: #8be6c7; }
.up { color: #ef8e78; }
.down { color: #68d5c0; }
</style>
