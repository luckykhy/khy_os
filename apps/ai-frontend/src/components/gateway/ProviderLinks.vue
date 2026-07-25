<template>
  <!--
    Resident provider links: where to get an API key / read docs for the picked
    preset. Pure presentation — the URLs are public reference data delivered by
    the backend providerPresets (key-less, http(s)-validated, env-overridable).
  -->
  <div v-if="hasLinks" class="gw-links">
    <span class="gw-links-lead">获取密钥 / 文档：</span>
    <a v-if="links.console" :href="links.console" target="_blank" rel="noopener noreferrer" class="gw-link gw-link-primary">
      <el-icon><Key /></el-icon><span>获取 API Key</span>
    </a>
    <a v-if="links.docs" :href="links.docs" target="_blank" rel="noopener noreferrer" class="gw-link">
      <el-icon><Document /></el-icon><span>文档</span>
    </a>
    <a v-if="links.home" :href="links.home" target="_blank" rel="noopener noreferrer" class="gw-link">
      <el-icon><HomeFilled /></el-icon><span>主页</span>
    </a>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Key, Document, HomeFilled } from '@element-plus/icons-vue'

const props = defineProps({
  links: { type: Object, default: () => ({}) },
})

const hasLinks = computed(() => {
  const l = props.links || {}
  return !!(l.home || l.console || l.docs)
})
</script>

<style scoped>
.gw-links { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 8px; font-size: 12px; }
.gw-links-lead { color: var(--khy-text-muted); }
.gw-link { display: inline-flex; align-items: center; gap: 4px; color: var(--khy-text-secondary); text-decoration: none; }
.gw-link:hover { color: var(--el-color-primary); text-decoration: underline; }
.gw-link-primary { color: var(--el-color-primary); font-weight: 600; }
</style>
