<script setup>
import { computed, onMounted, ref } from 'vue';
import { apiJson } from '@/api/client';
import { operationStatus, statusText } from '@/api/status';

const list = ref([]);
const query = ref('');
const status = ref(operationStatus('读取', '自选行情', '等待开始'));
const error = ref('');
const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return list.value;
  return list.value.filter((item) => `${item.symbol} ${item.symbolName || ''}`.toLowerCase().includes(needle));
});

async function load() {
  error.value = ''; status.value = operationStatus('读取', '自选行情', '进行中');
  try {
    const data = await apiJson('/api/watchlist?limit=100');
    list.value = data.list || [];
    status.value = operationStatus('读取', '自选行情', `已更新 ${list.value.length} 项`, 'success');
  } catch (cause) { error.value = cause.message; status.value = operationStatus('读取', '自选行情', '失败', 'error'); }
}
onMounted(load);
</script>

<template><div class="stack">
  <div class="row"><div><h1 class="page-title">行情</h1><p class="page-subtitle">当前账号的自选标的</p></div><button class="button" title="刷新" @click="load">↻</button></div>
  <input v-model="query" type="search" placeholder="搜索代码或名称" />
  <p class="status-line" :class="status.tone">{{ statusText(status) }}</p><p v-if="error" class="alert">{{ error }}</p>
  <section class="quote-list"><article v-for="item in filtered" :key="item.id || item.symbol" class="quote-row"><div><strong>{{ item.symbol }}</strong><span>{{ item.symbolName || item.category || '未命名标的' }}</span></div><div class="price"><strong>{{ item.latestPrice ?? '—' }}</strong><span :class="Number(item.latestChange) >= 0 ? 'up' : 'down'">{{ item.latestChange == null ? '暂无涨跌' : `${item.latestChange}%` }}</span></div></article><p v-if="!filtered.length && !error" class="panel muted">没有匹配的自选标的</p></section>
</div></template>

<style scoped>
.quote-list { display: grid; border: 1px solid #243241; border-radius: 8px; overflow: hidden; }.quote-row { display: flex; justify-content: space-between; gap: 12px; padding: 13px 14px; background: #111a24; border-bottom: 1px solid #243241; }.quote-row:last-child { border-bottom: 0; }.quote-row div { display: grid; gap: 3px; }.quote-row span { color: #8ca0b5; font-size: 12px; }.price { text-align: right; }.price .up { color: #ef8e78; }.price .down { color: #68d5c0; }
</style>
