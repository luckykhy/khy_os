<script setup>
import { computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useRuntimeStore } from '@/stores/runtime';
import { useSessionStore } from '@/stores/session';
import { useNotificationsStore } from '@/stores/notifications';
import { useSseStream } from '@/composables/useSseStream';
import { useReconnect } from '@/composables/useReconnect';
import { useMobileLifecycle } from '@/composables/useMobileLifecycle';
import ConnectionStatus from '@/components/ConnectionStatus.vue';

const route = useRoute();
const runtime = useRuntimeStore();
const session = useSessionStore();
const notifications = useNotificationsStore();
const links = [
  { to: '/home', label: '首页', icon: '⌂' },
  { to: '/chat', label: '对话', icon: '◇' },
  { to: '/tasks', label: '任务', icon: '▤' },
  { to: '/market', label: '行情', icon: '↗' },
];
const title = computed(() => route.meta.title || 'Khy-OS Companion');
const taskStream = useSseStream('任务事件流', ({ data }) => notifications.add(data));
const approvalStream = useSseStream('审批事件流', ({ data }) => notifications.add(data));

function startStreams() {
  taskStream.start('/api/large-tasks/events/stream').catch(() => {});
  approvalStream.start('/api/large-tasks/retry-policy/approvals/stream').catch(() => {});
}
function stopStreams() {
  taskStream.stop('应用已进入后台');
  approvalStream.stop('应用已进入后台');
}
async function resume() {
  await session.verifyCurrentUser().catch(() => {});
  startStreams();
}

useReconnect(startStreams);
useMobileLifecycle({ onResume: resume, onPause: stopStreams });

onMounted(async () => {
  if (!runtime.config) await runtime.restore();
  if (!session.session) await session.restore({ verify: false });
  startStreams();
});
</script>

<template>
  <div class="mobile-shell">
    <header class="topbar">
      <div><small>Khy-OS</small><strong>{{ title }}</strong></div>
      <ConnectionStatus :status="runtime.status" :connected="runtime.configured" />
    </header>
    <main class="shell-content"><RouterView /></main>
    <nav class="bottom-nav" aria-label="主导航">
      <RouterLink v-for="link in links" :key="link.to" :to="link.to" :class="{ active: route.path === link.to }">
        <span class="nav-icon">{{ link.icon }}</span><span>{{ link.label }}</span>
      </RouterLink>
      <RouterLink to="/settings" :class="{ active: route.path === '/settings' }"><span class="nav-icon">⚙</span><span>设置</span></RouterLink>
    </nav>
  </div>
</template>
