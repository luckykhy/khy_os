<template>
  <PublicLayout title="401 · 请先登录">
    <div class="unauth-card">
      <KhyIcon class="unauth-icon" kind="info" size="lg" />
      <h2 class="unauth-title">请先登录</h2>
      <p class="unauth-desc">
        这个页面需要登录后才能访问。会话可能已经失效，或者你还没有登录。
      </p>
      <p v-if="target" class="unauth-target">
        登录成功后会回到 {{ target }}
      </p>
      <div class="unauth-actions">
        <el-button type="primary" @click="toLogin">去登录</el-button>
        <el-button @click="back">返回上一页</el-button>
      </div>
    </div>
  </PublicLayout>
</template>

<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import KhyIcon from '@/components/KhyIcon.vue';
import PublicLayout from '@/layouts/PublicLayout.vue';
import { safeRedirectPath } from '@/utils/safeRedirect';

defineOptions({ name: 'NotAuthenticated' });

const route = useRoute();
const router = useRouter();

// Where the guard wanted to go before it bounced us here. Shown as a promise so
// the user can see login will take them back to the right place.
const target = computed(() => {
  const safe = safeRedirectPath(route.query.redirect, '/');
  return safe === '/' ? '' : safe;
});

function toLogin() {
  const safe = safeRedirectPath(route.query.redirect, '/');
  router.push(safe === '/' ? '/login' : `/login?redirect=${encodeURIComponent(safe)}`);
}

function back() {
  router.back();
}
</script>

<style scoped>
.unauth-card {
  max-width: 460px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

.unauth-icon {
  color: var(--khy-primary);
}

.unauth-title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  color: var(--khy-text-strong);
}

.unauth-desc {
  margin: 0;
  font-size: 14px;
  line-height: 1.7;
  color: var(--khy-text-secondary);
}

.unauth-target {
  margin: 0;
  padding: 8px 14px;
  border: 1px solid var(--khy-border);
  border-radius: var(--khy-radius-sm);
  background: var(--khy-bg-soft);
  font-size: 13px;
  color: var(--khy-text-secondary);
  word-break: break-all;
}

.unauth-actions {
  display: flex;
  gap: 10px;
  margin-top: 6px;
}
</style>
