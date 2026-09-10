<template>
  <GlobalProgressBar />
  <router-view />
  <KhyFloatBall />
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue';
import GlobalProgressBar from '@/components/GlobalProgressBar.vue';
import KhyFloatBall from '@/components/KhyFloatBall.vue';
import { useCrossPlatformStore } from '@/stores/crossPlatform';

const cpStore = useCrossPlatformStore();

onMounted(() => {
  // Auto-connect cross-platform sync when app mounts
  cpStore.init();
});

onUnmounted(() => {
  // Keep connection alive on page refresh (SPA navigation)
});
</script>
