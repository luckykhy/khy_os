<script setup>
import { onMounted, ref } from 'vue';
import { describeQuantOutage, fetchStrategies } from '@/api/trading';
import { operationStatus, statusText } from '@/api/status';

const strategies = ref([]);
const status = ref(operationStatus('读取', '策略列表', '等待开始'));
const error = ref('');

async function load() {
  error.value = '';
  status.value = operationStatus('读取', '策略列表', '进行中');
  try {
    strategies.value = await fetchStrategies();
    status.value = operationStatus('读取', '策略列表', `已更新 ${strategies.value.length} 条`, 'success');
  } catch (cause) {
    error.value = describeQuantOutage(cause);
    status.value = operationStatus('读取', '策略列表', '失败', 'error');
  }
}

function statusLabel(value) {
  return { active: '运行中', inactive: '已停用', draft: '草稿', testing: '测试中' }[value] || value || '未标注';
}

onMounted(load);
</script>

<template><div class="stack">
  <div class="row"><div><h1 class="page-title">策略</h1><p class="page-subtitle">自有策略与公开策略</p></div><button class="button" title="刷新" @click="load">↻</button></div>
  <p class="status-line" :class="status.tone">{{ statusText(status) }}</p>
  <p v-if="error" class="alert">{{ error }}</p>

  <article v-for="strategy in strategies" :key="strategy.id" class="panel strategy-card">
    <div class="row">
      <strong>{{ strategy.name || '未命名策略' }}</strong>
      <span class="state" :class="`state-${strategy.status || 'draft'}`">{{ statusLabel(strategy.status) }}</span>
    </div>
    <p class="muted">{{ strategy.description || '未提供策略说明' }}</p>
    <div class="tags">
      <span v-if="strategy.type">{{ strategy.type }}</span>
      <span v-if="strategy.language">{{ strategy.language }}</span>
      <span v-if="strategy.isPublic">公开</span>
    </div>
  </article>
  <p v-if="!strategies.length && !error" class="panel muted">还没有可用的策略</p>
</div></template>

<style scoped>
.strategy-card { display: grid; gap: 8px; }
.strategy-card p { margin: 0; font-size: 13px; line-height: 1.5; }
.state { padding: 3px 7px; border-radius: 4px; font-size: 11px; background: #263544; color: #9aabbb; }
.state-active { background: #18382f; color: #8be6c7; }
.state-testing { background: #40371d; color: #f0cf83; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; }
.tags span { padding: 3px 8px; border: 1px solid #324354; border-radius: 4px; color: #8ca0b5; font-size: 11px; }
</style>
