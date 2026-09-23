<template>
  <article class="khy-card" :class="{ 'khy-card--busy': busy, 'khy-card--compact': compact }">
    <header class="khy-card__head">
      <h4 class="khy-card__title" :title="card.title">{{ card.title }}</h4>
      <span class="khy-card__status" :data-tone="tone">{{ card.status || '未知' }}</span>
    </header>

    <p v-if="showSwimlane" class="khy-card__meta">
      <span class="khy-card__chip">{{ card.swimlane }}</span>
      <span v-if="card.source" class="khy-card__chip khy-card__chip--quiet">source: {{ card.source }}</span>
    </p>

    <div class="khy-card__progress" role="progressbar" :aria-valuenow="card.progressPct" aria-valuemin="0" aria-valuemax="100">
      <div class="khy-card__progress-bar" :style="{ width: card.progressPct + '%' }" />
    </div>

    <p class="khy-card__meta khy-card__meta--quiet">
      <span>{{ card.progressPct }}%</span>
      <span v-if="card.maxAttempts">尝试 {{ card.attemptCount }}/{{ card.maxAttempts }}</span>
      <span v-else-if="card.attemptCount">尝试 {{ card.attemptCount }}</span>
      <span v-if="relative">更新 {{ relative }}</span>
    </p>

    <p v-if="card.lane === null" class="khy-card__warn">
      状态「{{ card.status }}」不在看板列映射内
    </p>

    <footer v-if="hasActions" class="khy-card__actions">
      <template v-for="action in actions" :key="action">
        <button
          type="button"
          class="khy-card__btn"
          :class="{ 'khy-card__btn--danger': action === 'cancel' }"
          :disabled="busy"
          @click="onClick(action)"
        >
          {{ confirming === action ? '确认' + label(action) + '？' : label(action) }}
        </button>
      </template>
      <span v-if="busy" class="khy-card__busy">处理中…</span>
    </footer>
  </article>
</template>

<script setup>
import { computed, onBeforeUnmount, ref } from 'vue';
import { ACTION_ORDER, actionLabel, formatRelative, isActionable, statusTone } from './model.js';

const props = defineProps({
  card: { type: Object, required: true },
  busy: { type: Boolean, default: false },
  compact: { type: Boolean, default: false },
  showSwimlane: { type: Boolean, default: false },
});

const emit = defineEmits(['action']);

const confirming = ref(null);
let confirmTimer = null;

/** 只有后端允许的动作才渲染按钮 —— 门控真源在卡片自身的 `actions`。 */
const actions = computed(() => ACTION_ORDER.filter((action) => isActionable(props.card, action)));
const hasActions = computed(() => actions.value.length > 0);
const relative = computed(() => formatRelative(props.card.updatedAt));
/** 色调由唯一的状态知识表派生（见 model.js 的 STATUS_TONE）。 */
const tone = computed(() => statusTone(props.card.status));

function label(action) {
  return actionLabel(action);
}

function clearConfirm() {
  confirming.value = null;
  if (confirmTimer) {
    clearTimeout(confirmTimer);
    confirmTimer = null;
  }
}

/**
 * `cancel` 是不可逆操作，走**两步确认**（不用 window.confirm，避免阻塞与样式不一致）。
 * `pause` / `resume` 可逆，直接触发。
 */
function onClick(action) {
  if (props.busy) return;
  if (action === 'cancel' && confirming.value !== 'cancel') {
    confirming.value = 'cancel';
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = setTimeout(clearConfirm, 4000);
    return;
  }
  clearConfirm();
  emit('action', { action, card: props.card });
}

onBeforeUnmount(clearConfirm);
</script>

<style scoped>
.khy-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--el-border-color-lighter, #e4e7ed);
  border-radius: var(--el-border-radius-base, 4px);
  background: var(--el-bg-color, #ffffff);
  color: var(--el-text-color-primary, #303133);
  font-size: var(--el-font-size-small, 13px);
  line-height: 1.4;
}
.khy-card--busy { opacity: 0.65; }
.khy-card--compact { padding: 6px 8px; font-size: 12px; }

.khy-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 6px;
}
.khy-card__title {
  margin: 0;
  font-size: 1em;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.khy-card__status {
  flex: none;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 11px;
  background: var(--el-fill-color-light, #f5f7fa);
  color: var(--el-text-color-secondary, #909399);
}
/* 按色调而非原始状态着色：状态→色调的映射只在 model.js 里维护一份。 */
.khy-card__status[data-tone='running'] { background: var(--el-color-primary-light-9, #ecf5ff); color: var(--el-color-primary, #409eff); }
.khy-card__status[data-tone='warn'] { background: var(--el-color-warning-light-9, #fdf6ec); color: var(--el-color-warning, #e6a23c); }
.khy-card__status[data-tone='ok'] { background: var(--el-color-success-light-9, #f0f9eb); color: var(--el-color-success, #67c23a); }
.khy-card__status[data-tone='error'] { background: var(--el-color-danger-light-9, #fef0f0); color: var(--el-color-danger, #f56c6c); }

.khy-card__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0;
}
.khy-card__meta--quiet { color: var(--el-text-color-secondary, #909399); font-size: 11px; }
.khy-card__chip {
  padding: 0 5px;
  border-radius: 3px;
  background: var(--el-fill-color, #f0f2f5);
  font-size: 11px;
}
.khy-card__chip--quiet { background: transparent; }

.khy-card__progress {
  height: 4px;
  border-radius: 2px;
  background: var(--el-fill-color, #f0f2f5);
  overflow: hidden;
}
.khy-card__progress-bar {
  height: 100%;
  background: var(--el-color-primary, #409eff);
  transition: width 0.2s ease;
}

.khy-card__warn {
  margin: 0;
  color: var(--el-color-warning, #e6a23c);
  font-size: 11px;
}

.khy-card__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding-top: 2px;
}
.khy-card__btn {
  padding: 2px 8px;
  border: 1px solid var(--el-border-color, #dcdfe6);
  border-radius: var(--el-border-radius-base, 4px);
  background: var(--el-bg-color, #ffffff);
  color: var(--el-text-color-regular, #606266);
  font-size: 11px;
  cursor: pointer;
}
.khy-card__btn:hover:not(:disabled) {
  border-color: var(--el-color-primary, #409eff);
  color: var(--el-color-primary, #409eff);
}
.khy-card__btn:disabled { cursor: not-allowed; opacity: 0.6; }
.khy-card__btn--danger:hover:not(:disabled) {
  border-color: var(--el-color-danger, #f56c6c);
  color: var(--el-color-danger, #f56c6c);
}
.khy-card__busy { color: var(--el-text-color-secondary, #909399); font-size: 11px; }
</style>
