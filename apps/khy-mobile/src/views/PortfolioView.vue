<script setup>
import { computed, onMounted, ref } from 'vue';
import { closePosition, describeQuantOutage, fetchAccount, fetchPositions } from '@/api/trading';
import { operationStatus, statusText } from '@/api/status';

const account = ref(null);
const positions = ref([]);
const busyId = ref('');
const status = ref(operationStatus('读取', '账户与持仓', '等待开始'));
const error = ref('');

const totalUnrealized = computed(() =>
  positions.value.reduce((sum, item) => sum + Number(item.unrealizedProfit || 0), 0));

function money(value, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : fallback;
}
function toneOf(value) {
  const num = Number(value || 0);
  return num > 0 ? 'up' : num < 0 ? 'down' : '';
}

async function load() {
  error.value = '';
  status.value = operationStatus('读取', '账户与持仓', '进行中');
  try {
    // 两个请求彼此独立，并发取回；任一失败都归到同一条错误上，避免半屏空白。
    const [accountData, positionList] = await Promise.all([fetchAccount(), fetchPositions()]);
    account.value = accountData;
    positions.value = positionList;
    status.value = operationStatus('读取', '账户与持仓', `已更新 ${positions.value.length} 个持仓`, 'success');
  } catch (cause) {
    error.value = describeQuantOutage(cause);
    status.value = operationStatus('读取', '账户与持仓', '失败', 'error');
  }
}

async function close(position) {
  const id = position.id || position.tradeId;
  if (!id) {
    error.value = '该持仓为演示数据，没有可平仓的交易记录';
    return;
  }
  busyId.value = String(id);
  error.value = '';
  status.value = operationStatus('平仓', position.symbolName || position.symbol, '提交中');
  try {
    await closePosition(id);
    status.value = operationStatus('平仓', position.symbolName || position.symbol, '已完成', 'success');
    await load();
  } catch (cause) {
    error.value = describeQuantOutage(cause);
    status.value = operationStatus('平仓', position.symbolName || position.symbol, '失败', 'error');
  } finally {
    busyId.value = '';
  }
}

onMounted(load);
</script>

<template><div class="stack">
  <div class="row"><div><h1 class="page-title">持仓</h1><p class="page-subtitle">账户资产与当前持仓盈亏</p></div><button class="button" title="刷新" @click="load">↻</button></div>

  <section class="grid-2">
    <div class="metric-box"><span>总资产</span><strong>{{ money(account?.totalAssets) }}</strong></div>
    <div class="metric-box"><span>可用资金</span><strong>{{ money(account?.availableFunds) }}</strong></div>
    <div class="metric-box"><span>今日盈亏</span><strong :class="toneOf(account?.todayProfit)">{{ money(account?.todayProfit) }}</strong></div>
    <div class="metric-box"><span>累计盈亏</span><strong :class="toneOf(account?.totalProfit)">{{ money(account?.totalProfit) }}</strong></div>
  </section>

  <p class="status-line" :class="status.tone">{{ statusText(status) }}</p>
  <p v-if="error" class="alert">{{ error }}</p>

  <section v-if="positions.length" class="stack">
    <div class="row"><h2>持仓明细</h2><span class="muted" :class="toneOf(totalUnrealized)">浮动盈亏 {{ money(totalUnrealized) }}</span></div>
    <article v-for="position in positions" :key="position.id || position.symbol" class="position-card">
      <div class="row">
        <div><strong>{{ position.symbolName || position.symbol }}</strong><span class="muted">{{ position.symbol }}</span></div>
        <span v-if="position.isDemo" class="demo-tag">演示</span>
      </div>
      <div class="figures">
        <div><span>持仓量</span><strong>{{ position.totalQuantity ?? '—' }}</strong></div>
        <div><span>成本价</span><strong>{{ money(position.avgCost) }}</strong></div>
        <div><span>现价</span><strong>{{ money(position.currentPrice) }}</strong></div>
        <div><span>市值</span><strong>{{ money(position.marketValue) }}</strong></div>
      </div>
      <div class="row">
        <span :class="toneOf(position.unrealizedProfit)">
          浮盈 {{ money(position.unrealizedProfit) }}
          <template v-if="position.unrealizedProfitPercent != null">（{{ position.unrealizedProfitPercent }}%）</template>
        </span>
        <button class="button danger" :disabled="busyId === String(position.id || '')" @click="close(position)">平仓</button>
      </div>
    </article>
  </section>
  <p v-else-if="!error" class="panel muted">当前没有持仓</p>
</div></template>

<style scoped>
.metric-box { display: grid; gap: 5px; padding: 14px; background: #111a24; border: 1px solid #243241; border-radius: 8px; }
.metric-box span { color: #8ca0b5; font-size: 12px; }
.metric-box strong { font-size: 19px; color: #e9eef5; }
h2 { font-size: 17px; margin: 0; }
.position-card { display: grid; gap: 10px; padding: 14px; background: #111a24; border: 1px solid #243241; border-radius: 8px; }
.position-card > .row > div { display: grid; gap: 2px; }
.position-card .muted { font-size: 12px; }
.demo-tag { padding: 3px 7px; border-radius: 4px; font-size: 11px; background: #263544; color: #9aabbb; }
.figures { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.figures div { display: grid; gap: 3px; }
.figures span { color: #8ca0b5; font-size: 11px; }
.figures strong { font-size: 13px; font-weight: 500; }
.up { color: #ef8e78; }
.down { color: #68d5c0; }
</style>
