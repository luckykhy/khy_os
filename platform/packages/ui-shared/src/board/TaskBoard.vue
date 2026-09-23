<template>
  <section class="khy-board">
    <header class="khy-board__head">
      <div class="khy-board__headline">
        <h3 class="khy-board__title">{{ title }}</h3>
        <span v-if="model.generatedAt" class="khy-board__stamp">数据时间 {{ relativeStamp }}</span>
      </div>

      <ul class="khy-board__stats">
        <li class="khy-board__stat">共 <b>{{ summary.total }}</b></li>
        <li class="khy-board__stat khy-board__stat--run">执行中 <b>{{ summary.running }}</b></li>
        <li class="khy-board__stat khy-board__stat--pause">暂停 <b>{{ summary.paused }}</b></li>
        <li class="khy-board__stat khy-board__stat--done">完成 <b>{{ summary.done }}</b></li>
        <li class="khy-board__stat khy-board__stat--fail">失败 <b>{{ summary.failed }}</b></li>
      </ul>

      <div class="khy-board__tools">
        <label class="khy-board__toggle">
          <input v-model="hideEmpty" type="checkbox" />
          <span>隐藏空泳道</span>
        </label>
        <button type="button" class="khy-board__refresh" :disabled="loading" @click="$emit('refresh')">
          {{ loading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </header>

    <p v-if="error" class="khy-board__alert khy-board__alert--error">{{ error }}</p>

    <p v-if="model.unmapped > 0" class="khy-board__alert khy-board__alert--warn">
      有 {{ model.unmapped }} 张卡片的状态不在看板列映射内，未归入任何列（已单独标出，未丢弃）。
    </p>

    <p v-if="loading && model.cards.length === 0" class="khy-board__placeholder">正在加载任务看板…</p>

    <p v-else-if="model.cards.length === 0" class="khy-board__placeholder">{{ emptyText }}</p>

    <!-- 桌面：泳道 × 列 二维矩阵 -->
    <div
      v-else-if="mode === 'desktop'"
      class="khy-board__matrix"
      :style="{ '--khy-lane-count': model.lanes.length }"
    >
      <div class="khy-board__corner">泳道 \ 状态</div>
      <div v-for="lane in model.lanes" :key="'h-' + lane.id" class="khy-board__colhead">
        <span class="khy-board__colname">{{ lane.title }}</span>
        <span class="khy-board__colcount">{{ lane.count }}</span>
      </div>

      <template v-for="lane in swimlanes" :key="'r-' + lane.id">
        <div class="khy-board__rowhead" :title="lane.source">
          <span class="khy-board__rowname">{{ lane.title }}</span>
          <span class="khy-board__rowkind">{{ kindLabel(lane.kind) }}</span>
          <span class="khy-board__rowcount">{{ lane.count }}</span>
        </div>
        <div
          v-for="col in model.lanes"
          :key="lane.id + '@' + col.id"
          class="khy-board__cell"
          :class="{ 'khy-board__cell--empty': cardsAt(lane.id, col.id).length === 0 }"
        >
          <TaskCard
            v-for="card in cardsAt(lane.id, col.id)"
            :key="card.id"
            :card="card"
            :busy="busySet.has(card.id)"
            @action="onAction"
          />
        </div>
      </template>
    </div>

    <!-- 平板 / 手机：列切换器 + 单列纵向流（不做横向滚动矩阵，方案 F6） -->
    <div v-else class="khy-board__stream-wrap">
      <nav class="khy-board__tabs" role="tablist">
        <button
          v-for="tab in tabs.tabs"
          :key="tab.id"
          type="button"
          role="tab"
          class="khy-board__tab"
          :class="{ 'khy-board__tab--active': tab.active }"
          :aria-selected="tab.active ? 'true' : 'false'"
          @click="activeLane = tab.id"
        >
          {{ tab.title }}<span class="khy-board__tabcount">{{ tab.count }}</span>
        </button>
      </nav>

      <!-- 平板：按泳道分组 -->
      <div v-if="mode === 'tablet'" class="khy-board__sections">
        <section v-for="lane in activeSwimlanes" :key="lane.id" class="khy-board__section">
          <h4 class="khy-board__sectionhead">
            {{ lane.title }}<span class="khy-board__sectioncount">{{ lane.count }}</span>
          </h4>
          <div class="khy-board__sectionbody">
            <TaskCard
              v-for="card in cardsOfSwimlane(lane.id)"
              :key="card.id"
              :card="card"
              :busy="busySet.has(card.id)"
              compact
              @action="onAction"
            />
          </div>
        </section>
      </div>

      <!-- 手机：扁平单列，泳道以 chip 形式标在卡上 -->
      <div v-else class="khy-board__flat">
        <TaskCard
          v-for="card in activeCards"
          :key="card.id"
          :card="card"
          :busy="busySet.has(card.id)"
          compact
          show-swimlane
          @action="onAction"
        />
        <p v-if="activeCards.length === 0" class="khy-board__placeholder khy-board__placeholder--inline">
          该状态下没有任务。
        </p>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import TaskCard from './TaskCard.vue';
import {
  SWIMLANE_KIND_LABELS,
  cardsAt as modelCardsAt,
  cardsOfSwimlane as modelCardsOfSwimlane,
  emptyMessage,
  formatRelative,
  laneTabs,
  normalizeBoard,
  resolveBreakpoint,
  summarize,
  visibleSwimlanes,
} from './model.js';

const props = defineProps({
  /** 后端 `GET /large-tasks/board` 的 `data`（或已归一化的对象）。 */
  board: { type: Object, default: () => ({}) },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  /** 正在执行动作的任务 id 集合（数组或 Set）。 */
  busyIds: { type: [Array, Set], default: () => [] },
  title: { type: String, default: '任务看板' },
  hideEmptyDefault: { type: Boolean, default: true },
  /** 强制断点（测试/嵌入用）；留空则按视口宽度自动判定。 */
  forceBreakpoint: { type: String, default: '' },
});

const emit = defineEmits(['action', 'refresh']);

const model = computed(() => normalizeBoard(props.board));
const summary = computed(() => summarize(model.value));
const hideEmpty = ref(props.hideEmptyDefault);
const swimlanes = computed(() => visibleSwimlanes(model.value, { hideEmpty: hideEmpty.value }));
const emptyText = computed(() => emptyMessage(model.value));
const relativeStamp = computed(() => formatRelative(model.value.generatedAt));

const busySet = computed(() => {
  const raw = props.busyIds;
  if (raw instanceof Set) return raw;
  return new Set(Array.isArray(raw) ? raw : []);
});

// ── 断点 ──
const viewportWidth = ref(typeof window === 'undefined' ? 1440 : window.innerWidth);
const mode = computed(() => props.forceBreakpoint || resolveBreakpoint(viewportWidth.value));

function onResize() {
  viewportWidth.value = window.innerWidth;
}

onMounted(() => {
  if (props.forceBreakpoint || typeof window === 'undefined') return;
  onResize();
  window.addEventListener('resize', onResize, { passive: true });
});

onBeforeUnmount(() => {
  if (typeof window === 'undefined') return;
  window.removeEventListener('resize', onResize);
});

// ── 列切换器（平板/手机） ──
// ⚠ 不在 computed 里写 ref —— 副作用会让依赖图不可预测，且容易触发重复求值。
//   `activeLane` 只由用户点击写入；「当前列」用 effectiveLane 派生（选择 or 首列）。
const activeLane = ref(null);
const effectiveLane = computed(
  () => activeLane.value || (model.value.lanes[0] ? model.value.lanes[0].id : null)
);
const tabs = computed(() => laneTabs(model.value, effectiveLane.value));

function cardsAt(swimlaneId, laneId) {
  return modelCardsAt(model.value, swimlaneId, laneId);
}

function cardsOfSwimlane(swimlaneId) {
  return modelCardsOfSwimlane(model.value, swimlaneId).filter((c) => c.lane === effectiveLane.value);
}

const activeCards = computed(() =>
  model.value.cards.filter((c) => c.lane === effectiveLane.value)
);

/** 平板分组视图只展示当前列里有卡片的泳道。 */
const activeSwimlanes = computed(() =>
  swimlanes.value.filter((lane) => cardsOfSwimlane(lane.id).length > 0)
);

function kindLabel(kind) {
  return SWIMLANE_KIND_LABELS[kind] || kind;
}

function onAction(payload) {
  emit('action', payload);
}
</script>

<style scoped>
.khy-board {
  display: flex;
  flex-direction: column;
  gap: 12px;
  color: var(--el-text-color-primary, #303133);
}

.khy-board__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.khy-board__headline {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.khy-board__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.khy-board__stamp {
  color: var(--el-text-color-secondary, #909399);
  font-size: 11px;
}

.khy-board__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.khy-board__stat {
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--el-fill-color-light, #f5f7fa);
  color: var(--el-text-color-regular, #606266);
  font-size: 12px;
}
.khy-board__stat--run { color: var(--el-color-primary, #409eff); }
.khy-board__stat--pause { color: var(--el-color-warning, #e6a23c); }
.khy-board__stat--done { color: var(--el-color-success, #67c23a); }
.khy-board__stat--fail { color: var(--el-color-danger, #f56c6c); }

.khy-board__tools {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: auto;
}
.khy-board__toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--el-text-color-regular, #606266);
  font-size: 12px;
  cursor: pointer;
}
.khy-board__refresh {
  padding: 4px 12px;
  border: 1px solid var(--el-border-color, #dcdfe6);
  border-radius: var(--el-border-radius-base, 4px);
  background: var(--el-bg-color, #ffffff);
  color: var(--el-text-color-regular, #606266);
  font-size: 12px;
  cursor: pointer;
}
.khy-board__refresh:hover:not(:disabled) {
  border-color: var(--el-color-primary, #409eff);
  color: var(--el-color-primary, #409eff);
}
.khy-board__refresh:disabled { cursor: not-allowed; opacity: 0.6; }

.khy-board__alert {
  margin: 0;
  padding: 6px 10px;
  border-radius: var(--el-border-radius-base, 4px);
  font-size: 12px;
}
.khy-board__alert--error {
  background: var(--el-color-danger-light-9, #fef0f0);
  color: var(--el-color-danger, #f56c6c);
}
.khy-board__alert--warn {
  background: var(--el-color-warning-light-9, #fdf6ec);
  color: var(--el-color-warning, #e6a23c);
}

.khy-board__placeholder {
  margin: 0;
  padding: 24px;
  text-align: center;
  color: var(--el-text-color-secondary, #909399);
  font-size: 13px;
}
.khy-board__placeholder--inline { padding: 12px; }

/* ── 桌面矩阵 ── */
.khy-board__matrix {
  display: grid;
  grid-template-columns: minmax(112px, 148px) repeat(var(--khy-lane-count, 6), minmax(132px, 1fr));
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 4px;
}
.khy-board__corner,
.khy-board__colhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 6px 8px;
  border-radius: var(--el-border-radius-base, 4px);
  background: var(--el-fill-color-light, #f5f7fa);
  font-size: 12px;
  font-weight: 600;
}
.khy-board__corner {
  color: var(--el-text-color-secondary, #909399);
  font-weight: 400;
}
.khy-board__colcount,
.khy-board__rowcount,
.khy-board__sectioncount,
.khy-board__tabcount {
  padding: 0 5px;
  border-radius: 8px;
  background: var(--el-fill-color, #f0f2f5);
  color: var(--el-text-color-secondary, #909399);
  font-size: 11px;
  font-weight: 400;
}
.khy-board__rowhead {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: var(--el-border-radius-base, 4px);
  background: var(--el-fill-color-light, #f5f7fa);
}
.khy-board__rowname {
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.khy-board__rowkind {
  color: var(--el-text-color-secondary, #909399);
  font-size: 11px;
}
.khy-board__cell {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 44px;
  padding: 4px;
  border: 1px dashed transparent;
  border-radius: var(--el-border-radius-base, 4px);
}
.khy-board__cell--empty {
  background: var(--el-fill-color-lighter, #fafafa);
}

/* ── 平板 / 手机 ── */
.khy-board__stream-wrap {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.khy-board__tabs {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 2px;
}
.khy-board__tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  padding: 5px 10px;
  border: 1px solid var(--el-border-color-lighter, #e4e7ed);
  border-radius: 14px;
  background: var(--el-bg-color, #ffffff);
  color: var(--el-text-color-regular, #606266);
  font-size: 12px;
  cursor: pointer;
}
.khy-board__tab--active {
  border-color: var(--el-color-primary, #409eff);
  background: var(--el-color-primary-light-9, #ecf5ff);
  color: var(--el-color-primary, #409eff);
}

.khy-board__sections,
.khy-board__flat {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.khy-board__section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.khy-board__sectionhead {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.khy-board__sectionbody {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
