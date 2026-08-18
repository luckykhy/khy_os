<script setup>
defineProps({ status: { type: Object, default: () => ({}) }, connected: Boolean });
</script>

<template>
  <span class="connection-status" :class="connected ? 'is-online' : 'is-offline'" :title="`${status.action || ''} · ${status.target || ''} · ${status.progress || ''}`">
    <i></i>{{ connected ? '已连接' : '未连接' }}
  </span>
</template>
