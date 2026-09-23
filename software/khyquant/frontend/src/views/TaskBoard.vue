<template>
  <div class="task-board-view">
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
 * 大型任务看板（/tasks）。
 *
 * 呈现与派生逻辑全部来自 `@khy/ui-shared/board`，与 apps/ai-frontend 共用同一份
 * 实现（两端 Element Plus 的注册方式不同：本端全局注册，ai-frontend 按需自动导入，
 * 所以共享组件刻意只用语义化 HTML + Element Plus 的 CSS 变量，不用 <el-*> 标签）。
 *
 * 本视图只负责：取数、派发动作、提示结果。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { getFriendlyErrorMessage } from '@/utils/errorMessage'
import { actOnLargeTask, getTaskBoard } from '@/api/largeTasks'
import TaskBoard from '@khy/ui-shared/board/TaskBoard.vue'
import { actionLabel } from '@khy/ui-shared/board'

const board = ref({})
const loading = ref(false)
const error = ref('')
const busyIds = ref(new Set())
let disposed = false

async function load() {
  loading.value = true
  try {
    const res = await getTaskBoard({ limit: 500 })
    if (disposed) return
    board.value = (res && res.data) || {}
    error.value = ''
  } catch (e) {
    if (disposed) return
    // 保留上一份数据不清空 —— 一次网络抖动不该把看板变成白屏。
    error.value = getFriendlyErrorMessage(e) || '加载任务看板失败。'
  } finally {
    if (!disposed) loading.value = false
  }
}

async function onAction({ action, card }) {
  if (!card || !card.id) return
  const next = new Set(busyIds.value)
  next.add(card.id)
  busyIds.value = next
  try {
    const res = await actOnLargeTask(card.id, action, { reason: 'task board' })
    const data = (res && res.data) || {}
    // 后端会回 already_* 标记表示「本来就是这个状态」，如实告知而不是谎报成功。
    if (data.already_terminal) {
      ElMessage.info(`任务已处于终态，无需${actionLabel(action)}。`)
    } else if (data.already_paused) {
      ElMessage.info('任务本来就处于暂停状态。')
    } else {
      ElMessage.success(`已${actionLabel(action)}：${card.title}`)
    }
    await load()
  } catch (e) {
    ElMessage.error(getFriendlyErrorMessage(e) || `${actionLabel(action)}失败。`)
  } finally {
    const done = new Set(busyIds.value)
    done.delete(card.id)
    busyIds.value = done
  }
}

onMounted(load)
onBeforeUnmount(() => {
  disposed = true
})
</script>

<style scoped>
.task-board-view {
  padding: 16px;
}
</style>
