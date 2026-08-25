<script setup>
import { onMounted, ref } from 'vue';
import { describeQuantOutage, fetchBacktestDetail, fetchBacktests } from '@/api/trading';
import { operationStatus, statusText } from '@/api/status';

const list = ref([]);
const total = ref(0);
const detail = ref(null);
const expandedId = ref(null);
const status = ref(operationStatus('读取', '回测结果', '等待开始'));
const error = ref('');

function percent(value) {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  return Number.isFinite(num) ? `${num.toFixed(2)}%` : '—';
}
function money(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—';
}
function day(value) {
  return value ? String(value).slice(0, 10) : '—';
}
function toneOf(value) {
  const num = Number(value || 0);
  return num > 0 ? 'up' : num < 0 ? 'down' : '';
}

async function load() {
  error.value = '';
  status.value = operationStatus('读取', '回测结果', '进行中');
  try {
    const data = await fetchBacktests({ pageSize: 20 });
    list.value = data.list;
    total.value = data.total;
    status.value = operationStatus('读取', '回测结果', `已更新 ${list.value.length}/${total.value} 条`, 'success');
  } catch (cause) {
    error.value = describeQuantOutage(cause);
    status.value = operationStatus('读取', '回测结果', '失败', 'error');
  }
}

// 详情按需拉取：列表项已够看概要，展开时才多打一次请求。
async function toggle(item) {
  if (expandedId.value === item.id) {
    expandedId.value = null;
    detail.value = null;
    return;
  }
  expandedId.value = item.id;
  detail.value = null;
  status.value = operationStatus('读取', `回测 ${item.name || item.id}`, '进行中');
  try {
    detail.value = await fetchBacktestDetail(item.id);
    status.value = operationStatus('读取', `回测 ${item.name || item.id}`, '已展开', 'success');
  } catch (cause) {
    error.value = describeQuantOutage(cause);
    status.value = operationStatus('读取', `回测 ${item.name || item.id}`, '失败', 'error');
  }
}

onMounted(load);
</script>

<template><div class="stack">
  <div class="row"><div><h1 class="page-title">回测</h1><p class="page-subtitle">历史回测结果与绩效指标</p></div><button class="button" title="刷新" @click="load">↻</button></div>
  <p class="status-line" :class="status.tone">{{ statusText(status) }}</p>
  <p v-if="error" class="alert">{{ error }}</p>

  <article v-for="item in list" :key="item.id" class="panel backtest-card">
    <button class="card-head" @click="toggle(item)">
      <div>
        <strong>{{ item.name || `回测 #${item.id}` }}</strong>
        <span class="muted">{{ item.strategy?.name || '未关联策略' }} · {{ day(item.startDate) }} 至 {{ day(item.endDate) }}</span>
      </div>
      <span class="chevron">{{ expandedId === item.id ? '▾' : '▸' }}</span>
    </button>

    <div class="figures">
      <div><span>总收益</span><strong :class="toneOf(item.totalReturn)">{{ percent(item.totalReturn) }}</strong></div>
      <div><span>年化</span><strong :class="toneOf(item.annualizedReturn)">{{ percent(item.annualizedReturn) }}</strong></div>
      <div><span>最大回撤</span><strong class="down">{{ percent(item.maxDrawdown) }}</strong></div>
      <div><span>胜率</span><strong>{{ percent(item.winRate) }}</strong></div>
    </div>

    <div v-if="expandedId === item.id" class="detail">
      <p v-if="!detail" class="muted">读取 · 回测详情 · 进行中</p>
      <template v-else>
        <div class="figures">
          <div><span>初始资金</span><strong>{{ money(detail.initialCapital) }}</strong></div>
          <div><span>最终资金</span><strong>{{ money(detail.finalCapital) }}</strong></div>
          <div><span>交易次数</span><strong>{{ detail.totalTrades ?? 0 }}</strong></div>
          <div><span>盈亏笔数</span><strong>{{ detail.winningTrades ?? 0 }} / {{ detail.losingTrades ?? 0 }}</strong></div>
        </div>
        <p v-if="detail.symbols?.length" class="muted">标的：{{ detail.symbols.join('、') }}</p>
      </template>
    </div>
  </article>
  <p v-if="!list.length && !error" class="panel muted">还没有回测记录</p>
</div></template>

<style scoped>
.backtest-card { display: grid; gap: 10px; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; padding: 0; text-align: left; background: none; border: 0; color: inherit; }
.card-head div { display: grid; gap: 3px; }
.card-head .muted { font-size: 12px; }
.chevron { color: #68d5c0; font-size: 13px; }
.figures { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.figures div { display: grid; gap: 3px; }
.figures span { color: #8ca0b5; font-size: 11px; }
.figures strong { font-size: 13px; font-weight: 500; }
.detail { display: grid; gap: 8px; padding-top: 10px; border-top: 1px solid #243241; }
.detail p { margin: 0; font-size: 12px; }
.up { color: #ef8e78; }
.down { color: #68d5c0; }
</style>
