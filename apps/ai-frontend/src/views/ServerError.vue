<template>
  <PublicLayout title="500 · 出了点问题">
    <div class="error-card">
      <KhyIcon class="error-icon" kind="warning" size="lg" />
      <h2 class="error-title">出了点问题</h2>
      <p class="error-desc">
        页面加载或跳转时发生了意外错误。重新加载通常能恢复；如果反复出现，请把浏览器控制台里的报错发给平台维护者。
      </p>
      <div class="error-actions">
        <el-button type="primary" @click="reload">重新加载</el-button>
        <el-button @click="goHome">回到首页</el-button>
      </div>
    </div>
  </PublicLayout>
</template>

<script setup>
import { useRouter } from 'vue-router';
import { useUserStore } from '@/stores/user';
import KhyIcon from '@/components/KhyIcon.vue';
import PublicLayout from '@/layouts/PublicLayout.vue';

defineOptions({ name: 'ServerError' });

const router = useRouter();
const userStore = useUserStore();

// A full reload re-runs the navigation that failed (a busted chunk usually
// comes back on the second try); the router replace below is the escape hatch
// when it does not.
function reload() {
  window.location.reload();
}

function goHome() {
  router.replace(userStore.preferredHome);
}
</script>

<style scoped>
.error-card {
  max-width: 460px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

.error-icon {
  color: var(--khy-warning);
}

.error-title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  color: var(--khy-text-strong);
}

.error-desc {
  margin: 0;
  font-size: 14px;
  line-height: 1.7;
  color: var(--khy-text-secondary);
}

.error-actions {
  display: flex;
  gap: 10px;
  margin-top: 6px;
}
</style>
