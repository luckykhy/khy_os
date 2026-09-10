<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useRuntimeStore } from '@/stores/runtime';
import { useSessionStore } from '@/stores/session';
import { useNotificationsStore } from '@/stores/notifications';
import { useModelsStore } from '@/stores/models';
import { useCrossPlatform } from '@/api/crossPlatform/crossPlatformClient';
import { statusText } from '@/api/status';
import { getSetting } from '@/api/localDb';

const router = useRouter();
const runtime = useRuntimeStore();
const session = useSessionStore();
const notifications = useNotificationsStore();
const models = useModelsStore();
const cp = useCrossPlatform();
const mode = ref('');
const isStandalone = computed(() => mode.value === 'standalone');

onMounted(async () => {
  mode.value = await getSetting('settings_mode') || '';
  if (runtime.config?.apiBaseUrl) {
    cp.connect();
  }
});

async function logout() {
  await session.signOut();
  notifications.clear();
  await router.replace('/login');
}
async function resetConnection() {
  await session.signOut();
  notifications.clear();
  await runtime.clear();
  await router.replace('/connect');
}

async function switchMode() {
  // 切换模式后跳转到欢迎页重新选择
  await router.replace('/welcome');
}

function platformLabel(platform) {
  const map = { terminal: '终端', web: '网页', desktop: '桌面', mobile: '手机' };
  return map[platform] || platform;
}

const unreadCount = computed(() => cp.unreadNotifications.length);
</script>

<template><div class="stack">
  <div><h1 class="page-title">设置</h1><p class="page-subtitle">连接、会话与本地状态</p></div>

  <!-- 运行模式 -->
  <section class="panel stack">
    <h2>运行模式</h2>
    <p class="status-line">{{ isStandalone ? '独立模式 — 直连 AI 供应商' : '远程模式 — 通过 khy-os 网关' }}</p>
    <button class="button" @click="switchMode">切换模式</button>
  </section>

  <!-- 独立模式：模型配置入口 -->
  <section v-if="isStandalone" class="panel stack">
    <h2>AI 供应商</h2>
    <p class="muted">已配置 {{ Object.keys(models.standaloneApiKeys).filter(k => models.standaloneApiKeys[k]).length }} 家供应商</p>
    <button class="button primary" @click="router.push('/models')">管理模型与密钥</button>
  </section>

  <!-- 远程模式：连接目标 -->
  <section v-else class="panel stack">
    <h2>连接目标</h2>
    <p class="break">{{ runtime.config?.apiBaseUrl || '未配置' }}</p>
    <p class="muted">来源：{{ runtime.config?.source || '未知' }} · 最近验证：{{ runtime.config?.lastVerifiedAt || '未验证' }}</p>
    <p class="status-line">{{ statusText(runtime.status) }}</p>
    <button class="button" @click="router.push('/connect')">重新验证连接</button>
    <button class="button danger" @click="resetConnection">清除连接与会话</button>
  </section>

  <!-- 远程模式：登录会话 -->
  <section v-if="!isStandalone" class="panel stack">
    <h2>登录会话</h2>
    <p>{{ session.user?.username || session.user?.email || '已登录账号' }}</p>
    <p class="status-line">{{ statusText(session.status) }}</p>
    <button class="button danger" @click="logout">退出登录</button>
  </section>

  <section class="panel stack"><h2>事件摘要</h2><p class="muted">本次运行保留 {{ notifications.events.length }} 条脱敏摘要，未读 {{ notifications.unread }} 条。</p><button class="button" @click="notifications.clear">清空事件摘要</button></section>

  <!-- 跨设备同步（仅远程模式） -->
  <section v-if="!isStandalone" class="panel stack">
    <h2>跨设备同步</h2>
    <p class="status-line">{{ cp.isConnected ? '已连接' : '未连接' }} · {{ cp.onlineDevices.length }} 台设备在线 · {{ unreadCount }} 条未读通知</p>
    <div style="display: flex; gap: 8px; flex-wrap: wrap;">
      <button v-if="!cp.isConnected" class="button primary" @click="cp.connect()">连接</button>
      <button v-else class="button" @click="cp.disconnect()">断开</button>
      <button class="button" @click="cp.listDevices()">刷新设备</button>
    </div>
    <div v-if="cp.onlineDevices.length" style="margin-top: 8px;">
      <div v-for="d in cp.onlineDevices" :key="d.deviceId" class="device-row">
        <span class="device-name">{{ platformLabel(d.platform) }}: {{ d.deviceName || d.deviceId }}</span>
      </div>
    </div>
  </section>
</div>
</template>

<style scoped>
.device-row { padding: 6px 0; border-bottom: 1px solid #1e2a3a; }
.device-name { font-size: 13px; color: #8ca0b5; }
</style>
