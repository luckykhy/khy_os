<template>
  <PublicLayout title="403 · 没有访问权限">
    <div class="forbidden-card">
      <KhyIcon class="forbidden-icon" kind="warning" size="lg" />
      <h2 class="forbidden-title">没有访问权限</h2>
      <p class="forbidden-desc">
        这个页面需要管理员角色。如果你的账号应该有权限，请联系平台管理员确认角色配置。
      </p>
      <div class="forbidden-actions">
        <el-button type="primary" @click="goHome">返回我的首页</el-button>
        <el-button @click="back">返回上一页</el-button>
      </div>
    </div>
  </PublicLayout>
</template>

<script setup>
import { useRouter } from 'vue-router';
import { useUserStore } from '@/stores/user';
import KhyIcon from '@/components/KhyIcon.vue';
import PublicLayout from '@/layouts/PublicLayout.vue';

defineOptions({ name: 'Forbidden' });

const router = useRouter();
const userStore = useUserStore();

function goHome() {
  router.push(userStore.preferredHome);
}

function back() {
  router.back();
}
</script>

<style scoped>
.forbidden-card {
  max-width: 460px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

.forbidden-icon {
  color: var(--khy-danger);
}

.forbidden-title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  color: var(--khy-text-strong);
}

.forbidden-desc {
  margin: 0;
  font-size: 14px;
  line-height: 1.7;
  color: var(--khy-text-secondary);
}

.forbidden-actions {
  display: flex;
  gap: 10px;
  margin-top: 6px;
}
</style>
