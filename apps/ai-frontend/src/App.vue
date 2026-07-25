<template>
  <GlobalProgressBar />
  <router-view />
  <KhyFloatBall />
</template>

<script setup>
import GlobalProgressBar from '@/components/GlobalProgressBar.vue'
import KhyFloatBall from '@/components/KhyFloatBall.vue'
</script>
