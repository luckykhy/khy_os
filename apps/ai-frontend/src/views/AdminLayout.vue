<template>
  <!-- 管理控制台外壳 — 只渲染 NAV 的「管理控制台」组，与用户中心（views/Layout.vue）
       是两个独立外壳：普通用户永远挂不到这里（路由整棵子树 requiresAdmin），
       管理员经顶栏链接在两个外壳间切换。 -->
  <AppShell scope="admin" />
</template>

<script setup>
import AppShell from '@/layouts/AppShell.vue';
</script>
