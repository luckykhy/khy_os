<script setup>
import { computed, onMounted, ref } from 'vue';
import { apiJson } from '@/api/client';
import { operationStatus, statusText } from '@/api/status';
import { useNotificationsStore } from '@/stores/notifications';
import { useModelsStore } from '@/stores/models';
import { getSetting } from '@/api/localDb';
import EventTimeline from '@/components/EventTimeline.vue';

const snapshot = ref(null);
const status = ref(operationStatus('读取', '跨设备交接摘要', '等待开始'));
const error = ref('');
const notifications = useNotificationsStore();
const models = useModelsStore();
const mode = ref('');
const isStandalone = computed(() => mode.value === 'standalone');

async function refresh() {
  if (isStandalone.value) return;
  error.value = '';
  status.value = operationStatus('读取', '跨设备交接摘要', '进行中');
  try {
    const data = await apiJson('/api/large-tasks/handover/snapshot?mobile=true');
    snapshot.value = data.snapshot || data;
    status.value = operationStatus('读取', '跨设备交接摘要', '已更新', 'success');
  } catch (cause) {
    error.value = cause.message;
    status.value = operationStatus('读取', '跨设备交接摘要', '失败', 'error');
  }
}

const configuredProviders = computed(() => {
  if (!isStandalone.value) return 0;
  return Object.keys(models.standaloneApiKeys).filter((k) => models.standaloneApiKeys[k]).length;
});

onMounted(async () => {
  mode.value = await getSetting('settings_mode') || '';
  if (mode.value === 'standalone') {
    await models.restore();
    await models.loadStandaloneKeys().catch(() => {});
  }
  refresh();
});
</script>

<template>
  <div class="stack">
    <!-- 独立模式首页 -->
    <template v-if="isStandalone">
      <div class="row"><div><h1 class="page-title">Khy-OS 移动伴侣</h1><p class="page-subtitle">独立模式 · 直连 AI 供应商</p></div></div>
      <section class="grid-2">
        <RouterLink class="metric" to="/chat"><strong>AI</strong><span>开始对话</span></RouterLink>
        <RouterLink class="metric" to="/models"><strong>{{ configuredProviders }}</strong><span>已配供应商</span></RouterLink>
      </section>
      <section class="panel stack" v-if="configuredProviders === 0">
        <h2>快速开始</h2>
        <p class="muted">配置一个 AI 供应商的 API Key 即可开始对话。</p>
        <button class="button primary" @click="$router.push('/models')">配置模型与密钥</button>
      </section>
      <section class="panel stack" v-else>
        <h2>当前模型</h2>
        <p class="muted">{{ models.defaultModel || models.providers.find(p => p.id === models.effectiveStandaloneProvider)?.models?.[0] || '未选择' }}</p>
        <p class="status-line">已配置 {{ configuredProviders }} 家供应商，可在 模型 页面切换。</p>
      </section>
    </template>

    <!-- 远程模式首页 -->
    <template v-else>
      <div class="row"><div><h1 class="page-title">工作台</h1><p class="page-subtitle">运行状态与需要处理的事项</p></div><button class="button" title="刷新" @click="refresh">↻</button></div>
      <section class="grid-2">
        <RouterLink class="metric" to="/approvals"><strong>{{ snapshot?.summary?.pending_remote_approval_count ?? snapshot?.pending_approvals?.length ?? 0 }}</strong><span>待审批</span></RouterLink>
        <RouterLink class="metric" to="/tasks"><strong>{{ snapshot?.summary?.active_large_task_count ?? snapshot?.background_tasks?.length ?? 0 }}</strong><span>运行任务</span></RouterLink>
        <RouterLink class="metric" to="/chat"><strong>AI</strong><span>开始对话</span></RouterLink>
        <RouterLink class="metric" to="/trading"><strong>⇄</strong><span>交易与持仓</span></RouterLink>
      </section>
      <p class="status-line" :class="status.tone">{{ statusText(status) }}</p><p v-if="error" class="alert">{{ error }}</p>
      <section><div class="row"><h2>最近事件</h2><button v-if="notifications.unread" class="button" @click="notifications.markAllRead">标为已读</button></div><EventTimeline v-if="notifications.events.length" :events="notifications.events.slice(0, 8)" /><p v-else class="panel muted">暂无移动事件摘要</p></section>
    </template>
  </div>
</template>

<style scoped>
.metric { min-height: 104px; display: grid; align-content: center; gap: 5px; padding: 14px; color: #e9eef5; text-decoration: none; background: #111a24; border: 1px solid #243241; border-radius: 8px; }.metric strong { color: #68d5c0; font-size: 26px; }.metric span { color: #9aabbb; font-size: 13px; }h2 { font-size: 17px; }
</style>
