<template>
  <div class="admin-task-board">
    <TaskBoard
      :board="board"
      :loading="loading"
      :error="error"
      :busy-ids="busyIds"
      @action="onAction"
      @refresh="load"
    />
  </div>
</template>

<script setup>
/**
 * 管理控制台 · 任务看板（/admin/tasks）。
 *
 * 本视图只做三件事：取数、派发动作、提示结果。所有呈现与派生逻辑都在
 * `@khy/ui-shared/board`（与 web-quant 端共用同一份实现）。
 *
 * 放在 admin 组而非用户组：数据源 `largeTaskRuntimeStore` 是**全局**的，
 * 含平台自身的后台任务（`background_task_manager`）与其他来源，不属于任何
 * 单个用户 —— 暴露给普通用户等于泄露他人的任务信息。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { deriveErrorMessage, showError, showSuccess } from '@/api/notify';
import { largeTasksApi } from '@/api/largeTasks';
import TaskBoard from '@khy/ui-shared/board/TaskBoard.vue';
import { actionLabel } from '@khy/ui-shared/board';

const board = ref({});
const loading = ref(false);
const error = ref('');
const busyIds = ref(new Set());
let disposed = false;

async function load() {
  loading.value = true;
  try {
    const res = await largeTasksApi.board({ limit: 500 });
    if (disposed) return;
    // 拦截器已处理错误提示；这里只保证视图拿到的是信封里的 data。
    board.value = (res && res.data) || {};
    error.value = '';
  } catch (e) {
    if (disposed) return;
    // 保留上一份数据不清空 —— 一次网络抖动不该把看板变成白屏。
    error.value = deriveErrorMessage(e, { fallback: '加载任务看板失败。' });
  } finally {
    if (!disposed) loading.value = false;
  }
}

async function onAction({ action, card }) {
  if (!card || !card.id) return;
  const next = new Set(busyIds.value);
  next.add(card.id);
  busyIds.value = next;
  try {
    const res = await largeTasksApi.act(card.id, action, { reason: 'admin task board' });
    const data = (res && res.data) || {};
    // 后端会回 already_* 标记表示「本来就是这个状态」，如实告知而不是谎报成功。
    if (data.already_terminal) {
      showSuccess(`任务已处于终态，无需${actionLabel(action)}。`);
    } else if (data.already_paused) {
      showSuccess('任务本来就处于暂停状态。');
    } else {
      showSuccess(`已${actionLabel(action)}：${card.title}`);
    }
    await load();
  } catch (e) {
    showError(deriveErrorMessage(e, { fallback: `${actionLabel(action)}失败。` }));
  } finally {
    const done = new Set(busyIds.value);
    done.delete(card.id);
    busyIds.value = done;
  }
}

onMounted(load);
onBeforeUnmount(() => {
  disposed = true;
});
</script>

<style scoped>
.admin-task-board {
  padding: 16px;
}
</style>
