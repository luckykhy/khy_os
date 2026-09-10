<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useRuntimeStore } from '@/stores/runtime';
import { useSessionStore } from '@/stores/session';
import { useNotificationsStore } from '@/stores/notifications';
import { useSseStream } from '@/composables/useSseStream';
import { useReconnect } from '@/composables/useReconnect';
import { useMobileLifecycle } from '@/composables/useMobileLifecycle';
import ConnectionStatus from '@/components/ConnectionStatus.vue';
import { getSetting } from '@/api/localDb';

const route = useRoute();
const runtime = useRuntimeStore();
const session = useSessionStore();
const notifications = useNotificationsStore();
const mode = ref('');
const isStandalone = computed(() => mode.value === 'standalone');

// 底部只留主入口。任务与审批从首页卡片进入，交易域从 /trading 二级展开。
// 独立模式下隐藏交易/行情（这些是远程网关功能）
const links = computed(() => {
  const base = [
    { to: '/home', label: '首页', icon: '⌂' },
    { to: '/chat', label: '对话', icon: '◇' },
  ];
  if (!isStandalone.value) {
    base.push({ to: '/trading', label: '交易', icon: '⇄' });
    base.push({ to: '/market', label: '行情', icon: '↗' });
  }
  return base;
});
const title = computed(() => route.meta.title || 'Khy-OS Companion');
// 交易域子页面不在导航里，但仍应让「交易」标签保持高亮，否则二级页面看着像脱离了导航。
const TRADING_GROUP = ['/trading', '/portfolio', '/order', '/trades', '/strategies', '/backtests'];
function isActive(to) {
  if (to === '/trading') return TRADING_GROUP.includes(route.path);
  return route.path === to;
}

// SSE 流只在远程模式下启动
const taskStream = useSseStream('任务事件流', ({ data }) => notifications.add(data));
const approvalStream = useSseStream('审批事件流', ({ data }) => notifications.add(data));

function startStreams() {
  if (isStandalone.value) return; // 独立模式无远程事件流
  taskStream.start('/api/large-tasks/events/stream').catch(() => {});
  approvalStream.start('/api/large-tasks/retry-policy/approvals/stream').catch(() => {});
}
function stopStreams() {
  if (isStandalone.value) return;
  taskStream.stop('应用已进入后台');
  approvalStream.stop('应用已进入后台');
}
async function resume() {
  if (isStandalone.value) return;
  await session.verifyCurrentUser().catch(() => {});
  startStreams();
}

useReconnect(startStreams);
useMobileLifecycle({ onResume: resume, onPause: stopStreams });

onMounted(async () => {
  mode.value = await getSetting('settings_mode') || '';
  if (!isStandalone.value) {
    if (!runtime.config) await runtime.restore();
    if (!session.session) await session.restore({ verify: false });
    startStreams();
  }
});
</script>

<template>
  <div class="mobile-shell">
    <header class="topbar">
      <div><small>Khy-OS</small><strong>{{ title }}</strong></div>
      <div class="topbar-right">
        <span v-if="isStandalone" class="mode-indicator">独立模式</span>
        <ConnectionStatus v-else :status="runtime.status" :connected="runtime.configured" />
      </div>
    </header>
    <main class="shell-content"><RouterView /></main>
    <nav class="bottom-nav" :style="{ '--nav-count': links.length + (isStandalone ? 2 : 1) }" aria-label="主导航">
      <RouterLink v-for="link in links" :key="link.to" :to="link.to" :class="{ active: isActive(link.to) }">
        <span class="nav-icon">{{ link.icon }}</span><span>{{ link.label }}</span>
      </RouterLink>
      <RouterLink v-if="isStandalone" to="/models" :class="{ active: route.path === '/models' }"><span class="nav-icon">⚡</span><span>模型</span></RouterLink>
      <RouterLink to="/settings" :class="{ active: route.path === '/settings' }"><span class="nav-icon">⚙</span><span>设置</span></RouterLink>
    </nav>
  </div>
</template>
