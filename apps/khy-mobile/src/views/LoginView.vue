<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useRuntimeStore } from '@/stores/runtime';
import { useSessionStore } from '@/stores/session';
import { statusText } from '@/api/status';

const runtime = useRuntimeStore();
const session = useSessionStore();
const route = useRoute();
const router = useRouter();
const username = ref('');
const password = ref('');
const busy = ref(false);
const next = computed(() => typeof route.query.next === 'string' ? route.query.next : '/home');

onMounted(async () => {
  await runtime.restore();
  const restored = await session.restore({ verify: false });
  if (restored?.accessToken) await router.replace(next.value);
});

async function submit() {
  busy.value = true;
  try {
    await session.signIn(username.value.trim(), password.value);
    await router.replace(next.value === '/login' ? '/home' : next.value);
  } catch { /* store renders the error */ }
  finally { busy.value = false; }
}
</script>

<template>
  <main class="login-page"><section class="login-inner stack">
    <div><small class="brand-mark">KHY-OS COMPANION</small><h1>登录工作节点</h1><p>{{ runtime.config?.apiBaseUrl || '正在读取连接目标' }}</p></div>
    <form class="panel stack" @submit.prevent="submit">
      <label class="field">账号<input v-model="username" autocomplete="username" required /></label>
      <label class="field">密码<input v-model="password" type="password" autocomplete="current-password" required /></label>
      <button class="button primary" :disabled="busy">登录</button>
      <button class="button" type="button" @click="router.push('/connect')">更换连接目标</button>
    </form>
    <p class="status-line" :class="session.status.tone">{{ statusText(session.status) }}</p>
    <p v-if="session.error" class="alert">{{ session.error }}</p>
  </section></main>
</template>

<style scoped>
.login-page { min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; }.login-inner { width: min(420px, 100%); }.brand-mark { color: #68d5c0; letter-spacing: .08em; }.login-inner h1 { margin: 8px 0; font-size: 30px; }.login-inner > div p { overflow-wrap: anywhere; color: #8ca0b5; }
</style>
