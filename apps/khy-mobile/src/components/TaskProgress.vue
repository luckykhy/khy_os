<script setup>
defineProps({ task: { type: Object, required: true } });
const percent = (task) => Math.max(0, Math.min(100, Number(task.progress_pct ?? task.progress ?? task.percent ?? 0)));
const label = (task) => task.status || 'unknown';
</script>

<template>
  <article class="task-progress">
    <div class="row"><strong>{{ task.name || task.task_id || task.id || '未命名任务' }}</strong><span>{{ label(task) }}</span></div>
    <div class="progress-track"><span :style="{ width: `${percent(task)}%` }"></span></div>
    <div class="muted">{{ percent(task) }}% · {{ task.trace_id || '暂无 trace' }}</div>
  </article>
</template>
