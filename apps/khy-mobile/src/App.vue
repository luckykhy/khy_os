<template>
  <router-view />
  <ErrorNotificationBanner />
</template>

<script setup>
import { onMounted } from 'vue';
import ErrorNotificationBanner from './components/ErrorNotificationBanner.vue';
import { useCrossPlatform } from '@/api/crossPlatform/crossPlatformClient';

const cp = useCrossPlatform();

onMounted(() => {
  // Auto-connect cross-platform sync when app mounts
  // The SDK will discover WS URL from runtime config
  cp.connect().catch(() => {
    // Auto-connect failure is non-blocking - user can manually connect in Settings
  });
});
</script>
