<script setup>
import { useRouter } from 'vue-router';
import { useRuntimeStore } from '@/stores/runtime';
import { useSessionStore } from '@/stores/session';
import { useNotificationsStore } from '@/stores/notifications';
import { statusText } from '@/api/status';

const router = useRouter();
const runtime = useRuntimeStore();
const session = useSessionStore();
const notifications = useNotificationsStore();

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
</script>

<template><div class="stack">
  <div><h1 class="page-title">设置</h1><p class="page-subtitle">连接、会话与本地状态</p></div>
  <section class="panel stack"><h2>连接目标</h2><p class="break">{{ runtime.config?.apiBaseUrl || '未配置' }}</p><p class="muted">来源：{{ runtime.config?.source || '未知' }} · 最近验证：{{ runtime.config?.lastVerifiedAt || '未验证' }}</p><p class="status-line">{{ statusText(runtime.status) }}</p><button class="button" @click="router.push('/connect')">重新验证连接</button><button class="button danger" @click="resetConnection">清除连接与会话</button></section>
  <section class="panel stack"><h2>登录会话</h2><p>{{ session.user?.username || session.user?.email || '已登录账号' }}</p><p class="status-line">{{ statusText(session.status) }}</p><button class="button danger" @click="logout">退出登录</button></section>
  <section class="panel stack"><h2>事件摘要</h2><p class="muted">本次运行保留 {{ notifications.events.length }} 条脱敏摘要，未读 {{ notifications.unread }} 条。</p><button class="button" @click="notifications.clear">清空事件摘要</button></section>
</div></template>

<style scoped>h2 { font-size: 16px; }.panel p { margin: 0; }.break { overflow-wrap: anywhere; color: #68d5c0; }</style>
