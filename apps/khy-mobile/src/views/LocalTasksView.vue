<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useTasksStore } from '@/stores/tasks';
import { useModelsStore } from '@/stores/models';
import { operationStatus, statusText } from '@/api/status';

const tasks = useTasksStore();
const models = useModelsStore();
const router = useRouter();
const expanded = ref(null);
const status = ref(operationStatus('读取', '本地任务', '等待开始'));
const showCreate = ref(false);
const draft = ref({
  name: '',
  prompt: '',
  provider: '',
  model: '',
  once: false,
  intervalMinutes: 30,
});

onMounted(async () => {
  await tasks.refresh();
  tasks.start();
  status.value = operationStatus('读取', '本地任务', `已加载 ${tasks.tasks.length} 个`, 'success');
  if (!draft.value.provider) draft.value.provider = models.selectedProvider || 'openai';
});

function describe(t) {
  if (!t.schedule || t.schedule === 'once') return '单次';
  if (t.schedule.kind === 'interval') return `每 ${t.schedule.minutes} 分钟`;
  return String(t.schedule);
}

function statusLabel(t) {
  return {
    idle: '待运行', running: '运行中', paused: '已暂停', done: '已完成', failed: '失败', disabled: '已停用',
  }[t.status] || t.status;
}

function statusTone(t) {
  return { running: 'ok', done: 'ok', failed: 'miss', paused: 'warn' }[t.status] || 'muted';
}

async function createOne() {
  if (!draft.value.name.trim() || !draft.value.prompt.trim()) return;
  const schedule = draft.value.once
    ? 'once'
    : { kind: 'interval', minutes: Math.max(1, Number(draft.value.intervalMinutes) || 30) };
  await tasks.createTask({
    name: draft.value.name.trim(),
    prompt: draft.value.prompt.trim(),
    provider: draft.value.provider,
    model: draft.value.model || undefined,
    schedule,
    status: 'idle',
  });
  showCreate.value = false;
  draft.value.name = '';
  draft.value.prompt = '';
}

async function syncBtn() {
  const r = await tasks.syncNow();
  if (r.synced) status.value = operationStatus('同步', '后端', `已同步（远端 ${r.remote} 条 / 本地 ${r.local} 条）`, 'success');
  else status.value = operationStatus('同步', '后端', `跳过：${r.reason || '未知'}`, 'warn');
}
</script>

<template>
  <div class="stack">
    <div>
      <h1 class="page-title">本地任务</h1>
      <p class="page-subtitle">手机本地调度，每 N 分钟跑一次 prompt，结果存历史</p>
    </div>

    <section class="panel stack">
      <div class="row">
        <h2>任务列表（{{ tasks.tasks.length }}）</h2>
        <div class="row actions">
          <button class="button small" @click="syncBtn">同步</button>
          <button class="button small" @click="tasks.refresh()">刷新</button>
          <button class="button small primary" @click="showCreate = !showCreate">{{ showCreate ? '收起' : '新建' }}</button>
        </div>
      </div>
      <p class="status-line" :class="status.tone">{{ statusText(status) }}</p>

      <div v-if="showCreate" class="creator stack">
        <label class="field">
          <span>任务名</span>
          <input v-model="draft.name" placeholder="如：AAPL 价格检查" />
        </label>
        <label class="field">
          <span>Prompt（发给 AI 的内容）</span>
          <textarea v-model="draft.prompt" rows="3" placeholder="查一下苹果公司现在股价，如果高于 200 美元提醒我" />
        </label>
        <div class="row split">
          <label class="field">
            <span>Provider</span>
            <select v-model="draft.provider">
              <option v-for="p in models.providers" :key="p.id" :value="p.id">{{ p.label }}</option>
            </select>
          </label>
          <label class="field">
            <span>Model（留空用默认）</span>
            <input v-model="draft.model" placeholder="如 gpt-4o-mini" />
          </label>
        </div>
        <div class="row split">
          <label class="check">
            <input type="checkbox" v-model="draft.once" /> 只跑一次
          </label>
          <label class="field" v-if="!draft.once">
            <span>间隔（分钟）</span>
            <input v-model.number="draft.intervalMinutes" type="number" min="1" />
          </label>
        </div>
        <button class="button primary" @click="createOne">保存任务</button>
      </div>

      <div v-if="!tasks.tasks.length" class="empty">
        <p>还没有本地任务。</p>
        <p class="muted">所有任务都跑在手机本地（不需要 khy-os 后端）。</p>
      </div>

      <details
        v-for="t in tasks.tasks"
        :key="t.id"
        class="task"
        :open="expanded === t.id"
        @toggle="expanded = $event.target.open ? t.id : null"
      >
        <summary>
          <span class="task-name">{{ t.name }}</span>
          <span class="badge" :class="statusTone(t)">{{ statusLabel(t) }}</span>
          <span class="muted schedule">{{ describe(t) }}</span>
        </summary>
        <div class="row task-actions">
          <span class="muted">provider: {{ t.provider || 'openai' }} · model: {{ t.model || '默认' }}</span>
          <div class="row ops">
            <button class="button small" :disabled="t.status === 'running'" @click="tasks.trigger(t.id)">立即跑</button>
            <button class="button small" v-if="t.status === 'paused' || t.status === 'failed' || t.status === 'done'" @click="tasks.setStatus(t.id, 'idle')">恢复</button>
            <button class="button small" v-else @click="tasks.setStatus(t.id, 'paused')">暂停</button>
            <button class="button small danger" @click="tasks.removeTask(t.id)">删除</button>
          </div>
        </div>
        <pre v-if="t.prompt" class="prompt">{{ t.prompt }}</pre>
        <details v-if="t.history?.length" class="history">
          <summary>历史（{{ t.history.length }}）</summary>
          <ol>
            <li v-for="(h, i) in t.history.slice().reverse()" :key="i">
              <span class="muted">{{ new Date(h.startedAt).toLocaleString() }}</span>
              <span v-if="h.error" class="error">失败：{{ h.error }}</span>
              <pre v-else>{{ h.result }}</pre>
            </li>
          </ol>
          <button class="button small" @click="tasks.clearHistory(t.id)">清空历史</button>
        </details>
      </details>
    </section>
  </div>
