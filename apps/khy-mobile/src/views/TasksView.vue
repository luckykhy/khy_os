<script setup>
import { onMounted, ref } from 'vue';
import { apiJson } from '@/api/client';
import { operationStatus, statusText } from '@/api/status';
import TaskProgress from '@/components/TaskProgress.vue';

const tasks = ref([]);
const filter = ref('');
const status = ref(operationStatus('读取', '任务列表', '等待开始'));
const error = ref('');

async function load() {
  status.value = operationStatus('读取', '任务列表', '进行中'); error.value = '';
  try {
    const query = filter.value ? `?status=${encodeURIComponent(filter.value)}` : '';
    const data = await apiJson(`/api/large-tasks${query}`);
    tasks.value = Array.isArray(data.tasks) ? [...data.tasks].reverse() : [];
    status.value = operationStatus('读取', '任务列表', `已更新 ${tasks.value.length} 项`, 'success');
  } catch (cause) { error.value = cause.message; status.value = operationStatus('读取', '任务列表', '失败', 'error'); }
}
onMounted(load);
</script>

<template><div class="stack">
  <div class="row"><div><h1 class="page-title">任务</h1><p class="page-subtitle">大型任务的当前进度</p></div><button class="button" title="刷新" @click="load">↻</button></div>
  <select v-model="filter" aria-label="任务状态" @change="load"><option value="">全部状态</option><option value="queued">排队中</option><option value="running">运行中</option><option value="paused">已暂停</option><option value="retry_wait">等待重试</option><option value="succeeded">已完成</option><option value="failed">失败</option><option value="cancelled">已取消</option></select>
  <p class="status-line" :class="status.tone">{{ statusText(status) }}</p><p v-if="error" class="alert">{{ error }}</p>
  <div class="stack"><TaskProgress v-for="task in tasks" :key="task.task_id || task.id" :task="task" /><p v-if="!tasks.length && !error" class="panel muted">当前筛选条件下没有任务</p></div>
</div></template>
