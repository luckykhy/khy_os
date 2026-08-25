<script setup>
import { onMounted, ref } from 'vue';
import { describeQuantOutage, fetchAccount } from '@/api/trading';
import { operationStatus, statusText } from '@/api/status';

// 交易域页面比底部导航位多，这里做二级入口：一屏给出资产概览 + 各子页面入口。
const account = ref(null);
const status = ref(operationStatus('读取', '账户概览', '等待开始'));
const error = ref('');

const entries = [
  { to: '/portfolio', icon: '▦', label: '持仓', hint: '资产与浮动盈亏' },
  { to: '/order', icon: '⇄', label: '下单', hint: '委托与撤单' },
  { to: '/trades', icon: '≡', label: '流水', hint: '成交记录与统计' },
  { to: '/strategies', icon: '◈', label: '策略', hint: '自有与公开策略' },
  { to: '/backtests', icon: '◱', label: '回测', hint: '历史绩效指标' },
];

function money(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
}
function toneOf(value) {
  const num = Number(value || 0);
  return num > 0 ? 'up' : num < 0 ? 'down' : '';
}

async function load() {
  error.value = '';
  status.value = operationStatus('读取', '账户概览', '进行中');
  try {
    account.value = await fetchAccount();
    status.value = operationStatus('读取', '账户概览', '已更新', 'success');
  } catch (cause) {
    error.value = describeQuantOutage(cause);
    status.value = operationStatus('读取', '账户概览', '失败', 'error');
  }
}

onMounted(load);
</script>

<template><div class="stack">
  <div class="row"><div><h1 class="page-title">交易</h1><p class="page-subtitle">账户、委托与策略绩效</p></div><button class="button" title="刷新" @click="load">↻</button></div>

  <section class="asset-panel">
    <span class="muted">总资产</span>
    <strong class="total">{{ money(account?.totalAssets) }}</strong>
    <div class="asset-row">
      <span>可用 {{ money(account?.availableFunds) }}</span>
      <span :class="toneOf(account?.todayProfit)">今日 {{ money(account?.todayProfit) }}</span>
    </div>
  </section>

  <p class="status-line" :class="status.tone">{{ statusText(status) }}</p>
  <p v-if="error" class="alert">{{ error }}</p>

  <section class="entry-grid">
    <RouterLink v-for="entry in entries" :key="entry.to" class="entry" :to="entry.to">
      <span class="entry-icon">{{ entry.icon }}</span>
      <strong>{{ entry.label }}</strong>
      <span class="muted">{{ entry.hint }}</span>
    </RouterLink>
  </section>
</div></template>

<style scoped>
.asset-panel { display: grid; gap: 6px; padding: 18px; background: #111a24; border: 1px solid #243241; border-radius: 8px; }
.asset-panel .muted { font-size: 12px; }
.total { font-size: 30px; color: #68d5c0; }
.asset-row { display: flex; gap: 14px; margin-top: 2px; color: #8ca0b5; font-size: 13px; }
.entry-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.entry { display: grid; gap: 4px; padding: 14px; color: #e9eef5; text-decoration: none; background: #111a24; border: 1px solid #243241; border-radius: 8px; }
.entry-icon { font-size: 20px; color: #68d5c0; line-height: 1.4; }
.entry .muted { font-size: 11px; }
.up { color: #ef8e78; }
.down { color: #68d5c0; }
</style>