</template>

<style scoped>
.panel { padding: 16px; border-radius: var(--m-radius-lg); }
.panel h2 { margin: 0 0 10px; font-size: 15px; }
.actions { gap: 6px; }
.creator { padding: 10px; background: var(--m-bg-deep); border-radius: var(--m-radius-md); }
.row.split { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.check { display: flex; align-items: center; gap: 8px; align-self: end; }
.empty { padding: 18px 12px; text-align: center; color: var(--m-text-muted); border: 1px dashed var(--m-border); border-radius: var(--m-radius-md); }
.empty p { margin: 4px 0; }
.task { border: 1px solid var(--m-border); border-radius: var(--m-radius-md); background: var(--m-bg-deep); padding: 8px 12px; }
.task + .task { margin-top: 8px; }
.task summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 10px; }
.task summary::-webkit-details-marker { display: none; }
.task-name { font-weight: 600; flex: 1; }
.schedule { font-size: 12px; }
.task-actions { gap: 8px; flex-wrap: wrap; }
.task-actions .ops { gap: 6px; flex-shrink: 0; }
.prompt { margin: 8px 0 0; padding: 8px; background: var(--m-bg-code); color: #b8c8d8; border-radius: 4px; font-size: 12px; white-space: pre-wrap; overflow-x: auto; }
.history { margin-top: 8px; }
.history ol { padding-left: 16px; max-height: 240px; overflow-y: auto; }
.history li { margin-bottom: 8px; font-size: 13px; }
.history pre { margin: 4px 0 0; padding: 6px; background: var(--m-bg-code); color: #b8c8d8; border-radius: 4px; font-size: 11px; white-space: pre-wrap; }
.error { color: var(--m-danger-text); }
.badge { padding: 2px 8px; border-radius: var(--m-radius-pill); font-size: 11px; font-weight: 600; }
.badge.ok { color: var(--m-success); background: var(--m-success-bg); border: 1px solid var(--m-success-border); }
.badge.miss { color: var(--m-warn); background: #2a2310; border: 1px solid #5a4818; }
.badge.warn { color: var(--m-warn); background: #2a2310; border: 1px solid #5a4818; }
.badge.muted { color: var(--m-text-muted); background: var(--m-bg); border: 1px solid var(--m-border); }
.button.danger { color: var(--m-danger-text); border-color: #9b5446; background: #3a2020; }
.button.primary { color: var(--m-accent-on); background: var(--m-accent); border-color: var(--m-accent); }
.button.small { padding: 6px 10px; font-size: 12px; }
</style>
